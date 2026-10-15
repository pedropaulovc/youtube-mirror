// @ts-nocheck
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { itemWorkflowId, type ChannelMeta, type MirroredRecord } from "../../worker/types";
import { makeChannelConfig, makeComment, makeVideo, TEST_CHANNEL_ID } from "../helpers/factories";

// The worker's main module imports @atproto/api, which crashes on import in the
// Workers test runtime. Mock it (workflow steps here are mocked via mockStepResult).
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

async function clearKv() {
	const keys = await env.KV.list();
	for (const key of keys.keys) await env.KV.delete(key.name);
}

describe.sequential("MirrorChannelWorkflow orchestration", () => {
	beforeEach(async () => {
		await clearKv();
	});

	it("records a change-detection snapshot after a poll with no new videos", async () => {
		const config = makeChannelConfig({ mirrorCommunity: false, mirrorComments: false });
		await env.KV.put(`users:${TEST_CHANNEL_ID}`, JSON.stringify(config));

		const video = makeVideo({ id: "meta-vid", publishedAt: "2026-06-10T00:00:00Z" });
		const instanceId = `channel-${Date.now()}`;
		await using instance = await introspectWorkflowInstance(env.CHANNEL_WORKFLOW, instanceId);

		// Bypass the live YouTube fetch; the video already "exists" as mirrored so
		// the filter step yields no new items to dispatch.
		await env.KV.put(`mirrored:${TEST_CHANNEL_ID}:${video.id}`, JSON.stringify({ bskyUri: "at://x", bskyCid: "c", account: "main", kind: "video", createdAt: new Date().toISOString() }));
		await instance.modify(async (m) => {
			await m.mockStepResult({ name: `youtube-token-${TEST_CHANNEL_ID}` }, "fake-token");
			await m.mockStepResult({ name: `fetch-videos-${TEST_CHANNEL_ID}` }, [video]);
		});

		await env.CHANNEL_WORKFLOW.create({ id: instanceId, params: { channelId: TEST_CHANNEL_ID } });
		await instance.waitForStatus("complete", { timeout: 8000 });

		const meta = await env.KV.get<ChannelMeta>(`channel-meta:${TEST_CHANNEL_ID}`, "json");
		expect(meta).not.toBeNull();
		expect(meta!.latestVideoPublishedAt).toBe("2026-06-10T00:00:00Z");
	}, 20_000);

	it("dispatches a new video to the item workflow", async () => {
		const config = makeChannelConfig({ mirrorCommunity: false, mirrorComments: false });
		await env.KV.put(`users:${TEST_CHANNEL_ID}`, JSON.stringify(config));

		const video = makeVideo({ id: "new-vid" });
		const itemId = `item-${TEST_CHANNEL_ID}-video-${video.id}`;
		await using itemInstance = await introspectWorkflowInstance(env.ITEM_WORKFLOW, itemId);
		await itemInstance.modify(async (m) => {
			await m.mockStepResult({ name: `post-video-${video.id}` }, "mocked");
		});
		const instanceId = `channel-dispatch-${Date.now()}`;
		await using instance = await introspectWorkflowInstance(env.CHANNEL_WORKFLOW, instanceId);
		await instance.modify(async (m) => {
			await m.mockStepResult({ name: `youtube-token-${TEST_CHANNEL_ID}` }, "fake-token");
			await m.mockStepResult({ name: `fetch-videos-${TEST_CHANNEL_ID}` }, [video]);
		});

		await env.CHANNEL_WORKFLOW.create({ id: instanceId, params: { channelId: TEST_CHANNEL_ID } });
		await instance.waitForStatus("complete", { timeout: 8000 });

		const result = await itemInstance.waitForStepResult({ name: `post-video-${video.id}` });
		expect(result).toBe("mocked");
		await itemInstance.waitForStatus("complete", { timeout: 8000 });
		const child = await env.ITEM_WORKFLOW.get(itemId);
		expect(child).not.toBeNull();
	}, 20_000);

	it("dispatches dotted comments and advances the cursor after successful dispatch", async () => {
		const config = makeChannelConfig({ mirrorCommunity: false });
		await env.KV.put(`users:${TEST_CHANNEL_ID}`, JSON.stringify(config));

		const video = makeVideo({ id: "comment-parent-video", publishedAt: new Date().toISOString() });
		const videoRecord: MirroredRecord = {
			bskyUri: "at://x",
			bskyCid: "c",
			account: "main",
			kind: "video",
			createdAt: new Date().toISOString(),
		};
		await env.KV.put(`mirrored:${TEST_CHANNEL_ID}:${video.id}`, JSON.stringify(videoRecord));

		const firstPublishedAt = new Date(Date.now() - 10_000).toISOString();
		const lastPublishedAt = new Date(Date.now() - 5_000).toISOString();
		const comment = makeComment({
			id: "Ugz.comment.with.dots",
			parentItemId: video.id,
			videoId: video.id,
			publishedAt: firstPublishedAt,
		});
		const laterComment = makeComment({
			id: "Ugz_following_comment",
			parentItemId: video.id,
			videoId: video.id,
			publishedAt: lastPublishedAt,
		});
		const comments = [comment, laterComment];
		const safeId = await itemWorkflowId(TEST_CHANNEL_ID, "comment", comment.id);
		const laterItemId = await itemWorkflowId(TEST_CHANNEL_ID, "comment", laterComment.id);
		await using itemInstance = await introspectWorkflowInstance(env.ITEM_WORKFLOW, safeId);
		await using laterItemInstance = await introspectWorkflowInstance(env.ITEM_WORKFLOW, laterItemId);
		await itemInstance.modify(async (m) => {
			await m.mockStepResult({ name: `post-comment-${comment.id}` }, "mocked");
		});
		await laterItemInstance.modify(async (m) => {
			await m.mockStepResult({ name: `post-comment-${laterComment.id}` }, "mocked");
		});
		const instanceId = `channel-dotted-comment-${Date.now()}`;
		await using instance = await introspectWorkflowInstance(env.CHANNEL_WORKFLOW, instanceId);
		await instance.modify(async (m) => {
			await m.mockStepResult({ name: `youtube-token-${TEST_CHANNEL_ID}` }, "fake-token");
			await m.mockStepResult({ name: `fetch-videos-${TEST_CHANNEL_ID}` }, [video]);
			await m.mockStepResult({ name: `fetch-comments-${video.id}` }, comments);
		});

		await env.CHANNEL_WORKFLOW.create({ id: instanceId, params: { channelId: TEST_CHANNEL_ID } });
		await instance.waitForStatus("complete", { timeout: 8000 });

		expect(await itemInstance.waitForStepResult({ name: `post-comment-${comment.id}` })).toBe("mocked");
		expect(await laterItemInstance.waitForStepResult({ name: `post-comment-${laterComment.id}` })).toBe("mocked");
		await Promise.all([
			itemInstance.waitForStatus("complete", { timeout: 8000 }),
			laterItemInstance.waitForStatus("complete", { timeout: 8000 }),
		]);
		expect(safeId).not.toContain(comment.id);
		expect(await env.ITEM_WORKFLOW.get(safeId)).not.toBeNull();
		expect(await env.ITEM_WORKFLOW.get(laterItemId)).not.toBeNull();
		expect(await env.KV.get(`comment-cursor:${TEST_CHANNEL_ID}:${video.id}`, "text")).toBe(firstPublishedAt);
	}, 20_000);

	it("skips the community scrape until its polling interval elapses", async () => {
		const config = makeChannelConfig({ mirrorCommunity: true, mirrorComments: false });
		await env.KV.put(`users:${TEST_CHANNEL_ID}`, JSON.stringify(config));
		await env.KV.put(`community-last-checked:${TEST_CHANNEL_ID}`, new Date().toISOString());

		const instanceId = `channel-community-gate-${Date.now()}`;
		await using instance = await introspectWorkflowInstance(env.CHANNEL_WORKFLOW, instanceId);
		await instance.modify(async (m) => {
			await m.mockStepResult({ name: `youtube-token-${TEST_CHANNEL_ID}` }, "fake-token");
			await m.mockStepResult({ name: `fetch-videos-${TEST_CHANNEL_ID}` }, []);
		});

		await env.CHANNEL_WORKFLOW.create({ id: instanceId, params: { channelId: TEST_CHANNEL_ID } });
		const posts = await instance.waitForStepResult({ name: `fetch-community-${TEST_CHANNEL_ID}` });
		expect(posts).toEqual({ state: "not-due", posts: [] });
		await instance.waitForStatus("complete", { timeout: 8000 });
	}, 20_000);
});
