import { normalizeChannelId } from "./handles";
import type { CachedSession, ChannelConfig, ChannelMeta, MirroredRecord } from "./types";

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

export function parseConfiguredChannelIds(value: unknown): string[] {
	if (typeof value !== "string") {
		throw new Error("MIRROR_CHANNEL_IDS binding is missing");
	}

	const ids = [...new Set(value.split(",").map(normalizeChannelId).filter(Boolean))];
	if (ids.length === 0 || ids.some((id) => !CHANNEL_ID.test(id))) {
		throw new Error("MIRROR_CHANNEL_IDS binding must be a comma-separated list of valid YouTube channel IDs");
	}
	return ids;
}

export function parseConfiguredChannelIdsFromEnvironment(environment: unknown): string[] {
	if (typeof environment !== "object" || environment === null) {
		return parseConfiguredChannelIds(undefined);
	}
	return parseConfiguredChannelIds((environment as Record<string, unknown>).MIRROR_CHANNEL_IDS);
}

/**
 * Typed wrapper around KVNamespace that centralizes key formatting and
 * eliminates raw `as unknown as T` casts for KV reads.
 *
 * All `users:*`, `mirrored:*`, `channel-meta:*`, `recent:*`, and
 * `comment-cursor:*` keys are namespaced by the channel ID (`UC…`).
 */
export class KvStore {
	kv: KVNamespace;
	constructor(kv: KVNamespace) {
		this.kv = kv;
	}

	// --- Channel config ---

	async getChannelConfig(channelId: string): Promise<ChannelConfig | null> {
		return this.kv.get<ChannelConfig>(`users:${normalizeChannelId(channelId)}`, "json");
	}

	// --- Mirrored records ---

	async getMirrored(channelId: string, itemId: string): Promise<MirroredRecord | null> {
		return this.kv.get<MirroredRecord>(`mirrored:${normalizeChannelId(channelId)}:${itemId}`, "json");
	}

	async putMirrored(channelId: string, itemId: string, record: MirroredRecord): Promise<void> {
		await this.kv.put(`mirrored:${normalizeChannelId(channelId)}:${itemId}`, JSON.stringify(record));
	}

	// --- Change-detection snapshot ---

	async getChannelMeta(channelId: string): Promise<ChannelMeta | null> {
		return this.kv.get<ChannelMeta>(`channel-meta:${normalizeChannelId(channelId)}`, "json");
	}

	async putChannelMeta(channelId: string, meta: ChannelMeta): Promise<void> {
		await this.kv.put(`channel-meta:${normalizeChannelId(channelId)}`, JSON.stringify(meta));
	}

	// --- Comment cursor (incremental comment polling per video) ---

	async getCommentCursor(channelId: string, videoId: string): Promise<string | null> {
		return this.kv.get(`comment-cursor:${normalizeChannelId(channelId)}:${videoId}`, "text");
	}

	async putCommentCursor(channelId: string, videoId: string, iso: string): Promise<void> {
		await this.kv.put(`comment-cursor:${normalizeChannelId(channelId)}:${videoId}`, iso);
	}

	// --- Bluesky session cache ---

	async getSession(atProtoAccount: string): Promise<CachedSession | null> {
		return this.kv.get<CachedSession>(`session:${atProtoAccount}`, "json");
	}

	async putSession(atProtoAccount: string, session: CachedSession, ttl: number): Promise<void> {
		await this.kv.put(`session:${atProtoAccount}`, JSON.stringify(session), { expirationTtl: ttl });
	}
}
