import { FIRECRAWL_SCRAPE_URL, FIRECRAWL_TIMEOUT_MS } from "./constants";
import { communityPostUrl } from "./youtube-api";
import type { CommunityPostItem, Poll } from "./types";
import { normalizeHandle } from "./handles";
import { warn, verbose } from "./log";

// YouTube's Data API v3 has no community-post endpoint, so the community tab is
// scraped via Firecrawl (which renders the JS-heavy page through its own proxies)
// and structured with a JSON schema.

const COMMUNITY_SCHEMA = {
	type: "object",
	properties: {
		posts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					postId: { type: "string", description: "The community post ID (starts with 'Ug'), from the post URL" },
					postUrl: { type: "string", description: "Full URL to the post, e.g. https://www.youtube.com/post/Ug..." },
					text: { type: "string", description: "The post's text content" },
					publishedText: { type: "string", description: "Relative time label, e.g. '2 days ago'" },
					images: { type: "array", items: { type: "string" }, description: "Image URLs attached to the post" },
					poll: {
						type: "object",
						properties: {
							question: { type: "string" },
							options: {
								type: "array",
								items: {
									type: "object",
									properties: {
										text: { type: "string" },
										votePercent: { type: "number" },
									},
								},
							},
						},
					},
					likeText: { type: "string", description: "Like count label" },
				},
			},
		},
	},
} as const;

interface RawPoll {
	question?: string;
	options?: { text?: string; votePercent?: number }[];
}
interface RawPost {
	postId?: string;
	postUrl?: string;
	text?: string;
	publishedText?: string;
	images?: string[];
	poll?: RawPoll;
	likeText?: string;
}

export function communityTabUrl(handle: string): string {
	return `https://www.youtube.com/@${normalizeHandle(handle)}/community`;
}

/** Parse the community post ID (`Ug…`) out of a post URL. */
export function postIdFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const m = /\/post\/([\w-]+)/.exec(url);
	return m?.[1];
}

export function normalizeCommunityPost(raw: RawPost, channelId: string): CommunityPostItem | null {
	const id = raw.postId ?? postIdFromUrl(raw.postUrl);
	if (!id) return null; // no stable ID → can't dedupe, skip

	let poll: Poll | undefined;
	if (raw.poll && Array.isArray(raw.poll.options) && raw.poll.options.length > 0) {
		poll = {
			question: raw.poll.question,
			options: raw.poll.options
				.filter((o) => typeof o.text === "string")
				.map((o) => ({ text: o.text as string, votePercent: o.votePercent })),
		};
	}

	return {
		kind: "community",
		id,
		channelId,
		text: raw.text ?? "",
		publishedText: raw.publishedText,
		images: (raw.images ?? []).filter((u) => typeof u === "string"),
		poll,
		likeText: raw.likeText,
		postUrl: raw.postUrl ?? communityPostUrl(id),
	};
}

/**
 * Scrape a channel's community tab via Firecrawl and return normalized posts.
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
				// Firecrawl v2 nests JSON-extraction options inside the format entry
				// (`{ type: "json", schema, prompt }`); the older top-level `jsonOptions`
				// shape is rejected by /v2/scrape, which silently disables community mirroring.
				formats: [
					{
						type: "json",
						schema: COMMUNITY_SCHEMA,
						prompt: "Extract every community-tab post with its ID, text, images, poll, and relative publish time.",
					},
				],
				onlyMainContent: false,
				waitFor: 8000,
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

	const json = (await response.json().catch(() => null)) as { data?: { json?: { posts?: RawPost[] } } } | null;
	const rawPosts = json?.data?.json?.posts;
	if (!Array.isArray(rawPosts)) {
		verbose({ tag: "yt-community", handle, message: `Firecrawl returned no posts array for ${url}` });
		return [];
	}

	const posts: CommunityPostItem[] = [];
	for (const raw of rawPosts) {
		const normalized = normalizeCommunityPost(raw, channelId);
		if (normalized) posts.push(normalized);
	}
	return posts;
}
