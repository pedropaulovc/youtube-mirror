import { setTimeout as delay } from "node:timers/promises";
import {
	environmentFromArgs,
	parseDeploymentEnvironment,
	REQUIRED_SECRET_NAMES,
	type DeploymentEnvironment,
	type PublicRsaJwk,
} from "./deployment-environment.js";

const PER_PAGE = 100;
const DEADLINE_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireToken(): string {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error("Required environment variable CLOUDFLARE_API_TOKEN is not set");
	return token;
}

async function requestJson(url: URL | string, init: RequestInit, deadline: number): Promise<JsonObject> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("Environment verification exceeded its shared deadline");
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(remaining) });
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error(`Verification request returned non-JSON HTTP ${response.status}`);
	}
	if (!response.ok || !isObject(payload) || payload.success !== true) {
		throw new Error(`Verification request failed with HTTP ${response.status}`);
	}
	return payload;
}

async function verifyCloudflareResources(
	environment: DeploymentEnvironment,
	token: string,
	deadline: number,
): Promise<void> {
	const base = `https://api.cloudflare.com/client/v4/accounts/${environment.accountId}`;
	const headers = { Authorization: `Bearer ${token}` };
	await Promise.all([
		requestJson(`${base}/storage/kv/namespaces/${environment.kvNamespaceId}`, { headers }, deadline),
		requestJson(`${base}/secrets_store/stores/${environment.secretsStoreId}`, { headers }, deadline),
	]);
	console.log(`Verified ${environment.name} KV and Secrets Store belong to account ${environment.accountId}`);
}

function requireInteger(value: unknown, field: string): number {
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw new Error(`Cloudflare response has invalid ${field}`);
	}
	return value as number;
}

async function listSecrets(
	environment: DeploymentEnvironment,
	token: string,
	deadline: number,
): Promise<Map<string, string>> {
	const endpoint = new URL(
		`https://api.cloudflare.com/client/v4/accounts/${environment.accountId}/secrets_store/stores/${environment.secretsStoreId}/secrets`,
	);
	const secrets = new Map<string, string>();
	let expectedTotal: number | undefined;
	let totalPages: number | undefined;

	for (let page = 1; totalPages === undefined || page <= totalPages; page++) {
		endpoint.search = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) }).toString();
		const payload = await requestJson(
			endpoint,
			{ headers: { Authorization: `Bearer ${token}` } },
			deadline,
		);
		if (!Array.isArray(payload.result) || !isObject(payload.result_info)) {
			throw new Error("Secrets Store response is missing pagination data");
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
			throw new Error("Secrets Store pagination changed during verification");
		}

		for (const item of payload.result) {
			if (
				!isObject(item) ||
				typeof item.name !== "string" ||
				typeof item.status !== "string" ||
				item.store_id !== environment.secretsStoreId
			) {
				throw new Error("Secrets Store returned invalid secret metadata");
			}
			if (secrets.has(item.name)) throw new Error(`Secrets Store returned duplicate metadata for ${item.name}`);
			secrets.set(item.name, item.status);
		}
	}
	if (expectedTotal === undefined || secrets.size !== expectedTotal) {
		throw new Error("Secrets Store did not return its full inventory");
	}
	return secrets;
}

async function verifyActiveSecrets(
	environment: DeploymentEnvironment,
	token: string,
	deadline: number,
): Promise<void> {
	const expected = REQUIRED_SECRET_NAMES(environment.channelIds);
	let missing = expected.length;
	let inactive = 0;

	while (Date.now() < deadline) {
		const stored = await listSecrets(environment, token, deadline);
		missing = 0;
		inactive = 0;
		for (const name of expected) {
			const status = stored.get(name);
			if (status === undefined) missing++;
			else if (status !== "active") inactive++;
		}
		if (missing === 0 && inactive === 0) {
			console.log(`Verified ${expected.length} ${environment.name} Secrets Store entries are active`);
			return;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await delay(Math.min(POLL_INTERVAL_MS, remaining));
	}
	throw new Error(`Secrets Store activation timed out: ${missing} missing, ${inactive} not active`);
}

function publicJwkMatches(actual: unknown, expected: PublicRsaJwk): boolean {
	if (!isObject(actual)) return false;
	return (
		actual.kty === expected.kty &&
		actual.kid === expected.kid &&
		actual.n === expected.n &&
		actual.e === expected.e &&
		actual.alg === expected.alg &&
		actual.use === expected.use
	);
}

async function verifyIssuer(environment: DeploymentEnvironment, deadline: number): Promise<void> {
	const discoveryResponse = await fetch(`${environment.issuerUrl}/.well-known/openid-configuration`, {
		signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
	});
	const discovery: unknown = await discoveryResponse.json();
	if (
		!discoveryResponse.ok ||
		!isObject(discovery) ||
		discovery.issuer !== environment.issuerUrl ||
		discovery.jwks_uri !== `${environment.issuerUrl}/.well-known/jwks.json`
	) {
		throw new Error("OIDC discovery does not match the selected environment origin");
	}
	const jwksResponse = await fetch(discovery.jwks_uri, {
		signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
	});
	const jwks: unknown = await jwksResponse.json();
	if (
		!jwksResponse.ok ||
		!isObject(jwks) ||
		!Array.isArray(jwks.keys) ||
		jwks.keys.length !== 1 ||
		!publicJwkMatches(jwks.keys[0], environment.oidcPublicJwk)
	) {
		throw new Error("OIDC JWKS does not contain exactly the selected environment key");
	}
	console.log(`Verified ${environment.name} OIDC discovery and JWKS`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const expected = environmentFromArgs(args);
	const environment = parseDeploymentEnvironment(process.env, expected);
	const deadline = Date.now() + DEADLINE_MS;
	const token = requireToken();
	await verifyCloudflareResources(environment, token, deadline);
	if (args.includes("--active-secrets")) await verifyActiveSecrets(environment, token, deadline);
	if (args.includes("--issuer")) await verifyIssuer(environment, deadline);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Environment verification failed");
	process.exitCode = 1;
});
