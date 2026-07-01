import type { WorkflowStep } from "cloudflare:workers";
import type { AppBskyRichtextFacet } from "@atproto/api";
import { getAuthenticatedClient, BlueskyClient } from "../bluesky";
import type { PostResult, UploadedMedia, ExternalCard } from "../bluesky";
import { videoCardDescription, videoPostText } from "../content";
import type { ChannelConfig, ItemKind, MirroredRecord, VideoItem } from "../types";
import { Logger, log, warn, verbose } from "../log";
import { normalizeChannelId } from "../handles";
import { RECENT_INDEX_TTL_SECONDS } from "../constants";

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
		// First chunk carries images/external card + any first-chunk facets.
		const firstResult = await client.createPost(chunks[0], createdAt, {
			images: options?.images,
			external: options?.external,
			replyToUri: options?.replyToUri,
			replyToCid: options?.replyToCid,
			replyRootUri: options?.replyRootUri,
			replyRootCid: options?.replyRootCid,
			facets: options?.firstChunkFacets,
		});

		// Remaining chunks as self-replies, collecting URIs so the whole chain can
		// be deleted as a unit (otherwise the tail orphans).
		const chainUris: string[] = [];
		let prevResult = firstResult;
		const rootUri = options?.replyRootUri ?? firstResult.uri;
		const rootCid = options?.replyRootCid ?? firstResult.cid;
		for (let i = 1; i < chunks.length; i++) {
			const replyResult = await client.createPost(chunks[i], createdAt, {
				replyToUri: prevResult.uri,
				replyToCid: prevResult.cid,
				replyRootUri: rootUri,
				replyRootCid: rootCid,
			});
			chainUris.push(replyResult.uri);
			verbose({ tag: "bsky-post", type: "chain", channelId: logContext.channelId, itemId: logContext.itemId, chunk: i + 1, totalChunks: chunks.length, bskyUri: replyResult.uri, message: `${logContext.channelId}: chain chunk ${i + 1}/${chunks.length} for ${logContext.itemId} → ${replyResult.uri}` });
			prevResult = replyResult;
		}

		return { ...firstResult, chainUris };
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
