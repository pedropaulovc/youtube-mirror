import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { ensureOpEnv } from "./op-bootstrap.js";
import { environmentFromArgs, parseDeploymentEnvironment } from "./deployment-environment.js";

interface BlueskyAccountConfig {
	passwordKey: string;
	atProtoAccount: string;
	email: string;
}

interface ChannelConfig {
	main: BlueskyAccountConfig;
	rt: BlueskyAccountConfig;
	handle: string;
	uploadsPlaylistId: string;
	mirrorComments: boolean;
	mirrorCommunity: boolean;
}

const rawArgs = process.argv.slice(2);
const selected = environmentFromArgs(rawArgs);
const args = [...rawArgs];
args.splice(args.indexOf("--environment"), 2);
const commit = args.includes("--commit");
const positional = args.filter((argument) => !argument.startsWith("--"));
process.env.DEPLOY_ENVIRONMENT = selected;
if (commit) ensureOpEnv(["CLOUDFLARE_API_TOKEN"]);
const environment = parseDeploymentEnvironment(process.env, selected);
const [channelId, handle, mainAtProtoAccount, rtAtProtoAccount, mainEmail, rtEmail] = positional;

if (!channelId || !handle || !mainAtProtoAccount || !rtAtProtoAccount || !mainEmail || !rtEmail) {
	console.error(
		"Usage: npx tsx scripts/seed-channel.ts <channelId> <handle> <mainAtprotoAccount> <rtAtprotoAccount> <mainEmail> <rtEmail> --environment production|ppe [--commit]",
	);
	process.exit(1);
}
if (!environment.channelIds.includes(channelId)) {
	throw new Error(`${channelId} is not listed in the ${environment.name} MIRROR_CHANNEL_IDS variable`);
}
if (
	environment.name === "ppe" &&
	(!mainAtProtoAccount.includes("-ppe-") || !rtAtProtoAccount.includes("-ppe-"))
) {
	throw new Error("PPE Bluesky account handles must contain -ppe-; production accounts cannot be seeded into PPE");
}

const config: ChannelConfig = {
	main: {
		passwordKey: `youtube-mirror-atproto-password-${channelId}`,
		atProtoAccount: mainAtProtoAccount,
		email: mainEmail,
	},
	rt: {
		passwordKey: `youtube-mirror-atproto-password-${channelId}-rt`,
		atProtoAccount: rtAtProtoAccount,
		email: rtEmail,
	},
	handle: handle.replace(/^@/, ""),
	uploadsPlaylistId: channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : channelId,
	mirrorComments: true,
	mirrorCommunity: true,
};

console.log(`${environment.name} ChannelConfig:\n${JSON.stringify(config, null, 2)}`);
console.log(`\nTarget account: ${environment.accountId}`);
console.log(`Target KV namespace: ${environment.kvNamespaceId}`);

if (!commit) {
	console.log("\nDry preview only. Re-run with --commit after the selected environment's bindings verify.");
} else {
	const verification = execFileSync(
		"npx",
		["tsx", "scripts/verify-environment.ts", "--environment", environment.name, "--active-secrets", "--bindings"],
		{ stdio: "inherit", env: process.env },
	);
	void verification;
	const temporaryPath = `scripts/.tmp-kv-${environment.name}-${channelId}.json`;
	writeFileSync(temporaryPath, JSON.stringify(config));
	try {
		execFileSync(
			"npx",
			[
				"wrangler",
				"kv",
				"key",
				"put",
				"--namespace-id",
				environment.kvNamespaceId,
				`users:${channelId}`,
				"--path",
				temporaryPath,
				"--remote",
			],
			{ stdio: "inherit", env: process.env },
		);
	} finally {
		unlinkSync(temporaryPath);
	}
}
