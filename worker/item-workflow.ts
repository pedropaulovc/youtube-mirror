import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { ChannelConfig, ContentItem } from "./types";
import { setWorkflowContext } from "./log";
import { normalizeChannelId } from "./handles";
import { buildContext } from "./handlers/context";
import { mirrorVideo } from "./handlers/video";
import { mirrorCommunity } from "./handlers/community";
import { mirrorComment } from "./handlers/comment";

export interface MirrorItemWorkflowParams {
	item: ContentItem;
	channelId: string;
	channelConfig: ChannelConfig;
	parentWorkflowId?: string;
}

export class MirrorItemWorkflow extends WorkflowEntrypoint<Env, MirrorItemWorkflowParams> {
	async run(event: WorkflowEvent<MirrorItemWorkflowParams>, step: WorkflowStep) {
		const { item, channelConfig, parentWorkflowId } = event.payload;
		const channelId = normalizeChannelId(event.payload.channelId);
		setWorkflowContext(event.instanceId, parentWorkflowId);

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
}
