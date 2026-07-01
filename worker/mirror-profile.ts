export { MirrorProfileWorkflow } from "./profile-sync-workflow";

import { createWorkflowWithRetry } from "./cron-dispatch";
import { KvStore } from "./kv";

export default {
	async fetch(): Promise<Response> {
		return new Response(null, { status: 404 });
	},

	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		const channelIds = await new KvStore(env.KV).listChannelIds();

		console.log({ tag: "cron", worker: "mirror-profile", totalChannels: channelIds.length, message: `mirror-profile cron: dispatching ${channelIds.length} channels` });

		for (const channelId of channelIds) {
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			try {
				await createWorkflowWithRetry(env.PROFILE_SYNC_WORKFLOW, `profile-${channelId}-${ts}`, { channelId });
			} catch (err) {
				console.error({ tag: "cron", channelId, message: `${channelId}: failed to start profile workflow`, error: String(err) });
			}
		}
	},
} satisfies ExportedHandler<Env>;
