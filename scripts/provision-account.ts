import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { AtpAgent } from "@atproto/api";
import type { ChannelConfig } from "../worker/types.js";
import { ensureOpEnv } from "./op-bootstrap.js";

ensureOpEnv(["CLOUDFLARE_API_TOKEN"]);

// ── Constants ──────────────────────────────────────────────────────────
// Bluesky accounts live on the self-hosted PDS; the worker resolves each
// account's real PDS via its DID document at runtime (see resolvePdsUrl).
const PDS_HOST = "selfhosted.social";
const PDS_URL = `https://${PDS_HOST}`;
const SECRETS_STORE_ID = "f0c7662b60484d17a094e384a3853ab9";
const KV_NAMESPACE_ID = "4678dd1b9ac742439e0a0b029b1e9d03";
const OP_ENVIRONMENT = "bykx5xzmykwxw3of4gtncs7i7i";
// 1Password vault reachable by the service-account token in .env.local.
const BACKUP_VAULT = "youtube-mirror";
const BIRTH_DATE_ISO = "1991-03-01";
const EMAIL_BASE = "pedro+youtube-mirror";
const EMAIL_DOMAIN = "vza.net";
const MAX_HANDLE_PREFIX = 18; // chars before .selfhosted.social
const DEFAULT_MAX_ITEMS = 15;
const DEFAULT_POLL_INTERVAL_MINUTES = 15;
// Bluesky config workers that create/delete posts and therefore need the
// per-channel app-password bindings declared in their secrets_store_secrets.
const WRANGLER_CONFIGS = [
	"wrangler.mirror-channel.jsonc",
	"wrangler.mirror-item.jsonc",
	"wrangler.mirror-delete.jsonc",
	"wrangler.mirror-profile.jsonc",
];

// ── PDS Login Rate Limiter ─────────────────────────────────────────────
// selfhosted.social enforces ~5 logins per 5-minute sliding window.
// Proactive limiter prevents most 429s; retry-after fallback handles the rest.
const PDS_LOGIN_LIMIT = 4;
const PDS_LOGIN_WINDOW_MS = 300_000;
const pdsLoginTimestamps: number[] = [];

function pdsRateLimitPurge(): void {
	const now = Date.now();
	while (pdsLoginTimestamps.length > 0 && pdsLoginTimestamps[0] <= now - PDS_LOGIN_WINDOW_MS) {
		pdsLoginTimestamps.shift();
	}
}

async function pdsRateLimitWait(): Promise<void> {
	pdsRateLimitPurge();
	if (pdsLoginTimestamps.length >= PDS_LOGIN_LIMIT) {
		const waitMs = pdsLoginTimestamps[0] + PDS_LOGIN_WINDOW_MS - Date.now() + 1_000;
		log("rate-limit", `PDS login limit reached (${PDS_LOGIN_LIMIT}/5min), waiting ${Math.ceil(waitMs / 1000)}s...`);
		await new Promise((r) => setTimeout(r, waitMs));
	}
	pdsLoginTimestamps.push(Date.now());
}

function getRetryAfterSec(error: unknown): number | null {
	const headers = (error as { headers?: Record<string, string> })?.headers;
	if (!headers) return null;
	const val = headers["retry-after"] ?? headers["x-ratelimit-after"];
	if (!val) return null;
	const seconds = Number(val);
	return Number.isFinite(seconds) ? seconds : null;
}

async function pdsRateLimitedLogin(agent: AtpAgent, identifier: string, password: string): Promise<void> {
	await pdsRateLimitWait();
	try {
		await agent.login({ identifier, password });
	} catch (error: unknown) {
		const retryAfter = getRetryAfterSec(error);
		if (retryAfter === null) throw error;
		const waitSec = Math.max(retryAfter, 30);
		log("rate-limit", `PDS returned retry-after ${retryAfter}s, waiting ${waitSec}s...`);
		pdsLoginTimestamps.pop();
		await new Promise((r) => setTimeout(r, waitSec * 1000));
		pdsLoginTimestamps.push(Date.now());
		await agent.login({ identifier, password });
	}
}

// ── Helpers ────────────────────────────────────────────────────────────

function log(phase: string, msg: string) {
	console.log(`[${phase}] ${msg}`);
}

function run(cmd: string): string {
	return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function runPassthrough(cmd: string) {
	execSync(cmd, { encoding: "utf8", stdio: "inherit" });
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
	log("register", `  Password: ${password}`);
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
	const handleInput = page.getByRole("textbox", { name: `.${PDS_HOST}` });
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
		run(`op item get "${fullHandle}" --vault ${BACKUP_VAULT} --format json`);
		log("1password", `${fullHandle} already exists, updating PLC key fields`);
		execSync(
			`op item edit "${fullHandle}" --vault ${BACKUP_VAULT} "plc_rotation_key_hex[password]=${plcKeyHex}" "plc_rotation_key_did[text]=${plcDidKey}"`,
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		return;
	} catch {
		// Item doesn't exist, create it
	}
	log("1password", `Saving ${fullHandle} to ${BACKUP_VAULT} vault`);
	execSync(
		`op item create --category login --vault ${BACKUP_VAULT} --title "${fullHandle}" --url https://bsky.app "username=${fullHandle}" "password=${password}" "email=${email}" "plc_rotation_key_hex[password]=${plcKeyHex}" "plc_rotation_key_did[text]=${plcDidKey}"`,
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
}

function savePasswordToSecretStore(name: string, password: string): void {
	log("secrets", `Saving secret: ${name}`);
	// printf (no trailing newline) instead of echo to avoid storing newlines.
	try {
		execSync(
			`printf '%s' "${password}" | npx wrangler secrets-store secret create ${SECRETS_STORE_ID} --name ${name} --scopes workers --remote`,
			{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
		);
	} catch (err) {
		// Only the already-exists case is safe to ignore. A transient Cloudflare error,
		// bad credentials, or wrong store ID must abort — otherwise we'd write bindings and
		// seed KV pointing at a secret that doesn't exist, and every login would fail.
		const output = `${(err as { stdout?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}${String(err)}`;
		if (!/already exists|duplicate/i.test(output)) {
			throw new Error(`Failed to create secret ${name}: ${output}`);
		}
		log("secrets", `Secret ${name} already exists, skipping`);
	}
}

/** Append the two per-channel app-password bindings to each worker's secrets_store_secrets. */
function updateWranglerBindings(channelId: string): void {
	const mainBinding = `youtube-mirror-atproto-password-${channelId}`;
	const rtBinding = `${mainBinding}-rt`;
	const entry = (name: string) =>
		`\t\t{\n\t\t\t"binding": "${name}",\n\t\t\t"store_id": "${SECRETS_STORE_ID}",\n\t\t\t"secret_name": "${name}"\n\t\t}`;
	const injection = `,\n${entry(mainBinding)},\n${entry(rtBinding)}`;

	for (const configPath of WRANGLER_CONFIGS) {
		const content = readFileSync(configPath, "utf8");
		if (content.includes(mainBinding)) {
			log("wrangler", `${configPath}: bindings already present, skipping`);
			continue;
		}
		// Insert before the secrets_store_secrets array close (first "\n\t]" after it).
		const match = content.match(/("secrets_store_secrets"\s*:\s*\[[\s\S]*?)(\n\t\])/);
		if (!match) {
			log("wrangler", `WARNING: could not find secrets_store_secrets array in ${configPath}`);
			continue;
		}
		const updated = content.replace(match[0], match[1] + injection + match[2]);
		writeFileSync(configPath, updated);
		log("wrangler", `${configPath}: bindings added`);
	}
}

function updateTypesFile(channelId: string): void {
	const typesPath = "worker-configuration.d.ts";
	const content = readFileSync(typesPath, "utf8");
	const mainBinding = `youtube-mirror-atproto-password-${channelId}`;
	const rtBinding = `${mainBinding}-rt`;

	if (content.includes(mainBinding)) {
		log("types", "Bindings already in worker-configuration.d.ts, skipping");
		return;
	}

	const anchor = "FIRECRAWL_API_TOKEN: SecretsStoreSecret;";
	const anchorPos = content.indexOf(anchor);
	if (anchorPos === -1) {
		log("types", "WARNING: could not find insertion anchor in worker-configuration.d.ts");
		return;
	}
	const insertPos = content.indexOf("\n", anchorPos) + 1;
	const newLines = `\t"${mainBinding}": SecretsStoreSecret;\n\t"${rtBinding}": SecretsStoreSecret;\n`;
	const updated = content.slice(0, insertPos) + newLines + content.slice(insertPos);
	writeFileSync(typesPath, updated);
	log("types", "worker-configuration.d.ts updated");
}

function addKvConfig(
	channelId: string,
	youtubeHandle: string,
	mainHandle: string,
	rtHandle: string,
	mainEmail: string,
	rtEmail: string,
	maxItems: number,
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
	const tmpFile = `scripts/.tmp-kv-${channelId}.json`;
	writeFileSync(tmpFile, JSON.stringify(config));
	log("kv", `Writing users:${channelId} to KV`);
	run(`npx wrangler kv key put --namespace-id=${KV_NAMESPACE_ID} "users:${channelId}" --path=${tmpFile} --remote`);
	try { execSync(`rm ${tmpFile}`); } catch { /* ignore */ }
}

function deployViaGit(channelId: string, youtubeHandle: string): void {
	updateTypesFile(channelId);

	log("deploy", "Committing and pushing...");
	runPassthrough("git add wrangler.mirror-*.jsonc worker-configuration.d.ts");
	try { run("git diff --cached --quiet"); log("deploy", "No changes to commit, skipping"); return; } catch { /* has staged changes */ }
	runPassthrough(`git commit -m "Add ${youtubeHandle} (${channelId}) mirror account bindings"`);
	runPassthrough("git push");
	log("deploy", "Pushed to remote. Open a PR and merge to main — the CI/CD deploy job ships the bindings.");
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
	const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
	const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
	const channelId = positional[0];
	const youtubeHandleRaw = positional[1];
	if (!channelId || !youtubeHandleRaw) {
		console.error("Usage: npx tsx scripts/provision-account.ts <channelId> <handle> [mainToken] [rtToken] [mainPlcToken] [rtPlcToken] [--max=N]");
		console.error("  channelId: the UC… channel ID");
		console.error("  handle:    the @handle without the leading @");
		process.exit(1);
	}
	const youtubeHandle = youtubeHandleRaw.replace(/^@/, "");
	const maxFlag = flags.find((f) => f.startsWith("--max="));
	const maxItems = maxFlag ? Number(maxFlag.split("=")[1]) : DEFAULT_MAX_ITEMS;

	log("main", `Provisioning mirror for @${youtubeHandle} (${channelId})`);

	// Phase 1: Account details (state file for resumability).
	const mainHandle = buildHandle(youtubeHandle, "-mirr");
	const rtHandle = buildHandle(youtubeHandle, "-mir-rt");
	const mainEmail = `${EMAIL_BASE}-${youtubeHandle.toLowerCase()}@${EMAIL_DOMAIN}`;
	const rtEmail = `${EMAIL_BASE}-${youtubeHandle.toLowerCase()}-rt@${EMAIL_DOMAIN}`;

	const stateFile = `scripts/.provision-${youtubeHandle.toLowerCase()}.json`;
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
		log("email", `Re-run with tokens to confirm: op run --environment ${OP_ENVIRONMENT} -- npx tsx scripts/provision-account.ts ${channelId} ${youtubeHandle} <mainToken> <rtToken>`);
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
		log("plc", `Re-run with PLC tokens: op run --environment ${OP_ENVIRONMENT} -- npx tsx scripts/provision-account.ts ${channelId} ${youtubeHandle} <mainToken> <rtToken> <mainPlcToken> <rtPlcToken>`);
		log("plc", `  (use - for already-confirmed email tokens)`);
	}

	// Phase 7: Infrastructure.
	backupPasswordTo1Password(mainHandle, mainPassword, mainEmail, state.mainPlcKeyHex!);
	backupPasswordTo1Password(rtHandle, rtPassword, rtEmail, state.rtPlcKeyHex!);
	savePasswordToSecretStore(`youtube-mirror-atproto-password-${channelId}`, mainPassword);
	savePasswordToSecretStore(`youtube-mirror-atproto-password-${channelId}-rt`, rtPassword);
	updateWranglerBindings(channelId);
	// Deploy the app-password bindings BEFORE seeding the KV row. The minute cron
	// discovers `users:{channelId}` the instant it lands, so if KV were seeded first
	// the first poll could dispatch item workflows whose `passwordKey` bindings aren't
	// live yet. (The channel workflow's restart-on-terminal-failure path re-runs any
	// item that erred during the deploy gap, but seeding last avoids the race entirely.)
	deployViaGit(channelId, youtubeHandle);

	// Seed KV LAST, and only once the app-password bindings are actually deployed.
	// Our CD deploys on merge-to-main (gated PR), not on any push — so seeding KV in
	// the same run would let the minute cron discover `users:{channelId}` and dispatch
	// item workflows whose `passwordKey` bindings aren't live yet. Gate it behind
	// --seed-kv: first run creates accounts/secrets + commits bindings; after the PR
	// merges and deploys, re-run the SAME command with --seed-kv (idempotent no-ops
	// through the earlier phases) to seed KV and start mirroring race-free.
	if (!flags.includes("--seed-kv")) {
		log("main", "");
		log("main", "=== Accounts + secrets provisioned; bindings committed. ===");
		log("main", `Main: https://bsky.app/profile/${mainHandle}.${PDS_HOST}`);
		log("main", `RT:   https://bsky.app/profile/${rtHandle}.${PDS_HOST}`);
		log("main", "");
		log("main", "Next: open a PR for the pushed branch, merge to main (deploys the bindings),");
		log("main", "then re-run this SAME command with --seed-kv to seed KV and start mirroring:");
		log("main", `  npx tsx scripts/provision-account.ts ${channelId} ${youtubeHandle} - - - - --max=${maxItems} --seed-kv`);
		return;
	}

	addKvConfig(channelId, youtubeHandle, mainHandle, rtHandle, mainEmail, rtEmail, maxItems);

	log("main", "");
	log("main", "=== Provisioning complete! KV seeded — mirroring starts on next cron. ===");
	log("main", `Main: https://bsky.app/profile/${mainHandle}.${PDS_HOST}`);
	log("main", `RT:   https://bsky.app/profile/${rtHandle}.${PDS_HOST}`);
	log("main", `maxItems cap: ${maxItems}`);
	log("main", "");
	log("main", "Passwords saved to secrets store and backed up to 1Password.");
	log("main", "");
	log("main", "The channel cron backfills automatically, or trigger the first mirror now with:");
	log("main", `  op run --environment ${OP_ENVIRONMENT} -- npx wrangler workflows trigger youtube-mirror-channel --config wrangler.mirror-channel.jsonc --id="mirror-${youtubeHandle}-$(date -u +%Y-%m-%dT%H-%M-%S)" --params='{"channelId":"${channelId}"}'`);
}

main().catch((e) => {
	console.error("Fatal error:", e);
	process.exit(1);
});
