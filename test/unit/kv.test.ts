import { describe, expect, it } from "vitest";
import { parseConfiguredChannelIds, parseConfiguredChannelIdsFromEnvironment } from "../../worker/kv";

const FIRST_CHANNEL = "UC5NO8MgTQKHAWXp6z8Xl7yQ";
const SECOND_CHANNEL = "UCktCGXaNOhayFRU823ScWuA";

describe("parseConfiguredChannelIds", () => {
	it("trims and deduplicates configured channel IDs", () => {
		expect(parseConfiguredChannelIds(` ${FIRST_CHANNEL},${SECOND_CHANNEL},${FIRST_CHANNEL} `)).toEqual([
			FIRST_CHANNEL,
			SECOND_CHANNEL,
		]);
	});

	it("reads the channel list from the Worker environment binding", () => {
		expect(parseConfiguredChannelIdsFromEnvironment({ MIRROR_CHANNEL_IDS: FIRST_CHANNEL })).toEqual([FIRST_CHANNEL]);
	});

	it("rejects missing, empty, and malformed configuration", () => {
		expect(() => parseConfiguredChannelIds(undefined)).toThrow("binding is missing");
		expect(() => parseConfiguredChannelIds(" ")).toThrow("valid YouTube channel IDs");
		expect(() => parseConfiguredChannelIds("not-a-channel")).toThrow("valid YouTube channel IDs");
	});
});
