import { describe, expect, it } from "vitest";
import { itemWorkflowId } from "../../worker/types";

describe("itemWorkflowId", () => {
	it("preserves existing valid generated IDs byte-for-byte", async () => {
		expect(await itemWorkflowId(" UCchannel_123 ", "video", "video-456")).toBe(
			"item-UCchannel_123-video-video-456",
		);
	});

	it("hashes invalid IDs deterministically without leaking their raw contents", async () => {
		const itemId = "comment.id.with.dots";
		const first = await itemWorkflowId("UCchannel", "comment", itemId);
		const second = await itemWorkflowId("UCchannel", "comment", itemId);

		expect(first).toBe(second);
		expect(first).toMatch(/^item-[A-Za-z0-9_-]+$/);
		expect(first.length).toBeLessThanOrEqual(100);
		expect(first).not.toContain(itemId);
		expect(await itemWorkflowId("UCchannel2", "comment", itemId)).not.toBe(first);
		expect(await itemWorkflowId("UCchannel", "comment", `${itemId}.other`)).not.toBe(first);
		expect(await itemWorkflowId("UCchannel", "video", itemId)).not.toBe(first);
	});

	it("preserves a valid Workflow ID at the 100-character limit", async () => {
		const itemId = "x".repeat(79);
		const expected = `item-UCchannel-video-${itemId}`;

		expect(expected).toHaveLength(100);
		expect(await itemWorkflowId("UCchannel", "video", itemId)).toBe(expected);
	});

	it("hashes overlong IDs to a valid bounded ID", async () => {
		const itemId = "x".repeat(120);
		const id = await itemWorkflowId("UCchannel", "video", itemId);

		expect(id).toMatch(/^item-[A-Za-z0-9_-]+$/);
		expect(id.length).toBeLessThanOrEqual(100);
		expect(id).not.toContain(itemId);
		expect(await itemWorkflowId("UCchannel", "video", itemId)).toBe(id);
	});
});
