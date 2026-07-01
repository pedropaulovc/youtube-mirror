// Test-only entry point: exports every workflow class from a single module so
// the vitest wrangler config (wrangler.test.jsonc) can bind them all in-process
// without cross-script `script_name` references. Production uses the separate
// per-worker entry points (mirror-{channel,item,delete,profile}.ts).
export { MirrorChannelWorkflow } from "./workflow";
export { MirrorItemWorkflow } from "./item-workflow";
export { MirrorDeleteWorkflow } from "./delete-workflow";
export { MirrorProfileWorkflow } from "./profile-sync-workflow";

export default {
	async fetch(): Promise<Response> {
		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
