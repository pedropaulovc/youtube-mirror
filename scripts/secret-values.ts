import type { DeploymentEnvironmentName } from "./deployment-environment.js";

export interface SecretValue {
	readonly name: string;
	readonly value: string;
	readonly environment?: DeploymentEnvironmentName;
}

export function deploymentSecretValues(signingKey: string, firecrawlApiToken: string): readonly SecretValue[] {
	return [
		{ name: "youtube-mirror-oidc-signing-key", value: signingKey },
		{ name: "youtube-mirror-firecrawl-api-token", value: firecrawlApiToken },
	];
}

export function atProtoSecretValues(
	environment: DeploymentEnvironmentName,
	channelId: string,
	mainPassword: string,
	rtPassword: string,
): readonly SecretValue[] {
	return [
		{
			name: `youtube-mirror-atproto-password-${channelId}`,
			value: mainPassword,
			environment,
		},
		{
			name: `youtube-mirror-atproto-password-${channelId}-rt`,
			value: rtPassword,
			environment,
		},
	];
}
