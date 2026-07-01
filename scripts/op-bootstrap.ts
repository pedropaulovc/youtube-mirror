import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 1Password environment holding CLOUDFLARE_API_TOKEN / FIRECRAWL_API_TOKEN for
// the youtube-mirror provisioning scripts. Re-execs the calling script under
// `op run` if any required var is missing.
const OP_ENVIRONMENT = "bykx5xzmykwxw3of4gtncs7i7i";

/**
 * Load the repo-local `.env.local` (holds `OP_SERVICE_ACCOUNT_TOKEN`) into
 * process.env so every `op` invocation authenticates as the service account that
 * can actually read `OP_ENVIRONMENT`. A stray/ambient `OP_SERVICE_ACCOUNT_TOKEN`
 * from the shell points at a different account and makes every `op` call fail with
 * "An unexpected error occurred while processing the request", so the repo-local
 * value must WIN. When `.env.local` is absent (e.g. CI injecting the token as a
 * secret), the ambient environment is used unchanged.
 */
function loadLocalEnv(): void {
	const path = fileURLToPath(new URL("../.env.local", import.meta.url));
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m) continue; // skips blanks and `# comment` lines
		let value = m[2];
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		process.env[m[1]] = value;
	}
}

export function ensureOpEnv(requiredVars: string[]): void {
	loadLocalEnv();
	const missing = requiredVars.filter((v) => !process.env[v]);
	if (missing.length === 0) return;

	if (process.env.OP_BOOTSTRAPPED === "1") {
		throw new Error(
			`Missing env vars after op run: ${missing.join(", ")} (check 1Password environment ${OP_ENVIRONMENT})`,
		);
	}

	const scriptPath = process.argv[1];
	const scriptArgs = process.argv.slice(2);
	// OP_SERVICE_ACCOUNT_TOKEN loaded above is inherited by the `op run` child (and by
	// the re-exec'd script's own direct `op item` calls, which run under it).
	const result = spawnSync(
		"op",
		["run", "--environment", OP_ENVIRONMENT, "--", "npx", "tsx", scriptPath, ...scriptArgs],
		{ stdio: "inherit", env: { ...process.env, OP_BOOTSTRAPPED: "1" } },
	);
	process.exit(result.status ?? 1);
}
