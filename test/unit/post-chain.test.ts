import { describe, it, expect, vi } from "vitest";

// context.ts → bluesky.ts imports @atproto/api, which crashes on import in the
// Workers test isolate. Mock it (as the integration tests do).
vi.mock("@atproto/api", () => ({
	AtpAgent: function () {
		return {};
	},
	RichText: function (opts: { text: string }) {
		return { text: opts.text, facets: [], detectFacets: vi.fn() };
	},
}));

const { buildContext } = await import("../../worker/handlers/context");
import type { BlueskyClient } from "../../worker/bluesky";
import { makeChannelConfig, TEST_CHANNEL_ID } from "../helpers/factories";

// Minimal in-memory KV so postChain's resume marker persists across calls.
function fakeEnv() {
	const store = new Map<string, string>();
	const KV = {
		get: async (key: string, type?: string) => {
			const v = store.get(key);
			if (v === undefined) return null;
			return type === "json" ? JSON.parse(v) : v;
		},
		put: async (key: string, val: string) => {
			store.set(key, val);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
	};
	return { env: { KV } as unknown as Env, store };
}

describe("postChain idempotency", () => {
	it("does not re-post the root when a later segment fails and the step retries", async () => {
		const { env } = fakeEnv();
		const ctx = buildContext(env, {} as never, TEST_CHANNEL_ID, makeChannelConfig());

		const calls: string[] = [];
		let failR2Once = true;
		const client = {
			createPost: async (text: string) => {
				calls.push(text);
				if (text === "r2" && failR2Once) {
					failR2Once = false;
					throw new Error("transient failure posting r2");
				}
				return { uri: `at://post/${text}`, cid: `cid-${text}` };
			},
		} as unknown as BlueskyClient;

		const chunks = ["root", "r1", "r2"];
		const logCtx = { channelId: TEST_CHANNEL_ID, itemId: "vidZ" };

		// First attempt fails on the final segment.
		await expect(ctx.postChain(client, chunks, new Date(), logCtx)).rejects.toThrow(/r2/);

		// Retry of the enclosing step: postChain resumes from the marker.
		const result = await ctx.postChain(client, chunks, new Date(), logCtx);

		expect(calls.filter((c) => c === "root")).toHaveLength(1); // root posted exactly once
		expect(calls.filter((c) => c === "r1")).toHaveLength(1); // r1 not re-posted either
		expect(result.uri).toBe("at://post/root");
		expect(result.chainUris).toEqual(["at://post/r1", "at://post/r2"]);
	});
});
