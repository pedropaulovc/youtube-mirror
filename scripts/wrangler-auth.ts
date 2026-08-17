import { spawnSync } from "node:child_process";

export const WRANGLER_AUTH_PROFILE = "youtube-mirror-source";
export const WRANGLER_AUTH_USERNAME = "pedro@vza.net";
export const CLOUDFLARE_ACCOUNT_NAME = "sessions-prod";
export const CLOUDFLARE_ACCOUNT_ID = "18ef3246e9f36d1560485ef53889c0ab";
export const CLOUDFLARE_WORKERS_DEV_SUBDOMAIN = "pedro-18e";
export const WRANGLER_AUTH_SCOPES = [
	"account:read",
	"user:read",
	"workers:write",
	"workers_kv:write",
	"workers_routes:write",
	"workers_scripts:write",
	"workers_tail:read",
	"secrets_store:write",
] as const;

function loginCommand(): string {
	return [
		"npx wrangler auth create",
		WRANGLER_AUTH_PROFILE,
		"--browser",
		"--scopes",
		...WRANGLER_AUTH_SCOPES,
	].join(" ");
}

function printInstructions(): void {
	console.log("Cloudflare source OAuth login");
	console.log(`Email: ${WRANGLER_AUTH_USERNAME}`);
	console.log(`Account: ${CLOUDFLARE_ACCOUNT_NAME} (${CLOUDFLARE_ACCOUNT_ID})`);
	console.log(`workers.dev subdomain: ${CLOUDFLARE_WORKERS_DEV_SUBDOMAIN}`);
	console.log("");
	console.log("When Cloudflare asks which account to authorize, select the account above.");
	console.log("");
	console.log("Login command:");
	console.log(`  ${loginCommand()}`);
	console.log("");
	console.log("The Wrangler OAuth scope list has no separate Workers Observability scope.");
	console.log("Source observability-destination cleanup still requires an API token with Workers Observability Write.");
}

function runLogin(): void {
	printInstructions();
	const result = spawnSync(
		"npx",
		[
			"wrangler",
			"auth",
			"create",
			WRANGLER_AUTH_PROFILE,
			"--browser",
			"--scopes",
			...WRANGLER_AUTH_SCOPES,
		],
		{ stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Wrangler OAuth login exited with status ${result.status ?? "unknown"}`);
	}
}

function printUsage(): void {
	console.log("Usage: npx tsx scripts/wrangler-auth.ts [--login]");
	console.log("");
	printInstructions();
}

try {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		printUsage();
	} else if (args.length === 1 && args[0] === "--login") {
		runLogin();
	} else {
		printUsage();
		process.exitCode = 1;
	}
} catch (error: unknown) {
	console.error(error instanceof Error ? error.message : "Wrangler OAuth login failed");
	process.exitCode = 1;
}
