import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ChannelConfig, ContentItem, ItemKind } from "./types";
import { setWorkflowContext } from "./log";
import { normalizeChannelId } from "./handles";
import { buildContext } from "./handlers/context";
import { mirrorVideo } from "./handlers/video";
import { mirrorCommunity } from "./handlers/community";
import { mirrorComment } from "./handlers/comment";
import { fetchVideos } from "./youtube-api";
import { fetchCommunityPosts } from "./firecrawl";

// A full item + config (the channel workflow's fast path), OR a lightweight
// reference the workflow hydrates itself (manual re-mirror via scripts/mirror-item.ts,
// which can't build the item/config without KV + API access).
export interface MirrorItemWorkflowParams {
	item?: ContentItem;
	kind?: ItemKind;
	itemId?: string;
	channelId: string;
	channelConfig?: ChannelConfig;
	parentWorkflowId?: string;
}

export class MirrorItemWorkflow extends WorkflowEntrypoint<Env, MirrorItemWorkflowParams> {
	async run(event: WorkflowEvent<MirrorItemWorkflowParams>, step: WorkflowStep) {
		const { parentWorkflowId } = event.payload;
		const channelId = normalizeChannelId(event.payload.channelId);
		setWorkflowContext(event.instanceId, parentWorkflowId);

		const channelConfig = event.payload.channelConfig ?? (await this.loadConfig(channelId));
		const item = event.payload.item ?? (await this.hydrateItem(channelId, channelConfig, event.payload));

		const ctx = buildContext(this.env, step, channelId, channelConfig, parentWorkflowId, event.instanceId);
		ctx.logger.log({ tag: "workflow-start", channelId, kind: item.kind, itemId: item.id, message: `${channelId}: MirrorItemWorkflow ${event.instanceId} started for ${item.kind} ${item.id}` });

		switch (item.kind) {
			case "video":
				await mirrorVideo(item, ctx);
				break;
			case "community":
				await mirrorCommunity(item, ctx);
				break;
			case "comment":
				await mirrorComment(item, ctx);
				break;
		}
	}

	private async loadConfig(channelId: string): Promise<ChannelConfig> {
		const config = await this.env.KV.get<ChannelConfig>(`users:${channelId}`, "json");
		if (!config) throw new NonRetryableError(`No config found for channel ${channelId}`);
		return config;
	}

	/** Rebuild a ContentItem from a `{kind, itemId}` reference for manual re-mirroring. */
	private async hydrateItem(
		channelId: string,
		channelConfig: ChannelConfig,
		ref: { kind?: ItemKind; itemId?: string },
	): Promise<ContentItem> {
		const { kind, itemId } = ref;
		if (!kind || !itemId) throw new NonRetryableError(`MirrorItemWorkflow payload needs an item or a {kind, itemId} reference`);

		if (kind === "video") {
			const apiKey = await this.env.YOUTUBE_API_KEY.get();
			const [video] = await fetchVideos([itemId], apiKey);
			if (!video) throw new NonRetryableError(`Video ${itemId} not found on YouTube`);
			return video;
		}

		if (kind === "community") {
			const token = await this.env.FIRECRAWL_API_TOKEN.get();
			const posts = await fetchCommunityPosts(channelConfig.handle, channelId, token);
			const post = posts.find((p) => p.id === itemId);
			if (!post) throw new NonRetryableError(`Community post ${itemId} not found for channel ${channelId}`);
			return post;
		}

		// Comments carry parent/video context that only the poller has; rebuilding one
		// in isolation isn't supported. Re-run the channel poll to re-mirror comments.
		throw new NonRetryableError(`Manual re-mirror of comments is unsupported (item ${itemId})`);
	}
}
