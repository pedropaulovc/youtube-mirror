const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;

// Instance statuses that mean a previous dispatch of this id failed terminally and
// must be re-run. Anything else (queued/running/paused/waiting/complete) means the
// item is already in flight or finished — restarting it would duplicate the post.
const TERMINAL_FAILURE: ReadonlySet<string> = new Set(["errored", "terminated"]);

/**
 * Create a workflow instance, retrying transient Cloudflare control-plane
 * failures (`Error: internal error`). The cron handlers dispatch one instance
 * per channel; a bare `.create()` that threw on a transient hiccup made that
 * channel skip its entire poll cycle.
 *
 * The instance `id` is held stable across attempts (callers pass a deterministic
 * per-item id), so a retry after a hiccup that actually created the instance
 * server-side surfaces as `already exists`. We can't treat that as blanket
 * success: because the id is deterministic, a poll that re-dispatches an item
 * whose earlier attempt failed terminally ALSO hits `already exists` (the failed
 * instance lingers in retention). Swallowing it would strand that item forever —
 * it never mirrors and never re-dispatches. So on `already exists` we inspect the
 * existing instance and restart it when it's errored/terminated.
 */
export async function createWorkflowWithRetry(
	workflow: Workflow,
	id: string,
	params: Record<string, unknown>,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await workflow.create({
				id,
				params,
				retention: {
					successRetention: "1 day",
					errorRetention: "1 day",
				},
			});
			return;
		} catch (err) {
			if (isAlreadyExists(err)) return await reconcileExisting(workflow, id);
			if (attempt >= MAX_ATTEMPTS - 1) throw err;
			await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * (attempt + 1)));
		}
	}
}

// An instance with this id already exists. Re-run it only if a prior dispatch left
// it errored or terminated; instances still running or already complete are left
// untouched (restarting a live/finished one would re-post the item).
async function reconcileExisting(workflow: Workflow, id: string): Promise<void> {
	const instance = await workflow.get(id);
	const { status } = await instance.status();
	if (TERMINAL_FAILURE.has(status)) await instance.restart();
}

function isAlreadyExists(err: unknown): boolean {
	return String(err).toLowerCase().includes("already exists");
}
