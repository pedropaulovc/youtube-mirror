import { describe, it, expect } from "vitest";
import { truncateGraphemes } from "../../worker/text";

const graphemeCount = (s: string) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;

describe("truncateGraphemes", () => {
	it("returns the input unchanged when within the limit", () => {
		expect(truncateGraphemes("hello", 10)).toBe("hello");
		expect(truncateGraphemes("hello", 5)).toBe("hello");
	});

	it("never exceeds maxGraphemes including the ellipsis", () => {
		// Before the fix this returned maxGraphemes + 1 (ellipsis appended on top of a
		// full slice), overflowing hard caps like Bluesky's 64-grapheme displayName.
		const out = truncateGraphemes("abcdefghij", 5);
		expect(graphemeCount(out)).toBe(5);
		expect(out.endsWith("…")).toBe(true);
	});

	it("leaves room for a suffix appended by the caller (64-grapheme cap)", () => {
		const suffix = " [UNOFFICIAL]";
		const cap = 64;
		const title = "x".repeat(100);
		const display = truncateGraphemes(title, cap - graphemeCount(suffix)) + suffix;
		expect(graphemeCount(display)).toBeLessThanOrEqual(cap);
	});

	it("counts a multi-codepoint ellipsis against the budget", () => {
		const out = truncateGraphemes("abcdefghij", 5, "...");
		expect(graphemeCount(out)).toBeLessThanOrEqual(5);
	});
});
