/** File-level Git preview data, loaded on demand rather than by the footer's polling loop. */
import { createReadStream } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { resolveGitPath as localPath, runGit as git } from "./git-command.ts";
import { compareGitFiles } from "./git-path-order.ts";

export type GitChangeCategory =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "copied"
	| "typeChanged"
	| "untracked"
	| "conflicted";

export const GIT_CHANGE_CATEGORIES: readonly GitChangeCategory[] = [
	"conflicted",
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"typeChanged",
	"untracked",
];

export interface GitChangeFile {
	path: string;
	originalPath?: string;
	categories: GitChangeCategory[];
	additions: number | null;
	deletions: number | null;
	kind: "text" | "binary" | "conflict" | "unavailable";
	deleted: boolean;
}

interface StatusFile extends GitChangeFile {
	headObject?: string;
}

interface LineCounts {
	additions: number | null;
	deletions: number | null;
}

const STATUS_CATEGORIES: ReadonlyArray<readonly [string, GitChangeCategory]> = [
	["M", "modified"],
	["A", "added"],
	["D", "deleted"],
	["R", "renamed"],
	["C", "copied"],
	["T", "typeChanged"],
];
const BINARY_PROBE_BYTES = 8000;

/** Consume only metadata separators: spaces and tabs inside a filename are not delimiters. */
function statusFields(record: string, separators: number): { fields: string[]; path: string } | undefined {
	let cursor = -1;
	for (let index = 0; index < separators; index++) {
		cursor = record.indexOf(" ", cursor + 1);
		if (cursor < 0) return undefined;
	}
	return { fields: record.slice(0, cursor).split(" "), path: record.slice(cursor + 1) };
}

export function parseGitChangeFiles(output: string): StatusFile[] {
	const records = output.split("\0");
	const files = new Map<string, StatusFile>();
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		const type = record[0];
		let path: string;
		let originalPath: string | undefined;
		let headObject: string | undefined;
		let categories: GitChangeCategory[];
		if (type === "?") {
			path = record.slice(2);
			categories = ["untracked"];
		} else if (type === "1" || type === "2" || type === "u") {
			const parsed = statusFields(record, type === "1" ? 8 : type === "2" ? 9 : 10);
			if (!parsed) continue;
			path = parsed.path;
			if (type === "2") originalPath = records[++index];
			if (type !== "u" && !/^0+$/.test(parsed.fields[6])) headObject = parsed.fields[6];
			categories = type === "u"
				? ["conflicted"]
				: STATUS_CATEGORIES.filter(([letter]) => parsed.fields[1].includes(letter)).map(([, category]) => category);
		} else continue;
		const previous = files.get(path);
		if (previous) {
			previous.categories = [...new Set([...previous.categories, ...categories])];
			previous.headObject ??= headObject;
			previous.originalPath ??= originalPath;
		} else {
			files.set(path, {
				path,
				originalPath,
				headObject,
				categories,
				additions: null,
				deletions: null,
				kind: categories.includes("conflicted") ? "conflict" : "unavailable",
				deleted: false,
			});
		}
	}
	return [...files.values()];
}

/** NUL numstat renames use an empty path followed by separate old/new path records. */
export function parseGitNumstat(output: string): Map<string, LineCounts> {
	const records = output.split("\0");
	const counts = new Map<string, LineCounts>();
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const first = record.indexOf("\t");
		const second = record.indexOf("\t", first + 1);
		if (first < 0 || second < 0) continue;
		const added = record.slice(0, first);
		const removed = record.slice(first + 1, second);
		let path = record.slice(second + 1);
		if (path === "") {
			index++; // Original path is not the path the user can open now.
			path = records[++index];
		}
		if (!path) continue;
		if (added === "-" && removed === "-") counts.set(path, { additions: null, deletions: null });
		else if (/^\d+$/.test(added) && /^\d+$/.test(removed)) {
			counts.set(path, { additions: Number(added), deletions: Number(removed) });
		}
	}
	return counts;
}

/** Stream complete new files; large text files do not need to fit into a JavaScript string. */
async function countNewFile(path: string, forceText: boolean): Promise<LineCounts> {
	let lines = 0;
	let last = -1;
	let probed = 0;
	for await (const chunk of createReadStream(path)) {
		const bytes = chunk as Buffer;
		const probe = bytes.subarray(0, Math.max(0, BINARY_PROBE_BYTES - probed));
		if (!forceText && probe.includes(0)) return { additions: null, deletions: null };
		probed += probe.length;
		for (const byte of bytes) if (byte === 10) lines++;
		if (bytes.length) last = bytes[bytes.length - 1];
	}
	return { additions: lines + (last !== -1 && last !== 10 ? 1 : 0), deletions: 0 };
}

async function isBinaryFile(path: string): Promise<boolean> {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(BINARY_PROBE_BYTES);
		const { bytesRead } = await file.read(buffer);
		return buffer.subarray(0, bytesRead).includes(0);
	} finally {
		await file.close();
	}
}

function assignCounts(file: GitChangeFile, counts: LineCounts): void {
	file.additions = counts.additions;
	file.deletions = counts.deletions;
	file.kind = counts.additions === null ? "binary" : "text";
}

/** Compare a real worktree file to its HEAD blob when the index obscures their relationship. */
async function compareHeadFile(root: string, file: StatusFile, target: string): Promise<LineCounts> {
	const original = await git(root, ["cat-file", "blob", file.headObject!]);
	const output = await git(root, [
		"diff", "--no-index", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--", "-", target,
	], original, true);
	return parseGitNumstat(output.toString("utf8")).values().next().value ?? { additions: 0, deletions: 0 };
}

/** Limit parallel filesystem work, especially when a new directory has many untracked files. */
async function visitFiles(files: StatusFile[], visit: (file: StatusFile) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
		while (next < files.length) await visit(files[next++]);
	}));
}

export async function readGitChanges(root: string): Promise<GitChangeFile[]> {
	const [status, head] = await Promise.all([
		git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
		git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(value => value.toString("utf8").trim()).catch(error => {
			if ((error as { code?: string | number }).code === 1) return null;
			throw error;
		}),
	]);
	const files = parseGitChangeFiles(status.toString("utf8")).filter(file => localPath(root, file.path) !== undefined);
	if (files.length === 0) return [];
	const [diff, attributes] = await Promise.all([
		head === null ? Promise.resolve(Buffer.alloc(0)) : git(root, [
			"-c", "diff.relative=false", "diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--find-renames", head, "--",
		]).catch(() => null),
		git(root, ["check-attr", "-z", "--stdin", "diff"], Buffer.from(files.map(file => file.path + "\0").join(""))).catch(() => Buffer.alloc(0)),
	]);
	const counts = diff === null ? undefined : parseGitNumstat(diff.toString("utf8"));
	const diffAttributes = new Map<string, string>();
	const values = attributes.toString("utf8").split("\0");
	for (let index = 0; index + 2 < values.length; index += 3) diffAttributes.set(values[index], values[index + 2]);
	await visitFiles(files, async file => {
		const target = localPath(root, file.path)!;
		try {
			const stat = await lstat(target).catch(error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			file.deleted = stat === undefined;
			if (file.categories.includes("conflicted")) return;
			// RD keeps the destination in status, but HEAD records the final
			// deletion under its original name. Do not misreport that as 0/0.
			const recorded = counts?.get(file.path) ?? (
				file.deleted && file.categories.includes("renamed") && file.originalPath
					? counts?.get(file.originalPath)
					: undefined
			);
			if (!stat) {
				if (recorded) assignCounts(file, recorded);
				else if (counts && !file.categories.includes("untracked")) {
					// A newly staged file removed again has no final difference from HEAD.
					assignCounts(file, { additions: 0, deletions: 0 });
				}
				return;
			}
			if (!stat.isFile() && !stat.isSymbolicLink()) return; // Submodules/directories have no text line counts.
			const attribute = diffAttributes.get(file.path);
			if (attribute === "unset") {
				assignCounts(file, { additions: null, deletions: null });
				return;
			}
			if (file.categories.includes("untracked") || head === null) {
				if (file.headObject && head !== null && !stat.isSymbolicLink()) {
					assignCounts(file, await compareHeadFile(root, file, target));
				} else if (stat.isSymbolicLink()) {
					const link = await readlink(target);
					assignCounts(file, { additions: link.split("\n").length - (link.endsWith("\n") ? 1 : 0), deletions: 0 });
				} else assignCounts(file, await countNewFile(target, attribute === "set"));
			} else if (
				file.categories.includes("renamed") &&
				file.originalPath &&
				file.headObject &&
				counts?.has(file.originalPath)
			) {
				// A rename staged before a large worktree edit can fall below Git's
				// rename threshold in the HEAD diff. Compare the known original blob
				// instead of losing its deletions in separate delete/add records.
				if (!stat.isSymbolicLink()) assignCounts(file, await compareHeadFile(root, file, target));
			} else if (recorded) assignCounts(file, recorded);
			else if (counts) {
				// Absence from a successful HEAD diff means the staged edit was
				// canceled in the worktree. Binary files still must not show fake lines.
				const binary = !stat.isSymbolicLink() && attribute !== "set" && await isBinaryFile(target);
				assignCounts(file, { additions: binary ? null : 0, deletions: binary ? null : 0 });
			}
		} catch {
			file.kind = "unavailable";
			file.additions = null;
			file.deletions = null;
		}
	});
	return files.sort(compareGitFiles);
}
