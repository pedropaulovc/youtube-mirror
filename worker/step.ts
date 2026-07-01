import type { WorkflowStep } from "cloudflare:workers";

type StepConfig = Parameters<WorkflowStep["do"]>[1];

/**
 * Typed wrapper around WorkflowStep.do() that centralizes the `as unknown as T`
 * cast needed because TypeScript can't prove our interfaces satisfy the recursive
 * Rpc.Serializable<T> constraint. Runtime behavior is identical.
 */
export function stepDo<T>(
	step: WorkflowStep,
	name: string,
	fn: () => Promise<T>,
): Promise<T>;
export function stepDo<T>(
	step: WorkflowStep,
	name: string,
	config: StepConfig,
	fn: () => Promise<T>,
): Promise<T>;
export function stepDo<T>(
	step: WorkflowStep,
	name: string,
	configOrFn: StepConfig | (() => Promise<T>),
	maybeFn?: () => Promise<T>,
): Promise<T> {
	if (maybeFn) {
		return step.do(name, configOrFn as StepConfig, maybeFn as never) as unknown as Promise<T>;
	}
	return step.do(name, configOrFn as () => Promise<never>) as unknown as Promise<T>;
}
