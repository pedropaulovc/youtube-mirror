import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { AtpAgent } from "@atproto/api";
import type { ChannelConfig } from "../worker/types.js";
import { ensureOpEnv } from "./op-bootstrap.js";
import { environmentFromArgs, parseDeploymentEnvironment } from "./deployment-environment.js";
import { PdsRateLimiter } from "./pds-rate-limit.js";
import { atProtoSecretValues } from "./secret-values.js";
import { synchronizeSecretStoreEntries } from "./secrets-store.js";

const RAW_ARGS = process.argv.slice(2);
const DEPLOYMENT_NAME = environmentFromArgs(RAW_ARGS);
const SCRIPT_ARGS = [...RAW_ARGS];
SCRIPT_ARGS.splice(SCRIPT_ARGS.indexOf("--environment"), 2);
process.env.DEPLOY_ENVIRONMENT = DEPLOYMENT_NAME;
ensureOpEnv(["CLOUDFLARE_API_TOKEN"]);
const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!cloudflareApiToken) throw new Error("CLOUDFLARE_API_TOKEN is required");
delete process.env.CLOUDFLARE_API_TOKEN;
const DEPLOYMENT = parseDeploymentEnvironment(process.env, DEPLOYMENT_NAME);

// ── Constants ──────────────────────────────────────────────────────────
// Bluesky accounts live on the self-hosted PDS; the worker resolves each
// account's real PDS via its DID document at runtime (see resolvePdsUrl).
const PDS_HOST = "selfhosted.social";
const PDS_URL = `https://${PDS_HOST}`;
const KV_NAMESPACE_ID = DEPLOYMENT.kvNamespaceId;
// 1Password vault reachable by the service-account token in .env.local.
const BACKUP_VAULT = "youtube-mirror";
const BIRTH_DATE_ISO = "1991-03-01";
const EMAIL_BASE = "pedro+youtube-mirror";
const EMAIL_DOMAIN = "vza.net";
const MAX_HANDLE_PREFIX = 18; // chars before .selfhosted.social
const DEFAULT_MAX_ITEMS = 15;
const DEFAULT_POLL_INTERVAL_MINUTES = 15;

// ── PDS Login Rate Limiter ─────────────────────────────────────────────
// selfhosted.social enforces ~5 logins per 5-minute sliding window.
// The limiter spaces proactive attempts and retries repeated 429 responses
// with bounded exponential backoff when the PDS supplies no useful delay.
const pdsLoginLimiter = new PdsRateLimiter({
	log: (message) => log("rate-limit", message),
});

async function pdsRateLimitedLogin(agent: AtpAgent, identifier: string, password: string): Promise<void> {
	await pdsLoginLimiter.login(() => agent.login({ identifier, password }).then(() => undefined));
}

// ── Helpers ────────────────────────────────────────────────────────────

function log(phase: string, msg: string) {
	console.log(`[${phase}] ${msg}`);
}

const MAX_CHILD_DIAGNOSTIC_LENGTH = 1_000;

function sanitizedChildEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.CLOUDFLARE_API_TOKEN;
	return env;
}

function cloudflareChildEnv(apiToken: string): NodeJS.ProcessEnv {
	const env = sanitizedChildEnv();
	env.CLOUDFLARE_API_TOKEN = apiToken;
	return env;
}

function runWrangler(args: readonly string[], apiToken: string, input?: string): string {
	const result = spawnSync("npx", ["wrangler", ...args], {
		input,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		env: cloudflareChildEnv(apiToken),
	});
	if (result.status !== 0) {
		const details = sanitizeDiagnostic(result.stderr.toString());
		throw new Error(
			`Wrangler command failed (exit ${result.status ?? "unknown"}${details ? `: ${details}` : ""})`,
		);
	}
	return result.stdout.toString().trim();
}

function sanitizeDiagnostic(output: string): string {
	return output
		.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
		.replace(/((?:["']?(?:token|secret|password|credential)["']?)\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
		.trim()
		.slice(0, MAX_CHILD_DIAGNOSTIC_LENGTH);
}


function generatePassword(): string {
	return crypto.randomUUID() + "-" + crypto.randomUUID();
}

function buildHandle(youtubeHandle: string, suffix: string): string {
	// AT Proto handle segments only allow [a-z0-9-], with no leading/trailing hyphen.
	const sanitized = youtubeHandle
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	const maxPrefix = MAX_HANDLE_PREFIX - suffix.length;
	const prefix = sanitized.slice(0, maxPrefix).replace(/-+$/, "");
	return `${prefix}${suffix}`;
}

function uploadsPlaylistId(channelId: string): string {
	return channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : channelId;
}

// ── PLC Rotation Key Helpers ──────────────────────────────────────────
// A self-held secp256k1 rotation key on the DID lets us recover the account
// even if the PDS disappears. Mirrors the twitter-mirror recovery scheme.

const SECP256K1_MULTICODEC = Buffer.from([0xe7, 0x01]);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(buffer: Buffer): string {
	let num = BigInt("0x" + buffer.toString("hex"));
	const chars: string[] = [];
	while (num > 0n) {
		chars.unshift(BASE58_ALPHABET[Number(num % 58n)]);
		num = num / 58n;
	}
	for (const byte of buffer) {
		if (byte === 0) chars.unshift("1");
		else break;
	}
	return chars.join("");
}

function compressedPubKeyToDidKey(compressed: Buffer): string {
	const multicodecKey = Buffer.concat([SECP256K1_MULTICODEC, compressed]);
	return `did:key:z${base58btcEncode(multicodecKey)}`;
}

function privateKeyHexToDidKey(privateKeyHex: string): string {
	// Derive the secp256k1 public point (0x04 || X || Y) from the raw scalar.
	const ecdh = crypto.createECDH("secp256k1");
	ecdh.setPrivateKey(Buffer.from(privateKeyHex, "hex"));
	const uncompressed = ecdh.getPublicKey();
	const x = uncompressed.subarray(1, 33);
	const y = uncompressed.subarray(33, 65);
	const prefix = y[y.length - 1] % 2 === 0 ? 0x02 : 0x03;
	return compressedPubKeyToDidKey(Buffer.concat([Buffer.from([prefix]), x]));
}

function generateSecp256k1KeyPair(): { privateKeyHex: string; didKey: string } {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" });
	const privKeyJwk = privateKey.export({ format: "jwk" });
	const privateKeyHex = Buffer.from(privKeyJwk.d!, "base64url").toString("hex");
	const pubDer = publicKey.export({ type: "spki", format: "der" });
	const uncompressed = pubDer.subarray(pubDer.length - 65);
	const x = uncompressed.subarray(1, 33);
	const y = uncompressed.subarray(33, 65);
	const prefix = y[y.length - 1] % 2 === 0 ? 0x02 : 0x03;
	const didKey = compressedPubKeyToDidKey(Buffer.concat([Buffer.from([prefix]), x]));
	return { privateKeyHex, didKey };
}

async function plcHasRotationKey(handle: string, privateKeyHex: string): Promise<boolean> {
	const didKey = privateKeyHexToDidKey(privateKeyHex);
	const res = await fetch(`${PDS_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`);
	if (!res.ok) return false;
	const { did } = (await res.json()) as { did: string };
	const auditLog = await fetch(`https://plc.directory/${did}/log/audit`).then((r) => r.json() as Promise<Array<{ operation: { rotationKeys: string[] } }>>);
	return auditLog[auditLog.length - 1].operation.rotationKeys.includes(didKey);
}

async function applyPlcRotationKey(agent: AtpAgent, privateKeyHex: string, token: string): Promise<void> {
	const handle = agent.session!.handle;
	const did = agent.session!.did;
	const didKey = privateKeyHexToDidKey(privateKeyHex);

	const auditLog = await fetch(`https://plc.directory/${did}/log/audit`).then((r) => r.json() as Promise<Array<{ operation: { rotationKeys: string[] } }>>);
	const currentKeys = auditLog[auditLog.length - 1].operation.rotationKeys;

	if (currentKeys.includes(didKey)) {
		log("plc", `${handle}: rotation key already present, skipping`);
		return;
	}

	const newKeys = [didKey, ...currentKeys];
	log("plc", `${handle}: adding rotation key ${didKey}`);

	const signRes = await agent.com.atproto.identity.signPlcOperation({ token, rotationKeys: newKeys });

	const plcRes = await fetch(`https://plc.directory/${did}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(signRes.data.operation),
	});

	if (!plcRes.ok) {
		const body = await plcRes.text();
		throw new Error(`PLC update failed for ${handle}: ${plcRes.status} ${body}`);
	}
	log("plc", `${handle}: PLC directory updated`);
}

// ── Playwright Account Registration ────────────────────────────────────

async function accountExists(handle: string): Promise<boolean> {
	const agent = new AtpAgent({ service: PDS_URL });
	try {
		await agent.resolveHandle({ handle: `${handle}.${PDS_HOST}` });
		return true;
	} catch {
		return false;
	}
}

/** Returns true if a new account was created, false if it already existed. */
async function createAccountViaPlaywright(
	handle: string,
	email: string,
	password: string,
	label: string,
): Promise<boolean> {
	if (await accountExists(handle)) {
		log("register", `${label} account ${handle}.${PDS_HOST} already exists, skipping creation`);
		return false;
	}

	log("register", `Creating ${label} account: ${handle}.${PDS_HOST}`);
	log("register", `  Email: ${email}`);
	log("register", "");

	const browser = await chromium.launch({ headless: false });
	const context = await browser.newContext();
	await context.clearCookies();
	const page = await context.newPage();
	await page.goto("https://bsky.app");
	await page.waitForLoadState("networkidle");

	log("register", "Step 1/3: Filling account details...");
	const createBtn = page.getByRole("button", { name: "Create account" }).last();
	await createBtn.waitFor({ timeout: 15_000 });
	await createBtn.click();

	await page.getByText("Your account").waitFor({ timeout: 10_000 });

	// Switch to custom PDS
	const pdsBtn = page.getByRole("button", { name: "Bluesky Social" });
	await pdsBtn.click();
	await page.getByRole("tab", { name: "Custom" }).waitFor({ timeout: 5_000 });
	await page.getByRole("tab", { name: "Custom" }).click();
	const serverInput = page.getByRole("textbox", { name: "Server address" });
	await serverInput.waitFor({ timeout: 5_000 });
	await serverInput.fill(PDS_HOST);
	await page.getByRole("button", { name: "Done" }).click();
	await page.waitForTimeout(1000);

	await page.getByRole("textbox", { name: "Enter your email address" }).fill(email);
	await page.getByRole("textbox", { name: "Choose your password" }).fill(password);
	await page.getByRole("textbox", { name: "Date of birth" }).fill(BIRTH_DATE_ISO);
	await page.waitForTimeout(500);
	await page.getByRole("button", { name: "Continue to next step" }).click();

	log("register", "Step 2/3: Setting handle...");
	await page.getByText("Choose your username").waitFor({ timeout: 15_000 });
	const handleInput = page.getByTestId("handleInput");
	await handleInput.waitFor({ timeout: 5_000 });
	await handleInput.fill(handle);
	await page.waitForTimeout(3000);
	await page.getByRole("button", { name: "Continue to next step" }).click();

	log("register", "Step 3/3: Solve the hCaptcha in the browser window.");
	log("register", "Waiting for account creation to complete...");

	await page.getByText("Give your profile a face").waitFor({ timeout: 300_000 });
	log("register", "Account created! Closing browser.");
	await browser.close();

	log("register", "Verifying account login...");
	const agent = new AtpAgent({ service: PDS_URL });
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await pdsRateLimitedLogin(agent, `${handle}.${PDS_HOST}`, password);
			log("register", `Account ${handle}.${PDS_HOST} verified (DID: ${agent.session!.did})`);
			return true;
		} catch (e) {
			if (attempt < 4) {
				log("register", `Login attempt ${attempt + 1} failed, retrying in 3s...`);
				await new Promise((r) => setTimeout(r, 3000));
			} else {
				throw e;
			}
		}
	}
	throw new Error(`Failed to verify account ${handle}.${PDS_HOST} after 5 attempts`);
}

// ── DMs + Email Verification ───────────────────────────────────────────

async function enableDMs(agent: AtpAgent): Promise<void> {
	const did = agent.session!.did;
	await agent.com.atproto.repo.putRecord({
		repo: did,
		collection: "chat.bsky.actor.declaration",
		rkey: "self",
		record: { $type: "chat.bsky.actor.declaration", allowIncoming: "all" },
	});
	log("dms", `DMs enabled for ${agent.session!.handle}`);
}

async function isEmailConfirmed(agent: AtpAgent): Promise<boolean> {
	const session = await agent.com.atproto.server.getSession();
	return session.data.emailConfirmed === true;
}

async function requestEmailVerification(agent: AtpAgent): Promise<void> {
	await agent.com.atproto.server.requestEmailConfirmation();
	log("email", `Verification email requested for ${agent.session!.handle}`);
}

// ── Infrastructure ─────────────────────────────────────────────────────

function backupPasswordTo1Password(handle: string, password: string, email: string, plcKeyHex: string): void {
	const fullHandle = `${handle}.${PDS_HOST}`;
	const plcDidKey = privateKeyHexToDidKey(plcKeyHex);
	try {
		runOp(["item", "get", fullHandle, "--vault", BACKUP_VAULT, "--format", "json"]);
		log("1password", `${fullHandle} already exists, updating PLC key fields`);
		runOp([
			"item",
			"edit",
			fullHandle,
			"--vault",
			BACKUP_VAULT,
			`plc_rotation_key_hex[password]=${plcKeyHex}`,
			`plc_rotation_key_did[text]=${plcDidKey}`,
		]);
		return;
	} catch {
		// Item doesn't exist, create it
	}
	log("1password", `Saving ${fullHandle} to ${BACKUP_VAULT} vault`);
	runOp([
		"item",
		"create",
		"--category",
		"login",
		"--vault",
		BACKUP_VAULT,
		"--title",
		fullHandle,
		"--url",
		"https://bsky.app",
		`username=${fullHandle}`,
		`password=${password}`,
		`email=${email}`,
		`plc_rotation_key_hex[password]=${plcKeyHex}`,
		`plc_rotation_key_did[text]=${plcDidKey}`,
	]);
}

function runOp(args: readonly string[], input?: string): string {
	const result = spawnSync("op", args, {
		input,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		env: sanitizedChildEnv(),
	});
	if (result.status !== 0) {
		const details = sanitizeDiagnostic(result.stderr.toString());
		throw new Error(`1Password command failed${details ? `: ${details}` : ""}`);
	}
	return result.stdout.toString().trim();
}


function addKvConfig(
	channelId: string,
	youtubeHandle: string,
	mainHandle: string,
	rtHandle: string,
	mainEmail: string,
	rtEmail: string,
	maxItems: number,
	apiToken: string,
): void {
	const config: ChannelConfig = {
		main: {
			passwordKey: `youtube-mirror-atproto-password-${channelId}`,
			atProtoAccount: `${mainHandle}.${PDS_HOST}`,
			email: mainEmail,
		},
		rt: {
			passwordKey: `youtube-mirror-atproto-password-${channelId}-rt`,
			atProtoAccount: `${rtHandle}.${PDS_HOST}`,
			email: rtEmail,
		},
		handle: youtubeHandle,
		uploadsPlaylistId: uploadsPlaylistId(channelId),
		maxItems,
		pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
		mirrorComments: true,
		mirrorCommunity: true,
	};

	// --path avoids Windows/WSL shell quoting mangling the JSON.
	const tmpFile = `scripts/.tmp-kv-${DEPLOYMENT.name}-${channelId}.json`;
	writeFileSync(tmpFile, JSON.stringify(config));
	try {
		log("kv", `Writing users:${channelId} to KV`);
		runWrangler(
			[
				"kv",
				"key",
				"put",
				`--namespace-id=${KV_NAMESPACE_ID}`,
				`users:${channelId}`,
				`--path=${tmpFile}`,
				"--remote",
			],
			apiToken,
		);
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup failures after the write result is known.
		}
	}
}


// ── Main ───────────────────────────────────────────────────────────────

async function main() {
	const positional = SCRIPT_ARGS.filter((argument) => !argument.startsWith("--"));
	const flags = SCRIPT_ARGS.filter((argument) => argument.startsWith("--"));
	const channelId = positional[0];
	const youtubeHandleRaw = positional[1];
	if (!channelId || !youtubeHandleRaw) {
		console.error("Usage: npx tsx scripts/provision-account.ts <channelId> <handle> [mainToken] [rtToken] [mainPlcToken] [rtPlcToken] --environment production|ppe [--max=N]");
		console.error("  channelId: the UC… channel ID");
		console.error("  handle:    the @handle without the leading @");
		process.exit(1);
	}
	const youtubeHandle = youtubeHandleRaw.replace(/^@/, "");
	const maxFlag = flags.find((f) => f.startsWith("--max="));
	const maxItems = maxFlag ? Number(maxFlag.split("=")[1]) : DEFAULT_MAX_ITEMS;
	if (!DEPLOYMENT.channelIds.includes(channelId)) {
		throw new Error(`${channelId} is not listed in the ${DEPLOYMENT.name} MIRROR_CHANNEL_IDS variable`);
	}

	log("main", `Provisioning ${DEPLOYMENT.name} mirror for @${youtubeHandle} (${channelId})`);

	// Phase 1: Account details (state file for resumability).
	const mainSuffix = DEPLOYMENT.name === "ppe" ? "-ppe-mir" : "-mirr";
	const rtSuffix = DEPLOYMENT.name === "ppe" ? "-ppe-rt" : "-mir-rt";
	const emailEnvironment = DEPLOYMENT.name === "ppe" ? "-ppe" : "";
	const mainHandle = buildHandle(youtubeHandle, mainSuffix);
	const rtHandle = buildHandle(youtubeHandle, rtSuffix);
	const mainEmail = `${EMAIL_BASE}-${youtubeHandle.toLowerCase()}${emailEnvironment}@${EMAIL_DOMAIN}`;
	const rtEmail = `${EMAIL_BASE}-${youtubeHandle.toLowerCase()}${emailEnvironment}-rt@${EMAIL_DOMAIN}`;

	const stateFile = `scripts/.provision-${DEPLOYMENT.name}-${youtubeHandle.toLowerCase()}.json`;
	type ProvisionState = { mainPassword: string; rtPassword: string; mainPlcKeyHex?: string; rtPlcKeyHex?: string };
	let state: ProvisionState;
	if (existsSync(stateFile)) {
		state = JSON.parse(readFileSync(stateFile, "utf8")) as ProvisionState;
		log("main", `Resuming from state file: ${stateFile}`);
	} else {
		state = { mainPassword: generatePassword(), rtPassword: generatePassword() };
	}
	if (!state.mainPlcKeyHex) state.mainPlcKeyHex = generateSecp256k1KeyPair().privateKeyHex;
	if (!state.rtPlcKeyHex) state.rtPlcKeyHex = generateSecp256k1KeyPair().privateKeyHex;
	writeFileSync(stateFile, JSON.stringify(state, null, 2));
	log("main", `State saved to: ${stateFile}`);
	const { mainPassword, rtPassword } = state;

	log("main", `Main handle: ${mainHandle}.${PDS_HOST}`);
	log("main", `RT handle: ${rtHandle}.${PDS_HOST}`);

	// Phase 2: Create accounts via Playwright (manual hCaptcha).
	await createAccountViaPlaywright(mainHandle, mainEmail, mainPassword, "MAIN");
	await createAccountViaPlaywright(rtHandle, rtEmail, rtPassword, "RT");

	// Phase 3: Login to both accounts.
	log("main", "Logging into accounts via AT Proto API...");
	const mainAgent = new AtpAgent({ service: PDS_URL });
	await pdsRateLimitedLogin(mainAgent, `${mainHandle}.${PDS_HOST}`, mainPassword);
	const rtAgent = new AtpAgent({ service: PDS_URL });
	await pdsRateLimitedLogin(rtAgent, `${rtHandle}.${PDS_HOST}`, rtPassword);

	// Phase 4: Enable DMs (takedown contact) + email verification.
	// Profiles (display name / avatar / banner) are populated by the deployed
	// profile-sync workflow — no need to replicate them here.
	await enableDMs(mainAgent);
	await enableDMs(rtAgent);
	const mainEmailConfirmed = await isEmailConfirmed(mainAgent);
	const rtEmailConfirmed = await isEmailConfirmed(rtAgent);
	const mainToken = positional[2];
	const rtToken = positional[3];
	const mainPlcToken = positional[4];
	const rtPlcToken = positional[5];
	if (mainEmailConfirmed) log("email", `Main email already confirmed, skipping`);
	else if (!mainToken) await requestEmailVerification(mainAgent);
	if (rtEmailConfirmed) log("email", `RT email already confirmed, skipping`);
	else if (!rtToken) await requestEmailVerification(rtAgent);
	if ((!mainEmailConfirmed && !mainToken) || (!rtEmailConfirmed && !rtToken)) {
		log("email", `Re-run with tokens: npx tsx scripts/provision-account.ts ${channelId} ${youtubeHandle} <mainToken> <rtToken> --environment ${DEPLOYMENT.name}`);
	}

	// Phase 5: Confirm email addresses.
	if (mainEmailConfirmed) log("email", `Main email already confirmed`);
	else if (mainToken && mainToken !== "-") {
		await mainAgent.com.atproto.server.confirmEmail({ email: mainEmail, token: mainToken });
		log("email", `Email confirmed for ${mainHandle}.${PDS_HOST}`);
	} else if (!mainToken) log("email", `Skipped main email confirmation — pass token as 3rd arg`);
	if (rtEmailConfirmed) log("email", `RT email already confirmed`);
	else if (rtToken && rtToken !== "-") {
		await rtAgent.com.atproto.server.confirmEmail({ email: rtEmail, token: rtToken });
		log("email", `Email confirmed for ${rtHandle}.${PDS_HOST}`);
	} else if (!rtToken) log("email", `Skipped RT email confirmation — pass token as 4th arg`);

	// Phase 6: PLC rotation keys (account recovery).
	const mainHasPlcKey = await plcHasRotationKey(`${mainHandle}.${PDS_HOST}`, state.mainPlcKeyHex!);
	const rtHasPlcKey = await plcHasRotationKey(`${rtHandle}.${PDS_HOST}`, state.rtPlcKeyHex!);
	if (mainHasPlcKey) log("plc", `Main account already has PLC rotation key, skipping`);
	else if (mainPlcToken) await applyPlcRotationKey(mainAgent, state.mainPlcKeyHex!, mainPlcToken);
	else if (mainEmailConfirmed || mainToken) {
		log("plc", `Requesting PLC operation signature for ${mainHandle}.${PDS_HOST}...`);
		await mainAgent.com.atproto.identity.requestPlcOperationSignature();
		log("plc", `PLC token sent to ${mainEmail}`);
	} else log("plc", `Main: email must be confirmed before PLC rotation key can be set`);
	if (rtHasPlcKey) log("plc", `RT account already has PLC rotation key, skipping`);
	else if (rtPlcToken) await applyPlcRotationKey(rtAgent, state.rtPlcKeyHex!, rtPlcToken);
	else if (rtEmailConfirmed || rtToken) {
		log("plc", `Requesting PLC operation signature for ${rtHandle}.${PDS_HOST}...`);
		await rtAgent.com.atproto.identity.requestPlcOperationSignature();
		log("plc", `PLC token sent to ${rtEmail}`);
	} else log("plc", `RT: email must be confirmed before PLC rotation key can be set`);
	if ((!mainHasPlcKey && !mainPlcToken) || (!rtHasPlcKey && !rtPlcToken)) {
		log("plc", `Re-run with PLC tokens: npx tsx scripts/provision-account.ts ${channelId} ${youtubeHandle} <mainToken> <rtToken> <mainPlcToken> <rtPlcToken> --environment ${DEPLOYMENT.name}`);
		log("plc", `  (use - for already-confirmed email tokens)`);
	}

	// Phase 7: back up the account passwords and publish them directly to the
	// selected Cloudflare Secrets Store.  1Password remains the recovery source
	// for account deletion and operational recovery; GitHub never receives them.
	backupPasswordTo1Password(mainHandle, mainPassword, mainEmail, state.mainPlcKeyHex!);
	backupPasswordTo1Password(rtHandle, rtPassword, rtEmail, state.rtPlcKeyHex!);
	await synchronizeSecretStoreEntries(
		DEPLOYMENT,
		cloudflareApiToken,
		atProtoSecretValues(DEPLOYMENT.name, channelId, mainPassword, rtPassword),
	);

	// Seed KV only after the selected deployment has installed and activated the
	// corresponding Worker bindings. This keeps the poller from observing a user
	// row before its password bindings exist.
	if (!flags.includes("--seed-kv")) {
		log("main", "");
		log("main", `Accounts and ${DEPLOYMENT.name} Secrets Store entries are ready.`);
		log("main", `Deploy ${DEPLOYMENT.name}, then re-run with --seed-kv:`);
		log("main", `  npx tsx scripts/provision-account.ts ${channelId} ${youtubeHandle} - - - - --environment ${DEPLOYMENT.name} --max=${maxItems} --seed-kv`);
		return;
	}
	const verification = spawnSync(
		"npx",
		["tsx", "scripts/verify-environment.ts", "--environment", DEPLOYMENT.name, "--active-secrets", "--bindings"],
		{ encoding: "utf8", stdio: "inherit", env: cloudflareChildEnv(cloudflareApiToken) },
	);
	if (verification.error) throw verification.error;
	if (verification.status !== 0) {
		throw new Error(`Refusing to seed ${DEPLOYMENT.name} before its bindings verify`);
	}

	addKvConfig(channelId, youtubeHandle, mainHandle, rtHandle, mainEmail, rtEmail, maxItems, cloudflareApiToken);

	log("main", "");
	log("main", `Provisioning complete. ${DEPLOYMENT.name} KV is seeded.`);
	log("main", `Main: https://bsky.app/profile/${mainHandle}.${PDS_HOST}`);
	log("main", `RT:   https://bsky.app/profile/${rtHandle}.${PDS_HOST}`);
	log("main", `maxItems cap: ${maxItems}`);
	log("main", "Passwords are backed up in the youtube-mirror 1Password vault and stored in the selected Cloudflare Secrets Store.");
}

main().catch((e) => {
	console.error("Fatal error:", e);
	process.exit(1);
});
