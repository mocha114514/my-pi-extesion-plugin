// Plain-text checklist views, without summarizing or truncating retained text.
//
// The formatter defaults to full output so compaction snapshots remain complete.
// Overview omits item descriptions; items includes only the requested tasks and
// omits the overall goal already available in overview. All views retain list
// identity, revision, titles, completion state, dependencies, and live blockers.
//
// Goals and descriptions are inserted verbatim, preserving paragraphs, tabs,
// and CR. Ids and titles are JSON strings so spaces and quotes stay visible.

import { blockedBy, type ListState } from "./model.ts";
import { itemsInDisplayOrder } from "./order.ts";

function quote(value: string): string {
	return JSON.stringify(value);
}

export type ListReadView =
	| { mode: "overview" | "full" }
	| { mode: "items"; ids: readonly string[] };

export function formatList(state: ListState, view: ListReadView = { mode: "full" }): string {
	const selectedIds = view.mode === "items" ? new Set(view.ids) : undefined;
	if (selectedIds) {
		const knownIds = new Set(state.items.map(item => item.id));
		const missing = [...selectedIds].filter(id => !knownIds.has(id));
		if (missing.length > 0) {
			throw new Error(
				`Unknown checklist item IDs: ${missing.map(quote).join(", ")}. ` +
				"Use list_read with mode=overview to inspect valid IDs.",
			);
		}
	}

	const lines: string[] = [];
	lines.push(`schemaVersion: ${state.schemaVersion}`);
	lines.push(`id: ${quote(state.id)}`);
	lines.push(`revision: ${state.revision}`);
	lines.push(`title: ${quote(state.title)}`);
	if (view.mode !== "items") {
		lines.push("goal:");
		// Do not infer a missing historical goal from the title or the item list.
		lines.push(state.goal ?? "[Not recorded: this legacy checklist predates required goals.]");
	}
	lines.push("items:");
	// Resolve blockers against the whole list, including unselected prerequisites.
	const completion = new Map(state.items.map(item => [item.id, item.done] as const));

	for (const item of itemsInDisplayOrder(state.items)) {
		if (selectedIds && !selectedIds.has(item.id)) continue;
		const mark = item.done ? "x" : " ";
		lines.push(`- [${mark}] ${quote(item.id)}`);
		lines.push(`  title: ${quote(item.title)}`);
		lines.push("  dependsOn:");
		for (const dependency of item.dependsOn) {
			lines.push(`    - ${quote(dependency)}`);
		}
		lines.push("  blockedBy:");
		for (const dependency of blockedBy(state, item, completion)) {
			lines.push(`    - ${quote(dependency)}`);
		}
		if (view.mode !== "overview") {
			// Joining around this chunk preserves every description paragraph.
			lines.push("  description:");
			lines.push(item.description);
		}
	}

	return `${lines.join("\n")}\n`;
}
