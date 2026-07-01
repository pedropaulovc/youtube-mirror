import { describe, it, expect, vi, afterEach } from "vitest";

// bluesky.ts imports @atproto/api, which crashes on import in the Workers isolate.
vi.mock("@atproto/api", () => ({
	AtpAgent: function () {
		return {};
	},
	RichText: function (opts: { text: string }) {
		return { text: opts.text, facets: [] };
	},
}));

const { resolvePdsUrl } = await import("../../worker/bluesky");

function jsonResponse(obj: unknown, status = 200): Response {
	return new Response(JSON.stringify(obj), { status });
}

describe("resolvePdsUrl", () => {
	afterEach(() => vi.restoreAllMocks());

	it("resolves handle → DID → DID document → the account's real PDS endpoint", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
			const s = String(url);
			if (s.includes("resolveHandle")) return jsonResponse({ did: "did:plc:abc123" });
			if (s.includes("plc.directory")) {
				return jsonResponse({
					service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://real-pds.example.com" }],
				});
			}
			return jsonResponse({}, 404);
		});

		// A custom-domain handle whose PDS is NOT derivable from the handle string.
		await expect(resolvePdsUrl("alice.com")).resolves.toBe("https://real-pds.example.com");
	});

	it("falls back to the default entryway when the handle can't be resolved", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "InvalidRequest" }, 400));
		await expect(resolvePdsUrl("nonexistent.invalid")).resolves.toBe("https://bsky.social");
	});
});
