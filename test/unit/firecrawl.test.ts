import { describe, it, expect, vi, afterEach } from "vitest";
import { communityTabUrl, postIdFromUrl, normalizeCommunityPost, fetchCommunityPosts } from "../../worker/firecrawl";
import { TEST_CHANNEL_ID } from "../helpers/factories";

describe("firecrawl", () => {
	afterEach(() => vi.restoreAllMocks());

	it("builds the community tab URL from a handle", () => {
		expect(communityTabUrl("@MyChannel")).toBe("https://www.youtube.com/@mychannel/community");
	});

	describe("fetchCommunityPosts request shape", () => {
		it("sends the v2 JSON format (formats:[{type:'json',schema}]), not the legacy jsonOptions", async () => {
			let captured: Record<string, unknown> = {};
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
				captured = JSON.parse(String((init as RequestInit).body));
				return new Response(JSON.stringify({ data: { json: { posts: [] } } }), { status: 200 });
			});

			await fetchCommunityPosts("mychannel", TEST_CHANNEL_ID, "fc-token");

			expect(captured).not.toHaveProperty("jsonOptions");
			const formats = captured.formats as { type: string; schema: unknown }[];
			expect(Array.isArray(formats)).toBe(true);
			expect(formats[0].type).toBe("json");
			expect(formats[0].schema).toBeDefined();
		});

		it("returns [] on a non-OK response without throwing", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
			await expect(fetchCommunityPosts("mychannel", TEST_CHANNEL_ID, "fc-token")).resolves.toEqual([]);
		});
	});

	describe("postIdFromUrl", () => {
		it("extracts the post ID from a /post/ URL", () => {
			expect(postIdFromUrl("https://www.youtube.com/post/UgAbc-123")).toBe("UgAbc-123");
		});
		it("returns undefined for a non-post URL", () => {
			expect(postIdFromUrl("https://www.youtube.com/watch?v=x")).toBeUndefined();
			expect(postIdFromUrl(undefined)).toBeUndefined();
		});
	});

	describe("normalizeCommunityPost", () => {
		it("normalizes a post and derives the ID from the URL when postId is absent", () => {
			const post = normalizeCommunityPost(
				{ postUrl: "https://www.youtube.com/post/UgXYZ", text: "Hi", images: ["a.jpg", 5 as unknown as string], publishedText: "1 day ago" },
				TEST_CHANNEL_ID,
			);
			expect(post).not.toBeNull();
			expect(post!.id).toBe("UgXYZ");
			expect(post!.images).toEqual(["a.jpg"]);
		});

		it("returns null when there is no stable ID", () => {
			expect(normalizeCommunityPost({ text: "orphan" }, TEST_CHANNEL_ID)).toBeNull();
		});

		it("keeps a poll only when it has options", () => {
			const withPoll = normalizeCommunityPost(
				{ postId: "UgP", poll: { question: "Q?", options: [{ text: "A", votePercent: 60 }] } },
				TEST_CHANNEL_ID,
			);
			expect(withPoll!.poll?.options).toHaveLength(1);

			const emptyPoll = normalizeCommunityPost({ postId: "UgP2", poll: { options: [] } }, TEST_CHANNEL_ID);
			expect(emptyPoll!.poll).toBeUndefined();
		});
	});
});
