import { FIRECRAWL_SCRAPE_URL, FIRECRAWL_TIMEOUT_MS } from "./constants";
import { communityPostUrl } from "./youtube-api";
import type { CommunityPostItem, Poll } from "./types";
import { normalizeHandle } from "./handles";
import { warn, verbose } from "./log";

// YouTube's Data API v3 has no community-post endpoint, so the community tab is
// scraped via Firecrawl. We request the raw HTML (a cheap scrape) rather than
// Firecrawl's LLM-backed JSON extraction (expensive): YouTube server-renders the
// full community feed into a `ytInitialData` blob in the page, which we parse here.

export function communityTabUrl(handle: string): string {
	return `https://www.youtube.com/@${normalizeHandle(handle)}/community`;
}

/** Parse the community post ID (`Ug…`) out of a post URL. */
export function postIdFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const m = /\/post\/([\w-]+)/.exec(url);
	return m?.[1];
}

// --- ytInitialData parsing ------------------------------------------------

type JsonObject = { [key: string]: unknown };

/** Slice a brace-balanced JSON object out of `s` starting at the `{` at `start`. */
function sliceBalancedObject(s: string, start: number): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return s.slice(start, i + 1);
		}
	}
	return null;
}

/** Extract and parse the `ytInitialData` object embedded in a YouTube page's HTML. */
export function extractYtInitialData(html: string): unknown | null {
	const marker = "ytInitialData";
	let i = html.indexOf(marker);
	while (i !== -1) {
		const braceStart = html.indexOf("{", i);
		if (braceStart === -1) return null;
		const json = sliceBalancedObject(html, braceStart);
		if (json) {
			try {
				return JSON.parse(json);
			} catch {
				// The first match may be a lexer reference, not the assignment — keep looking.
			}
		}
		i = html.indexOf(marker, i + marker.length);
	}
	return null;
}

/** Depth-first collect every value stored under `key` anywhere in the tree. */
function collectRenderers(node: unknown, key: string, out: JsonObject[]): void {
	if (Array.isArray(node)) {
		for (const n of node) collectRenderers(n, key, out);
		return;
	}
	if (!node || typeof node !== "object") return;
	for (const [k, v] of Object.entries(node as JsonObject)) {
		if (k === key && v && typeof v === "object") out.push(v as JsonObject);
		collectRenderers(v, key, out);
	}
}

/** Concatenate a YouTube text object's `runs[].text` (or its `simpleText`). */
function runsText(holder: unknown): string {
	if (!holder || typeof holder !== "object") return "";
	const h = holder as { runs?: { text?: string }[]; simpleText?: string };
	if (Array.isArray(h.runs)) return h.runs.map((r) => r.text ?? "").join("");
	return h.simpleText ?? "";
}

function extractImages(attachment: unknown): string[] {
	if (!attachment) return [];
	const images: JsonObject[] = [];
	collectRenderers(attachment, "backstageImageRenderer", images);
	const urls: string[] = [];
	for (const img of images) {
		const thumbs = ((img.image as { thumbnails?: { url?: string; width?: number }[] })?.thumbnails) ?? [];
		const best = thumbs.reduce<{ url?: string; width?: number } | undefined>(
			(acc, t) => ((t.width ?? 0) > (acc?.width ?? 0) ? t : acc),
			thumbs[0],
		);
		if (best?.url) urls.push(best.url);
	}
	return urls;
}

function extractPoll(attachment: unknown): Poll | undefined {
	if (!attachment) return undefined;
	const polls: JsonObject[] = [];
	collectRenderers(attachment, "pollRenderer", polls);
	const pr = polls[0];
	if (!pr) return undefined;
	const choices = (pr.choices as { text?: unknown }[] | undefined) ?? [];
	const options = choices
		.map((c) => ({ text: runsText(c.text) }))
		.filter((o) => o.text.length > 0);
	if (options.length === 0) return undefined;
	// Per-choice vote percentages aren't present in ytInitialData, only totals.
	return { options };
}

/** Normalize one `backstagePostRenderer` from ytInitialData into a CommunityPostItem. */
export function normalizeBackstagePost(renderer: JsonObject, channelId: string): CommunityPostItem | null {
	const id = typeof renderer.postId === "string" ? renderer.postId : undefined;
	if (!id) return null; // no stable ID → can't dedupe, skip

	const attachment = renderer.backstageAttachment;
	return {
		kind: "community",
		id,
		channelId,
		text: runsText(renderer.contentText),
		publishedText: runsText(renderer.publishedTimeText) || undefined,
		images: extractImages(attachment),
		poll: extractPoll(attachment),
		likeText: runsText(renderer.voteCount) || undefined,
		postUrl: communityPostUrl(id),
	};
}

/** Parse all community posts out of a YouTube community-tab page's raw HTML. */
export function parseCommunityPosts(html: string, channelId: string): CommunityPostItem[] {
	const data = extractYtInitialData(html);
	if (!data) return [];

	const renderers: JsonObject[] = [];
	collectRenderers(data, "backstagePostRenderer", renderers);

	const posts: CommunityPostItem[] = [];
	const seen = new Set<string>();
	for (const renderer of renderers) {
		const post = normalizeBackstagePost(renderer, channelId);
		if (post && !seen.has(post.id)) {
			seen.add(post.id);
			posts.push(post);
		}
	}
	return posts;
}

/**
 * Scrape a channel's community tab via Firecrawl and return normalized posts.
 * Requests raw HTML only (no LLM extraction) and parses `ytInitialData` locally.
 * Returns an empty array on any failure (network, non-OK, no data) — community
 * mirroring is best-effort and never blocks video/comment mirroring.
 */
export async function fetchCommunityPosts(
	handle: string,
	channelId: string,
	apiKey: string,
): Promise<CommunityPostItem[]> {
	const url = communityTabUrl(handle);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(FIRECRAWL_SCRAPE_URL, {
			method: "POST",
			signal: controller.signal,
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				url,
				formats: ["rawHtml"],
				onlyMainContent: false,
				proxy: "stealth",
			}),
		});
	} catch (err) {
		warn({ tag: "yt-community", handle, message: `Firecrawl scrape threw for ${url}`, error: String(err) });
		return [];
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		warn({ tag: "yt-community", handle, status: response.status, message: `Firecrawl scrape non-OK for ${url}` });
		return [];
	}

	const json = (await response.json().catch(() => null)) as { data?: { rawHtml?: string } } | null;
	const html = json?.data?.rawHtml;
	if (!html) {
		verbose({ tag: "yt-community", handle, message: `Firecrawl returned no HTML for ${url}` });
		return [];
	}

	return parseCommunityPosts(html, channelId);
}
