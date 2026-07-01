/**
 * Compute the timestamp to advance `comment-cursor:{channelId}:{videoId}` to after
 * a poll dispatched a batch of comments (oldest-first).
 *
 * The next poll refetches with a strict `publishedAt > cursor` filter, so the cursor
 * must never land ON a timestamp shared with a comment that FAILED to dispatch —
 * YouTube `publishedAt` is second-granular, so ties within a second are common, and
 * a tie would filter the failed comment out forever. When a dispatch fails, hold the
 * cursor at the newest timestamp strictly older than the failed comment's, so it (and
 * everything at or after it) is retried next poll. Returns `undefined` when the cursor
 * must not advance at all.
 */
export function safeCommentCursor(
	comments: ReadonlyArray<{ publishedAt: string }>,
	firstFailedIndex: number | null,
): string | undefined {
	if (firstFailedIndex === null) return comments[comments.length - 1]?.publishedAt;

	const failedAt = comments[firstFailedIndex]?.publishedAt;
	if (failedAt === undefined) return comments[comments.length - 1]?.publishedAt;

	let cursor: string | undefined;
	for (let i = 0; i < firstFailedIndex; i++) {
		if (comments[i].publishedAt < failedAt) cursor = comments[i].publishedAt;
	}
	return cursor;
}
