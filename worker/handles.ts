/**
 * YouTube channel IDs (`UC…`) are case-sensitive opaque identifiers — normalize
 * only by trimming whitespace, never by lowercasing (that would corrupt them).
 */
export function normalizeChannelId(channelId: string): string {
	return channelId.trim();
}

/**
 * YouTube @handles are case-insensitive. Strip a leading "@" and lowercase so
 * config lookups and the community-tab URL are canonical.
 */
export function normalizeHandle(handle: string): string {
	return handle.trim().replace(/^@/, "").toLowerCase();
}
