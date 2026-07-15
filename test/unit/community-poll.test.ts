import { describe, expect, it } from "vitest";
import { communityPollState } from "../../worker/community-poll";

describe("communityPollState", () => {
	const now = new Date("2026-07-15T12:00:00Z").getTime();

	it("is due without a previous successful check", () => {
		expect(communityPollState(null, now, 60)).toBe("due");
	});

	it("waits until the configured interval elapses", () => {
		expect(communityPollState("2026-07-15T11:30:00Z", now, 60)).toBe("not-due");
		expect(communityPollState("2026-07-15T11:00:00Z", now, 60)).toBe("due");
	});
});
