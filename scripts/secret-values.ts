export interface SecretValue {
	readonly name: string;
	readonly value: string;
}

export function deploymentSecretValues(signingKey: string, firecrawlApiToken: string): readonly SecretValue[] {
	return [
		{ name: "youtube-mirror-oidc-signing-key", value: signingKey },
		{ name: "youtube-mirror-firecrawl-api-token", value: firecrawlApiToken },
	];
}

export function atProtoSecretValues(
	channelId: string,
	mainPassword: string,
	rtPassword: string,
): readonly SecretValue[] {
	return [
		{
			name: `youtube-mirror-atproto-password-${channelId}`,
			value: mainPassword,
		},
		{
			name: `youtube-mirror-atproto-password-${channelId}-rt`,
			value: rtPassword,
		},
	];
}
