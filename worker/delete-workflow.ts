import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { checkVideosExist } from "./youtube-api";
import { getAuthenticatedClient } from "./bluesky";
import type { BlueskyClient } from "./bluesky";
import { stepDo } from "./step";
import type { ChannelConfig, MirroredRecord, RecentIndexEntry } from "./types";
import { log, error, verbose, setWorkflowContext, Logger } from "./log";
import { normalizeChannelId } from "./handles";

export interface MirrorDeleteWorkflowParams {
	channelId: string;
}

interface RecentEntry {
	itemId: string;
	bskyUri: string;
	account: "main" | "rt";
}

// Every Bluesky post belonging to a mirrored item: the root plus any self-reply
// continuation segments (`chainUris`). De-duplicated, root first.
export function mirroredPostUris(fallbackUri: string, record: MirroredRecord | null): string[] {
	return [...new Set([record?.bskyUri ?? fallbackUri, ...(record?.chainUris ?? [])])];
}

export class MirrorDeleteWorkflow extends WorkflowEntrypoint<Env, MirrorDeleteWorkflowParams> {
	logger: Logger | undefined;
	private clientCache: Map<string, BlueskyClient> = new Map();

	async run(event: WorkflowEvent<MirrorDeleteWorkflowParams>, step: WorkflowStep) {
		const channelId = normalizeChannelId(event.payload.channelId);
		setWorkflowContext(event.instanceId);
		this.logger = new Logger(event.instanceId);
		log({ tag: "workflow-start", channelId, message: `${channelId}: MirrorDeleteWorkflow ${event.instanceId} started` });

		const channelConfig = await stepDo<ChannelConfig>(step, `load-config-${channelId}`, async () => {
			const config = await this.env.KV.get<ChannelConfig>(`users:${channelId}`, "json");
			if (!config) throw new Error(`No config found for channel ${channelId}`);
			return config;
		});

		// List recent mirrored VIDEOS from the self-expiring recency index. Only
		// videos are checked for deletion — the Data API can confirm their
		// existence cheaply; community/comment deletions are out of scope.
		const entries = await stepDo<RecentEntry[]>(step, `list-recent-${channelId}`, async () => {
			return this.listRecentVideos(channelId);
		});

		if (entries.length === 0) {
			verbose({ tag: "delete-check", channelId, message: `${channelId}: no recent mirrored videos to check` });
			return;
		}

		const apiKey = await this.env.YOUTUBE_API_KEY.get();
		const videoIds = entries.map((e) => e.itemId);

		// `checkVideosExist` throws (via ytFetch) on any non-OK API response, so a
		// successful call that returns an empty set genuinely means every checked
		// video is gone — common when a single recent upload is later deleted. Don't
		// guard on size === 0: that would strand the cleanup exactly when it's needed.
		const existing = await stepDo<string[]>(step, `check-existence-${channelId}`, async () => {
			const alive = await checkVideosExist(videoIds, apiKey);
			return [...alive];
		});
		const existingIds: Set<string> = new Set(existing);

		const deleted = videoIds.filter((id) => !existingIds.has(id));
		if (deleted.length === 0) {
			verbose({ tag: "delete-check", channelId, message: `${channelId}: no deleted videos found` });
			return;
		}

		log({ tag: "delete-check", channelId, deletedCount: deleted.length, message: `${channelId}: ${deleted.length} deleted videos to remove from Bluesky` });

		for (const videoId of deleted) {
			await step.do(`delete-bsky-${videoId}`, async () => {
				const entry = entries.find((e) => e.itemId === videoId);
				if (!entry) return;

				const record = await this.env.KV.get<MirroredRecord>(`mirrored:${channelId}:${videoId}`, "json");
				const uris = mirroredPostUris(entry.bskyUri, record);
				const client = await this.getClient(channelConfig, entry.account);

				let removed = 0;
				for (const uri of uris) {
					try {
						await client.deleteRecord(uri);
						removed++;
					} catch (err) {
						error({ tag: "delete-check", channelId, videoId, bskyUri: uri, message: `${channelId}: failed to delete Bluesky post ${uri}`, error: String(err) });
					}
				}
				const segmentNote = uris.length > 1 ? ` (${removed}/${uris.length} chain segments)` : "";
				log({ tag: "delete-check", channelId, videoId, account: entry.account, deletedCount: removed, message: `${channelId}: deleted Bluesky post for video ${videoId}${segmentNote}` });

				if (record) {
					const updated: MirroredRecord = { ...record, deletedAt: new Date().toISOString() };
					await this.env.KV.put(`mirrored:${channelId}:${videoId}`, JSON.stringify(updated));
				}
				await this.env.KV.delete(`recent:${channelId}:${videoId}`);
			});
		}
	}

	private async listRecentVideos(channelId: string): Promise<RecentEntry[]> {
		const prefix = `recent:${channelId}:`;
		const entries: RecentEntry[] = [];
		let cursor: string | undefined;
		do {
			const list = await this.env.KV.list<RecentIndexEntry>({ prefix, cursor });
			for (const key of list.keys) {
				if (!key.metadata) continue;
				const itemId = key.name.slice(prefix.length);
				const record = await this.env.KV.get<MirroredRecord>(`mirrored:${channelId}:${itemId}`, "json");
				if (record?.kind !== "video") continue; // only videos are delete-checked
				entries.push({ itemId, bskyUri: key.metadata.bskyUri, account: key.metadata.account });
			}
			cursor = list.list_complete ? undefined : list.cursor;
		} while (cursor);
		return entries;
	}

	private async getClient(config: ChannelConfig, account: "main" | "rt"): Promise<BlueskyClient> {
		const cacheKey = config[account].atProtoAccount;
		const existing = this.clientCache.get(cacheKey);
		if (existing) return existing;
		const client = await getAuthenticatedClient(
			this.env.KV,
			this.env as unknown as { [key: string]: SecretsStoreSecret },
			config[account],
		);
		this.clientCache.set(cacheKey, client);
		return client;
	}
}
