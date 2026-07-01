import { descriptionChunks, videoPostText } from "../content";
import type { VideoItem } from "../types";
import type { MirrorContext } from "./context";

/**
 * Mirror a video: a root post with the title + an external link card (thumbnail
 * → YouTube watch URL), followed by the description as a threaded self-reply chain.
 */
export async function mirrorVideo(video: VideoItem, ctx: MirrorContext): Promise<void> {
	const existing = await ctx.getMirrored(ctx.channelId, video.id);
	if (existing) return;

	await ctx.step.do(`post-video-${video.id}`, async () => {
		const client = await ctx.getClient(ctx.channelConfig, "main");
		const external = await ctx.buildVideoCard(client, video);
		const chunks = [videoPostText(video), ...descriptionChunks(video)];
		const result = await ctx.postChain(
			client,
			chunks,
			new Date(video.publishedAt),
			{ channelId: ctx.channelId, itemId: video.id },
			{ external },
		);
		await ctx.storeMirrored(ctx.channelId, video.id, "video", result, "main");
	});
}
