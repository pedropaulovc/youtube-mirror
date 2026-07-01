import { describe, it, expect } from "vitest";
import {
	uploadsPlaylistId,
	watchUrl,
	communityPostUrl,
	parseIso8601Duration,
	normalizeVideo,
	normalizeComment,
} from "../../worker/youtube-api";
import { TEST_CHANNEL_ID } from "../helpers/factories";

describe("youtube-api", () => {
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
});
