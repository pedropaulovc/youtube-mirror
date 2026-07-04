import { describe, it, expect, vi, afterEach } from "vitest";
import { communityTabUrl, postIdFromUrl, parseCommunityPosts, fetchCommunityPosts } from "../../worker/firecrawl";
import { TEST_CHANNEL_ID } from "../helpers/factories";

// Build a page whose embedded ytInitialData contains the given backstagePostRenderers.
function htmlWith(...posts: Record<string, unknown>[]): string {
	const yt = {
		contents: {
			sectionListRenderer: {
				contents: posts.map((post) => ({ backstagePostThreadRenderer: { post: { backstagePostRenderer: post } } })),
			},
		},
	};
	return `<!doctype html><html><body><script nonce="x">var ytInitialData = ${JSON.stringify(yt)};</script></body></html>`;
}

describe("firecrawl", () => {
	afterEach(() => vi.restoreAllMocks());

	it("builds the community tab URL from a handle", () => {
		expect(communityTabUrl("@MyChannel")).toBe("https://www.youtube.com/@mychannel/posts?hl=en");
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

	describe("parseCommunityPosts", () => {
		it("parses text, relative time, likes and the largest image from ytInitialData", () => {
			const html = htmlWith({
				postId: "UgText1",
				contentText: { runs: [{ text: "Hello " }, { text: "community!" }] },
				publishedTimeText: { runs: [{ text: "2 days ago" }] },
				voteCount: { simpleText: "1.2K" },
				backstageAttachment: {
					backstageImageRenderer: {
						image: { thumbnails: [{ url: "small.jpg", width: 100 }, { url: "big.jpg", width: 800 }] },
					},
				},
			});
			const posts = parseCommunityPosts(html, TEST_CHANNEL_ID);
			expect(posts).toHaveLength(1);
			expect(posts[0].id).toBe("UgText1");
			expect(posts[0].text).toBe("Hello community!");
			expect(posts[0].publishedText).toBe("2 days ago");
			expect(posts[0].likeText).toBe("1.2K");
			expect(posts[0].images).toEqual(["big.jpg"]);
			expect(posts[0].postUrl).toBe("https://www.youtube.com/post/UgText1");
		});

		it("keeps a poll's choices when the attachment is a pollRenderer", () => {
			const html = htmlWith({
				postId: "UgPoll1",
				contentText: { runs: [{ text: "Vote!" }] },
				backstageAttachment: {
					pollRenderer: {
						choices: [{ text: { runs: [{ text: "Yes" }] } }, { text: { runs: [{ text: "No" }] } }],
					},
				},
			});
			const [post] = parseCommunityPosts(html, TEST_CHANNEL_ID);
			expect(post.poll?.options.map((o) => o.text)).toEqual(["Yes", "No"]);
		});

		it("dedupes repeated posts and skips renderers with no postId", () => {
			const html = htmlWith(
				{ postId: "UgDup", contentText: { runs: [{ text: "a" }] } },
				{ postId: "UgDup", contentText: { runs: [{ text: "a" }] } },
				{ contentText: { runs: [{ text: "no id" }] } },
			);
			const posts = parseCommunityPosts(html, TEST_CHANNEL_ID);
			expect(posts.map((p) => p.id)).toEqual(["UgDup"]);
		});

		it("returns [] when the page has no ytInitialData", () => {
			expect(parseCommunityPosts("<html>no data here</html>", TEST_CHANNEL_ID)).toEqual([]);
		});
	});

	describe("fetchCommunityPosts request shape", () => {
		it("requests raw HTML only — no LLM JSON extraction (formats:['rawHtml'], no jsonOptions)", async () => {
			let captured: Record<string, unknown> = {};
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
				captured = JSON.parse(String((init as RequestInit).body));
				return new Response(JSON.stringify({ data: { rawHtml: htmlWith({ postId: "UgFromScrape", contentText: { runs: [{ text: "hi" }] } }) } }), { status: 200 });
			});

			const posts = await fetchCommunityPosts("mychannel", TEST_CHANNEL_ID, "fc-token");

			expect(captured.formats).toEqual(["rawHtml"]);
			expect(captured).not.toHaveProperty("jsonOptions");
			expect(posts.map((p) => p.id)).toEqual(["UgFromScrape"]);
		});

		it("returns [] on a non-OK response without throwing", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
			await expect(fetchCommunityPosts("mychannel", TEST_CHANNEL_ID, "fc-token")).resolves.toEqual([]);
		});
	});
});
