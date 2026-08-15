import { ensureOpEnv } from "./op-bootstrap.js";
import { environmentFromArgs, parseDeploymentEnvironment } from "./deployment-environment.js";

const rawArgs = process.argv.slice(2);
const selected = environmentFromArgs(rawArgs);
const args = [...rawArgs];
args.splice(args.indexOf("--environment"), 2);
process.env.DEPLOY_ENVIRONMENT = selected;
ensureOpEnv(["CLOUDFLARE_API_TOKEN"]);
const environment = parseDeploymentEnvironment(process.env, selected);
const [channelId, kind, itemId] = args.filter((argument) => !argument.startsWith("--"));
const token = process.env.CLOUDFLARE_API_TOKEN;

if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!channelId || !kind || !itemId || (kind !== "video" && kind !== "community")) {
	throw new Error(
		"Usage: npx tsx scripts/mirror-item.ts <channelId> <video|community> <itemId> --environment production|ppe",
	);
}
if (!environment.channelIds.includes(channelId)) {
	throw new Error(`${channelId} is not listed in the ${environment.name} MIRROR_CHANNEL_IDS variable`);
}

const response = await fetch(
	`https://api.cloudflare.com/client/v4/accounts/${environment.accountId}/workflows/youtube-mirror-item/instances`,
	{
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ params: { channelId, kind, itemId } }),
		signal: AbortSignal.timeout(30_000),
	},
);
const body: unknown = await response.json();
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exitCode = 1;
