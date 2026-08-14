import { describe, expect, it } from "vitest";
import {
	DEPLOYMENT_ACCOUNTS,
	parseDeploymentEnvironment,
	type DeploymentEnvironmentName,
} from "../../scripts/deployment-environment";

function environment(name: DeploymentEnvironmentName): NodeJS.ProcessEnv {
	const subdomain = name === "production" ? "youtube-prod" : "youtube-ppe";
	const kid = `${name}-key12345`;
	return {
		DEPLOY_ENVIRONMENT: name,
		CLOUDFLARE_ACCOUNT_ID: DEPLOYMENT_ACCOUNTS[name],
		KV_NAMESPACE_ID: name === "production" ? "1".repeat(32) : "2".repeat(32),
		SECRETS_STORE_ID: name === "production" ? "3".repeat(32) : "4".repeat(32),
		WORKERS_DEV_SUBDOMAIN: subdomain,
		OIDC_ISSUER_URL: `https://youtube-mirror-oidc-issuer.${subdomain}.workers.dev`,
		TELEMETRY_GATEWAY_ORIGIN: `https://youtube-mirror-telemetry-gateway.${subdomain}.workers.dev`,
		OIDC_SIGNING_KID: kid,
		OIDC_PUBLIC_JWK: JSON.stringify({
			kty: "RSA",
			kid,
			n: "a".repeat(342),
			e: "AQAB",
			alg: "RS256",
			use: "sig",
		}),
		GCP_WORKLOAD_PROVIDER: `//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/cloudflare-workers/providers/youtube-mirror-oidc-${name}`,
		GCP_SERVICE_ACCOUNT: "youtube@example.iam.gserviceaccount.com",
		AZURE_TENANT_ID: "6f10d2eb-7cce-444c-bf11-d6fe61d7b8f8",
		AZURE_APP_CLIENT_ID: "585e33f6-df1c-4998-bf9d-dcbe3c585d99",
		OTLP_TRACES_ENDPOINT: "https://monitor.example/v1/traces",
		OTLP_METRICS_ENDPOINT: "https://monitor.example/v1/metrics",
		OTLP_LOGS_ENDPOINT: "https://monitor.example/v1/logs",
		MIRROR_CHANNEL_IDS: "UC5NO8MgTQKHAWXp6z8Xl7yQ",
		ENABLE_SCHEDULES: "false",
	};
}

describe("parseDeploymentEnvironment", () => {
	it.each(["production", "ppe"] as const)("selects only the %s account and resources", (name) => {
		const parsed = parseDeploymentEnvironment(environment(name), name);
		expect(parsed.name).toBe(name);
		expect(parsed.accountId).toBe(DEPLOYMENT_ACCOUNTS[name]);
		expect(parsed.oidcPublicJwk.kid).toBe(`${name}-key12345`);
		expect(parsed.enableSchedules).toBe(false);
	});

	it("rejects a production account in PPE", () => {
		const values = environment("ppe");
		values.CLOUDFLARE_ACCOUNT_ID = DEPLOYMENT_ACCOUNTS.production;
		expect(() => parseDeploymentEnvironment(values, "ppe")).toThrow("ppe must use Cloudflare account");
	});

	it("rejects an origin outside the selected workers.dev subdomain", () => {
		const values = environment("production");
		values.OIDC_ISSUER_URL = "https://youtube-mirror-oidc-issuer.other.workers.dev";
		expect(() => parseDeploymentEnvironment(values, "production")).toThrow(
			"OIDC_ISSUER_URL does not match WORKERS_DEV_SUBDOMAIN",
		);
	});

	it("rejects a JWK whose kid belongs to another environment", () => {
		const values = environment("ppe");
		values.OIDC_SIGNING_KID = "production-key12345";
		expect(() => parseDeploymentEnvironment(values, "ppe")).toThrow("prefixed with ppe-");
	});

	it("rejects a JWK that does not match its signing kid", () => {
		const values = environment("production");
		values.OIDC_PUBLIC_JWK = JSON.stringify({
			kty: "RSA",
			kid: "production-different",
			n: "a".repeat(342),
			e: "AQAB",
			alg: "RS256",
			use: "sig",
		});
		expect(() => parseDeploymentEnvironment(values, "production")).toThrow("whose kid matches");
	});

	it("rejects an environment-specific GCP provider mismatch", () => {
		const values = environment("ppe");
		values.GCP_WORKLOAD_PROVIDER = values.GCP_WORKLOAD_PROVIDER?.replace("-ppe", "-production");
		expect(() => parseDeploymentEnvironment(values, "ppe")).toThrow("youtube-mirror-oidc-ppe");
	});

	it("fails closed when a required selector is absent", () => {
		const values = environment("production");
		delete values.KV_NAMESPACE_ID;
		expect(() => parseDeploymentEnvironment(values, "production")).toThrow("KV_NAMESPACE_ID is not set");
	});
});
