import { describe, it, expect } from "vitest";
import {
	classifyItem,
	splitIntoChunks,
	videoPostText,
	videoCardDescription,
	descriptionChunks,
	renderPollAsText,
	communityPostText,
	communityChunks,
	communityImages,
	MAX_BLUESKY_IMAGES,
} from "../../worker/content";
import { BLUESKY_GRAPHEME_LIMIT } from "../../worker/constants";
import { makeVideo, makeCommunityPost, makeComment } from "../helpers/factories";

describe("content", () => {
	it("classifyItem returns the item kind", () => {
		expect(classifyItem(makeVideo())).toBe("video");
		expect(classifyItem(makeCommunityPost())).toBe("community");
		expect(classifyItem(makeComment())).toBe("comment");
	});

	describe("splitIntoChunks", () => {
		it("returns a single empty chunk for empty text", () => {
			expect(splitIntoChunks("")).toEqual([""]);
		});

		it("keeps short text as one chunk", () => {
			expect(splitIntoChunks("hello world")).toEqual(["hello world"]);
		});

		it("splits oversized text into ≤limit-grapheme chunks", () => {
			const long = "This is a sentence. ".repeat(60); // ~1200 chars
			const chunks = splitIntoChunks(long);
			expect(chunks.length).toBeGreaterThan(1);
			for (const chunk of chunks) {
				expect([...chunk].length).toBeLessThanOrEqual(BLUESKY_GRAPHEME_LIMIT);
			}
		});

		it("counts emoji as single graphemes", () => {
			const emoji = "😀".repeat(BLUESKY_GRAPHEME_LIMIT);
			expect(splitIntoChunks(emoji)).toEqual([emoji]);
		});
	});

	describe("video helpers", () => {
		it("videoPostText returns the title unchanged when short", () => {
			expect(videoPostText(makeVideo({ title: "Short" }))).toBe("Short");
		});

		it("videoPostText truncates an over-limit title", () => {
			const title = "x".repeat(400);
			const text = videoPostText(makeVideo({ title }));
			expect([...text].length).toBe(BLUESKY_GRAPHEME_LIMIT);
			expect(text.endsWith("…")).toBe(true);
		});

		it("videoCardDescription uses the first non-empty line", () => {
			const video = makeVideo({ description: "\n\nFirst line\nSecond line" });
			expect(videoCardDescription(video)).toBe("First line");
		});

		it("descriptionChunks is empty when there is no description", () => {
			expect(descriptionChunks(makeVideo({ description: "   " }))).toEqual([]);
		});

		it("descriptionChunks splits a long description into a reply chain", () => {
			const description = "Line of description. ".repeat(60);
			const chunks = descriptionChunks(makeVideo({ description }));
			expect(chunks.length).toBeGreaterThan(1);
		});
	});

	describe("community helpers", () => {
		it("renderPollAsText renders question and options with percentages", () => {
			const text = renderPollAsText({
				question: "Best language?",
				options: [
					{ text: "TS", votePercent: 70 },
					{ text: "JS", votePercent: 30 },
				],
			});
			expect(text).toContain("Best language?");
			expect(text).toContain("TS — 70%");
			expect(text).toContain("JS — 30%");
		});

		it("communityPostText appends the rendered poll", () => {
			const post = makeCommunityPost({
				text: "Vote!",
				poll: { question: "Q", options: [{ text: "A" }] },
			});
			const text = communityPostText(post);
			expect(text).toContain("Vote!");
			expect(text).toContain("Q");
			expect(text).toContain("A");
		});

		it("communityChunks always yields at least one chunk", () => {
			expect(communityChunks(makeCommunityPost({ text: "", images: ["a"] }))).toEqual([""]);
		});

		it("communityImages caps at the Bluesky image limit", () => {
			const images = Array.from({ length: 8 }, (_, i) => `https://img/${i}.jpg`);
			expect(communityImages(makeCommunityPost({ images }))).toHaveLength(MAX_BLUESKY_IMAGES);
		});
	});
});
