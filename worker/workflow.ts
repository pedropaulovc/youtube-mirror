import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { fetchRecentVideoIds, fetchVideos, fetchComments, uploadsPlaylistId } from "./youtube-api";
import { getYouTubeAccessToken } from "./gcp-token";
import { fetchCommunityPosts } from "./firecrawl";
import { createWorkflowWithRetry } from "./cron-dispatch";
import { safeCommentCursor } from "./comment-cursor";
import { stepDo } from "./step";
import { itemWorkflowId } from "./types";
import type { ChannelConfig, ChannelMeta, CommentItem, CommunityPostItem, ContentItem, MirroredRecord, VideoItem } from "./types";
import { log, warn, setWorkflowContext, Logger } from "./log";
import { normalizeChannelId } from "./handles";
import { DEFAULT_MAX_ITEMS, MAX_ITEMS_LIMIT, MAX_COMMENT_VIDEOS, COMMENT_LOOKBACK_HOURS } from "./constants";

export interface MirrorChannelWorkflowParams {
	channelId: string;
}

export class MirrorChannelWorkflow extends WorkflowEntrypoint<Env, MirrorChannelWorkflowParams> {
	logger: Logger | undefined;

	async run(event: WorkflowEvent<MirrorChannelWorkflowParams>, step: WorkflowStep) {
		const channelId = normalizeChannelId(event.payload.channelId);
		const workflowId = event.instanceId;
		setWorkflowContext(workflowId);
		this.logger = new Logger(workflowId);
		log({ tag: "workflow-start", channelId, message: `${channelId}: MirrorChannelWorkflow ${workflowId} started` });

		// Step 1: Load channel config
		const channelConfig = await stepDo<ChannelConfig>(step, `load-config-${channelId}`, async () => {
			const config = await this.env.KV.get<ChannelConfig>(`users:${channelId}`, "json");
			if (!config) throw new Error(`No config found for channel ${channelId}`);
			return config;
		});

		const accessToken = await stepDo<string>(step, `youtube-token-${channelId}`, () => getYouTubeAccessToken(this.env));
		const maxItems = Math.max(1, Math.min(MAX_ITEMS_LIMIT, channelConfig.maxItems ?? DEFAULT_MAX_ITEMS));
		const uploadsId = channelConfig.uploadsPlaylistId ?? uploadsPlaylistId(channelId);

		// Step 2: Fetch recent videos
		const videos = await stepDo<VideoItem[]>(step, `fetch-videos-${channelId}`, async () => {
			const ids = await fetchRecentVideoIds(uploadsId, maxItems, accessToken);
			return ids.length > 0 ? fetchVideos(ids, accessToken) : [];
		});

		// Step 3: Filter already-mirrored videos, dispatch the rest
		const newVideos = await stepDo<VideoItem[]>(step, `filter-videos-${channelId}`, async () => {
			return this.filterNew(channelId, videos);
		});
		for (const video of newVideos) {
			await this.dispatchItem(channelId, channelConfig, video, workflowId);
		}

		// Step 4: Community posts (Firecrawl) — best-effort, gated by config
		if (channelConfig.mirrorCommunity !== false) {
			const newPosts = await stepDo<CommunityPostItem[]>(step, `fetch-community-${channelId}`, async () => {
				const firecrawlToken = await this.env.FIRECRAWL_API_TOKEN.get();
				const posts = await fetchCommunityPosts(channelConfig.handle, channelId, firecrawlToken);
				return this.filterNew(channelId, posts);
			});
			for (const post of newPosts) {
				await this.dispatchItem(channelId, channelConfig, post, workflowId);
			}
		}

		// Step 5: Comments on recently-mirrored videos (video comments come from the
		// Data API). Only poll videos already mirrored so the parent post exists.
		if (channelConfig.mirrorComments !== false) {
			await this.pollComments(channelId, channelConfig, videos, accessToken, workflowId, step);
		}

		// Step 6: Record change-detection snapshot for the next cycle
		await stepDo<void>(step, `record-meta-${channelId}`, async () => {
			const meta: ChannelMeta = {
				latestVideoPublishedAt: videos[0]?.publishedAt ?? null,
				latestCommunityId: null,
				updatedAt: new Date().toISOString(),
			};
			await this.env.KV.put(`channel-meta:${channelId}`, JSON.stringify(meta));
		});
	}

	/** Keep only items with no existing `mirrored:` record. */
	private async filterNew<T extends { id: string }>(channelId: string, items: T[]): Promise<T[]> {
		const out: T[] = [];
		for (const item of items) {
			const existing = await this.env.KV.get(`mirrored:${channelId}:${item.id}`);
			if (!existing) out.push(item);
		}
		return out;
	}

	/** Returns true iff the item workflow was successfully created/queued. */
	private async dispatchItem(
		channelId: string,
		channelConfig: ChannelConfig,
		item: ContentItem,
		parentWorkflowId: string,
	): Promise<boolean> {
		const id = itemWorkflowId(channelId, item.kind, item.id);
		try {
			await createWorkflowWithRetry(this.env.ITEM_WORKFLOW, id, { item, channelId, channelConfig, parentWorkflowId });
			return true;
		} catch (err) {
			warn({ tag: "dispatch", channelId, kind: item.kind, itemId: item.id, message: `${channelId}: failed to dispatch ${item.kind} ${item.id}`, error: String(err) });
			return false;
		}
	}

	private async pollComments(
		channelId: string,
		channelConfig: ChannelConfig,
		videos: VideoItem[],
		accessToken: string,
		workflowId: string,
		step: WorkflowStep,
	): Promise<void> {
		const cutoff = Date.now() - COMMENT_LOOKBACK_HOURS * 3600 * 1000;
		const recent = videos
			.filter((v) => new Date(v.publishedAt).getTime() >= cutoff)
			.slice(0, MAX_COMMENT_VIDEOS);

		for (const video of recent) {
			// Only poll comments once the video itself has been mirrored.
			const videoRec = await this.env.KV.get<MirroredRecord>(`mirrored:${channelId}:${video.id}`, "json");
			if (!videoRec) continue;

			const newComments = await stepDo<CommentItem[]>(step, `fetch-comments-${video.id}`, async () => {
				const cursor = await this.env.KV.get(`comment-cursor:${channelId}:${video.id}`, "text");
				const comments = await fetchComments(video.id, channelId, accessToken, cursor ?? undefined);
				return this.filterNew(channelId, comments);
			});

			if (newComments.length === 0) continue;

			// newComments is oldest-first. Advance the cursor only across the leading
			// run of comments that dispatched successfully: the first failed dispatch
			// caps the cursor so that comment (and everything after it) is refetched
			// next poll instead of being silently skipped. safeCommentCursor also guards
			// second-granular timestamp ties so the cursor never lands on a failed
			// comment's timestamp (the `> cursor` refetch filter would drop it).
			let firstFailedIndex: number | null = null;
			for (let i = 0; i < newComments.length; i++) {
				const ok = await this.dispatchItem(channelId, channelConfig, newComments[i], workflowId);
				if (!ok) {
					firstFailedIndex = i;
					break;
				}
			}
			const cursorAdvance = safeCommentCursor(newComments, firstFailedIndex);

			if (cursorAdvance) {
				const newest = cursorAdvance;
				await stepDo<void>(step, `advance-comment-cursor-${video.id}`, async () => {
					await this.env.KV.put(`comment-cursor:${channelId}:${video.id}`, newest);
				});
			}
		}
	}
}
