export interface OmissionDraft {
	type: "context_edit";
	targetId: string;
	replacement: null;
}

export interface EditableBoundary {
	entries: unknown[];
	context: {
		contextEntries: unknown[];
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Older Pi versions emit turn_end without a persistent editing preview. */
export function isEditableBoundary(value: unknown): value is EditableBoundary {
	return isRecord(value) &&
		Array.isArray(value.entries) &&
		isRecord(value.context) &&
		Array.isArray(value.context.contextEntries);
}

/**
 * Classify the entire response, not individual reasoning blocks. A tool-only
 * response is productive too; unknown or malformed output must be retained.
 * Stop reasons, visible thinking length, and opaque signatures are irrelevant.
 */
export function isThinkingOnlyAssistantMessage(value: unknown): boolean {
	if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) {
		return false;
	}

	let hasThinking = false;
	for (const block of value.content) {
		if (!isRecord(block)) return false;
		if (block.type === "thinking" && typeof block.thinking === "string") {
			hasThinking = true;
			continue;
		}
		if (block.type === "text" && typeof block.text === "string" && block.text.trim() === "") {
			continue;
		}
		return false;
	}
	return hasThinking;
}

/** Scan the full effective projection, including older retained responses. */
export function collectThinkingOnlyOmissions(contextEntries: readonly unknown[]): OmissionDraft[] {
	const drafts: OmissionDraft[] = [];
	const seen = new Set<string>();

	for (const entry of contextEntries) {
		if (!isRecord(entry) || !isRecord(entry.sourceEntry)) continue;
		const source = entry.sourceEntry;
		if (source.type !== "message" || typeof source.id !== "string" || source.id.length === 0) continue;
		// Zero messages means an existing edit already omitted the source entry.
		// Multi-message projections may contain other output: do not drop them.
		if (!Array.isArray(entry.messages) || entry.messages.length !== 1) continue;
		if (seen.has(source.id) || !isThinkingOnlyAssistantMessage(entry.messages[0])) continue;

		seen.add(source.id);
		drafts.push({ type: "context_edit", targetId: source.id, replacement: null });
	}
	return drafts;
}

export function buildCleanupBoundaryResult(event: EditableBoundary): { entries: unknown[] } | undefined {
	const omissions = collectThinkingOnlyOmissions(event.context.contextEntries);
	if (omissions.length === 0) return undefined;

	// Extend earlier handlers' drafts without replacing their decisions or
	// requesting continuation. Pi commits these edits and rebuilds its context.
	return { entries: [...event.entries, ...omissions] };
}
