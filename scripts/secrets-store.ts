import { spawnSync } from "node:child_process";
import type { DeploymentEnvironment } from "./deployment-environment.js";
import type { SecretValue } from "./secret-values.js";

const PER_PAGE = 100;

type JsonObject = Record<string, unknown>;
function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireInteger(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error(`Cloudflare response has invalid ${field}`);
	}
	return value as number;
}

async function listSecretIds(environment: DeploymentEnvironment, token: string): Promise<Map<string, string>> {
	const endpoint = new URL(
		`https://api.cloudflare.com/client/v4/accounts/${environment.accountId}/secrets_store/stores/${environment.secretsStoreId}/secrets`,
	);
	const ids = new Map<string, string>();
	let expectedTotal: number | undefined;
	let totalPages: number | undefined;

	for (let page = 1; totalPages === undefined || page <= totalPages; page++) {
		endpoint.search = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) }).toString();
		const response = await fetch(endpoint, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(30_000),
		});
		const payload: unknown = await response.json();
		if (!response.ok || !isObject(payload) || payload.success !== true || !Array.isArray(payload.result) || !isObject(payload.result_info)) {
			throw new Error(`Could not list ${environment.name} Secrets Store metadata`);
		}

		const responsePage = requireInteger(payload.result_info.page, "result_info.page");
		const responsePerPage = requireInteger(payload.result_info.per_page, "result_info.per_page");
		const responseCount = requireInteger(payload.result_info.count, "result_info.count");
		const responseTotal = requireInteger(payload.result_info.total_count, "result_info.total_count");
		const responsePages = Math.max(1, Math.ceil(responseTotal / PER_PAGE));
		if (
			responsePage !== page ||
			responsePerPage !== PER_PAGE ||
			responseCount !== payload.result.length ||
			responseCount > responsePerPage
		) {
			throw new Error("Secrets Store returned inconsistent pagination data");
		}
		if (expectedTotal === undefined) {
			expectedTotal = responseTotal;
			totalPages = responsePages;
		} else if (expectedTotal !== responseTotal || totalPages !== responsePages) {
			throw new Error("Secrets Store pagination changed during synchronization");
		}

		for (const item of payload.result) {
			if (
				!isObject(item) ||
				typeof item.name !== "string" ||
				typeof item.id !== "string" ||
				item.store_id !== environment.secretsStoreId
			) {
				throw new Error("Secrets Store returned invalid secret metadata");
			}
			if (ids.has(item.name)) throw new Error(`Secrets Store returned duplicate metadata for ${item.name}`);
			ids.set(item.name, item.id);
		}
	}

	if (expectedTotal === undefined || ids.size !== expectedTotal) {
		throw new Error("Secrets Store did not return its full inventory");
	}
	return ids;
}

function runWrangler(
	environment: DeploymentEnvironment,
	token: string,
	args: readonly string[],
	input: string,
): void {
	const result = spawnSync("npx", ["wrangler", ...args], {
		input,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 60_000,
		killSignal: "SIGTERM",
		env: {
			...process.env,
			CLOUDFLARE_ACCOUNT_ID: environment.accountId,
			CLOUDFLARE_API_TOKEN: token,
		},
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`Wrangler Secrets Store command failed (exit ${result.status ?? "unknown"})`,
		);
	}

}

export async function synchronizeSecretStoreEntries(
	environment: DeploymentEnvironment,
	token: string,
	values: readonly SecretValue[],
): Promise<void> {
	const names = new Set<string>();
	for (const secret of values) {
		if (
			secret.environment !== undefined &&
			secret.environment !== environment.name
		) {
			throw new Error(`Secrets Store entry ${secret.name} targets a different environment`);
		}
		if (!secret.name || !secret.value) throw new Error("Secrets Store entries require non-empty names and values");
		if (!names.add(secret.name)) throw new Error(`Duplicate Secrets Store entry ${secret.name}`);
	}
	if (values.length === 0) return;

	const existing = await listSecretIds(environment, token);
	for (const secret of values) {
		const secretId = existing.get(secret.name);
		const args = secretId
			? [
				"secrets-store",
				"secret",
				"update",
				environment.secretsStoreId,
				"--secret-id",
				secretId,
				"--scopes",
				"workers",
				"--remote",
			]
			: [
				"secrets-store",
				"secret",
				"create",
				environment.secretsStoreId,
				"--name",
				secret.name,
				"--scopes",
				"workers",
				"--remote",
			];
		runWrangler(environment, token, args, secret.value);
		console.log(`Synchronized ${secret.name} in ${environment.name}`);
	}
}
