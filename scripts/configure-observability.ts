import {
	environmentFromArgs,
	parseDeploymentEnvironment,
	type DeploymentEnvironment,
} from "./deployment-environment.js";

type JsonObject = Record<string, unknown>;

interface DestinationSpec {
	name: "youtube-azure-logs" | "youtube-azure-traces";
	dataset: "opentelemetry-logs" | "opentelemetry-traces";
	url: string;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSecret(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Required environment secret ${name} is not set`);
	return value;
}

async function cloudflareRequest(url: string, token: string, init: RequestInit = {}): Promise<JsonObject> {
	const response = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
		signal: AbortSignal.timeout(30_000),
	});
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error(`Cloudflare observability API returned non-JSON HTTP ${response.status}`);
	}
	if (!response.ok || !isObject(payload) || payload.success !== true) {
		throw new Error(`Cloudflare observability API failed with HTTP ${response.status}`);
	}
	return payload;
}

function specs(environment: DeploymentEnvironment): readonly DestinationSpec[] {
	return [
		{
			name: "youtube-azure-logs",
			dataset: "opentelemetry-logs",
			url: `${environment.telemetryGatewayOrigin}/v1/logs`,
		},
		{
			name: "youtube-azure-traces",
			dataset: "opentelemetry-traces",
			url: `${environment.telemetryGatewayOrigin}/v1/traces`,
		},
	];
}

async function main(): Promise<void> {
	const expected = environmentFromArgs(process.argv.slice(2));
	const environment = parseDeploymentEnvironment(process.env, expected);
	const token = requireSecret("CLOUDFLARE_API_TOKEN");
	const bearer = requireSecret("GATEWAY_INGEST_BEARER");
	const endpoint = `https://api.cloudflare.com/client/v4/accounts/${environment.accountId}/workers/observability/destinations`;
	const listing = await cloudflareRequest(endpoint, token);
	if (!Array.isArray(listing.result)) throw new Error("Cloudflare destination listing is not an array");

	for (const spec of specs(environment)) {
		const matches = listing.result.filter((item) => isObject(item) && item.name === spec.name);
		if (matches.length > 1) throw new Error(`Cloudflare returned duplicate ${spec.name} destinations`);
		const existing = matches[0];
		if (existing && isObject(existing)) {
			const configuration = existing.configuration;
			if (!isObject(configuration) || configuration.logpushDataset !== spec.dataset || typeof existing.slug !== "string") {
				throw new Error(`${spec.name} exists with a mismatched dataset or invalid slug`);
			}
			await cloudflareRequest(`${endpoint}/${encodeURIComponent(existing.slug)}`, token, {
				method: "PATCH",
				body: JSON.stringify({
					enabled: true,
					configuration: {
						type: "logpush",
						url: spec.url,
						headers: { Authorization: `Bearer ${bearer}` },
					},
				}),
			});
			console.log(`Updated ${environment.name} destination ${spec.name}`);
			continue;
		}

		await cloudflareRequest(endpoint, token, {
			method: "POST",
			body: JSON.stringify({
				name: spec.name,
				enabled: true,
				configuration: {
					type: "logpush",
					logpushDataset: spec.dataset,
					url: spec.url,
					headers: { Authorization: `Bearer ${bearer}` },
				},
			}),
		});
		console.log(`Created ${environment.name} destination ${spec.name}`);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "Could not configure observability destinations");
	process.exitCode = 1;
});
