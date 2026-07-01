export { MirrorChannelWorkflow } from "./workflow";

import { normalizeChannelId } from "./handles";
import { createWorkflowWithRetry } from "./cron-dispatch";
import { getScheduledChannels } from "./schedule";
import { DEFAULT_POLL_INTERVAL_MINUTES } from "./constants";
import type { ChannelConfig } from "./types";

export default {
	async fetch(): Promise<Response> {
		return new Response(null, { status: 404 });
	},

	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		const keys = await env.KV.list({ prefix: "users:" });
		const channelIds = keys.keys.map((k) => normalizeChannelId(k.name.replace("users:", "")));

		const configs = await Promise.all(
			channelIds.map(async (channelId) => {
				const raw = await env.KV.get<ChannelConfig>(`users:${channelId}`, "json");
				return { channelId, pollIntervalMinutes: raw?.pollIntervalMinutes ?? DEFAULT_POLL_INTERVAL_MINUTES };
			}),
		);

		const now = new Date(controller.scheduledTime);
		const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
		const scheduled = getScheduledChannels(configs, minute);

		console.log({ tag: "cron", scheduledTime: now.toISOString(), minute, totalChannels: channelIds.length, scheduledChannels: scheduled.length, channels: scheduled, message: `mirror-channel cron: minute ${minute}, dispatching ${scheduled.length}/${channelIds.length} channels` });

		for (const channelId of scheduled) {
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			try {
				await createWorkflowWithRetry(env.CHANNEL_WORKFLOW, `channel-${channelId}-${ts}`, { channelId });
			} catch (err) {
				console.error({ tag: "cron", channelId, message: `${channelId}: failed to start channel workflow`, error: String(err) });
			}
		}
	},
} satisfies ExportedHandler<Env>;
