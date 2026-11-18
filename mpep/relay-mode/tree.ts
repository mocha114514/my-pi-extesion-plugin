/**
 * Session-tree and conversation-history formatters for relay_status.
 *
 * Pi's RPC `get_tree` returns the full SessionTreeNode[] hierarchy with stable
 * entry IDs. Rendering that entire payload verbatim would quickly blow up the
 * foreground relay agent's context window, so we provide:
 *   1. `formatTreeIndex`: a compact one-line-per-node outline across the whole
 *      tree (preserving branches and current leaf marker).
 *   2. `formatNodeDetail`: paginated inspection of one specific entryId.
 *   3. `formatLatestTurns`: bounded view of the latest N conversation turns.
 */

export interface TreeEntryLike {
	type?: unknown;
	id?: unknown;
	parentId?: unknown;
	timestamp?: unknown;
	message?: unknown;
	summary?: unknown;
	tokensBefore?: unknown;
	provider?: unknown;
	modelId?: unknown;
	thinkingLevel?: unknown;
	customType?: unknown;
	content?: unknown;
	name?: unknown;
}

export interface TreeNodeLike {
	entry?: TreeEntryLike;
	children?: TreeNodeLike[];
	label?: string;
}

const DEFAULT_PREVIEW_CHARS = 90;

function singleLine(text: string, maxChars = DEFAULT_PREVIEW_CHARS): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (!collapsed) return "";
	if (collapsed.length <= maxChars) return collapsed;
	return `${collapsed.slice(0, maxChars - 3)}...`;
}

/** Extract concatenated text blocks from Pi message content (string or blocks). */
export function extractTextBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block as Record<string, unknown>;
		if (rec.type === "text" && typeof rec.text === "string" && rec.text.trim()) {
			parts.push(rec.text);
		}
	}
	return parts.join("\n");
}

/** Extract thinking blocks from an assistant message's content array. */
function extractThinkingBlocks(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block as Record<string, unknown>;
		if (rec.type === "thinking" && typeof rec.thinking === "string" && rec.thinking.trim()) {
			parts.push(rec.thinking);
		}
	}
	return parts.join("\n");
}

/** Summarize tool calls inside an assistant message content array. */
function summarizeToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block as Record<string, unknown>;
		if (rec.type === "toolCall" && typeof rec.name === "string") {
			names.push(rec.name);
		}
	}
	return names;
}

function summarizeToolCounts(names: string[]): string {
	if (names.length === 0) return "";
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	const items = [...counts.entries()].map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
	return `tools: ${items.join(", ")}`;
}

/** Format tool calls for detailed node/turn inspection (`fullArgs` preserves full JSON for node view). */
function formatDetailedToolCalls(content: unknown, fullArgs = false): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block as Record<string, unknown>;
		if (rec.type !== "toolCall" || typeof rec.name !== "string") continue;
		let argsPreview = "";
		if (rec.arguments !== undefined) {
			try {
				argsPreview = fullArgs
					? JSON.stringify(rec.arguments, null, 2)
					: singleLine(JSON.stringify(rec.arguments), 220);
			} catch {
				argsPreview = "[unserializable arguments]";
			}
		}
		lines.push(fullArgs && argsPreview.includes("\n")
			? `- [toolCall ${rec.name}]\n${argsPreview}`
			: `- [toolCall ${rec.name}] ${argsPreview}`);
	}
	return lines;
}

function isIncludedInOutline(node: TreeNodeLike, leafId: string | null, includeTools: boolean): boolean {
	const entry = node.entry;
	if (!entry) return false;
	const id = typeof entry.id === "string" ? entry.id : "";
	if (id && id === leafId) return true;
	if (node.label) return true;
	if ((node.children?.length ?? 0) > 1) return true;

	const entryType = typeof entry.type === "string" ? entry.type : "";
	if (entryType === "compaction" || entryType === "branch_summary" || entryType === "custom_message") {
		return true;
	}
	if (entryType !== "message") {
		// Hide routine metadata entries (thinking_level_change, custom, etc.) unless branched/labeled.
		return false;
	}
	const msg = entry.message as Record<string, unknown> | undefined;
	const role = typeof msg?.role === "string" ? msg.role : "";
	if (role === "toolResult") return includeTools;
	return role === "user" || role === "assistant" || role === "custom" || role === "bashExecution";
}

interface CollapsedNode {
	node: TreeNodeLike;
	children: CollapsedNode[];
}

/**
 * Collapse skipped nodes iteratively while preserving branching topology for
 * visible nodes (immune to deep-session stack overflow).
 */
function collapseTree(nodes: TreeNodeLike[], leafId: string | null, includeTools: boolean): CollapsedNode[] {
	const rootTarget: CollapsedNode[] = [];
	const stack: Array<{ node: TreeNodeLike; target: CollapsedNode[]; childrenTarget: CollapsedNode[]; visited: boolean }> = [];
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i]!;
		stack.push({ node, target: rootTarget, childrenTarget: [], visited: false });
	}

	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (!frame.visited) {
			frame.visited = true;
			stack.push(frame);
			const children = frame.node.children ?? [];
			for (let i = children.length - 1; i >= 0; i--) {
				stack.push({ node: children[i]!, target: frame.childrenTarget, childrenTarget: [], visited: false });
			}
			continue;
		}
		if (isIncludedInOutline(frame.node, leafId, includeTools)) {
			frame.target.push({ node: frame.node, children: frame.childrenTarget });
		} else {
			frame.target.push(...frame.childrenTarget);
		}
	}
	return rootTarget;
}

function summarizeEntryLine(node: TreeNodeLike, leafId: string | null): string {
	const entry = node.entry ?? {};
	const id = typeof entry.id === "string" ? entry.id : "?";
	const label = node.label ? ` [label: ${node.label}]` : "";
	const leafMark = id === leafId ? "  <-- current" : "";
	const entryType = typeof entry.type === "string" ? entry.type : "entry";

	if (entryType === "compaction") {
		const tokens = typeof entry.tokensBefore === "number" ? ` (${entry.tokensBefore} tokens)` : "";
		const preview = singleLine(String(entry.summary ?? ""));
		return `[${id}] compaction${tokens}${label}: ${preview || "(compacted)"}${leafMark}`;
	}
	if (entryType === "branch_summary") {
		const preview = singleLine(String(entry.summary ?? ""));
		return `[${id}] branch_summary${label}: ${preview || "(branch summary)"}${leafMark}`;
	}
	if (entryType === "custom_message") {
		const customType = typeof entry.customType === "string" ? entry.customType : "custom";
		const preview = singleLine(extractTextBlocks(entry.content));
		return `[${id}] custom(${customType})${label}: ${preview || "(empty)"}${leafMark}`;
	}
	if (entryType !== "message") {
		return `[${id}] ${entryType}${label}${leafMark}`;
	}

	const msg = (entry.message ?? {}) as Record<string, unknown>;
	const role = typeof msg.role === "string" ? msg.role : "message";

	if (role === "user") {
		const preview = singleLine(extractTextBlocks(msg.content));
		return `[${id}] user${label}: ${preview || "(empty)"}${leafMark}`;
	}
	if (role === "assistant") {
		const tools = summarizeToolCounts(summarizeToolCalls(msg.content));
		const stopReason = typeof msg.stopReason === "string" && msg.stopReason !== "stop" && msg.stopReason !== "toolUse"
			? ` [${msg.stopReason}]`
			: "";
		const text = extractTextBlocks(msg.content);
		const errorText = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
		const preview = singleLine(errorText || text);
		const tag = tools ? ` (${tools})` : "";
		return `[${id}] assistant${tag}${stopReason}${label}: ${preview || "(no text)"}${leafMark}`;
	}
	if (role === "toolResult") {
		const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
		const err = msg.isError ? " ERROR" : "";
		const preview = singleLine(extractTextBlocks(msg.content));
		return `[${id}] toolResult(${toolName}${err})${label}: ${preview || "(empty)"}${leafMark}`;
	}
	if (role === "bashExecution") {
		const cmd = typeof msg.command === "string" ? singleLine(msg.command, 60) : "";
		return `[${id}] bash${label}: $ ${cmd}${leafMark}`;
	}

	const preview = singleLine(extractTextBlocks(msg.content));
	return `[${id}] ${role}${label}: ${preview || "(empty)"}${leafMark}`;
}

export function formatTreeIndex(
	tree: unknown[],
	leafId: string | null,
	includeTools = false,
	offset = 0,
	limit = 200,
): string {
	if (!Array.isArray(tree) || tree.length === 0) {
		return "Worker session tree is empty (no messages recorded yet).";
	}
	const collapsed = collapseTree(tree as TreeNodeLike[], leafId, includeTools);
	if (collapsed.length === 0) {
		return "Worker session tree has no visible conversation nodes yet.";
	}

	const lines: string[] = [];
	// Keep linear chains flush at the current indent; only indent when a parent
	// actually forks into multiple sibling branches. Iterative stack avoids recursion limits.
	const renderStack: Array<{
		item: CollapsedNode;
		prefix: string;
		isLast: boolean;
		isBranchChild: boolean;
	}> = [];
	const rootsBranch = collapsed.length > 1;
	for (let i = collapsed.length - 1; i >= 0; i--) {
		renderStack.push({
			item: collapsed[i]!,
			prefix: "",
			isLast: i === collapsed.length - 1,
			isBranchChild: rootsBranch,
		});
	}

	while (renderStack.length > 0) {
		const frame = renderStack.pop()!;
		const connector = frame.isBranchChild ? (frame.isLast ? "└─ " : "├─ ") : "";
		lines.push(`${frame.prefix}${connector}${summarizeEntryLine(frame.item.node, leafId)}`);
		const childPrefix = frame.isBranchChild
			? `${frame.prefix}${frame.isLast ? "   " : "│  "}`
			: frame.prefix;
		const childCount = frame.item.children.length;
		const childrenBranch = childCount > 1;
		for (let i = childCount - 1; i >= 0; i--) {
			renderStack.push({
				item: frame.item.children[i]!,
				prefix: childPrefix,
				isLast: i === childCount - 1,
				isBranchChild: childrenBranch,
			});
		}
	}

	const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
	const safeOffset = Math.max(0, Math.min(lines.length, Math.floor(offset)));
	if (safeOffset === 0 && lines.length <= safeLimit) {
		return [`Worker session tree (${lines.length} entries):`, ...lines].join("\n");
	}

	const slice = lines.slice(safeOffset, safeOffset + safeLimit);
	const nextOffset = safeOffset + slice.length;
	const leafLine = lines.find((line) => line.includes("  <-- current"));
	const header =
		`Worker session tree (${lines.length} entries; showing ${safeOffset + 1}..${nextOffset}` +
		`${leafId ? `, current leaf: ${leafId}` : ""}):`;
	const footer = nextOffset < lines.length
		? `--- [More tree entries available: call relay_status({ view: "tree", offset: ${nextOffset}, limit: ${safeLimit} })]`
		: "--- [End of session tree]";

	const includeLeafHint = leafLine && !slice.includes(leafLine)
		? [`Current leaf node: ${leafLine.trim()}`]
		: [];
	return [header, ...includeLeafHint, ...slice, footer].join("\n");
}

function findNode(nodes: TreeNodeLike[], targetId: string): TreeNodeLike | undefined {
	const stack: TreeNodeLike[] = [];
	for (let i = nodes.length - 1; i >= 0; i--) {
		stack.push(nodes[i]!);
	}
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.entry?.id === targetId) return node;
		const children = node.children ?? [];
		for (let i = children.length - 1; i >= 0; i--) {
			stack.push(children[i]!);
		}
	}
	return undefined;
}

function renderEntryBody(node: TreeNodeLike): string {
	const entry = node.entry ?? {};
	const lines: string[] = [
		`Entry ID: ${String(entry.id ?? "?")}`,
		`Parent ID: ${entry.parentId ? String(entry.parentId) : "(root)"}`,
		`Type: ${String(entry.type ?? "unknown")}`,
	];
	if (typeof entry.timestamp === "string") lines.push(`Timestamp: ${entry.timestamp}`);
	if (node.label) lines.push(`Label: ${node.label}`);

	if (entry.type === "compaction") {
		if (typeof entry.tokensBefore === "number") lines.push(`Tokens Before: ${entry.tokensBefore}`);
		lines.push("", "--- Compaction Summary ---", String(entry.summary ?? "(empty)"));
		return lines.join("\n");
	}
	if (entry.type === "branch_summary") {
		lines.push("", "--- Branch Summary ---", String(entry.summary ?? "(empty)"));
		return lines.join("\n");
	}
	if (entry.type === "custom_message") {
		lines.push(`Custom Type: ${String(entry.customType ?? "")}`);
		lines.push("", extractTextBlocks(entry.content) || "(empty)");
		return lines.join("\n");
	}
	if (entry.type !== "message") {
		lines.push("", JSON.stringify(entry, null, 2));
		return lines.join("\n");
	}

	const msg = (entry.message ?? {}) as Record<string, unknown>;
	const role = typeof msg.role === "string" ? msg.role : "unknown";
	lines.push(`Role: ${role}`);

	if (role === "assistant") {
		if (typeof msg.model === "string") lines.push(`Model: ${msg.model}`);
		if (typeof msg.stopReason === "string") lines.push(`Stop Reason: ${msg.stopReason}`);
		if (typeof msg.errorMessage === "string" && msg.errorMessage) {
			lines.push(`Error: ${msg.errorMessage}`);
		}
		const thinking = extractThinkingBlocks(msg.content);
		if (thinking) {
			lines.push("", "--- Thinking ---", thinking);
		}
		const toolLines = formatDetailedToolCalls(msg.content, true);
		if (toolLines.length > 0) {
			lines.push("", "--- Tool Calls ---", ...toolLines);
		}
		const text = extractTextBlocks(msg.content);
		if (text) {
			lines.push("", "--- Assistant Text ---", text);
		}
		return lines.join("\n");
	}

	if (role === "toolResult") {
		lines.push(`Tool: ${String(msg.toolName ?? "unknown")}`);
		if (msg.isError) lines.push("Status: ERROR");
		lines.push("", "--- Tool Output ---", extractTextBlocks(msg.content) || "(empty)");
		return lines.join("\n");
	}

	lines.push("", extractTextBlocks(msg.content) || JSON.stringify(msg, null, 2));
	return lines.join("\n");
}

export function formatNodeDetail(tree: unknown[], entryId: string, offset = 0, maxChars = 8_000): string {
	if (!Array.isArray(tree)) return `Entry "${entryId}" not found (worker session tree is unavailable).`;
	const node = findNode(tree as TreeNodeLike[], entryId.trim());
	if (!node) {
		return `Entry "${entryId}" not found in worker session tree. Call relay_status({ view: "tree" }) to list valid entry IDs.`;
	}

	const fullText = renderEntryBody(node);
	const safeOffset = Math.max(0, Math.min(fullText.length, Math.floor(offset)));
	const safeLimit = Math.max(500, Math.min(20_000, Math.floor(maxChars)));
	const slice = fullText.slice(safeOffset, safeOffset + safeLimit);
	const nextOffset = safeOffset + slice.length;

	if (safeOffset === 0 && nextOffset >= fullText.length) {
		return slice;
	}
	return [
		slice,
		"",
		`--- [Showing chars ${safeOffset}..${nextOffset} of ${fullText.length}` +
			(nextOffset < fullText.length
				? `; call relay_status({ view: "node", entryId: "${entryId}", offset: ${nextOffset} }) for more]`
				: "; end of entry]"),
	].join("\n");
}

function formatMessageForLatest(msg: Record<string, unknown>): string {
	const role = typeof msg.role === "string" ? msg.role : "unknown";
	if (role === "user") {
		return `[USER]\n${extractTextBlocks(msg.content) || "(empty)"}`;
	}
	if (role === "assistant") {
		const parts: string[] = [];
		const toolLines = formatDetailedToolCalls(msg.content);
		if (toolLines.length > 0) parts.push(...toolLines);
		const text = extractTextBlocks(msg.content);
		if (text) parts.push(text);
		if (typeof msg.errorMessage === "string" && msg.errorMessage) {
			parts.push(`[ERROR: ${msg.errorMessage}]`);
		}
		return `[WORKER]\n${parts.join("\n") || "(no output)"}`;
	}
	if (role === "toolResult") {
		const toolName = typeof msg.toolName === "string" ? msg.toolName : "tool";
		const output = extractTextBlocks(msg.content);
		const clipped = output.length > 1200 ? `${output.slice(0, 1200)}\n... (${output.length - 1200} chars omitted)` : output;
		return `[TOOL RESULT: ${toolName}${msg.isError ? " ERROR" : ""}]\n${clipped || "(empty)"}`;
	}
	if (role === "compactionSummary") {
		return `[COMPACTION SUMMARY]\n${String(msg.summary ?? "")}`;
	}
	return `[${role.toUpperCase()}]\n${extractTextBlocks(msg.content) || singleLine(JSON.stringify(msg), 400)}`;
}

function isVisibleInLatest(msg: Record<string, unknown>): boolean {
	const role = typeof msg.role === "string" ? msg.role : "";
	if (role === "system") return false;
	if (role === "custom" && msg.display === false) return false;
	return true;
}

export function formatLatestTurns(messages: unknown[], limit = 2, maxChars = 12_000): string {
	if (!Array.isArray(messages) || messages.length === 0) {
		return "Worker has no conversation messages yet.";
	}
	const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
	const visibleMessages = messages.filter(
		(m): m is Record<string, unknown> => Boolean(m && typeof m === "object" && isVisibleInLatest(m as Record<string, unknown>)),
	);
	if (visibleMessages.length === 0) {
		return "Worker has no visible conversation turns yet.";
	}

	// Split backward by user messages so each "turn" spans one user prompt and all its tool/assistant follow-ups.
	const turnStarts: number[] = [];
	for (let i = 0; i < visibleMessages.length; i++) {
		if (visibleMessages[i]?.role === "user") turnStarts.push(i);
	}
	const startIdx = turnStarts.length >= safeLimit
		? turnStarts[turnStarts.length - safeLimit]!
		: 0;

	const slice = visibleMessages.slice(startIdx);
	const formatted = slice
		.map(formatMessageForLatest)
		.join("\n\n");

	if (formatted.length <= maxChars) return formatted;
	const tail = formatted.slice(formatted.length - maxChars);
	return `... (${formatted.length - maxChars} earlier chars omitted; use relay_status({ view: "tree" }) + view: "node" for full history) ...\n\n${tail}`;
}
