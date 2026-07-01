import { spawnSync } from "node:child_process";

// 1Password environment holding CLOUDFLARE_API_TOKEN / FIRECRAWL_API_TOKEN for
// the youtube-mirror provisioning scripts. Re-execs the calling script under
// `op run` if any required var is missing.
const OP_ENVIRONMENT = "bykx5xzmykwxw3of4gtncs7i7i";

export function ensureOpEnv(requiredVars: string[]): void {
	const missing = requiredVars.filter((v) => !process.env[v]);
	if (missing.length === 0) return;

	if (process.env.OP_BOOTSTRAPPED === "1") {
		throw new Error(
			`Missing env vars after op run: ${missing.join(", ")} (check 1Password environment ${OP_ENVIRONMENT})`,
		);
	}

	const scriptPath = process.argv[1];
	const scriptArgs = process.argv.slice(2);
	const result = spawnSync(
		"op",
		["run", "--environment", OP_ENVIRONMENT, "--", "npx", "tsx", scriptPath, ...scriptArgs],
		{ stdio: "inherit", env: { ...process.env, OP_BOOTSTRAPPED: "1" } },
	);
	process.exit(result.status ?? 1);
}
