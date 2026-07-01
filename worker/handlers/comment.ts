import type { AppBskyRichtextFacet } from "@atproto/api";
import { splitIntoChunks } from "../content";
import type { CommentItem } from "../types";
import type { MirrorContext } from "./context";

// A comment can be dispatched before its parent (a nested reply racing the parent
// comment's own workflow). Retry the step until the parent's mirrored post exists,
// rather than completing without a record — a deterministic-id instance never re-runs,
// and the poll cursor advances past it, so completing here would drop the comment.
const PARENT_WAIT_CONFIG = { retries: { limit: 10, delay: "30 seconds", backoff: "exponential" } } as const;

/**
 * Build a link facet over the `@author` label prefix, pointing at the
 * commenter's YouTube channel. `byteStart` is 0 (the prefix leads the text).
 */
export function buildAuthorFacet(label: string, authorChannelId: string): AppBskyRichtextFacet.Main {
	const byteEnd = new TextEncoder().encode(label).byteLength;
	return {
		index: { byteStart: 0, byteEnd },
		features: [{ $type: "app.bsky.richtext.facet#link", uri: `https://www.youtube.com/channel/${authorChannelId}` }],
	};
}

/**
 * Mirror a comment as a threaded Bluesky reply. Channel-owner comments post from
 * the main account; everyone else's post from the RT account with an `@author:`
 * prefix. Threads under the parent item's mirrored post, rooted at the video's post.
 */
export async function mirrorComment(comment: CommentItem, ctx: MirrorContext): Promise<void> {
	const existing = await ctx.getMirrored(ctx.channelId, comment.id);
	if (existing) return;

	const account: "main" | "rt" = comment.isChannelOwner ? "main" : "rt";

	let firstChunkFacets: AppBskyRichtextFacet.Main[] | undefined;
	let text = comment.text;
	if (!comment.isChannelOwner) {
		const label = comment.authorDisplayName.startsWith("@")
			? comment.authorDisplayName
			: `@${comment.authorDisplayName}`;
		const prefix = `${label}: `;
		text = prefix + comment.text;
		if (comment.authorChannelId) {
			firstChunkFacets = [buildAuthorFacet(label, comment.authorChannelId)];
		}
	}

	const chunks = splitIntoChunks(text);

	await ctx.step.do(`post-comment-${comment.id}`, PARENT_WAIT_CONFIG, async () => {
		// Resolve the parent inside the step so retries re-check for a parent that
		// hasn't been mirrored yet. Missing parent → throw → the step retries.
		const parent = await ctx.getMirrored(ctx.channelId, comment.parentItemId);
		if (!parent) {
			throw new Error(`${ctx.channelId}: parent ${comment.parentItemId} not mirrored yet, retrying comment ${comment.id}`);
		}

		// Root is the video's post (top-level of the thread). For a top-level comment
		// the parent already IS the video post; for a nested reply resolve the video.
		let rootUri = parent.bskyUri;
		let rootCid = parent.bskyCid;
		if (comment.parentItemKind === "comment" && comment.videoId) {
			const videoRec = await ctx.getMirrored(ctx.channelId, comment.videoId);
			if (videoRec) {
				rootUri = videoRec.bskyUri;
				rootCid = videoRec.bskyCid;
			}
		}

		const client = await ctx.getClient(ctx.channelConfig, account);
		const result = await ctx.postChain(
			client,
			chunks,
			new Date(comment.publishedAt),
			{ channelId: ctx.channelId, itemId: comment.id },
			{
				replyToUri: parent.bskyUri,
				replyToCid: parent.bskyCid,
				replyRootUri: rootUri,
				replyRootCid: rootCid,
				firstChunkFacets,
			},
		);
		await ctx.storeMirrored(ctx.channelId, comment.id, "comment", result, account);
	});
}
