export function buildCompactionCompletedNotice(issuedAt: string): string {
	return `[System Notice: Context compaction has completed successfully at ${issuedAt}. ` +
		"Any compaction forewarning (<system-reminder> about an approaching context limit) with an " +
		"earlier timestamp still visible in the kept history is now OBSOLETE — do not call " +
		"request_compaction again unless the extension issues a brand-new forewarning. Please review " +
		"your previous plan and resume your remaining work seamlessly.]";
}

interface LastTurn {
	stopReason: unknown;
	requestedCompaction: boolean;
}

interface CompactionCompletion {
	id: string;
	reason: string;
	willRetry: boolean;
}

interface Settlement {
	aborted: boolean;
	idle: boolean;
	hasPendingMessages: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Supplement only native compaction that leaves unfinished work idle. This is
 * independent of reasoning cleanup: omission alone must never trigger a retry.
 */
export class NativeCompactionContinuation {
	private lastTurn: LastTurn | undefined;
	private pendingCompactionId: string | undefined;
	private lastCompactionId: string | undefined;
	private readonly scheduledNotices = new Map<string, boolean>();

	reset(): void {
		// A session switch must still recognize notices already deferred by Pi.
		this.cancel();
		this.lastCompactionId = undefined;
	}

	/** New input or actual model activity supersedes a possible extra wake. */
	cancel(): void {
		this.lastTurn = undefined;
		this.pendingCompactionId = undefined;
		for (const text of this.scheduledNotices.keys()) {
			this.scheduledNotices.set(text, true);
		}
	}

	recordTurn(message: unknown, requestToolName: string): void {
		this.cancel();
		if (!isRecord(message) || message.role !== "assistant") return;
		const requestedCompaction = Array.isArray(message.content) && message.content.some((block) =>
			isRecord(block) && block.type === "toolCall" && block.name === requestToolName,
		);
		this.lastTurn = { stopReason: message.stopReason, requestedCompaction };
	}

	observeCompaction(event: CompactionCompletion, requestQueued: boolean): void {
		// Duplicate completion events must not disarm the already queued notice.
		if (event.id === this.lastCompactionId) return;
		this.lastCompactionId = event.id;

		const native = event.reason === "threshold" || event.reason === "overflow";
		if (!native || event.willRetry !== false) {
			this.cancel();
			return;
		}

		const unfinished = this.lastTurn?.stopReason === "length" ||
			(requestQueued && this.lastTurn?.requestedCompaction === true);
		this.pendingCompactionId = unfinished ? event.id : undefined;
	}

	takeNoticeAtSettlement(event: Settlement, issuedAt: string): string | undefined {
		if (event.aborted || !event.idle || event.hasPendingMessages) {
			this.cancel();
			return undefined;
		}
		this.lastTurn = undefined;
		if (!this.pendingCompactionId) return undefined;

		this.pendingCompactionId = undefined;
		const text = buildCompactionCompletedNotice(issuedAt);
		// Nested settlements can schedule another guide before an older one
		// is delivered. Keep each cancellation marker until its input arrives.
		this.scheduledNotices.set(text, false);
		return text;
	}

	/**
	 * sendUserMessage from agent_settled is deferred by Pi. If a newer input
	 * executes first, consume only our obsolete native notice, not any user's
	 * text or the existing requested-compaction onComplete notice.
	 */
	handleInput(source: string, text: string): { action: "handled" } | undefined {
		if (source === "extension" && this.scheduledNotices.has(text)) {
			const obsolete = this.scheduledNotices.get(text);
			this.scheduledNotices.delete(text);
			return obsolete ? { action: "handled" } : undefined;
		}
		this.cancel();
		return undefined;
	}
}
