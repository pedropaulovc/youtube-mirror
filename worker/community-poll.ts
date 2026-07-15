export type CommunityPollState = "due" | "not-due";

export const DEFAULT_COMMUNITY_POLL_INTERVAL_MINUTES = 60;

export function communityPollState(
	lastCheckedAt: string | null,
	now: number,
	intervalMinutes: number,
): CommunityPollState {
	if (!lastCheckedAt) return "due";
	const elapsed = now - new Date(lastCheckedAt).getTime();
	return elapsed >= intervalMinutes * 60 * 1000 ? "due" : "not-due";
}
