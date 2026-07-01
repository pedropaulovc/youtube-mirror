let _wfId: string | undefined;
let _parentWfId: string | undefined;

export function setWorkflowContext(workflowId: string, parentWorkflowId?: string) {
	_wfId = workflowId;
	_parentWfId = parentWorkflowId;
}

function inject(data: Record<string, unknown>): Record<string, unknown> {
	return {
		...(_wfId ? { workflowId: _wfId } : {}),
		...(_parentWfId ? { parentWorkflowId: _parentWfId } : {}),
		...data,
	};
}

export function log(data: Record<string, unknown>) {
	console.log(inject(data));
}

export function warn(data: Record<string, unknown>) {
	console.warn(inject(data));
}

export function error(data: Record<string, unknown>) {
	console.error(inject(data));
}

export function verbose(data: Record<string, unknown>) {
	console.log(inject({ level: "verbose", ...data }));
}

export class Logger {
	wfId: string;
	parentWfId: string | undefined;

	constructor(wfId: string, parentWfId?: string) {
		this.wfId = wfId;
		this.parentWfId = parentWfId;
	}

	inject(data: Record<string, unknown>): Record<string, unknown> {
		return {
			workflowId: this.wfId,
			...(this.parentWfId ? { parentWorkflowId: this.parentWfId } : {}),
			...data,
		};
	}

	log(data: Record<string, unknown>) {
		console.log(this.inject(data));
	}

	warn(data: Record<string, unknown>) {
		console.warn(this.inject(data));
	}

	error(data: Record<string, unknown>) {
		console.error(this.inject(data));
	}

	verbose(data: Record<string, unknown>) {
		console.log(this.inject({ level: "verbose", ...data }));
	}
}
