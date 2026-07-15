import { describe, it, expect, vi } from "vitest";
import { createWorkflowWithRetry } from "../../worker/cron-dispatch";

// Minimal fake of the Workflow binding: `create` behavior is injected per test, and
// `get(id)` returns an instance whose `status()`/`restart()` are spies we assert on.
function fakeWorkflow(opts: {
	create: (o: { id: string; params: Record<string, unknown> }) => Promise<unknown>;
	status?: string;
	restart?: () => Promise<void>;
}) {
	const restart = vi.fn(opts.restart ?? (async () => {}));
	const status = vi.fn(async () => ({ status: opts.status ?? "running" }));
	const get = vi.fn(async (id: string) => ({ id, status, restart }));
	const workflow = { create: vi.fn(opts.create), get } as unknown as Workflow;
	return { workflow, get, status, restart };
}

const alreadyExists = () => Promise.reject(new Error("instance with id X already exists"));

describe("createWorkflowWithRetry", () => {
	it("creates the instance and does not touch existing ones on success", async () => {
		const create = vi.fn(async () => ({}));
		const { workflow, get, restart } = fakeWorkflow({ create });
		await createWorkflowWithRetry(workflow, "id-1", { a: 1 });
		expect(create).toHaveBeenCalledWith({
			id: "id-1",
			params: { a: 1 },
			retention: {
				successRetention: "1 day",
				errorRetention: "1 day",
			},
		});
		expect(get).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
	});

	it("restarts an existing instance left errored by a prior dispatch", async () => {
		// The deterministic id means a re-dispatched item whose first attempt failed
		// terminally hits `already exists`. Without the restart it would strand forever.
		const { workflow, restart } = fakeWorkflow({ create: alreadyExists, status: "errored" });
		await createWorkflowWithRetry(workflow, "id-1", {});
		expect(restart).toHaveBeenCalledTimes(1);
	});

	it("restarts an existing instance left terminated by a prior dispatch", async () => {
		const { workflow, restart } = fakeWorkflow({ create: alreadyExists, status: "terminated" });
		await createWorkflowWithRetry(workflow, "id-1", {});
		expect(restart).toHaveBeenCalledTimes(1);
	});

	it("leaves a still-running instance untouched (would duplicate the post)", async () => {
		const { workflow, restart } = fakeWorkflow({ create: alreadyExists, status: "running" });
		await createWorkflowWithRetry(workflow, "id-1", {});
		expect(restart).not.toHaveBeenCalled();
	});

	it("leaves a completed instance untouched (item already mirrored)", async () => {
		const { workflow, restart } = fakeWorkflow({ create: alreadyExists, status: "complete" });
		await createWorkflowWithRetry(workflow, "id-1", {});
		expect(restart).not.toHaveBeenCalled();
	});

	it("retries a transient control-plane failure, then succeeds", async () => {
		let calls = 0;
		const { workflow } = fakeWorkflow({
			create: async () => {
				calls++;
				if (calls < 2) throw new Error("internal error");
				return {};
			},
		});
		await createWorkflowWithRetry(workflow, "id-1", {});
		expect(calls).toBe(2);
	});
});
