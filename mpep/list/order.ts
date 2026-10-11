// Stable numeric hierarchy ordering shared by checklist views.
//
// Storage stays in insertion order, so existing sessions need no migration.
// Nonnumeric IDs keep their original slots; only numeric slots are reordered.
// Numbering is presentation only and never introduces dependency edges.

import type { ListItem } from "./model.ts";

interface NumberedItem {
	item: ListItem;
	segments: bigint[];
}

function numericSegments(id: string): bigint[] | undefined {
	const match = /^[0-9]+(?:\.[0-9]+)*$/.exec(id);
	// JavaScript allows $ before a final line break; require the entire ID.
	if (!match || match[0] !== id) return undefined;
	// IDs have no length cap. BigInt avoids rounding large numeric segments.
	return id
		.split(".")
		.map(segment => BigInt(segment));
}

function compareSegments(left: readonly bigint[], right: readonly bigint[]): number {
	const shared = Math.min(left.length, right.length);
	for (let index = 0; index < shared; index += 1) {
		if (left[index] < right[index]) return -1;
		if (left[index] > right[index]) return 1;
	}
	// An equal prefix sorts before its descendants: 3, 3.1, 3.1.1.
	return left.length - right.length;
}

/** Return a display projection without mutating items, IDs, or dependencies. */
export function itemsInDisplayOrder(items: readonly ListItem[]): readonly ListItem[] {
	const positions: number[] = [];
	const numbered: NumberedItem[] = [];
	for (const [index, item] of items.entries()) {
		const segments = numericSegments(item.id);
		if (!segments) continue;
		positions.push(index);
		numbered.push({ item, segments });
	}
	if (numbered.length < 2) return items;

	// Array.sort is stable: IDs such as 3.01 and 3.1 retain their relative order.
	numbered.sort((left, right) => compareSegments(left.segments, right.segments));
	const ordered = [...items];
	for (const [index, entry] of numbered.entries()) {
		ordered[positions[index]] = entry.item;
	}
	return ordered;
}
