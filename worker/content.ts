import nlp from "compromise";
import type { CommunityPostItem, ContentItem, ItemKind, Poll, VideoItem } from "./types";
import { BLUESKY_GRAPHEME_LIMIT } from "./constants";

export function classifyItem(item: ContentItem): ItemKind {
	return item.kind;
}

// --- Text chunking (ported from twitter-mirror's tweets.ts) ---------------

function isInsideUrl(text: string, idx: number): boolean {
	for (let i = idx - 1; i >= 0; i--) {
		const ch = text[i];
		if (ch === " " || ch === "\n" || ch === "\t") return false;
		const remaining = text.substring(i);
		if (remaining.startsWith("https://") || remaining.startsWith("http://")) return true;
	}
	return false;
}

/**
 * Find the best clause-level break within `window`. Returns the char index to
 * split AFTER, or -1. Hierarchy: semicolon > comma > dash > conjunction.
 */
function findClauseBreak(window: string, minPos: number): number {
	const patterns: RegExp[] = [/;\s/g, /,\s/g, /\s-\s/g, /\s(?:and|but|which|that|who)\s/gi];
	for (const pattern of patterns) {
		let best = -1;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(window)) !== null) {
			const breakAt = match.index + match[0].length;
			if (breakAt >= minPos && breakAt > best) best = breakAt;
		}
		if (best !== -1) return best;
	}
	return -1;
}

/** Split oversized text using the full hierarchy: sentence > clause > word > hard. */
function splitOversized(text: string, maxGraphemes: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while ([...remaining].length > 0) {
		const remainingGraphemes = [...remaining];
		if (remainingGraphemes.length <= maxGraphemes) {
			chunks.push(remaining);
			break;
		}

		const window = remainingGraphemes.slice(0, maxGraphemes).join("");
		const minPos = Math.floor(maxGraphemes / 4);

		// 1. Sentence boundary (.!? followed by space, not inside URL)
		let bestSentenceBreak = -1;
		for (let i = 0; i < window.length; i++) {
			const ch = window[i];
			if ((ch === "." || ch === "!" || ch === "?") && !isInsideUrl(window, i)) {
				const nextIdx = i + 1;
				if (nextIdx >= window.length || window[nextIdx] === " " || window[nextIdx] === "\n") {
					bestSentenceBreak = i;
				}
			}
		}
		if (bestSentenceBreak >= minPos) {
			chunks.push(remaining.substring(0, bestSentenceBreak + 1));
			remaining = remaining.substring(bestSentenceBreak + 1).trimStart();
			continue;
		}

		// 2. Clause boundary
		const clauseBreak = findClauseBreak(window, minPos);
		if (clauseBreak !== -1) {
			chunks.push(remaining.substring(0, clauseBreak).trimEnd());
			remaining = remaining.substring(clauseBreak).trimStart();
			continue;
		}

		// 3. Word boundary (last space)
		let lastSpace = -1;
		for (let i = window.length - 1; i >= 0; i--) {
			if (window[i] === " ") {
				lastSpace = i;
				break;
			}
		}
		if (lastSpace > 0 && lastSpace >= maxGraphemes / 2) {
			chunks.push(remaining.substring(0, lastSpace));
			remaining = remaining.substring(lastSpace + 1);
			continue;
		}

		// 4. Hard split at grapheme boundary
		chunks.push(remainingGraphemes.slice(0, maxGraphemes).join(""));
		remaining = remainingGraphemes.slice(maxGraphemes).join("");
	}

	return chunks;
}

/**
 * Split text into Bluesky-sized chunks (≤ maxGraphemes each), preferring
 * sentence boundaries. Empty input yields a single empty chunk (Bluesky
 * requires the text field to be present).
 */
export function splitIntoChunks(text: string, maxGraphemes: number = BLUESKY_GRAPHEME_LIMIT): string[] {
	if (text === "") return [""];
	const graphemes = [...text];
	if (graphemes.length <= maxGraphemes) return [text];

	const sentences = nlp(text).sentences().out("array") as string[];
	const chunks: string[] = [];
	let current = "";

	for (const sentence of sentences) {
		const trimmed = sentence.trim();
		if (!trimmed) continue;

		const candidate = current ? `${current} ${trimmed}` : trimmed;
		if ([...candidate].length <= maxGraphemes) {
			current = candidate;
			continue;
		}

		if (current) {
			chunks.push(current);
			current = trimmed;
		} else {
			current = trimmed;
		}

		while ([...current].length > maxGraphemes) {
			const parts = splitOversized(current, maxGraphemes);
			for (let i = 0; i < parts.length - 1; i++) chunks.push(parts[i]);
			current = parts[parts.length - 1];
		}
	}

	if (current.trim()) chunks.push(current.trim());
	const filtered = chunks.filter((c) => c.length > 0);
	return filtered.length > 0 ? filtered : [""];
}

// --- Video helpers --------------------------------------------------------

/** Post text for a video's root post: the title, capped at the grapheme limit. */
export function videoPostText(video: VideoItem): string {
	const chars = [...video.title];
	if (chars.length <= BLUESKY_GRAPHEME_LIMIT) return video.title;
	return chars.slice(0, BLUESKY_GRAPHEME_LIMIT - 1).join("") + "…";
}

/** Short description used on the external link card (not the reply chain). */
export function videoCardDescription(video: VideoItem, maxChars: number = 300): string {
	const firstLine = video.description.split("\n").find((l) => l.trim().length > 0) ?? "";
	const chars = [...firstLine];
	return chars.length <= maxChars ? firstLine : chars.slice(0, maxChars - 1).join("") + "…";
}

/** The video description split into a threaded self-reply chain (empty if none). */
export function descriptionChunks(video: VideoItem): string[] {
	const desc = video.description.trim();
	if (!desc) return [];
	return splitIntoChunks(desc);
}

// --- Community helpers ----------------------------------------------------

export function renderPollAsText(poll: Poll): string {
	const lines: string[] = [];
	if (poll.question) lines.push(`📊 ${poll.question}`);
	for (const opt of poll.options) {
		lines.push(opt.votePercent != null ? `▫️ ${opt.text} — ${opt.votePercent}%` : `▫️ ${opt.text}`);
	}
	return lines.join("\n");
}

/** Full text for a community post: body plus poll rendering. */
export function communityPostText(post: CommunityPostItem): string {
	const parts: string[] = [];
	if (post.text.trim()) parts.push(post.text.trim());
	if (post.poll) parts.push(renderPollAsText(post.poll));
	return parts.join("\n\n");
}

/** Community post text split into chunks for a self-reply chain. */
export function communityChunks(post: CommunityPostItem): string[] {
	return splitIntoChunks(communityPostText(post));
}

// Bluesky allows at most 4 images per post.
export const MAX_BLUESKY_IMAGES = 4;

export function communityImages(post: CommunityPostItem): string[] {
	return post.images.slice(0, MAX_BLUESKY_IMAGES);
}
