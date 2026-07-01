/**
 * Seed a channel config into the production KV namespace.
 *
 * Usage:
 *   npx tsx scripts/seed-channel.ts <channelId> <handle> <mainAtprotoAccount> <rtAtprotoAccount> [--env <name>] [--commit]
 *
 * Without --commit this prints the JSON and the `wrangler kv key put` command it
 * WOULD run (dry preview). With --commit it actually invokes wrangler — you must
 * have valid Cloudflare credentials (CLOUDFLARE_API_TOKEN / wrangler login).
 */
import { execSync } from "node:child_process";
import process from "node:process";
import { ensureOpEnv } from "./op-bootstrap.js";

// Minimal inline copy of worker/types.ts (kept standalone — no worker/ import).
interface BlueskyAccountConfig {
	passwordKey: string;
	atProtoAccount: string;
	email: string;
}
interface ChannelConfig {
	main: BlueskyAccountConfig;
	rt: BlueskyAccountConfig;
	handle: string;
	maxItems?: number;
	pollIntervalMinutes?: number;
	mirrorComments?: boolean;
	mirrorCommunity?: boolean;
}

const args = process.argv.slice(2);
const commit = args.includes("--commit");
// Only the --commit path calls wrangler against production; self-source the CF token
// from the 1Password environment then (re-execs under `op run` if it isn't set). The
// dry preview needs no credentials.
if (commit) ensureOpEnv(["CLOUDFLARE_API_TOKEN"]);
const envIdx = args.indexOf("--env");
if (envIdx !== -1) args.splice(envIdx, 2); // --env <name> (unused for now)
const positional = args.filter((a) => !a.startsWith("--"));
const [channelId, handle, mainAtProtoAccount, rtAtProtoAccount] = positional;

if (!channelId || !handle || !mainAtProtoAccount || !rtAtProtoAccount) {
	console.error(
		"Usage: npx tsx scripts/seed-channel.ts <channelId> <handle> <mainAtprotoAccount> <rtAtprotoAccount> [--env <name>] [--commit]",
	);
	process.exit(1);
}

const config: ChannelConfig = {
	main: {
		passwordKey: `youtube-mirror-atproto-password-${channelId}`,
		atProtoAccount: mainAtProtoAccount,
		email: `${handle}@example.com`,
	},
	rt: {
		passwordKey: `youtube-mirror-atproto-password-${channelId}-rt`,
		atProtoAccount: rtAtProtoAccount,
		email: `${handle}-rt@example.com`,
	},
	handle,
	mirrorComments: true,
	mirrorCommunity: true,
};

const json = JSON.stringify(config);
const cmd = `wrangler kv key put "users:${channelId}" '${json}' --binding KV --remote --config wrangler.mirror-channel.jsonc`;

console.log("ChannelConfig:\n" + JSON.stringify(config, null, 2));
console.log("\nCommand:\n" + cmd);

if (commit) {
	console.log("\nRunning (requires real Cloudflare credentials)...");
	execSync(cmd, { stdio: "inherit" });
} else {
	console.log("\n(dry preview — re-run with --commit and real credentials to apply)");
}
