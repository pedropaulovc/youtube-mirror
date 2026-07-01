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
	return (
		segments
			.slice(0, maxGraphemes)
			.map((s) => s.segment)
			.join("") + ellipsis
	);
}
