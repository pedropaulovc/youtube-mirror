import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AtpAgent } from "@atproto/api";
import type { ChannelConfig } from "../worker/types.js";
import { ensureOpEnv } from "./op-bootstrap.js";
import { environmentFromArgs, parseDeploymentEnvironment } from "./deployment-environment.js";

const RAW_ARGS = process.argv.slice(2);
const DEPLOYMENT_NAME = environmentFromArgs(RAW_ARGS);
const SCRIPT_ARGS = [...RAW_ARGS];
SCRIPT_ARGS.splice(SCRIPT_ARGS.indexOf("--environment"), 2);
const confirmIndex = SCRIPT_ARGS.indexOf("--confirm-account");
const confirmedAccount = confirmIndex >= 0 ? SCRIPT_ARGS[confirmIndex + 1] : undefined;
if (confirmIndex >= 0) SCRIPT_ARGS.splice(confirmIndex, 2);
process.env.DEPLOY_ENVIRONMENT = DEPLOYMENT_NAME;
const DEPLOYMENT = parseDeploymentEnvironment(process.env, DEPLOYMENT_NAME);
if (confirmedAccount !== DEPLOYMENT.accountId) {
	throw new Error(`Pass --confirm-account ${DEPLOYMENT.accountId} to deprovision ${DEPLOYMENT.name}`);
}
ensureOpEnv(["CLOUDFLARE_API_TOKEN"]);

const CACHE_DIR = join(import.meta.dirname, ".deprovision-cache", DEPLOYMENT.name);
const SECRETS_STORE_ID = DEPLOYMENT.secretsStoreId;
const KV_NAMESPACE_ID = DEPLOYMENT.kvNamespaceId;
const ACCOUNT_ID = DEPLOYMENT.accountId;
const BACKUP_VAULT = "youtube-mirror";

// ── Helpers ────────────────────────────────────────────────────────────

function log(phase: string, msg: string) {
	console.log(`[${phase}] ${msg}`);
}

function run(cmd: string): string {
	return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}


// ── KV Config ─────────────────────────────────────────────────────────

function fetchKvConfig(channelId: string): ChannelConfig {
	const cachePath = join(CACHE_DIR, `${channelId}.json`);

	// Try KV first, fall back to local cache (for second run with delete tokens).
	let config: ChannelConfig;
	try {
		const raw = run(`npx wrangler kv key get --namespace-id=${KV_NAMESPACE_ID} --remote "users:${channelId}"`);
		config = JSON.parse(raw) as ChannelConfig;
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(cachePath, JSON.stringify(config, null, 2));
	} catch {
		if (!existsSync(cachePath)) {
			throw new Error(`KV config not found and no local cache at ${cachePath}`);
		}
		log("kv", `KV config already deleted, using local cache`);
		config = JSON.parse(readFileSync(cachePath, "utf8")) as ChannelConfig;
	}

	return config;
}

function pdsUrlFromAccount(atProtoAccount: string): string {
	// "foo.selfhosted.social" → "https://selfhosted.social"
	const parts = atProtoAccount.split(".");
	return `https://${parts.slice(1).join(".")}`;
}

// ── Bluesky Account Deletion ──────────────────────────────────────────

async function deleteBlueskyAccount(
	handle: string,
	pdsUrl: string,
	password: string,
	deleteToken: string | undefined,
): Promise<"deleted" | "deactivated" | "token-requested"> {
	const agent = new AtpAgent({ service: pdsUrl });
	try {
		await agent.login({ identifier: handle, password });
	} catch {
		log("bsky", `${handle}: login failed (already deleted?), skipping`);
		return "deleted";
	}

	if (deleteToken) {
		await agent.com.atproto.server.deleteAccount({ did: agent.session!.did, password, token: deleteToken });
		log("bsky", `${handle}: permanently deleted`);
		return "deleted";
	}

	await agent.com.atproto.server.deactivateAccount({});
	log("bsky", `${handle}: deactivated`);

	try {
		await agent.com.atproto.server.requestAccountDelete();
		log("bsky", `${handle}: deletion token sent to email`);
		return "token-requested";
	} catch {
		log("bsky", `${handle}: could not request deletion token (email not confirmed?)`);
		return "deactivated";
	}
}

// ── 1Password ─────────────────────────────────────────────────────────

function get1PasswordPassword(handle: string): string {
	return run(
		`op item get "${handle}" --vault=${BACKUP_VAULT} --fields=password --format=json --include-archive | jq -r '.value'`,
	);
}

function archive1PasswordItem(handle: string): void {
	try {
		run(`op item delete "${handle}" --archive --vault=${BACKUP_VAULT}`);
		log("1password", `${handle}: archived`);
	} catch {
		log("1password", `${handle}: not found or already archived`);
	}
}

function removeLegacyGitHubEnvironmentAccount(channelId: string): void {
	for (const name of [`ATPROTO_PASSWORD_${channelId}`, `ATPROTO_PASSWORD_${channelId}_RT`]) {
		try {
			run(`gh secret delete "${name}" --env "${DEPLOYMENT.name}"`);
			log("github", `${name}: deleted from ${DEPLOYMENT.name}`);
		} catch {
			log("github", `${name}: not found in ${DEPLOYMENT.name}`);
		}
	}
	const remaining = DEPLOYMENT.channelIds.filter((configured) => configured !== channelId);
	if (remaining.length === DEPLOYMENT.channelIds.length) {
		throw new Error(`${channelId} is not listed in ${DEPLOYMENT.name} MIRROR_CHANNEL_IDS`);
	}
	if (remaining.length === 0) {
		run(`gh variable delete MIRROR_CHANNEL_IDS --env "${DEPLOYMENT.name}"`);
		log("github", `Removed the empty ${DEPLOYMENT.name} MIRROR_CHANNEL_IDS variable`);
		return;
	}
	run(`gh variable set MIRROR_CHANNEL_IDS --env "${DEPLOYMENT.name}" --body "${remaining.join(",")}"`);
	log("github", `Removed ${channelId} from ${DEPLOYMENT.name} MIRROR_CHANNEL_IDS`);
}

// ── Cloudflare Secrets Store ──────────────────────────────────────────

function deleteSecretStoreSecret(name: string): void {
	const listing = run(
		`npx wrangler secrets-store secret list ${SECRETS_STORE_ID} --remote --per-page 50 --json 2>/dev/null || echo "[]"`,
	);

	let secrets: Array<{ name: string; id: string }>;
	try {
		secrets = JSON.parse(listing);
	} catch {
		log("secrets", `${name}: listing parse failed, trying name-based lookup`);
		try {
			const raw = run(`npx wrangler secrets-store secret list ${SECRETS_STORE_ID} --remote --per-page 50`);
			const match = raw.match(new RegExp(`│\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*│\\s*([a-f0-9]{32})\\s*│`));
			if (!match) {
				log("secrets", `${name}: not found in secrets store`);
				return;
			}
			run(`npx wrangler secrets-store secret delete ${SECRETS_STORE_ID} --secret-id ${match[1]} --remote`);
			log("secrets", `${name}: deleted from secrets store`);
			return;
		} catch (e) {
			log("secrets", `${name}: failed to delete — ${e}`);
			return;
		}
	}

	const secret = secrets.find((s) => s.name === name);
	if (!secret) {
		log("secrets", `${name}: not found in secrets store`);
		return;
	}
	run(`npx wrangler secrets-store secret delete ${SECRETS_STORE_ID} --secret-id ${secret.id} --remote`);
	log("secrets", `${name}: deleted from secrets store`);
}

// ── KV Cleanup ────────────────────────────────────────────────────────

function deleteKvKey(key: string): void {
	try {
		run(`echo "y" | npx wrangler kv key delete --namespace-id=${KV_NAMESPACE_ID} --remote "${key}"`);
		log("kv", `deleted: ${key}`);
	} catch {
		log("kv", `${key}: not found or already deleted`);
	}
}

function bulkDeleteKvKeys(prefix: string): number {
	const cfToken = process.env.CLOUDFLARE_API_TOKEN;
	if (!cfToken) throw new Error("CLOUDFLARE_API_TOKEN not set");
	const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`;

	const allKeys: string[] = [];
	let cursor: string | undefined;
	for (; ;) {
		const url = `${base}/keys?prefix=${encodeURIComponent(prefix)}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`;
		const res = JSON.parse(run(`curl -s "${url}" -H "Authorization: Bearer ${cfToken}"`));
		for (const k of res.result ?? []) allKeys.push(k.name);
		cursor = res.result_info?.cursor;
		if (!cursor || (res.result ?? []).length === 0) break;
	}

	if (allKeys.length === 0) return 0;

	for (let i = 0; i < allKeys.length; i += 10_000) {
		const batch = allKeys.slice(i, i + 10_000);
		const payload = JSON.stringify(batch);
		run(`curl -s -X DELETE "${base}/bulk" -H "Authorization: Bearer ${cfToken}" -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}'`);
	}

	return allKeys.length;
}


// ── Main ──────────────────────────────────────────────────────────────

async function main() {
	const channelId = SCRIPT_ARGS[0];
	const mainDeleteToken = SCRIPT_ARGS[1];
	const rtDeleteToken = SCRIPT_ARGS[2];
	if (!channelId) {
		console.error("Usage: npx tsx scripts/deprovision-account.ts <channelId> [mainDeleteToken] [rtDeleteToken] --environment production|ppe --confirm-account <accountId>");
		console.error("");
		console.error("Run without tokens first to deactivate accounts and request deletion tokens.");
		console.error("Then re-run with the email tokens to permanently delete.");
		process.exit(1);
	}
	if (!DEPLOYMENT.channelIds.includes(channelId)) {
		throw new Error(`${channelId} is not listed in ${DEPLOYMENT.name} MIRROR_CHANNEL_IDS`);
	}

	// Phase 0: Fetch account config from KV.
	log("main", `Deprovisioning ${DEPLOYMENT.name} mirror for ${channelId}`);
	const config = fetchKvConfig(channelId);
	const mainAccount = config.main.atProtoAccount;
	const rtAccount = config.rt.atProtoAccount;
	const mainPdsUrl = pdsUrlFromAccount(mainAccount);
	const rtPdsUrl = pdsUrlFromAccount(rtAccount);

	log("main", `Main: ${mainAccount} (password key: ${config.main.passwordKey})`);
	log("main", `RT:   ${rtAccount} (password key: ${config.rt.passwordKey})`);
	log("main", "");

	// Phase 1: Get passwords from 1Password.
	log("main", "Phase 1: Retrieving passwords from 1Password...");
	let mainPassword: string | undefined;
	let rtPassword: string | undefined;
	try { mainPassword = get1PasswordPassword(mainAccount); } catch { log("1password", `${mainAccount}: password not found`); }
	try { rtPassword = get1PasswordPassword(rtAccount); } catch { log("1password", `${rtAccount}: password not found`); }

	// Phase 2: Delete/deactivate Bluesky accounts.
	log("main", "Phase 2: Deleting Bluesky accounts...");
	let needsTokens = false;
	if (mainPassword) {
		const result = await deleteBlueskyAccount(mainAccount, mainPdsUrl, mainPassword, mainDeleteToken);
		if (result === "token-requested") needsTokens = true;
	}
	if (rtPassword) {
		const result = await deleteBlueskyAccount(rtAccount, rtPdsUrl, rtPassword, rtDeleteToken);
		if (result === "token-requested") needsTokens = true;
	}

	if (needsTokens && !mainDeleteToken) {
		log("main", "");
		log("main", "Accounts deactivated. Check email for deletion tokens, then re-run:");
		log("main", `  npx tsx scripts/deprovision-account.ts ${channelId} <mainToken> <rtToken> --environment ${DEPLOYMENT.name} --confirm-account ${DEPLOYMENT.accountId}`);
		log("main", "");
		log("main", "Continuing with infrastructure cleanup...");
	}

	// Second run (with tokens): only delete accounts, skip infrastructure cleanup.
	if (mainDeleteToken) {
		log("main", "=== Account deletion complete! ===");
		return;
	}

	// Phase 3: Archive 1Password items.
	log("main", "Phase 3: Archiving 1Password items...");
	archive1PasswordItem(mainAccount);
	archive1PasswordItem(rtAccount);

	// Remove the Store entries and any legacy GitHub copies from the pre-migration flow.
	log("main", "Phase 4: Deleting secrets store secrets...");
	deleteSecretStoreSecret(config.main.passwordKey);
	deleteSecretStoreSecret(config.rt.passwordKey);
	removeLegacyGitHubEnvironmentAccount(channelId);

	// Phase 5: Delete KV records.
	log("main", "Phase 5: Cleaning up KV...");
	deleteKvKey(`users:${channelId}`);
	deleteKvKey(`channel-meta:${channelId}`);
	const mirroredCount = bulkDeleteKvKeys(`mirrored:${channelId}:`);
	log("kv", `deleted ${mirroredCount} mirrored:${channelId}:* keys`);
	const recentCount = bulkDeleteKvKeys(`recent:${channelId}:`);
	log("kv", `deleted ${recentCount} recent:${channelId}:* keys`);
	const cursorCount = bulkDeleteKvKeys(`comment-cursor:${channelId}:`);
	log("kv", `deleted ${cursorCount} comment-cursor:${channelId}:* keys`);


	log("main", "");
	log("main", `${DEPLOYMENT.name} account deprovisioning complete.`);
}

main().catch((e) => {
	console.error("Fatal error:", e);
	process.exit(1);
});
