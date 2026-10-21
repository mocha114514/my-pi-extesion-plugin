/** Proportional full-diff buckets shared by the overview's paint and click paths. */
import type { GitDiffRow } from "../shared/git-file-diff.ts";

export const DIFF_OVERVIEW_WIDTH = 2;

export interface DiffOverviewBucket {
	/** Zero-based, half-open range in the displayed diff, including removed rows. */
	start: number;
	end: number;
	/** Representative rows nearest the bucket center, one target per change kind. */
	added?: number;
	removed?: number;
}

export function buildDiffOverview(rows: readonly GitDiffRow[], height: number): DiffOverviewBucket[] {
	const size = Math.max(0, Math.floor(height));
	if (!rows.length || !size) return [];

	return Array.from({ length: size }, (_, index) => {
		const start = Math.floor(index * rows.length / size);
		// Stretch short files across the full track instead of leaving tiny targets.
		const next = Math.floor((index + 1) * rows.length / size);
		const end = Math.min(rows.length, Math.max(start + 1, next));
		const center = (start + end - 1) / 2;
		const bucket: DiffOverviewBucket = { start, end };
		for (let row = start; row < end; row++) {
			const kind = rows[row].kind;
			if (kind === "context") continue;
			const previous = bucket[kind];
			if (previous === undefined || Math.abs(row - center) < Math.abs(previous - center)) {
				bucket[kind] = row;
			}
		}
		return bucket;
	});
}
