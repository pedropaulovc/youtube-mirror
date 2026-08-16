import { describe, expect, it } from "vitest";
import type { DeploymentEnvironment } from "../../scripts/deployment-environment";
import { renderConfig, renderConfigForDirectory } from "../../scripts/deployment-config";

const environment: DeploymentEnvironment = {
	name: "ppe",
	accountId: "b846acaf5be2e542781751bd94a63153",
	kvNamespaceId: "2".repeat(32),
	secretsStoreId: "4".repeat(32),
	workersDevSubdomain: "youtube-ppe",
	issuerUrl: "https://youtube-mirror-oidc-issuer.youtube-ppe.workers.dev",
	telemetryGatewayOrigin: "https://youtube-mirror-telemetry-gateway.youtube-ppe.workers.dev",
	oidcSigningKid: "ppe-key12345",
	oidcPublicJwk: {
		kty: "RSA",
		kid: "ppe-key12345",
		n: "a".repeat(342),
		e: "AQAB",
		alg: "RS256",
		use: "sig",
	},
	gcpWorkloadProvider: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/cloudflare-workers/providers/youtube-mirror-oidc-ppe",
	gcpServiceAccount: "youtube@example.iam.gserviceaccount.com",
	azureTenantId: "6f10d2eb-7cce-444c-bf11-d6fe61d7b8f8",
	azureAppClientId: "585e33f6-df1c-4998-bf9d-dcbe3c585d99",
	otlpTracesEndpoint: "https://monitor.example/v1/traces",
	otlpMetricsEndpoint: "https://monitor.example/v1/metrics",
	otlpLogsEndpoint: "https://monitor.example/v1/logs",
	channelIds: ["UC5NO8MgTQKHAWXp6z8Xl7yQ"],
	enableSchedules: false,
};

describe("renderConfig", () => {
	it("binds content Workers to the synchronized Secrets Store names", () => {
		const rendered = renderConfig("wrangler.mirror-channel.jsonc", { name: "youtube-mirror-channel" }, environment);
		expect(rendered.account_id).toBe(environment.accountId);
		expect(rendered.kv_namespaces).toEqual([{ binding: "KV", id: environment.kvNamespaceId }]);
		expect(rendered.secrets_store_secrets).toEqual([
			{
				binding: "OIDC_SIGNING_KEY",
				store_id: environment.secretsStoreId,
				secret_name: "youtube-mirror-oidc-signing-key",
			},
			{
				binding: "FIRECRAWL_API_TOKEN",
				store_id: environment.secretsStoreId,
				secret_name: "youtube-mirror-firecrawl-api-token",
			},
			{
				binding: "youtube-mirror-atproto-password-UC5NO8MgTQKHAWXp6z8Xl7yQ",
				store_id: environment.secretsStoreId,
				secret_name: "youtube-mirror-atproto-password-UC5NO8MgTQKHAWXp6z8Xl7yQ",
			},
			{
				binding: "youtube-mirror-atproto-password-UC5NO8MgTQKHAWXp6z8Xl7yQ-rt",
				store_id: environment.secretsStoreId,
				secret_name: "youtube-mirror-atproto-password-UC5NO8MgTQKHAWXp6z8Xl7yQ-rt",
			},
		]);
		expect(rendered.triggers).toEqual({ crons: [] });
	});

	it("binds the gateway signing key to the same synchronized store entry", () => {
		const rendered = renderConfig(
			"wrangler.mirror-telemetry-gateway.jsonc",
			{ name: "youtube-mirror-telemetry-gateway" },
			environment,
		);
		expect(rendered.secrets_store_secrets).toEqual([
			{
				binding: "OIDC_SIGNING_KEY",
				store_id: environment.secretsStoreId,
				secret_name: "youtube-mirror-oidc-signing-key",
			},
		]);
	});
	it("renders Worker configs with entrypoints rooted at the repository", () => {
		const rendered = renderConfigForDirectory(
			"wrangler.mirror-oidc-issuer.jsonc",
			{ name: "youtube-mirror-oidc-issuer", main: "worker/oidc-issuer.ts" },
			environment,
			".wrangler/deploy/production",
		);

		expect(rendered).toMatchObject({
			account_id: environment.accountId,
			main: "../../../worker/oidc-issuer.ts",
		});
	});
});
