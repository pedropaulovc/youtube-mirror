import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AtpAgent } from "@atproto/api";
import type { ChannelConfig } from "../worker/types.js";
import { ensureOpEnv } from "./op-bootstrap.js";

ensureOpEnv(["CLOUDFLARE_API_TOKEN"]);

const CACHE_DIR = join(import.meta.dirname, ".deprovision-cache");

// ── Constants ──────────────────────────────────────────────────────────
const SECRETS_STORE_ID = "f0c7662b60484d17a094e384a3853ab9";
const KV_NAMESPACE_ID = "4678dd1b9ac742439e0a0b029b1e9d03";
const ACCOUNT_ID = "18ef3246e9f36d1560485ef53889c0ab";
const OP_ENVIRONMENT = "bykx5xzmykwxw3of4gtncs7i7i";
const BACKUP_VAULT = "twitter-mirror-backup";
const WRANGLER_CONFIGS = [
	"wrangler.mirror-channel.jsonc",
	"wrangler.mirror-item.jsonc",
	"wrangler.mirror-delete.jsonc",
	"wrangler.mirror-profile.jsonc",
];

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
	for (;;) {
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

// ── Wrangler Config Cleanup ───────────────────────────────────────────

function removeWranglerBindings(channelId: string): void {
	const mainBinding = `youtube-mirror-atproto-password-${channelId}`;
	const rtBinding = `youtube-mirror-atproto-password-${channelId}-rt`;

	for (const configPath of WRANGLER_CONFIGS) {
		const content = readFileSync(configPath, "utf8");

		if (!content.includes(mainBinding)) {
			log("wrangler", `${configPath}: no bindings found, skipping`);
			continue;
		}

		// Remove the two binding objects (main + rt) — leading-comma form first.
		const bindingPattern = new RegExp(
			`,\\s*\\{\\s*"binding":\\s*"${mainBinding}"[^}]*\\}\\s*,\\s*\\{\\s*"binding":\\s*"${rtBinding}"[^}]*\\}`,
			"s",
		);
		let updated = content.replace(bindingPattern, "");

		// Fallback: these were the first entries (trailing comma form).
		if (updated === content) {
			const altPattern = new RegExp(
				`\\{\\s*"binding":\\s*"${mainBinding}"[^}]*\\}\\s*,\\s*\\{\\s*"binding":\\s*"${rtBinding}"[^}]*\\}\\s*,`,
				"s",
			);
			updated = content.replace(altPattern, "");
		}

		if (updated === content) {
			log("wrangler", `WARNING: regex did not match in ${configPath}`);
			continue;
		}

		writeFileSync(configPath, updated);
		log("wrangler", `${configPath}: bindings removed`);
	}
}

function removeTypeDeclarations(channelId: string): void {
	const typesPath = "worker-configuration.d.ts";
	const content = readFileSync(typesPath, "utf8");
	const mainBinding = `youtube-mirror-atproto-password-${channelId}`;

	if (!content.includes(mainBinding)) {
		log("types", "No type declarations found, skipping");
		return;
	}

	const pattern = new RegExp(
		`\\s*"${mainBinding}":\\s*SecretsStoreSecret;\\s*"${mainBinding}-rt":\\s*SecretsStoreSecret;`,
	);
	const updated = content.replace(pattern, "");

	if (updated === content) {
		log("types", "WARNING: regex did not match in worker-configuration.d.ts");
		return;
	}

	writeFileSync(typesPath, updated);
	log("types", "worker-configuration.d.ts: declarations removed");
}

// ── Deploy ────────────────────────────────────────────────────────────

function deployViaGit(channelId: string): void {
	log("deploy", "Committing and pushing...");
	runPassthrough("git add wrangler.mirror-*.jsonc worker-configuration.d.ts");
	try {
		run("git diff --cached --quiet");
		log("deploy", "No changes to commit, skipping");
		return;
	} catch {
		// has staged changes, proceed
	}
	runPassthrough(`git commit -m "Remove ${channelId} mirror account bindings"`);
	runPassthrough("git push");
	log("deploy", "Pushed to remote. Cloudflare CI/CD will deploy.");
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
	const channelId = process.argv[2];
	const mainDeleteToken = process.argv[3];
	const rtDeleteToken = process.argv[4];
	if (!channelId) {
		console.error("Usage: npx tsx scripts/deprovision-account.ts <channelId> [mainDeleteToken] [rtDeleteToken]");
		console.error("");
		console.error("Run without tokens first to deactivate accounts and request deletion tokens.");
		console.error("Then re-run with the email tokens to permanently delete.");
		process.exit(1);
	}

	// Phase 0: Fetch account config from KV.
	log("main", `Deprovisioning mirror for ${channelId}`);
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
		log("main", `  op run --environment ${OP_ENVIRONMENT} -- npx tsx scripts/deprovision-account.ts ${channelId} <mainToken> <rtToken>`);
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

	// Phase 4: Delete Cloudflare Secrets Store secrets.
	log("main", "Phase 4: Deleting secrets store secrets...");
	deleteSecretStoreSecret(config.main.passwordKey);
	deleteSecretStoreSecret(config.rt.passwordKey);

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

	// Phase 6: Remove wrangler bindings and type declarations.
	log("main", "Phase 6: Removing wrangler bindings...");
	removeWranglerBindings(channelId);
	removeTypeDeclarations(channelId);

	// Phase 7: Commit and push.
	log("main", "Phase 7: Deploying...");
	deployViaGit(channelId);

	log("main", "");
	log("main", "=== Deprovisioning complete! ===");
}

main().catch((e) => {
	console.error("Fatal error:", e);
	process.exit(1);
});
