import { communityChunks, communityImages } from "../content";
import type { CommunityPostItem } from "../types";
import type { MirrorContext } from "./context";

/**
 * Mirror a community-tab post: text (+ poll rendered as text) as the root post
 * with up to 4 images embedded; overflow text becomes a threaded self-reply chain.
 */
export async function mirrorCommunity(post: CommunityPostItem, ctx: MirrorContext): Promise<void> {
	const existing = await ctx.getMirrored(ctx.channelId, post.id);
	if (existing) return;

	await ctx.step.do(`post-community-${post.id}`, async () => {
		const client = await ctx.getClient(ctx.channelConfig, "main");
		const images = await ctx.uploadImages(client, communityImages(post));
		const chunks = communityChunks(post);
		const createdAt = post.publishedAt ? new Date(post.publishedAt) : new Date();
		const result = await ctx.postChain(
			client,
			chunks,
			createdAt,
			{ channelId: ctx.channelId, itemId: post.id },
			{ images: images.length > 0 ? images : undefined },
		);
		await ctx.storeMirrored(ctx.channelId, post.id, "community", result, "main");
	});
}
