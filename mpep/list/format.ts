// Full plain-text rendering of a list.
//
// This is a view, not a summary and not a parser. List id, revision, title,
// overall goal, and every item in display order are always present. Completed
// items use [x] and still include their description, dependencies, and blockers.
// Nothing is truncated and completed rows are not collapsed.
//
// Goals and descriptions are inserted verbatim, so blank paragraphs, tabs, and
// CR stay intact. Ids and titles are JSON strings so spaces and quotes stay visible.
// blockedBy comes from the model (direct incomplete dependencies only).

import { blockedBy, type ListState } from "./model.ts";
import { itemsInDisplayOrder } from "./order.ts";

function quote(value: string): string {
	return JSON.stringify(value);
}

export function formatList(state: ListState): string {
	const lines: string[] = [];
	lines.push(`schemaVersion: ${state.schemaVersion}`);
	lines.push(`id: ${quote(state.id)}`);
	lines.push(`revision: ${state.revision}`);
	lines.push(`title: ${quote(state.title)}`);
	lines.push("goal:");
	// Do not infer a missing historical goal from the title or the item list.
	lines.push(state.goal ?? "[Not recorded: this legacy checklist predates required goals.]");
	lines.push("items:");
	const completion = new Map(state.items.map(item => [item.id, item.done] as const));

	for (const item of itemsInDisplayOrder(state.items)) {
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
		// The description is one chunk. Joining around it adds structural
		// newlines but does not alter or drop the description text.
		lines.push("  description:");
		lines.push(item.description);
	}

	return `${lines.join("\n")}\n`;
}
