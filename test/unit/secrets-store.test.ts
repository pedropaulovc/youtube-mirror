import { describe, expect, it, vi } from "vitest";
import { atProtoSecretValues, deploymentSecretValues } from "../../scripts/secret-values";
import { synchronizeSecretStoreEntries } from "../../scripts/secrets-store";
import type { DeploymentEnvironment } from "../../scripts/deployment-environment";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

describe("Secrets Store value contracts", () => {
	it("keeps deployment synchronization limited to deployment credentials", () => {
		expect(deploymentSecretValues("oidc-private-key", "firecrawl-token")).toEqual([
			{ name: "youtube-mirror-oidc-signing-key", value: "oidc-private-key" },
			{ name: "youtube-mirror-firecrawl-api-token", value: "firecrawl-token" },
		]);
	});

	it("tags ATProto entries with their deployment environment", () => {
		expect(atProtoSecretValues("ppe", "UCchannel", "main-password", "rt-password")).toEqual([
			{
				name: "youtube-mirror-atproto-password-UCchannel",
				value: "main-password",
				environment: "ppe",
			},
			{
				name: "youtube-mirror-atproto-password-UCchannel-rt",
				value: "rt-password",
				environment: "ppe",
			},
		]);
	});
	it("rejects values tagged for a different deployment", async () => {
		const production = { name: "production" } as DeploymentEnvironment;

		await expect(
			synchronizeSecretStoreEntries(
				production,
				"unused-token",
				atProtoSecretValues("ppe", "UCchannel", "main-password", "rt-password"),
			),
		).rejects.toThrow("targets a different environment");
	});
});
