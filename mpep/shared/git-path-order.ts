/** A path's letters and digits determine its primary order, not separators. */
import type { GitChangeFile } from "./git-changes.ts";

export function compareGitPaths(left: string, right: string): number {
	const key = (path: string) => path.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
	const a = key(left);
	const b = key(right);
	if (a !== b) return a < b ? -1 : 1;
	// Punctuation/case-only differences still need a reproducible total order.
	return left < right ? -1 : left > right ? 1 : 0;
}

export function compareGitFiles(left: GitChangeFile, right: GitChangeFile): number {
	return compareGitPaths(left.path, right.path);
}
