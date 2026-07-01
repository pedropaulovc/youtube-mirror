import { describe, it, expect } from "vitest";
import { mirrorComment } from "../../worker/handlers/comment";
import type { MirrorContext } from "../../worker/handlers/context";
import type { MirroredRecord } from "../../worker/types";
import { makeChannelConfig, makeComment, TEST_CHANNEL_ID } from "../helpers/factories";

// A minimal fake MirrorContext that records postChain/storeMirrored calls and runs
// the step body inline (so a throw inside the step propagates, as a retry would be
// triggered by in production).
function makeFakeCtx(mirrored: Record<string, MirroredRecord>) {
	const posts: { chunks: string[]; options?: Record<string, unknown> }[] = [];
	const stored: { itemId: string; account: string }[] = [];
	const ctx = {
		channelId: TEST_CHANNEL_ID,
		channelConfig: makeChannelConfig(),
		step: {
			do: (_name: string, cfgOrFn: unknown, maybeFn?: unknown) => {
				const fn = (typeof cfgOrFn === "function" ? cfgOrFn : maybeFn) as () => Promise<unknown>;
				return fn();
			},
		},
		getMirrored: async (_cid: string, itemId: string) => mirrored[itemId] ?? null,
		getClient: async () => ({}),
		postChain: async (_client: unknown, chunks: string[], _d: Date, _lc: unknown, options?: Record<string, unknown>) => {
			posts.push({ chunks, options });
			return { uri: "at://did/app.bsky.feed.post/c", cid: "cidc", chainUris: [] };
		},
		storeMirrored: async (_cid: string, itemId: string, _kind: string, _r: unknown, account: string) => {
			stored.push({ itemId, account });
		},
	} as unknown as MirrorContext;
	return { ctx, posts, stored };
}

const parentVideo: MirroredRecord = {
	bskyUri: "at://did/app.bsky.feed.post/vid",
	bskyCid: "cidvid",
	account: "main",
	kind: "video",
	createdAt: "2026-06-01T12:00:00Z",
};

describe("mirrorComment", () => {
	it("throws (so the step retries) when the parent is not yet mirrored", async () => {
		const comment = makeComment({ id: "c1", parentItemId: "missing-video" });
		const { ctx, posts, stored } = makeFakeCtx({});
		await expect(mirrorComment(comment, ctx)).rejects.toThrow(/not mirrored yet/);
		expect(posts).toHaveLength(0);
		expect(stored).toHaveLength(0);
	});

	it("skips work when the comment is already mirrored", async () => {
		const comment = makeComment({ id: "c2", parentItemId: "vid001" });
		const already: MirroredRecord = { ...parentVideo, kind: "comment" };
		const { ctx, posts } = makeFakeCtx({ vid001: parentVideo, c2: already });
		await mirrorComment(comment, ctx);
		expect(posts).toHaveLength(0);
	});

	it("routes a foreign commenter to the rt account with an @author prefix + facet", async () => {
		const comment = makeComment({ id: "c3", parentItemId: "vid001", isChannelOwner: false, authorDisplayName: "@viewer", authorChannelId: "UCviewer00000000000000ab" });
		const { ctx, posts, stored } = makeFakeCtx({ vid001: parentVideo });
		await mirrorComment(comment, ctx);
		expect(posts[0].chunks[0].startsWith("@viewer: ")).toBe(true);
		expect((posts[0].options?.firstChunkFacets as unknown[])?.length).toBe(1);
		expect(stored[0].account).toBe("rt");
	});

	it("routes a channel-owner comment to the main account with no prefix", async () => {
		const comment = makeComment({ id: "c4", parentItemId: "vid001", isChannelOwner: true, authorDisplayName: "Test Channel", authorChannelId: TEST_CHANNEL_ID, text: "Thanks!" });
		const { ctx, posts, stored } = makeFakeCtx({ vid001: parentVideo });
		await mirrorComment(comment, ctx);
		expect(posts[0].chunks[0]).toBe("Thanks!");
		expect(posts[0].options?.firstChunkFacets).toBeUndefined();
		expect(stored[0].account).toBe("main");
	});
});
