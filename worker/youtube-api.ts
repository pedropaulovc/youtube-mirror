import { YOUTUBE_API_BASE, PLAYLIST_PAGE_SIZE, SHORTS_MAX_SECONDS } from "./constants";
import type { CommentItem, VideoItem } from "./types";
import { warn } from "./log";

// --- Public helpers -------------------------------------------------------

/**
 * Derive a channel's uploads playlist ID from its channel ID. Every channel's
 * uploads live in a playlist whose ID is the channel ID with the `UC` prefix
 * swapped for `UU` — so we skip a `channels.list` call entirely.
 */
export function uploadsPlaylistId(channelId: string): string {
	return channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : channelId;
}

export function watchUrl(videoId: string): string {
	return `https://www.youtube.com/watch?v=${videoId}`;
}

export function communityPostUrl(postId: string): string {
	return `https://www.youtube.com/post/${postId}`;
}

/** Parse an ISO-8601 duration ("PT1H2M3S") to whole seconds. */
export function parseIso8601Duration(duration: string): number {
	const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
	if (!m) return 0;
	const [, d, h, min, s] = m;
	return (
		(d ? Number(d) * 86400 : 0) +
		(h ? Number(h) * 3600 : 0) +
		(min ? Number(min) * 60 : 0) +
		(s ? Number(s) : 0)
	);
}

// --- Raw response shapes (only the fields we read) ------------------------

interface Thumbnail {
	url: string;
	width?: number;
	height?: number;
}
interface Thumbnails {
	default?: Thumbnail;
	medium?: Thumbnail;
	high?: Thumbnail;
	standard?: Thumbnail;
	maxres?: Thumbnail;
}
interface PlaylistItemsResponse {
	items?: { contentDetails?: { videoId?: string } }[];
	nextPageToken?: string;
}
interface VideoResource {
	id: string;
	snippet?: {
		title?: string;
		description?: string;
		publishedAt?: string;
		channelId?: string;
		channelTitle?: string;
		thumbnails?: Thumbnails;
	};
	contentDetails?: { duration?: string };
}
interface VideosResponse {
	items?: VideoResource[];
}
interface CommentResource {
	id: string;
	snippet?: {
		authorDisplayName?: string;
		authorChannelId?: { value?: string };
		textOriginal?: string;
		textDisplay?: string;
		publishedAt?: string;
	};
}
interface CommentThreadsResponse {
	items?: {
		snippet?: { topLevelComment?: CommentResource; totalReplyCount?: number };
		replies?: { comments?: CommentResource[] };
	}[];
	nextPageToken?: string;
}
interface CommentsListResponse {
	items?: CommentResource[];
	nextPageToken?: string;
}
export interface ChannelInfo {
	title: string;
	description: string;
	avatarUrl?: string;
	bannerUrl?: string;
	uploadsPlaylistId?: string;
}
interface ChannelsResponse {
	items?: {
		snippet?: { title?: string; description?: string; thumbnails?: Thumbnails };
		brandingSettings?: { image?: { bannerExternalUrl?: string } };
		contentDetails?: { relatedPlaylists?: { uploads?: string } };
	}[];
}

// --- Fetch core -----------------------------------------------------------

async function ytFetch<T>(path: string, params: { [key: string]: string }, accessToken: string): Promise<T> {
	const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

	const res = await fetch(url.toString(), {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`YouTube API ${path} failed: ${res.status} ${body.slice(0, 300)}`);
	}
	return (await res.json()) as T;
}

function pickThumbnail(t: Thumbnails | undefined): Thumbnail | undefined {
	return t?.maxres ?? t?.standard ?? t?.high ?? t?.medium ?? t?.default;
}

// --- Public API -----------------------------------------------------------

/**
 * List the most recent upload video IDs (newest first) from a channel's uploads
 * playlist. `playlistItems.list` costs 1 quota unit vs. 100 for `search.list`.
 */
export async function fetchRecentVideoIds(
	uploadsId: string,
	maxItems: number,
	accessToken: string,
): Promise<string[]> {
	const ids: string[] = [];
	let pageToken: string | undefined;
	while (ids.length < maxItems) {
		const params: { [key: string]: string } = {
			part: "contentDetails",
			playlistId: uploadsId,
			maxResults: String(Math.min(PLAYLIST_PAGE_SIZE, maxItems - ids.length)),
		};
		if (pageToken) params.pageToken = pageToken;
		const data = await ytFetch<PlaylistItemsResponse>("playlistItems", params, accessToken);
		for (const item of data.items ?? []) {
			const id = item.contentDetails?.videoId;
			if (id) ids.push(id);
		}
		if (!data.nextPageToken) break;
		pageToken = data.nextPageToken;
	}
	return ids;
}

/** Fetch full video details (batched ≤50 IDs per call, 1 unit each). */
export async function fetchVideos(videoIds: string[], accessToken: string): Promise<VideoItem[]> {
	const videos: VideoItem[] = [];
	for (let i = 0; i < videoIds.length; i += 50) {
		const batch = videoIds.slice(i, i + 50);
		const data = await ytFetch<VideosResponse>(
			"videos",
			{ part: "snippet,contentDetails", id: batch.join(",") },
			accessToken,
		);
		for (const v of data.items ?? []) {
			videos.push(normalizeVideo(v));
		}
	}
	return videos;
}

export function normalizeVideo(v: VideoResource): VideoItem {
	const snippet = v.snippet ?? {};
	const durationSeconds = parseIso8601Duration(v.contentDetails?.duration ?? "");
	const thumb = pickThumbnail(snippet.thumbnails);
	return {
		kind: "video",
		id: v.id,
		channelId: snippet.channelId ?? "",
		channelTitle: snippet.channelTitle ?? "",
		title: snippet.title ?? "",
		description: snippet.description ?? "",
		publishedAt: snippet.publishedAt ?? new Date(0).toISOString(),
		durationSeconds,
		isShort: durationSeconds > 0 && durationSeconds <= SHORTS_MAX_SECONDS,
		thumbnailUrl: thumb?.url,
		thumbnailWidth: thumb?.width,
		thumbnailHeight: thumb?.height,
		watchUrl: watchUrl(v.id),
	};
}

/**
 * Fetch comments on a video, newest first, as flat `CommentItem`s (top-level
 * comments and their replies). `after` filters to comments published strictly
 * after that ISO timestamp so polling is incremental. Ordered oldest-first in
 * the return value so a parent is always mirrored before its replies.
 */
export async function fetchComments(
	videoId: string,
	channelId: string,
	accessToken: string,
	after?: string,
	backfillCap: number = 100,
): Promise<CommentItem[]> {
	const afterMs = after ? new Date(after).getTime() : -Infinity;
	const incremental = Number.isFinite(afterMs);
	const out: CommentItem[] = [];

	// Two regimes, threads fetched newest-first:
	//  - Incremental (cursor set): drain EVERY thread newer than the cursor, across as
	//    many pages as it takes. The caller advances the cursor to the newest thread it
	//    sees, so stopping early strands the older-but-still-new threads on unfetched
	//    pages forever. HARD_PAGE_CAP only bounds the pathological case of a video
	//    gaining thousands of comments in one poll window (logged, not silent).
	//  - Cold start (no cursor): take just the newest `backfillCap` threads as a bounded
	//    backfill — don't drain the video's entire comment history on first sight.
	const HARD_PAGE_CAP = 20;
	const maxPages = incremental ? HARD_PAGE_CAP : Math.max(1, Math.ceil(backfillCap / 100));
	let pageToken: string | undefined;
	let threadCount = 0;
	let morePages = false;
	for (let page = 0; page < maxPages; page++) {
		const remaining = incremental ? 100 : Math.min(100, backfillCap - threadCount);
		if (remaining <= 0) {
			morePages = true; // cold-start backfill cap reached (bounded by design)
			break;
		}
		const params: { [key: string]: string } = {
			part: "snippet,replies",
			videoId,
			order: "time",
			textFormat: "plainText", // else textDisplay carries HTML markup/entities
			maxResults: String(remaining),
		};
		if (pageToken) params.pageToken = pageToken;

		let data: CommentThreadsResponse;
		try {
			data = await ytFetch<CommentThreadsResponse>("commentThreads", params, accessToken);
		} catch (err) {
			warn({ tag: "yt-comments", videoId, message: `commentThreads fetch failed for ${videoId}`, error: String(err) });
			// A FIRST-page failure is non-fatal — commonly a 403 because comments are
			// disabled (and an empty batch never advances the cursor). But once we've paged
			// past the first page, threads demonstrably exist, so this is transient; returning
			// the partial batch would let the caller advance `comment-cursor` past the unread
			// older-but-still-new threads. Propagate so the step retries.
			if (pageToken) throw err;
			morePages = false;
			break;
		}

		let newestInPage = -Infinity;
		for (const thread of data.items ?? []) {
			threadCount++;
			const top = thread.snippet?.topLevelComment;
			if (!top) continue;
			const topItem = normalizeComment(top, channelId, videoId, videoId, "video");
			const topMs = new Date(topItem.publishedAt).getTime();
			newestInPage = Math.max(newestInPage, topMs);
			if (topMs > afterMs) out.push(topItem);

			await appendThreadReplies(out, thread, topItem.id, channelId, videoId, accessToken, afterMs);
		}

		// Threads are newest-first: once an entire page predates the cursor, every
		// later page does too. Stop, too, when the API has no further pages.
		if (newestInPage <= afterMs || !data.nextPageToken) {
			morePages = false;
			break;
		}
		pageToken = data.nextPageToken;
		morePages = true; // a next page exists; if the loop cap stops us, this stays true
	}

	// Incremental poll that hit the page cap with threads newer than the cursor still
	// unfetched: the caller will advance the cursor past them. Rare (>2000 new comments
	// in one window), but surface it rather than dropping silently.
	if (incremental && morePages) {
		warn({ tag: "yt-comments", videoId, message: `comment paging hit ${HARD_PAGE_CAP}-page cap for ${videoId}; older new comments this cycle may be skipped` });
	}

	// Oldest-first so parents precede replies when dispatched.
	return out.sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
}

/**
 * Append a thread's replies to `out`. `commentThreads.list` inlines only a subset
 * of replies; when a thread has more than the inline set, fall back to the paginated
 * `comments.list` so no still-new reply is silently dropped.
 */
async function appendThreadReplies(
	out: CommentItem[],
	thread: NonNullable<CommentThreadsResponse["items"]>[number],
	topCommentId: string,
	channelId: string,
	videoId: string,
	accessToken: string,
	afterMs: number,
): Promise<void> {
	const inline = thread.replies?.comments ?? [];
	const total = thread.snippet?.totalReplyCount ?? inline.length;

	if (total > inline.length) {
		try {
			const afterIso = Number.isFinite(afterMs) ? new Date(afterMs).toISOString() : undefined;
			const replies = await fetchCommentReplies(topCommentId, channelId, videoId, accessToken, afterIso);
			out.push(...replies);
			return;
		} catch (err) {
			warn({ tag: "yt-comments", videoId, message: `comments.list fetch failed for ${topCommentId}`, error: String(err) });
			// Returning only the inline subset would let the caller advance `comment-cursor`
			// past the replies this failed fetch omitted — the `> cursor` filter then drops
			// them on every later poll. The poller writes a cursor after a successful poll on
			// BOTH cold backfills and incremental polls, so propagate in either case and let
			// the workflow step retry.
			throw err;
		}
	}

	for (const reply of inline) {
		const replyItem = normalizeComment(reply, channelId, videoId, topCommentId, "comment");
		if (new Date(replyItem.publishedAt).getTime() > afterMs) out.push(replyItem);
	}
}

export function normalizeComment(
	c: CommentResource,
	channelId: string,
	videoId: string,
	parentItemId: string,
	parentItemKind: "video" | "comment",
): CommentItem {
	const s = c.snippet ?? {};
	const authorChannelId = s.authorChannelId?.value;
	return {
		kind: "comment",
		id: c.id,
		channelId,
		parentItemId,
		parentItemKind,
		videoId,
		authorChannelId,
		authorDisplayName: s.authorDisplayName ?? "",
		authorHandle: s.authorDisplayName?.startsWith("@") ? s.authorDisplayName.slice(1) : undefined,
		text: s.textOriginal ?? s.textDisplay ?? "",
		publishedAt: s.publishedAt ?? new Date(0).toISOString(),
		isChannelOwner: !!authorChannelId && authorChannelId === channelId,
	};
}

/** Fetch channel branding for profile sync. */
export async function fetchChannelInfo(channelId: string, accessToken: string): Promise<ChannelInfo | null> {
	const data = await ytFetch<ChannelsResponse>(
		"channels",
		{ part: "snippet,brandingSettings,contentDetails", id: channelId },
		accessToken,
	);
	const item = data.items?.[0];
	if (!item) return null;
	const thumb = pickThumbnail(item.snippet?.thumbnails);
	return {
		title: item.snippet?.title ?? "",
		description: item.snippet?.description ?? "",
		avatarUrl: thumb?.url,
		bannerUrl: item.brandingSettings?.image?.bannerExternalUrl,
		uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads,
	};
}

/** Confirm which of the given video IDs still exist (delete-check). */
export async function checkVideosExist(videoIds: string[], accessToken: string): Promise<Set<string>> {
	const alive: Set<string> = new Set();
	for (let i = 0; i < videoIds.length; i += 50) {
		const batch = videoIds.slice(i, i + 50);
		const data = await ytFetch<VideosResponse>("videos", { part: "id", id: batch.join(",") }, accessToken);
		for (const v of data.items ?? []) alive.add(v.id);
	}
	return alive;
}

/** Fetch replies to a single top-level comment beyond the inline 5 (comments.list). */
export async function fetchCommentReplies(
	parentCommentId: string,
	channelId: string,
	videoId: string,
	accessToken: string,
	after?: string,
): Promise<CommentItem[]> {
	const afterMs = after ? new Date(after).getTime() : -Infinity;
	const out: CommentItem[] = [];
	let pageToken: string | undefined;
	do {
		const params: { [key: string]: string } = { part: "snippet", parentId: parentCommentId, maxResults: "100", textFormat: "plainText" };
		if (pageToken) params.pageToken = pageToken;
		const data = await ytFetch<CommentsListResponse>("comments", params, accessToken);
		for (const c of data.items ?? []) {
			const item = normalizeComment(c, channelId, videoId, parentCommentId, "comment");
			if (new Date(item.publishedAt).getTime() > afterMs) out.push(item);
		}
		pageToken = data.nextPageToken;
	} while (pageToken);
	return out.sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
}
