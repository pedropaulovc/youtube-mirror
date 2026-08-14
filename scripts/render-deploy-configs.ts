import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseConfigFileTextToJson } from "typescript";
import {
	environmentFromArgs,
	parseDeploymentEnvironment,
	type DeploymentEnvironment,
} from "./deployment-environment.js";

const CONFIG_FILES = [
	"wrangler.mirror-oidc-issuer.jsonc",
	"wrangler.mirror-telemetry-gateway.jsonc",
	"wrangler.mirror-item.jsonc",
	"wrangler.mirror-delete.jsonc",
	"wrangler.mirror-profile.jsonc",
	"wrangler.mirror-channel.jsonc",
] as const;
const CONTENT_CONFIGS = new Set([
	"wrangler.mirror-channel.jsonc",
	"wrangler.mirror-item.jsonc",
	"wrangler.mirror-delete.jsonc",
	"wrangler.mirror-profile.jsonc",
]);
const FIRECRAWL_CONFIGS = new Set([
	"wrangler.mirror-channel.jsonc",
	"wrangler.mirror-item.jsonc",
]);

interface JsonObject {
	[key: string]: unknown;
}

function secretBinding(binding: string, storeId: string): JsonObject {
	return { binding, store_id: storeId, secret_name: binding };
}

function contentBindings(configPath: string, environment: DeploymentEnvironment): JsonObject[] {
	const bindings = [secretBinding("OIDC_SIGNING_KEY", environment.secretsStoreId)];
	if (FIRECRAWL_CONFIGS.has(configPath)) {
		bindings.push(secretBinding("FIRECRAWL_API_TOKEN", environment.secretsStoreId));
	}
	for (const channelId of environment.channelIds) {
		bindings.push(
			secretBinding(`youtube-mirror-atproto-password-${channelId}`, environment.secretsStoreId),
			secretBinding(`youtube-mirror-atproto-password-${channelId}-rt`, environment.secretsStoreId),
		);
	}
	return bindings;
}

function renderConfig(
	configPath: string,
	base: JsonObject,
	environment: DeploymentEnvironment,
): JsonObject {
	const rendered: JsonObject = {
		...base,
		account_id: environment.accountId,
	};

	if (CONTENT_CONFIGS.has(configPath)) {
		rendered.vars = {
			DEPLOYMENT_ENVIRONMENT: environment.name,
			OIDC_ISSUER_URL: environment.issuerUrl,
			OIDC_SIGNING_KID: environment.oidcSigningKid,
			GCP_WORKLOAD_PROVIDER: environment.gcpWorkloadProvider,
			GCP_SERVICE_ACCOUNT: environment.gcpServiceAccount,
		};
		rendered.kv_namespaces = [{ binding: "KV", id: environment.kvNamespaceId }];
		rendered.secrets_store_secrets = contentBindings(configPath, environment);
	}

	if (configPath === "wrangler.mirror-channel.jsonc") {
		rendered.triggers = { crons: environment.enableSchedules ? ["* * * * *"] : [] };
	}
	if (configPath === "wrangler.mirror-delete.jsonc" || configPath === "wrangler.mirror-profile.jsonc") {
		rendered.triggers = { crons: environment.enableSchedules ? ["0 * * * *"] : [] };
	}
	if (configPath === "wrangler.mirror-oidc-issuer.jsonc") {
		rendered.vars = {
			DEPLOYMENT_ENVIRONMENT: environment.name,
			ISSUER_URL: environment.issuerUrl,
			OIDC_SIGNING_KID: environment.oidcSigningKid,
			OIDC_PUBLIC_JWK: JSON.stringify(environment.oidcPublicJwk),
		};
	}
	if (configPath === "wrangler.mirror-telemetry-gateway.jsonc") {
		rendered.vars = {
			DEPLOYMENT_ENVIRONMENT: environment.name,
			TENANT_ID: environment.azureTenantId,
			APP_CLIENT_ID: environment.azureAppClientId,
			OTLP_TRACES_ENDPOINT: environment.otlpTracesEndpoint,
			OTLP_METRICS_ENDPOINT: environment.otlpMetricsEndpoint,
			OTLP_LOGS_ENDPOINT: environment.otlpLogsEndpoint,
			OIDC_ISSUER_URL: environment.issuerUrl,
			GATEWAY_FEDERATION_SUBJECT: "cf-worker:youtube-mirror-telemetry-gateway",
			OIDC_SIGNING_KID: environment.oidcSigningKid,
		};
		rendered.secrets_store_secrets = [secretBinding("OIDC_SIGNING_KEY", environment.secretsStoreId)];
	}
	return rendered;
}

async function main(): Promise<void> {
	const expected = environmentFromArgs(process.argv.slice(2));
	const environment = parseDeploymentEnvironment(process.env, expected);
	const outputDirectory = join(".wrangler", "deploy", environment.name);
	await mkdir(outputDirectory, { recursive: true });

	for (const configPath of CONFIG_FILES) {
		const source = await readFile(configPath, "utf8");
		const parsed = parseConfigFileTextToJson(configPath, source);
		if (parsed.error || !parsed.config || typeof parsed.config !== "object" || Array.isArray(parsed.config)) {
			throw new Error(`Could not parse ${configPath} as JSONC`);
		}
		const outputPath = join(outputDirectory, basename(configPath));
		await writeFile(outputPath, `${JSON.stringify(renderConfig(configPath, parsed.config, environment), null, "\t")}\n`);
		console.log(outputPath);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Could not render deployment configs");
	process.exitCode = 1;
});
