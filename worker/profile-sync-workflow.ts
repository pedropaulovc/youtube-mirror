import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { fetchChannelInfo } from "./youtube-api";
import type { ChannelInfo } from "./youtube-api";
import { getAuthenticatedClient, resolveHandleToDid, queryModerationLabels } from "./bluesky";
import { stepDo } from "./step";
import type { ChannelConfig } from "./types";
import { log, warn, error, setWorkflowContext, Logger } from "./log";
import { truncateGraphemes } from "./text";
import { UNOFFICIAL_SUFFIX, RT_DISPLAY_PREFIX, RT_DISPLAY_SUFFIX, BIO_DISCLAIMER } from "./constants";
import { normalizeChannelId } from "./handles";

export interface MirrorProfileWorkflowParams {
	channelId: string;
}

export async function checkModerationLabels(
	channelId: string,
	accounts: ReadonlyArray<{ role: "main" | "rt"; handle: string }>,
): Promise<void> {
	for (const { role, handle } of accounts) {
		const did = await resolveHandleToDid(handle);
		if (!did) {
			warn({ tag: "moderation-label", channelId, account: role, bskyHandle: handle, message: `${channelId}: could not resolve DID for ${handle}` });
			continue;
		}
		const labels = await queryModerationLabels(did);
		for (const label of labels) {
			error({ tag: "moderation-label", channelId, account: role, bskyHandle: handle, did, label: label.val, labelExpires: label.exp ?? "never", labelCreated: label.cts, message: `${channelId}: ${role} account ${handle} has moderation label "${label.val}" (expires ${label.exp ?? "never"})` });
		}
	}
}

export class MirrorProfileWorkflow extends WorkflowEntrypoint<Env, MirrorProfileWorkflowParams> {
	logger: Logger | undefined;

	async run(event: WorkflowEvent<MirrorProfileWorkflowParams>, step: WorkflowStep) {
		const channelId = normalizeChannelId(event.payload.channelId);
		setWorkflowContext(event.instanceId);
		this.logger = new Logger(event.instanceId);
		log({ tag: "workflow-start", channelId, message: `${channelId}: MirrorProfileWorkflow ${event.instanceId} started` });

		const channelConfig = await stepDo<ChannelConfig>(step, `load-config-${channelId}`, async () => {
			const config = await this.env.KV.get<ChannelConfig>(`users:${channelId}`, "json");
			if (!config) throw new Error(`No config found for channel ${channelId}`);
			return config;
		});

		await stepDo<void>(step, `check-labels-${channelId}`, async () => {
			await checkModerationLabels(channelId, [
				{ role: "main", handle: channelConfig.main.atProtoAccount },
				{ role: "rt", handle: channelConfig.rt.atProtoAccount },
			]);
		});

		const info = await stepDo<ChannelInfo | null>(step, `fetch-profile-${channelId}`, async () => {
			const apiKey = await this.env.YOUTUBE_API_KEY.get();
			return fetchChannelInfo(channelId, apiKey);
		});

		if (!info) {
			warn({ tag: "sync-profile", channelId, message: `${channelId}: no channel info returned, skipping profile sync` });
			return;
		}

		await stepDo<void>(step, `update-profile-${channelId}`, async () => {
			const mainClient = await getAuthenticatedClient(
				this.env.KV,
				this.env as unknown as { [key: string]: SecretsStoreSecret },
				channelConfig.main,
			);

			const fields: Parameters<typeof mainClient.updateProfile>[0] = {};
			if (info.title) {
				const maxNameLen = 64 - [...UNOFFICIAL_SUFFIX].length;
				fields.displayName = truncateGraphemes(info.title, maxNameLen) + UNOFFICIAL_SUFFIX;
			}
			if (info.description) {
				const suffix = channelConfig.bioSuffix ?? BIO_DISCLAIMER;
				const maxBioLen = 256 - [...suffix].length;
				fields.description = truncateGraphemes(info.description, maxBioLen) + suffix;
			}
			if (info.avatarUrl) {
				try {
					fields.avatar = await mainClient.uploadBlobFromUrl(info.avatarUrl);
				} catch (err) {
					warn({ tag: "sync-profile", channelId, message: `${channelId}: failed to upload avatar`, error: String(err) });
				}
			}
			if (info.bannerUrl) {
				try {
					fields.banner = await mainClient.uploadBlobFromUrl(info.bannerUrl);
				} catch (err) {
					warn({ tag: "sync-profile", channelId, message: `${channelId}: failed to upload banner`, error: String(err) });
				}
			}

			await mainClient.updateProfile(fields);
			log({ tag: "sync-profile", channelId, message: `${channelId}: profile updated` });
		});

		await stepDo<void>(step, `update-rt-profile-${channelId}`, async () => {
			const rtClient = await getAuthenticatedClient(
				this.env.KV,
				this.env as unknown as { [key: string]: SecretsStoreSecret },
				channelConfig.rt,
			);

			const fields: Parameters<typeof rtClient.updateProfile>[0] = {};
			if (info.title) {
				const maxNameLen = 64 - [...RT_DISPLAY_PREFIX].length - [...RT_DISPLAY_SUFFIX].length;
				fields.displayName = RT_DISPLAY_PREFIX + truncateGraphemes(info.title, maxNameLen) + RT_DISPLAY_SUFFIX;
			}

			await rtClient.updateProfile(fields);
			log({ tag: "sync-profile", channelId, message: `${channelId}: RT profile updated` });
		});
	}
}
