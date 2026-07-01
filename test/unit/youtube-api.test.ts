import { describe, it, expect, vi, afterEach } from "vitest";
import {
	uploadsPlaylistId,
	watchUrl,
	communityPostUrl,
	parseIso8601Duration,
	normalizeVideo,
	normalizeComment,
	fetchComments,
} from "../../worker/youtube-api";
import { TEST_CHANNEL_ID } from "../helpers/factories";

function jsonResponse(obj: unknown): Response {
	return new Response(JSON.stringify(obj), { status: 200 });
}

function topThread(id: string, publishedAt: string, extra: Record<string, unknown> = {}) {
	return {
		snippet: { topLevelComment: { id, snippet: { textOriginal: "hi", publishedAt, authorChannelId: { value: "UCx" } } }, totalReplyCount: 0, ...extra },
	};
}

describe("youtube-api", () => {
	afterEach(() => vi.restoreAllMocks());
	describe("uploadsPlaylistId", () => {
		it("swaps the UC prefix for UU", () => {
			expect(uploadsPlaylistId("UCabc123")).toBe("UUabc123");
		});
		it("leaves non-UC IDs unchanged", () => {
			expect(uploadsPlaylistId("PLxyz")).toBe("PLxyz");
		});
	});

	it("builds watch and community URLs", () => {
		expect(watchUrl("abc")).toBe("https://www.youtube.com/watch?v=abc");
		expect(communityPostUrl("UgP")).toBe("https://www.youtube.com/post/UgP");
	});

	describe("parseIso8601Duration", () => {
		it("parses hours, minutes, seconds", () => {
			expect(parseIso8601Duration("PT1H2M3S")).toBe(3723);
		});
		it("parses minute-only and second-only durations", () => {
			expect(parseIso8601Duration("PT45S")).toBe(45);
			expect(parseIso8601Duration("PT10M")).toBe(600);
		});
		it("returns 0 for malformed input", () => {
			expect(parseIso8601Duration("nonsense")).toBe(0);
		});
	});

	describe("normalizeVideo", () => {
		it("maps snippet + contentDetails and flags Shorts", () => {
			const video = normalizeVideo({
				id: "vid9",
				snippet: {
					title: "T",
					description: "D",
					publishedAt: "2026-01-01T00:00:00Z",
					channelId: TEST_CHANNEL_ID,
					channelTitle: "C",
					thumbnails: { maxres: { url: "max.jpg", width: 1280, height: 720 }, high: { url: "high.jpg" } },
				},
				contentDetails: { duration: "PT30S" },
			});
			expect(video.kind).toBe("video");
			expect(video.id).toBe("vid9");
			expect(video.durationSeconds).toBe(30);
			expect(video.isShort).toBe(true);
			expect(video.thumbnailUrl).toBe("max.jpg");
			expect(video.watchUrl).toBe("https://www.youtube.com/watch?v=vid9");
		});

		it("does not flag long videos as Shorts", () => {
			const video = normalizeVideo({ id: "v", contentDetails: { duration: "PT5M" } });
			expect(video.isShort).toBe(false);
		});
	});

	describe("normalizeComment", () => {
		it("marks a comment from the channel itself as owner", () => {
			const c = normalizeComment(
				{ id: "c1", snippet: { authorChannelId: { value: TEST_CHANNEL_ID }, textOriginal: "hi", publishedAt: "2026-01-01T00:00:00Z" } },
				TEST_CHANNEL_ID,
				"vid1",
				"vid1",
				"video",
			);
			expect(c.isChannelOwner).toBe(true);
			expect(c.parentItemKind).toBe("video");
		});

		it("marks a foreign commenter as non-owner", () => {
			const c = normalizeComment(
				{ id: "c2", snippet: { authorChannelId: { value: "UCother" }, authorDisplayName: "@bob", textOriginal: "nice" } },
				TEST_CHANNEL_ID,
				"vid1",
				"topComment",
				"comment",
			);
			expect(c.isChannelOwner).toBe(false);
			expect(c.parentItemId).toBe("topComment");
			expect(c.authorHandle).toBe("bob");
		});
	});

	describe("auth", () => {
		it("authenticates with a Bearer access token, not an API key query param", async () => {
			let capturedUrl = "";
			let capturedInit: RequestInit | undefined;
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
				capturedUrl = String(url);
				capturedInit = init as RequestInit;
				return jsonResponse({ items: [topThread("t1", "2026-06-01T10:00:00Z")] });
			});

			await fetchComments("vidX", TEST_CHANNEL_ID, "ya29.sa-token");

			expect(new URL(capturedUrl).searchParams.get("key")).toBeNull();
			expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer ya29.sa-token");
		});
	});

	describe("fetchComments", () => {
		it("requests plain-text comment bodies (textFormat=plainText)", async () => {
			const urls: string[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
				urls.push(String(url));
				return jsonResponse({ items: [topThread("t1", "2026-06-01T10:00:00Z")] });
			});

			const out = await fetchComments("vidX", TEST_CHANNEL_ID, "key");
			expect(out).toHaveLength(1);
			expect(urls[0]).toContain("commentThreads");
			expect(new URL(urls[0]).searchParams.get("textFormat")).toBe("plainText");
		});

		it("pages through multiple thread pages via nextPageToken", async () => {
			let call = 0;
			const pageTokens: (string | null)[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
				pageTokens.push(new URL(String(url)).searchParams.get("pageToken"));
				call++;
				if (call === 1) return jsonResponse({ items: [topThread("t1", "2026-06-02T10:00:00Z")], nextPageToken: "P2" });
				return jsonResponse({ items: [topThread("t2", "2026-06-01T10:00:00Z")] });
			});

			const out = await fetchComments("vidX", TEST_CHANNEL_ID, "key", undefined, 200);
			expect(call).toBe(2); // followed nextPageToken to the second page
			expect(pageTokens).toEqual([null, "P2"]);
			expect(out.map((c) => c.id).sort()).toEqual(["t1", "t2"]);
		});

		it("incremental polls drain every thread newer than the cursor across pages", async () => {
			// Both threads are newer than the cursor but split across two pages. Before the
			// fix, a cursored poll used the default cap (maxPages=1), stopped after page 1,
			// and dropped t2 — then the caller advanced the cursor past it, losing it forever.
			let call = 0;
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
				call++;
				if (new URL(String(url)).searchParams.get("pageToken") == null) {
					return jsonResponse({ items: [topThread("t1", "2026-06-02T10:00:00Z")], nextPageToken: "P2" });
				}
				return jsonResponse({ items: [topThread("t2", "2026-06-01T12:00:00Z")] });
			});

			const out = await fetchComments("vidX", TEST_CHANNEL_ID, "key", "2026-06-01T00:00:00Z");
			expect(call).toBe(2); // paged past the default cap to reach the cursor
			expect(out.map((c) => c.id).sort()).toEqual(["t1", "t2"]);
		});

		it("cold start (no cursor) caps at the backfill size instead of draining all history", async () => {
			// Every page reports another page available; a cold start must still stop at the
			// bounded backfill rather than walking the video's entire comment history.
			let call = 0;
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
				call++;
				return jsonResponse({ items: [topThread(`t${call}`, "2026-06-01T10:00:00Z")], nextPageToken: `P${call + 1}` });
			});

			await fetchComments("vidX", TEST_CHANNEL_ID, "key"); // no cursor, default cap 100
			expect(call).toBe(1); // ceil(100/100) = 1 page — bounded, not a full drain
		});

		it("fetches the full reply set via comments.list when a thread has more than the inline replies", async () => {
			let commentsListCalled = false;
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
				const u = new URL(String(url));
				if (u.pathname.endsWith("/commentThreads")) {
					return jsonResponse({
						items: [
							topThread("top1", "2026-06-01T10:00:00Z", {
								totalReplyCount: 3,
								// inline subset carries only 1 of the 3 replies
							}),
						].map((t) => ({ ...t, replies: { comments: [{ id: "r-inline", snippet: { textOriginal: "inline", publishedAt: "2026-06-01T10:05:00Z" } }] } })),
					});
				}
				// comments.list — the full reply set
				commentsListCalled = true;
				expect(u.searchParams.get("textFormat")).toBe("plainText");
				return jsonResponse({
					items: [
						{ id: "r1", snippet: { textOriginal: "a", publishedAt: "2026-06-01T10:05:00Z" } },
						{ id: "r2", snippet: { textOriginal: "b", publishedAt: "2026-06-01T10:06:00Z" } },
						{ id: "r3", snippet: { textOriginal: "c", publishedAt: "2026-06-01T10:07:00Z" } },
					],
				});
			});

			const out = await fetchComments("vidX", TEST_CHANNEL_ID, "key");
			expect(commentsListCalled).toBe(true);
			const ids = out.map((c) => c.id);
			expect(ids).toContain("r1");
			expect(ids).toContain("r3");
			expect(ids).not.toContain("r-inline"); // the full set replaced the inline subset
		});

		it("propagates a comments.list failure during an incremental poll (cursor-unsafe)", async () => {
			// Thread has more replies than the inline subset; comments.list errors. With a
			// cursor set, returning the inline subset would let the caller advance past the
			// omitted replies — so the fetch must reject and let the step retry.
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
				const u = new URL(String(url));
				if (u.pathname.endsWith("/commentThreads")) {
					return jsonResponse({
						items: [{ ...topThread("top1", "2026-06-02T10:00:00Z", { totalReplyCount: 3 }), replies: { comments: [{ id: "r-inline", snippet: { textOriginal: "x", publishedAt: "2026-06-02T10:05:00Z" } }] } }],
					});
				}
				return new Response("boom", { status: 500 }); // comments.list fails
			});

			await expect(fetchComments("vidX", TEST_CHANNEL_ID, "key", "2026-06-01T00:00:00Z")).rejects.toThrow();
		});

		it("propagates a comments.list failure on a cold backfill too (cursor still advances after)", async () => {
			// The poller writes a cursor after a successful poll even with no prior cursor, so
			// a partial inline subset would strand the omitted replies. Must reject here too.
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
				const u = new URL(String(url));
				if (u.pathname.endsWith("/commentThreads")) {
					return jsonResponse({
						items: [{ ...topThread("top1", "2026-06-02T10:00:00Z", { totalReplyCount: 3 }), replies: { comments: [{ id: "r-inline", snippet: { textOriginal: "x", publishedAt: "2026-06-02T10:05:00Z" } }] } }],
					});
				}
				return new Response("boom", { status: 500 });
			});

			await expect(fetchComments("vidX", TEST_CHANNEL_ID, "key")).rejects.toThrow();
		});

		it("propagates a thread-page failure past the first page (partial batch is cursor-unsafe)", async () => {
			// Page 1 succeeds, page 2 (pageToken in use) errors transiently. Returning page 1
			// alone would let the caller advance the cursor past page 2's still-new threads.
			let call = 0;
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
				if (!new URL(String(url)).pathname.endsWith("/commentThreads")) return jsonResponse({ items: [] });
				call++;
				if (call === 1) return jsonResponse({ items: [topThread("t1", "2026-06-02T10:00:00Z")], nextPageToken: "P2" });
				return new Response("boom", { status: 503 });
			});

			await expect(fetchComments("vidX", TEST_CHANNEL_ID, "key", "2026-06-01T00:00:00Z")).rejects.toThrow();
		});

		it("skips a video whose FIRST comment page fails (comments disabled → non-fatal)", async () => {
			vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
				if (!new URL(String(url)).pathname.endsWith("/commentThreads")) return jsonResponse({ items: [] });
				return new Response("comments disabled", { status: 403 });
			});

			const out = await fetchComments("vidX", TEST_CHANNEL_ID, "key"); // resolves empty, doesn't throw
			expect(out).toEqual([]);
		});
	});
});
