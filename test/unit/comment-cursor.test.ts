import { describe, it, expect } from "vitest";
import { safeCommentCursor } from "../../worker/comment-cursor";

const c = (publishedAt: string) => ({ publishedAt });

describe("safeCommentCursor", () => {
	it("stays below the newest second even when all dispatched (overlap for same-second late comments)", () => {
		// A comment created in the newest second just after the fetch would be filtered
		// out forever by `> cursor`, so hold the cursor at the previous timestamp.
		const comments = [c("2026-06-01T10:00:00Z"), c("2026-06-01T10:00:05Z"), c("2026-06-01T10:00:09Z")];
		expect(safeCommentCursor(comments, null)).toBe("2026-06-01T10:00:05Z");
	});

	it("does not advance when the whole successful batch sits in one second", () => {
		const comments = [c("2026-06-01T10:00:05Z"), c("2026-06-01T10:00:05Z")];
		expect(safeCommentCursor(comments, null)).toBeUndefined();
	});

	it("returns undefined for an empty batch", () => {
		expect(safeCommentCursor([], null)).toBeUndefined();
	});

	it("caps the cursor below the first failed comment's timestamp", () => {
		// index 2 failed; the cursor should stop at index 1, not reach index 2/3.
		const comments = [c("2026-06-01T10:00:00Z"), c("2026-06-01T10:00:05Z"), c("2026-06-01T10:00:07Z"), c("2026-06-01T10:00:09Z")];
		expect(safeCommentCursor(comments, 2)).toBe("2026-06-01T10:00:05Z");
	});

	it("does not land on a timestamp shared with the failed comment (second-granular tie)", () => {
		// index 1 succeeded and index 2 FAILED at the same second: advancing to that
		// second would filter the failed comment out via the strict `> cursor` refetch.
		const comments = [c("2026-06-01T10:00:00Z"), c("2026-06-01T10:00:05Z"), c("2026-06-01T10:00:05Z"), c("2026-06-01T10:00:09Z")];
		expect(safeCommentCursor(comments, 2)).toBe("2026-06-01T10:00:00Z");
	});

	it("does not advance at all when the whole batch ties with an immediate failure", () => {
		const comments = [c("2026-06-01T10:00:05Z"), c("2026-06-01T10:00:05Z")];
		expect(safeCommentCursor(comments, 0)).toBeUndefined();
	});
});
