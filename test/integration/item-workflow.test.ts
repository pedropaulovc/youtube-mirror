// @ts-nocheck
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MirroredRecord } from "../../worker/types";
import { makeChannelConfig, makeVideo, makeCommunityPost, makeComment, TEST_CHANNEL_ID } from "../helpers/factories";

// The worker's main module (loaded in this test isolate) imports @atproto/api at
// the top level, which crashes on import in the Workers test runtime. Mock it.
vi.mock("@atproto/api", () => ({
	AtpAgent: function () {
		return {
			login: vi.fn().mockResolvedValue({}),
			session: { did: "did:plc:test", handle: "h", accessJwt: "j" },
			post: vi.fn().mockResolvedValue({ uri: "at://x", cid: "c" }),
			uploadBlob: vi.fn().mockResolvedValue({ data: { blob: {} } }),
		};
	},
	RichText: function (opts: { text: string }) {
		return { text: opts.text, facets: [], detectFacets: vi.fn().mockResolvedValue(undefined) };
	},
}));

const config = makeChannelConfig();

async function clearKv() {
	const keys = await env.KV.list();
	for (const key of keys.keys) await env.KV.delete(key.name);
}

describe.sequential("MirrorItemWorkflow routing", () => {
	beforeEach(async () => {
		await clearKv();
		await env.KV.put(`users:${TEST_CHANNEL_ID}`, JSON.stringify(config));
	});

	it("routes a video to the post-video step", async () => {
		const video = makeVideo({ id: "route-vid" });
		const instanceId = `item-video-${Date.now()}`;
		await using instance = await introspectWorkflowInstance(env.ITEM_WORKFLOW, instanceId);
		await instance.modify(async (m) => {
			await m.mockStepResult({ name: `post-video-${video.id}` }, "mocked");
		});
		await env.ITEM_WORKFLOW.create({
			id: instanceId,
			params: { item: video, channelId: TEST_CHANNEL_ID, channelConfig: config },
		});
		const result = await instance.waitForStepResult({ name: `post-video-${video.id}` });
		expect(result).toBe("mocked");
	}, 15_000);

	it("routes a community post to the post-community step", async () => {
		const post = makeCommunityPost({ id: "route-post" });
		const instanceId = `item-community-${Date.now()}`;
		await using instance = await introspectWorkflowInstance(env.ITEM_WORKFLOW, instanceId);
		await instance.modify(async (m) => {
			await m.mockStepResult({ name: `post-community-${post.id}` }, "mocked");
		});
		await env.ITEM_WORKFLOW.create({
			id: instanceId,
			params: { item: post, channelId: TEST_CHANNEL_ID, channelConfig: config },
		});
		const result = await instance.waitForStepResult({ name: `post-community-${post.id}` });
		expect(result).toBe("mocked");
	}, 15_000);

	it("defers a comment whose parent is not yet mirrored (no step, no record)", async () => {
		const comment = makeComment({ id: "orphan-comment", parentItemId: "missing-video" });
		const instanceId = `item-comment-defer-${Date.now()}`;
		await using instance = await introspectWorkflowInstance(env.ITEM_WORKFLOW, instanceId);
		await env.ITEM_WORKFLOW.create({
			id: instanceId,
			params: { item: comment, channelId: TEST_CHANNEL_ID, channelConfig: config },
		});
		await instance.waitForStatus("complete", { timeout: 5000 });
		const record = await env.KV.get(`mirrored:${TEST_CHANNEL_ID}:${comment.id}`);
		expect(record).toBeNull();
	}, 15_000);

	it("posts a comment once its parent video is mirrored", async () => {
		const parent: MirroredRecord = {
			bskyUri: "at://did/app.bsky.feed.post/parent",
			bskyCid: "bafparent",
			account: "main",
			kind: "video",
			createdAt: new Date().toISOString(),
		};
		await env.KV.put(`mirrored:${TEST_CHANNEL_ID}:vid001`, JSON.stringify(parent));

		const comment = makeComment({ id: "threaded-comment", parentItemId: "vid001", parentItemKind: "video", videoId: "vid001" });
		const instanceId = `item-comment-${Date.now()}`;
		await using instance = await introspectWorkflowInstance(env.ITEM_WORKFLOW, instanceId);
		await instance.modify(async (m) => {
			await m.mockStepResult({ name: `post-comment-${comment.id}` }, "mocked");
		});
		await env.ITEM_WORKFLOW.create({
			id: instanceId,
			params: { item: comment, channelId: TEST_CHANNEL_ID, channelConfig: config },
		});
		const result = await instance.waitForStepResult({ name: `post-comment-${comment.id}` });
		expect(result).toBe("mocked");
	}, 15_000);
});
