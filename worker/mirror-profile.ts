export { MirrorProfileWorkflow } from "./profile-sync-workflow";

import { normalizeChannelId } from "./handles";
import { createWorkflowWithRetry } from "./cron-dispatch";

export default {
	async fetch(): Promise<Response> {
		return new Response(null, { status: 404 });
	},

	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		const keys = await env.KV.list({ prefix: "users:" });
		const channelIds = keys.keys.map((k) => normalizeChannelId(k.name.replace("users:", "")));

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
