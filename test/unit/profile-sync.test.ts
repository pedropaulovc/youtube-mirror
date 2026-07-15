import { describe, expect, it, vi } from "vitest";

vi.mock("@atproto/api", () => ({
	AtpAgent: function () { return {}; },
	RichText: function () { return { text: "", facets: [], detectFacets: vi.fn() }; },
}));

import { checkModerationLabels } from "../../worker/profile-sync-workflow";

describe("checkModerationLabels", () => {
	it("propagates transient label-query failures so the daily throttle is not written", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("resolveHandle")) {
				return new Response(JSON.stringify({ did: "did:plc:main-test" }), { status: 200 });
			}
			return new Response("unavailable", { status: 503 });
		});

		await expect(checkModerationLabels("UCtest", [{ role: "main", handle: "main.example" }]))
			.rejects.toThrow("moderation label query failed");
	});
});
