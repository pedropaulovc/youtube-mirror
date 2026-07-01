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
	if (comments.length === 0) return undefined;

	// The boundary second the cursor must stay BELOW:
	//  - a failed dispatch: the failed comment's timestamp, so it (and everything at or
	//    after it) is refetched next poll;
	//  - all dispatched: the newest fetched comment's timestamp — a later comment created
	//    in that same second would otherwise be filtered out forever by the strict
	//    `> cursor` refetch.
	// Hold the cursor at the newest timestamp strictly below the boundary and let
	// filterNew dedupe the re-fetched overlap. Returns undefined (don't advance) when the
	// whole batch sits in the boundary second.
	const limit = firstFailedIndex === null ? comments.length : firstFailedIndex;
	const boundary = firstFailedIndex === null
		? comments[comments.length - 1].publishedAt
		: comments[firstFailedIndex].publishedAt;

	let cursor: string | undefined;
	for (let i = 0; i < limit; i++) {
		if (comments[i].publishedAt < boundary) cursor = comments[i].publishedAt;
	}
	return cursor;
}
