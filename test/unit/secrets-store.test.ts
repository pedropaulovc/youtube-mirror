import { describe, expect, it } from "vitest";
import { atProtoSecretValues, deploymentSecretValues } from "../../scripts/secret-values";

describe("Secrets Store value contracts", () => {
	it("keeps deployment synchronization limited to deployment credentials", () => {
		expect(deploymentSecretValues("oidc-private-key", "firecrawl-token")).toEqual([
			{ name: "youtube-mirror-oidc-signing-key", value: "oidc-private-key" },
			{ name: "youtube-mirror-firecrawl-api-token", value: "firecrawl-token" },
		]);
	});

	it("builds both ATProto entries for the selected channel", () => {
		expect(atProtoSecretValues("UCchannel", "main-password", "rt-password")).toEqual([
			{
				name: "youtube-mirror-atproto-password-UCchannel",
				value: "main-password",
			},
			{
				name: "youtube-mirror-atproto-password-UCchannel-rt",
				value: "rt-password",
			},
		]);
	});
});
