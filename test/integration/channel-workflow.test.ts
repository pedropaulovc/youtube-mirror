// @ts-nocheck
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChannelMeta } from "../../worker/types";
import { makeChannelConfig, makeVideo, TEST_CHANNEL_ID } from "../helpers/factories";

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
		const instanceId = `channel-dispatch-${Date.now()}`;
		await using instance = await introspectWorkflowInstance(env.CHANNEL_WORKFLOW, instanceId);
		await instance.modify(async (m) => {
			await m.mockStepResult({ name: `fetch-videos-${TEST_CHANNEL_ID}` }, [video]);
		});

		await env.CHANNEL_WORKFLOW.create({ id: instanceId, params: { channelId: TEST_CHANNEL_ID } });
		await instance.waitForStatus("complete", { timeout: 8000 });

		// The dispatched item workflow uses the deterministic id item-{channel}-video-{id}.
		const child = await env.ITEM_WORKFLOW.get(`item-${TEST_CHANNEL_ID}-video-${video.id}`);
		expect(child).not.toBeNull();
	}, 20_000);
});
