export { MirrorItemWorkflow } from "./item-workflow";

// mirror-item is invoked only via the CHANNEL workflow's ITEM_WORKFLOW binding —
// it has no cron and serves no HTTP traffic.
export default {
	async fetch(): Promise<Response> {
		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
