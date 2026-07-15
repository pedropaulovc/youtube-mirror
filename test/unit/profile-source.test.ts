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

		const targets = { main: "main.example", rt: "rt.example" };
		const initial = profileSourceSnapshot(info, targets);
		expect(profileSourceSnapshot({ ...info }, targets)).toBe(initial);
		expect(profileSourceSnapshot({ ...info, title: "Renamed channel" }, targets)).not.toBe(initial);
		expect(profileSourceSnapshot(info, targets, " custom suffix")).not.toBe(initial);
		expect(profileSourceSnapshot(info, { ...targets, main: "replacement.example" })).not.toBe(initial);
	});
});
