/** Timing belongs to one dispatched task, never to the resident instance's lifetime. */
export interface RunTiming {
	/** Unix milliseconds; absent on legacy records or before task dispatch. */
	runStartedAt?: number;
	/** Frozen on completion/interruption; absent while running or after an unobserved crash. */
	runEndedAt?: number;
}

/** Reset only when dispatching a new task, not for internal structured-output nudges. */
export function startRunTiming(timing: RunTiming, now = Date.now()): void {
	timing.runStartedAt = now;
	timing.runEndedAt = undefined;
}

/** Idempotent: keeping, reading, or shutting down a finished instance must not extend its run. */
export function finishRunTiming(timing: RunTiming, now = Date.now()): void {
	if (timing.runStartedAt !== undefined && timing.runEndedAt === undefined) {
		timing.runEndedAt = now;
	}
}

/** Shared model-visible text for list/check; never infer task timing from instance metadata. */
export function formatRunTiming(timing: RunTiming & { status: string }, now = Date.now()): string {
	if (timing.runStartedAt === undefined) {
		return "Current run: startedAt=unknown elapsed=unknown (no task timing recorded).";
	}
	const startedAt = new Date(timing.runStartedAt).toISOString();
	const end = timing.runEndedAt ?? (timing.status === "running" ? now : undefined);
	if (end === undefined) {
		// Recovery cannot know when an unobserved crash stopped the previous run.
		return `Current run: startedAt=${startedAt} elapsed=unknown (end time unavailable).`;
	}
	const seconds = (Math.max(0, end - timing.runStartedAt) / 1000).toFixed(1);
	const state = timing.runEndedAt === undefined ? "running" : "finished";
	return `Current run: startedAt=${startedAt} elapsed=${seconds}s (${state}).`;
}
