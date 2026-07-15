import { normalizeChannelId } from "./handles";

// --- Helpers ---

export type ItemKind = "video" | "community" | "comment";

/** Deterministic workflow ID — one workflow per (channel, kind, item) triple. */
export function itemWorkflowId(channelId: string, kind: ItemKind, itemId: string): string {
	return `item-${normalizeChannelId(channelId)}-${kind}-${itemId}`;
}

// --- KV Schema Types ---

export interface CachedSession {
	accessJwt: string;
	did: string;
	handle: string;
}

export interface BlueskyAccountConfig {
	passwordKey: string;
	atProtoAccount: string;
	email: string;
}

export interface ChannelConfig {
	/** Channel's own content (videos, community posts) is mirrored here. */
	main: BlueskyAccountConfig;
	/** Foreign commenters' replies are mirrored here ("@commenter: ..."). */
	rt: BlueskyAccountConfig;
	/** YouTube @handle without the leading "@" — used for the community-tab URL. */
	handle: string;
	/** Uploads playlist ID (UU…). Derived from channelId (UC…→UU…) and cached. */
	uploadsPlaylistId?: string;
	maxItems?: number; // videos+community fetched per poll (default 15, max 50)
	pollIntervalMinutes?: number; // default 15, min 1
	communityPollIntervalMinutes?: number; // default 60, min 1
	bioSuffix?: string; // custom bio suffix (replaces BIO_DISCLAIMER when set)
	mirrorComments?: boolean; // default true
	mirrorCommunity?: boolean; // default true
}

// Per-channel change-detection snapshot for the cheap polling gate. Stored at
// `channel-meta:{channelId}`, refreshed every poll. See worker/change-gate.ts.
export interface ChannelMeta {
	latestVideoPublishedAt: string | null;
	latestCommunityId: string | null;
	updatedAt: string;
}

export interface MirroredRecord {
	bskyUri: string;
	bskyCid: string;
	account: "main" | "rt";
	kind: ItemKind;
	createdAt: string;
	deletedAt?: string;
	// Continuation-segment URIs of a self-reply chain (the root is `bskyUri`).
	// Present only when a video description / long community post spanned multiple
	// Bluesky posts, so the delete-check can remove the whole chain, not just the root.
	chainUris?: string[];
}

// Stored as both the value and the KV list metadata of `recent:{channelId}:{itemId}`
// keys (the delete-check recency index). The minimal slice delete-check needs to
// locate and remove a Bluesky post without reading the full MirroredRecord.
export interface RecentIndexEntry {
	bskyUri: string;
	account: "main" | "rt";
}

// --- Content Types (normalized from YouTube Data API v3 / Firecrawl) ---

export type AuthorRelation = "self" | "cross-mirror" | "foreign";

export interface VideoItem {
	kind: "video";
	id: string; // videoId
	channelId: string;
	channelTitle: string;
	title: string;
	description: string;
	publishedAt: string; // ISO 8601
	durationSeconds: number;
	isShort: boolean;
	thumbnailUrl?: string;
	thumbnailWidth?: number;
	thumbnailHeight?: number;
	watchUrl: string; // https://www.youtube.com/watch?v={id}
}

export interface Poll {
	question?: string;
	options: { text: string; votePercent?: number }[];
}

export interface CommunityPostItem {
	kind: "community";
	id: string; // postId
	channelId: string;
	text: string;
	publishedAt?: string; // absolute ISO when derivable
	publishedText?: string; // relative label from scrape ("2 days ago")
	images: string[];
	poll?: Poll;
	likeText?: string;
	postUrl: string; // https://www.youtube.com/post/{id}
}

export interface CommentItem {
	kind: "comment";
	id: string; // commentId
	channelId: string; // the mirrored channel
	/** Item this comment threads under: a videoId, community postId, or parent commentId. */
	parentItemId: string;
	parentItemKind: "video" | "community" | "comment";
	videoId?: string; // the root video (top-level and nested video comments)
	authorChannelId?: string;
	authorDisplayName: string;
	authorHandle?: string;
	text: string;
	publishedAt: string; // ISO 8601
	/** True when the comment's author is the mirrored channel itself. */
	isChannelOwner: boolean;
}

export type ContentItem = VideoItem | CommunityPostItem | CommentItem;
