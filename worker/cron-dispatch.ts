const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;

/**
 * Create a workflow instance, retrying transient Cloudflare control-plane
 * failures (`Error: internal error`). The cron handlers dispatch one instance
 * per channel; a bare `.create()` that threw on a transient hiccup made that
 * channel skip its entire poll cycle.
 *
 * The instance `id` is held stable across attempts (callers pass a per-channel
 * id stamped once before the loop), so a retry after a hiccup that actually
 * created the instance server-side surfaces as `already exists` — which we
 * treat as success rather than re-dispatching.
 */
export async function createWorkflowWithRetry(
	workflow: Workflow,
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await workflow.create({ id, params });
			return;
		} catch (err) {
			if (isAlreadyExists(err)) return; // a prior attempt landed server-side
			if (attempt >= MAX_ATTEMPTS - 1) throw err;
			await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * (attempt + 1)));
		}
	}
}

function isAlreadyExists(err: unknown): boolean {
	return String(err).toLowerCase().includes("already exists");
}
