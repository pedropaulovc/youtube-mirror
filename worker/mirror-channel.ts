export { MirrorChannelWorkflow } from "./workflow";

import { createWorkflowWithRetry } from "./cron-dispatch";
import { getScheduledChannels } from "./schedule";
import { KvStore } from "./kv";
import { DEFAULT_POLL_INTERVAL_MINUTES } from "./constants";

// A malformed KV value (0, negative, NaN) would make `index % interval` evaluate to
// NaN in the scheduler and silently drop the channel from every cron minute. Clamp to
// the documented minimum of 1.
function clampPollInterval(value: number | undefined): number {
	return Number.isFinite(value) && (value as number) >= 1 ? Math.floor(value as number) : DEFAULT_POLL_INTERVAL_MINUTES;
}

export default {
	async fetch(): Promise<Response> {
		return new Response(null, { status: 404 });
	},

	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		const kv = new KvStore(env.KV);
		const channelIds = await kv.listChannelIds();

		const configs = await Promise.all(
			channelIds.map(async (channelId) => {
				const raw = await kv.getChannelConfig(channelId);
				return { channelId, pollIntervalMinutes: clampPollInterval(raw?.pollIntervalMinutes) };
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
