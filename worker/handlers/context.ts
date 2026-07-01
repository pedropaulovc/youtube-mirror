import type { WorkflowStep } from "cloudflare:workers";
import type { AppBskyRichtextFacet } from "@atproto/api";
import { getAuthenticatedClient, BlueskyClient } from "../bluesky";
import type { PostResult, UploadedMedia, ExternalCard } from "../bluesky";
import { videoCardDescription, videoPostText } from "../content";
import type { ChannelConfig, ItemKind, MirroredRecord, VideoItem } from "../types";
import { Logger, log, warn, verbose } from "../log";
import { normalizeChannelId } from "../handles";
import { RECENT_INDEX_TTL_SECONDS, CHAIN_PROGRESS_TTL } from "../constants";

// Persisted progress of a multi-post reply chain, so a retry of the enclosing step
// resumes from the last posted segment instead of re-posting the root (a duplicate).
interface ChainProgress {
	rootUri?: string;
	rootCid?: string;
	prevUri?: string;
	prevCid?: string;
	chainUris: string[];
}

export interface PostChainOptions {
	images?: UploadedMedia[];
	external?: ExternalCard;
	replyToUri?: string;
	replyToCid?: string;
	replyRootUri?: string;
	replyRootCid?: string;
	/** Facets applied only to the first chunk (where any `@commenter:` prefix lives). */
	firstChunkFacets?: AppBskyRichtextFacet.Main[];
}

export interface MirrorContext {
	step: WorkflowStep;
	env: Env;
	channelId: string;
	channelConfig: ChannelConfig;
	parentWorkflowId?: string;
	logger: Logger;
	getClient: (config: ChannelConfig, account: "main" | "rt") => Promise<BlueskyClient>;
	getMirrored: (channelId: string, itemId: string) => Promise<MirroredRecord | null>;
	storeMirrored: (
		channelId: string,
		itemId: string,
		kind: ItemKind,
		result: PostResult & { chainUris?: string[] },
		account: "main" | "rt",
	) => Promise<void>;
	postChain: (
		client: BlueskyClient,
		chunks: string[],
		createdAt: Date,
		logContext: { channelId: string; itemId: string },
		options?: PostChainOptions,
	) => Promise<PostResult & { chainUris: string[] }>;
	uploadImages: (client: BlueskyClient, imageUrls: string[]) => Promise<UploadedMedia[]>;
	buildVideoCard: (client: BlueskyClient, video: VideoItem) => Promise<ExternalCard>;
}

export function buildContext(
	env: Env,
	step: WorkflowStep,
	channelId: string,
	channelConfig: ChannelConfig,
	parentWorkflowId?: string,
	workflowId?: string,
): MirrorContext {
	const logger = new Logger(workflowId ?? "unknown", parentWorkflowId);
	const clientCache: Map<string, BlueskyClient> = new Map();

	const getClient = async (config: ChannelConfig, account: "main" | "rt"): Promise<BlueskyClient> => {
		const cacheKey = config[account].atProtoAccount;
		const existing = clientCache.get(cacheKey);
		if (existing) return existing;
		const client = await getAuthenticatedClient(
			env.KV,
			env as unknown as { [key: string]: SecretsStoreSecret },
			config[account],
		);
		clientCache.set(cacheKey, client);
		return client;
	};

	const getMirrored = async (cid: string, itemId: string): Promise<MirroredRecord | null> => {
		return env.KV.get<MirroredRecord>(`mirrored:${normalizeChannelId(cid)}:${itemId}`, "json");
	};

	const storeMirrored = async (
		cid: string,
		itemId: string,
		kind: ItemKind,
		result: PostResult & { chainUris?: string[] },
		account: "main" | "rt",
	): Promise<void> => {
		const now = new Date();
		const record: MirroredRecord = {
			bskyUri: result.uri,
			bskyCid: result.cid,
			account,
			kind,
			createdAt: now.toISOString(),
			...(result.chainUris?.length ? { chainUris: result.chainUris } : {}),
		};
		const c = normalizeChannelId(cid);
		await env.KV.put(`mirrored:${c}:${itemId}`, JSON.stringify(record));
		// The chain is durably recorded now; drop its resume marker.
		await env.KV.delete(`chain-progress:${c}:${itemId}`);

		// Recency index: a small, self-expiring mirror of the record keyed under
		// `recent:{channelId}:` so the delete-check lists only the recent window
		// instead of scanning the whole mirrored history.
		const indexEntry = { bskyUri: record.bskyUri, account: record.account };
		await env.KV.put(`recent:${c}:${itemId}`, JSON.stringify(indexEntry), {
			expirationTtl: RECENT_INDEX_TTL_SECONDS,
			metadata: indexEntry,
		});

		log({ tag: "bsky-post", type: "post", channelId: cid, itemId, kind, account, bskyUri: result.uri, bskyCid: result.cid, message: `${cid}: mirrored ${kind} ${itemId} on ${account} → ${result.uri}` });
	};

	const postChain = async (
		client: BlueskyClient,
		chunks: string[],
		createdAt: Date,
		logContext: { channelId: string; itemId: string },
		options?: PostChainOptions,
	): Promise<PostResult & { chainUris: string[] }> => {
		// Resume marker: if the enclosing step already posted some segments before
		// failing, pick up where it left off rather than duplicating the root/chain.
		const progressKey = `chain-progress:${normalizeChannelId(logContext.channelId)}:${logContext.itemId}`;
		const progress: ChainProgress =
			(await env.KV.get<ChainProgress>(progressKey, "json")) ?? { chainUris: [] };

		// First chunk carries images/external card + any first-chunk facets.
		if (!progress.rootUri) {
			const firstResult = await client.createPost(chunks[0], createdAt, {
				images: options?.images,
				external: options?.external,
				replyToUri: options?.replyToUri,
				replyToCid: options?.replyToCid,
				replyRootUri: options?.replyRootUri,
				replyRootCid: options?.replyRootCid,
				facets: options?.firstChunkFacets,
			});
			progress.rootUri = firstResult.uri;
			progress.rootCid = firstResult.cid;
			progress.prevUri = firstResult.uri;
			progress.prevCid = firstResult.cid;
			await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: CHAIN_PROGRESS_TTL });
		}

		// Remaining chunks as self-replies, collecting URIs so the whole chain can
		// be deleted as a unit (otherwise the tail orphans). Resume past segments
		// already recorded in `progress.chainUris`.
		const rootUri = options?.replyRootUri ?? progress.rootUri;
		const rootCid = options?.replyRootCid ?? progress.rootCid;
		for (let i = 1 + progress.chainUris.length; i < chunks.length; i++) {
			const replyResult = await client.createPost(chunks[i], createdAt, {
				replyToUri: progress.prevUri,
				replyToCid: progress.prevCid,
				replyRootUri: rootUri,
				replyRootCid: rootCid,
			});
			progress.chainUris.push(replyResult.uri);
			progress.prevUri = replyResult.uri;
			progress.prevCid = replyResult.cid;
			await env.KV.put(progressKey, JSON.stringify(progress), { expirationTtl: CHAIN_PROGRESS_TTL });
			verbose({ tag: "bsky-post", type: "chain", channelId: logContext.channelId, itemId: logContext.itemId, chunk: i + 1, totalChunks: chunks.length, bskyUri: replyResult.uri, message: `${logContext.channelId}: chain chunk ${i + 1}/${chunks.length} for ${logContext.itemId} → ${replyResult.uri}` });
		}

		return { uri: progress.rootUri, cid: progress.rootCid!, chainUris: progress.chainUris };
	};

	const uploadImages = async (client: BlueskyClient, imageUrls: string[]): Promise<UploadedMedia[]> => {
		const images: UploadedMedia[] = [];
		for (const url of imageUrls) {
			try {
				images.push(await client.uploadImage(url));
			} catch (err) {
				warn({ tag: "uploadImage", url, message: `failed to upload image ${url}`, error: String(err) });
			}
		}
		return images;
	};

	const buildVideoCard = async (client: BlueskyClient, video: VideoItem): Promise<ExternalCard> => {
		let thumb;
		if (video.thumbnailUrl) {
			try {
				thumb = await client.uploadBlobFromUrl(video.thumbnailUrl);
			} catch (err) {
				warn({ tag: "video-thumb", url: video.thumbnailUrl, videoId: video.id, message: `failed to upload thumbnail`, error: String(err) });
			}
		}
		return {
			uri: video.watchUrl,
			title: videoPostText(video),
			description: videoCardDescription(video),
			thumb,
		};
	};

	return {
		step,
		env,
		channelId,
		channelConfig,
		parentWorkflowId,
		logger,
		getClient,
		getMirrored,
		storeMirrored,
		postChain,
		uploadImages,
		buildVideoCard,
	};
}
