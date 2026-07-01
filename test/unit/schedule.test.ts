import { describe, it, expect } from "vitest";
import { getScheduledChannels } from "../../worker/schedule";

describe("getScheduledChannels", () => {
	const channels = [
		{ channelId: "UCa", pollIntervalMinutes: 3 },
		{ channelId: "UCb", pollIntervalMinutes: 3 },
		{ channelId: "UCc", pollIntervalMinutes: 3 },
	];

	it("partitions channels across the interval so each fires once per cycle", () => {
		const fired: Set<string> = new Set();
		for (let minute = 0; minute < 3; minute++) {
			for (const id of getScheduledChannels(channels, minute)) fired.add(id);
		}
		expect(fired).toEqual(new Set(["UCa", "UCb", "UCc"]));
	});

	it("fires a given channel on exactly one minute-slot per cycle", () => {
		const slots = [0, 1, 2].map((m) => getScheduledChannels(channels, m));
		const appearances = slots.flat().filter((id) => id === "UCa").length;
		expect(appearances).toBe(1);
	});

	it("is stable regardless of input order", () => {
		const reversed = [...channels].reverse();
		expect(getScheduledChannels(channels, 0)).toEqual(getScheduledChannels(reversed, 0));
	});
});
