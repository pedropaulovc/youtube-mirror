export type DeploymentEnvironmentName = "production" | "ppe";

export interface PublicRsaJwk {
	kty: "RSA";
	kid: string;
	n: string;
	e: string;
	alg: "RS256";
	use: "sig";
}

export interface DeploymentEnvironment {
	name: DeploymentEnvironmentName;
	accountId: string;
	kvNamespaceId: string;
	secretsStoreId: string;
	workersDevSubdomain: string;
	issuerUrl: string;
	telemetryGatewayOrigin: string;
	oidcSigningKid: string;
	oidcPublicJwk: PublicRsaJwk;
	gcpWorkloadProvider: string;
	gcpServiceAccount: string;
	azureTenantId: string;
	azureAppClientId: string;
	otlpTracesEndpoint: string;
	otlpMetricsEndpoint: string;
	otlpLogsEndpoint: string;
	channelIds: readonly string[];
	enableSchedules: boolean;
}

export const DEPLOYMENT_ACCOUNTS = {
	production: "c6f17a1f1124bf50cba0f5e495aef9ba",
	ppe: "b846acaf5be2e542781751bd94a63153",
} as const satisfies Record<DeploymentEnvironmentName, string>;

const HEX_ID = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KID = /^[A-Za-z0-9_-]{8,128}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const WORKERS_DEV_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const REQUIRED_SECRET_NAMES = (channelIds: readonly string[]): readonly string[] => [
	"youtube-mirror-oidc-signing-key",
	"youtube-mirror-firecrawl-api-token",
	...channelIds.flatMap((channelId) => [
		`youtube-mirror-atproto-password-${channelId}`,
		`youtube-mirror-atproto-password-${channelId}-rt`,
	]),
];

function requireValue(source: NodeJS.ProcessEnv, name: string): string {
	const value = source[name]?.trim();
	if (!value) throw new Error(`Required environment variable ${name} is not set`);
	return value;
}

function requireHexId(source: NodeJS.ProcessEnv, name: string): string {
	const value = requireValue(source, name);
	if (!HEX_ID.test(value)) throw new Error(`${name} must be a 32-character lowercase hexadecimal Cloudflare ID`);
	return value;
}

function requireUuid(source: NodeJS.ProcessEnv, name: string): string {
	const value = requireValue(source, name);
	if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
	return value;
}

function requireOrigin(
	source: NodeJS.ProcessEnv,
	name: string,
	workerName: string,
	workersDevSubdomain: string,
): string {
	const value = requireValue(source, name);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an absolute HTTPS origin`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
		throw new Error(`${name} must be an HTTPS origin without credentials, a port, path, query, or fragment`);
	}
	if (url.hostname !== `${workerName}.${workersDevSubdomain}.workers.dev`) {
		throw new Error(`${name} does not match WORKERS_DEV_SUBDOMAIN`);
	}
	return url.origin;
}

function requireHttpsUrl(source: NodeJS.ProcessEnv, name: string): string {
	const value = requireValue(source, name);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an absolute HTTPS URL`);
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error(`${name} must be an HTTPS URL without credentials`);
	}
	return url.toString();
}

function parsePublicJwk(source: NodeJS.ProcessEnv, kid: string): PublicRsaJwk {
	let value: unknown;
	try {
		value = JSON.parse(requireValue(source, "OIDC_PUBLIC_JWK"));
	} catch {
		throw new Error("OIDC_PUBLIC_JWK must be valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("OIDC_PUBLIC_JWK must be a JSON object");
	}
	const jwk = value as Record<string, unknown>;
	if (
		jwk.kty !== "RSA" ||
		jwk.kid !== kid ||
		jwk.alg !== "RS256" ||
		jwk.use !== "sig" ||
		typeof jwk.n !== "string" ||
		jwk.n.length < 256 ||
		typeof jwk.e !== "string" ||
		jwk.e.length === 0
	) {
		throw new Error("OIDC_PUBLIC_JWK must be an RS256 signing JWK whose kid matches OIDC_SIGNING_KID");
	}
	return {
		kty: "RSA",
		kid,
		n: jwk.n,
		e: jwk.e,
		alg: "RS256",
		use: "sig",
	};
}

function parseChannelIds(source: NodeJS.ProcessEnv): readonly string[] {
	const values = requireValue(source, "MIRROR_CHANNEL_IDS")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	const unique = [...new Set(values)];
	if (unique.length === 0 || unique.some((value) => !CHANNEL_ID.test(value))) {
		throw new Error("MIRROR_CHANNEL_IDS must be a comma-separated list of valid YouTube channel IDs");
	}
	return unique;
}

function parseSchedules(source: NodeJS.ProcessEnv): boolean {
	const value = requireValue(source, "ENABLE_SCHEDULES");
	if (value !== "true" && value !== "false") {
		throw new Error("ENABLE_SCHEDULES must be exactly true or false");
	}
	return value === "true";
}

export function parseDeploymentEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	expected?: DeploymentEnvironmentName,
): DeploymentEnvironment {
	const name = requireValue(source, "DEPLOY_ENVIRONMENT");
	if (name !== "production" && name !== "ppe") {
		throw new Error("DEPLOY_ENVIRONMENT must be exactly production or ppe");
	}
	if (expected && name !== expected) {
		throw new Error(`Expected ${expected} deployment resources, received ${name}`);
	}

	const accountId = requireValue(source, "CLOUDFLARE_ACCOUNT_ID");
	if (accountId !== DEPLOYMENT_ACCOUNTS[name]) {
		throw new Error(`${name} must use Cloudflare account ${DEPLOYMENT_ACCOUNTS[name]}`);
	}

	const workersDevSubdomain = requireValue(source, "WORKERS_DEV_SUBDOMAIN");
	if (!WORKERS_DEV_SUBDOMAIN.test(workersDevSubdomain)) {
		throw new Error("WORKERS_DEV_SUBDOMAIN must be a valid Cloudflare workers.dev subdomain");
	}
	const oidcSigningKid = requireValue(source, "OIDC_SIGNING_KID");
	if (!KID.test(oidcSigningKid) || !oidcSigningKid.startsWith(`${name}-`)) {
		throw new Error(`OIDC_SIGNING_KID must be an 8-128 character base64url value prefixed with ${name}-`);
	}
	const issuerUrl = requireOrigin(
		source,
		"OIDC_ISSUER_URL",
		"youtube-mirror-oidc-issuer",
		workersDevSubdomain,
	);
	const telemetryGatewayOrigin = requireOrigin(
		source,
		"TELEMETRY_GATEWAY_ORIGIN",
		"youtube-mirror-telemetry-gateway",
		workersDevSubdomain,
	);
	if (issuerUrl === telemetryGatewayOrigin) throw new Error("OIDC issuer and telemetry gateway origins must differ");

	const provider = requireValue(source, "GCP_WORKLOAD_PROVIDER");
	if (!provider.startsWith("//iam.googleapis.com/projects/") || !provider.endsWith(`/youtube-mirror-oidc-${name}`)) {
		throw new Error(`GCP_WORKLOAD_PROVIDER must select the youtube-mirror-oidc-${name} provider`);
	}

	return {
		name,
		accountId,
		kvNamespaceId: requireHexId(source, "KV_NAMESPACE_ID"),
		secretsStoreId: requireHexId(source, "SECRETS_STORE_ID"),
		workersDevSubdomain,
		issuerUrl,
		telemetryGatewayOrigin,
		oidcSigningKid,
		oidcPublicJwk: parsePublicJwk(source, oidcSigningKid),
		gcpWorkloadProvider: provider,
		gcpServiceAccount: requireValue(source, "GCP_SERVICE_ACCOUNT"),
		azureTenantId: requireUuid(source, "AZURE_TENANT_ID"),
		azureAppClientId: requireUuid(source, "AZURE_APP_CLIENT_ID"),
		otlpTracesEndpoint: requireHttpsUrl(source, "OTLP_TRACES_ENDPOINT"),
		otlpMetricsEndpoint: requireHttpsUrl(source, "OTLP_METRICS_ENDPOINT"),
		otlpLogsEndpoint: requireHttpsUrl(source, "OTLP_LOGS_ENDPOINT"),
		channelIds: parseChannelIds(source),
		enableSchedules: parseSchedules(source),
	};
}

export function environmentFromArgs(args: readonly string[]): DeploymentEnvironmentName {
	const index = args.indexOf("--environment");
	const value = index >= 0 ? args[index + 1] : undefined;
	if (value !== "production" && value !== "ppe") {
		throw new Error("Pass --environment production or --environment ppe");
	}
	return value;
}
