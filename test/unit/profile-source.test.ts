import { describe, expect, it } from "vitest";
import { profileSourceSnapshot } from "../../worker/profile-source";

describe("profileSourceSnapshot", () => {
	it("is stable until a source field or configured suffix changes", () => {
		const info = {
			title: "Test channel",
			description: "Description",
			avatarUrl: "https://example.com/avatar.jpg",
			bannerUrl: "https://example.com/banner.jpg",
		};

		const initial = profileSourceSnapshot(info);
		expect(profileSourceSnapshot({ ...info })).toBe(initial);
		expect(profileSourceSnapshot({ ...info, title: "Renamed channel" })).not.toBe(initial);
		expect(profileSourceSnapshot(info, " custom suffix")).not.toBe(initial);
	});
});
