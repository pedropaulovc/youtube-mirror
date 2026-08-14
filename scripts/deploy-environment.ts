import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { environmentFromArgs, parseDeploymentEnvironment } from "./deployment-environment.js";

function run(command: string, args: readonly string[], input?: string): void {
	const result = spawnSync(command, args, {
		input,
		encoding: "utf8",
		stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}`);
	}
}

function tsx(script: string, environment: "production" | "ppe", ...args: string[]): void {
	run("npx", ["tsx", script, "--environment", environment, ...args]);
}

function deploy(config: string): void {
	run("npx", ["wrangler", "deploy", "--config", config]);
}

function requireSecret(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Required environment secret ${name} is not set`);
	return value;
}

function main(): void {
	const selected = environmentFromArgs(process.argv.slice(2));
	const environment = parseDeploymentEnvironment(process.env, selected);
	const configDirectory = join(".wrangler", "deploy", selected);
	const config = (name: string) => join(configDirectory, `wrangler.mirror-${name}.jsonc`);

	// Verify selectors before the first write, then render configs from the same
	// validated environment contract used by every following command.
	tsx("scripts/verify-environment.ts", selected);
	tsx("scripts/render-deploy-configs.ts", selected);
	tsx("scripts/sync-environment-secrets.ts", selected);
	tsx("scripts/verify-environment.ts", selected, "--active-secrets");

	deploy(config("oidc-issuer"));
	tsx("scripts/verify-environment.ts", selected, "--issuer");

	const ingestBearer = requireSecret("GATEWAY_INGEST_BEARER");
	run(
		"npx",
		["wrangler", "secret", "bulk", "--config", config("telemetry-gateway")],
		JSON.stringify({ INGEST_BEARER: ingestBearer }),
	);
	deploy(config("telemetry-gateway"));
	tsx("scripts/configure-observability.ts", selected);

	// Cross-script Workflow bindings make this order part of the deployment
	// contract. Channel is last because its minute schedule activates polling.
	deploy(config("item"));
	deploy(config("delete"));
	deploy(config("profile"));
	deploy(config("channel"));

	console.log(
		`Deployed ${environment.name} to ${environment.accountId} with schedules ${environment.enableSchedules ? "enabled" : "disabled"}`,
	);
}

try {
	main();
} catch (error: unknown) {
	console.error(error instanceof Error ? error.message : "Deployment failed");
	process.exitCode = 1;
}
