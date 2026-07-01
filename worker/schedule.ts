/**
 * Deterministically partition channels across minutes so each channel is polled
 * once per its `pollIntervalMinutes`, spreading load evenly across the cron cycle.
 * Sorted by channelId for stability, then bucketed by `index % interval`.
 */
export function getScheduledChannels(
	channels: ReadonlyArray<{ channelId: string; pollIntervalMinutes: number }>,
	minute: number,
): string[] {
	const sorted = [...channels].sort((a, b) =>
		a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0,
	);
	return sorted
		.filter(({ pollIntervalMinutes }, i) => i % pollIntervalMinutes === minute % pollIntervalMinutes)
		.map(({ channelId }) => channelId);
}
