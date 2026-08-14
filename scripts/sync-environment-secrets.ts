import { spawnSync } from "node:child_process";
import {
	environmentFromArgs,
	parseDeploymentEnvironment,
	type DeploymentEnvironment,
} from "./deployment-environment.js";

type JsonObject = Record<string, unknown>;

interface SecretValue {
	name: string;
	value: string;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSecret(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Required environment secret ${name} is not set`);
	return value;
}

function secretValues(environment: DeploymentEnvironment): SecretValue[] {
	const values: SecretValue[] = [
		{ name: "youtube-mirror-oidc-signing-key", value: requireSecret("OIDC_SIGNING_KEY") },
		{ name: "youtube-mirror-firecrawl-api-token", value: requireSecret("FIRECRAWL_API_TOKEN") },
	];
	for (const channelId of environment.channelIds) {
		values.push(
			{
				name: `youtube-mirror-atproto-password-${channelId}`,
				value: requireSecret(`ATPROTO_PASSWORD_${channelId}`),
			},
			{
				name: `youtube-mirror-atproto-password-${channelId}-rt`,
				value: requireSecret(`ATPROTO_PASSWORD_${channelId}_RT`),
			},
		);
	}
	return values;
}

async function listSecretIds(environment: DeploymentEnvironment, token: string): Promise<Map<string, string>> {
	const endpoint = new URL(
		`https://api.cloudflare.com/client/v4/accounts/${environment.accountId}/secrets_store/stores/${environment.secretsStoreId}/secrets`,
	);
	const ids = new Map<string, string>();
	let page = 1;
	let totalPages = 1;
	do {
		endpoint.search = new URLSearchParams({ page: String(page), per_page: "100" }).toString();
		const response = await fetch(endpoint, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(30_000),
		});
		const payload: unknown = await response.json();
		if (!response.ok || !isObject(payload) || payload.success !== true || !Array.isArray(payload.result)) {
			throw new Error(`Could not list ${environment.name} Secrets Store metadata`);
		}
		for (const item of payload.result) {
			if (!isObject(item) || typeof item.name !== "string" || typeof item.id !== "string") {
				throw new Error("Secrets Store returned invalid secret metadata");
			}
			if (ids.has(item.name)) throw new Error(`Secrets Store returned duplicate metadata for ${item.name}`);
			ids.set(item.name, item.id);
		}
		if (isObject(payload.result_info) && Number.isInteger(payload.result_info.total_count)) {
			totalPages = Math.max(1, Math.ceil((payload.result_info.total_count as number) / 100));
		}
		page++;
	} while (page <= totalPages);
	return ids;
}

function runWrangler(args: readonly string[], input: string): void {
	const result = spawnSync("npx", ["wrangler", ...args], {
		input,
		encoding: "utf8",
		stdio: ["pipe", "inherit", "inherit"],
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Wrangler exited with status ${result.status ?? "unknown"}`);
}

async function main(): Promise<void> {
	const expected = environmentFromArgs(process.argv.slice(2));
	const environment = parseDeploymentEnvironment(process.env, expected);
	const token = requireSecret("CLOUDFLARE_API_TOKEN");
	const existing = await listSecretIds(environment, token);
	for (const secret of secretValues(environment)) {
		const id = existing.get(secret.name);
		if (id) {
			runWrangler(
				[
					"secrets-store",
					"secret",
					"update",
					environment.secretsStoreId,
					"--secret-id",
					id,
					"--scopes",
					"workers",
					"--remote",
				],
				secret.value,
			);
		} else {
			runWrangler(
				[
					"secrets-store",
					"secret",
					"create",
					environment.secretsStoreId,
					"--name",
					secret.name,
					"--scopes",
					"workers",
					"--remote",
				],
				secret.value,
			);
		}
		console.log(`Synchronized ${secret.name} in ${environment.name}`);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Could not synchronize Secrets Store entries");
	process.exitCode = 1;
});
