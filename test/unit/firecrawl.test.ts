import { describe, it, expect } from "vitest";
import { communityTabUrl, postIdFromUrl, normalizeCommunityPost } from "../../worker/firecrawl";
import { TEST_CHANNEL_ID } from "../helpers/factories";

describe("firecrawl", () => {
	it("builds the community tab URL from a handle", () => {
		expect(communityTabUrl("@MyChannel")).toBe("https://www.youtube.com/@mychannel/community");
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
