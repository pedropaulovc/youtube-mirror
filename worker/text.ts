/**
 * Truncate a string to a maximum number of grapheme clusters,
 * appending an ellipsis indicator when truncation occurs.
 *
 * Uses `Intl.Segmenter` for correct grapheme-cluster counting
 * (handles emoji, combining marks, etc.).
 */
export function truncateGraphemes(
	text: string,
	maxGraphemes: number,
	ellipsis: string = "…",
): string {
	const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
	const segments = [...segmenter.segment(text)];
	if (segments.length <= maxGraphemes) return text;
	// Reserve one grapheme for the ellipsis so the result is at most maxGraphemes
	// total — callers size maxGraphemes against hard caps (e.g. Bluesky's 64-grapheme
	// displayName) and then append a suffix, so an off-by-one overflows the cap.
	const ellipsisLen = [...segmenter.segment(ellipsis)].length;
	return (
		segments
			.slice(0, Math.max(0, maxGraphemes - ellipsisLen))
			.map((s) => s.segment)
			.join("") + ellipsis
	);
}
