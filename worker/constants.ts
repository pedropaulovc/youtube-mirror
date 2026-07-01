// Bluesky limits
export const BLUESKY_GRAPHEME_LIMIT = 300;
export const MAX_IMAGE_SIZE = 2_000_000; // Bluesky limit: 2 MB
export const SESSION_TTL = 6600; // 110 minutes (JWT TTL is 120m, 10m safety margin)

// Channel workflow limits
export const DEFAULT_MAX_ITEMS = 15; // videos + community posts fetched per poll
export const MAX_ITEMS_LIMIT = 50; // YouTube playlistItems maxResults cap
export const DEFAULT_POLL_INTERVAL_MINUTES = 15;

// Comment mirroring: only poll comments on videos published within this window,
// so an old back-catalogue doesn't get scanned every cycle.
export const COMMENT_LOOKBACK_HOURS = 48;
export const MAX_COMMENT_VIDEOS = 5; // most-recent videos to poll comments for

// Shorts detection: videos at or below this duration are YouTube Shorts.
export const SHORTS_MAX_SECONDS = 60;

// YouTube Data API v3
export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
export const PLAYLIST_PAGE_SIZE = 50;

// Firecrawl (community-tab scraping — YouTube's official API has no
// community-post endpoint, so these are the only source).
export const FIRECRAWL_ENABLED = true;
export const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
export const FIRECRAWL_TIMEOUT_MS = 25_000;

// Profile sync
export const UNOFFICIAL_SUFFIX = " [UNOFFICIAL]";
export const RT_DISPLAY_PREFIX = "Comments mirrored by ";
export const RT_DISPLAY_SUFFIX = ` ${UNOFFICIAL_SUFFIX.trim()}`;
export const BIO_DISCLAIMER =
	" // Mirror crossposting a YouTube channel to Bluesky. Unofficial. DM for takedown / claim ownership.";

// Bluesky moderation
export const BLUESKY_LABELER_DID = "did:plc:ar7c4by46qjdydhdevvrndac";
export const BLUESKY_PUBLIC_API = "https://public.api.bsky.app";

// Default PDS / entryway used when a handle's DID document can't be resolved to a
// concrete PDS service endpoint. bsky.social hosts the majority of accounts.
export const DEFAULT_PDS_URL = "https://bsky.social";
// PLC directory for resolving did:plc DID documents → PDS service endpoint.
export const PLC_DIRECTORY_URL = "https://plc.directory";
// Cache TTL for a resolved account→PDS mapping (KV `pds:{account}`). PDS moves are
// rare, so a long TTL keeps the two extra resolution round-trips off the hot path.
export const PDS_CACHE_TTL = 86400; // 24h

// Chain-progress marker (chain-progress:{channelId}:{itemId}) TTL. Records how far a
// multi-post reply chain got so a step retry resumes instead of re-posting the root.
// Deleted on success; the TTL only reaps markers orphaned by a permanently-failed item.
export const CHAIN_PROGRESS_TTL = 86400; // 24h

// Delete workflow
export const CHECK_WINDOW_HOURS = 24;

// Recency index (recent:{channelId}:{itemId}) TTL. Kept comfortably above the
// delete-check window so the index always covers it, with slack for cron cadence
// and KV's ~60s write propagation. Self-expiring → no manual GC, no backfill.
export const RECENT_INDEX_TTL_SECONDS = CHECK_WINDOW_HOURS * 60 * 60 * 3;
