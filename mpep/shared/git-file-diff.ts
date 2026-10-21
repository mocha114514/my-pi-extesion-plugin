/**
 * Read-only full-file diffs for the Git history / worktree preview.
 *
 * Rows cover every line, not a context window: unchanged lines stay in place and
 * removed lines sit where they were. The row order comes from a context-0 unified
 * patch (the public pi-coding-agent helper, which already depends on `diff`).
 * Gaps the patch omits are filled from the same normalized line arrays, so this
 * module does not carry its own diff algorithm.
 *
 * Nothing here checks out, stages, or writes the worktree. Blobs are read with
 * bounded `cat-file` calls. Worktree bytes are read in place, without following a
 * symlink that is the file itself.
 */
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { runGit, resolveGitPath } from "./git-command.ts";
import type { GitChangeFile } from "./git-changes.ts";
import type { GitCommit } from "./git-history.ts";

export type GitFileSource =
	| { kind: "workspace" }
	| { kind: "commit"; commit: GitCommit };

export interface GitDiffRow {
	kind: "context" | "added" | "removed";
	/** 1-based line in the before text. Omitted on a pure addition. */
	oldLine?: number;
	/** 1-based line in the after text. Omitted on a pure removal. */
	newLine?: number;
}

export interface GitTextDiff {
	kind: "text";
	oldLines: string[];
	newLines: string[];
	rows: GitDiffRow[];
}

export type GitFileDiff =
	| GitTextDiff
	| { kind: "binary" | "unavailable" | "tooLarge" };

/** Status entries may carry the HEAD blob recorded by porcelain v2. The public file type does not. */
type IdentityFile = GitChangeFile & { headObject?: string };

interface Hunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	body: string[];
}

type LoadState =
	| { state: "text"; text: string }
	| { state: "binary" }
	| { state: "tooLarge" }
	| { state: "unavailable" };

const MAX_BYTES = 16 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8000;
const MAX_DIFF_CELLS = 4_000_000;
const PATCH_PATH = "file";

class DiffLimitError extends Error {
	constructor() {
		super("Git diff input exceeds the read bound");
		this.name = "DiffLimitError";
	}
}

/** Normalize CRLF storage differences; standalone carriage returns remain source data. */
function normalizeNewlines(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

/** Drop the separator but keep a trailing empty line when the text ends in a blank line. */
function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

function parseHunkHeader(line: string): Omit<Hunk, "body"> | undefined {
	const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
	if (!match) return undefined;
	return {
		oldStart: Number(match[1]),
		oldCount: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newCount: match[4] === undefined ? 1 : Number(match[4]),
	};
}

function parseHunks(patch: string): Hunk[] {
	const lines = patch.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	let index = 0;
	while (index < lines.length && !lines[index].startsWith("@@ ")) index++;
	const hunks: Hunk[] = [];
	while (index < lines.length) {
		const header = parseHunkHeader(lines[index]);
		if (!header) throw new Error("Could not align the full-file diff");
		index++;
		const body: string[] = [];
		while (index < lines.length && !lines[index].startsWith("@@ ")) {
			body.push(lines[index]);
			index++;
		}
		hunks.push({ ...header, body });
	}
	return hunks;
}

/**
 * Build one row per before-line and after-line.
 * A zero-length hunk range is the unified-diff quirk: the start was already
 * decremented, so that start is the last line *before* the insertion or deletion.
 */
function rowsFromPatch(patch: string, oldCount: number, newCount: number): GitDiffRow[] {
	const hunks = parseHunks(patch);
	const rows: GitDiffRow[] = [];
	let oldLine = 1;
	let newLine = 1;
	const pushContext = (throughOld: number, throughNew: number) => {
		if (throughOld < oldLine - 1 || throughNew < newLine - 1) {
			throw new Error("Could not align the full-file diff");
		}
		while (oldLine <= throughOld || newLine <= throughNew) {
			if (oldLine > throughOld || newLine > throughNew) {
				throw new Error("Could not align the full-file diff");
			}
			rows.push({ kind: "context", oldLine, newLine });
			oldLine++;
			newLine++;
		}
	};
	for (const hunk of hunks) {
		pushContext(
			hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1,
			hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1,
		);
		for (const line of hunk.body) {
			// The marker belongs to the previous line; it is not content and has no line number.
			if (line.startsWith("\\")) continue;
			const prefix = line[0];
			if (prefix === " ") {
				rows.push({ kind: "context", oldLine, newLine });
				oldLine++;
				newLine++;
			} else if (prefix === "-") {
				rows.push({ kind: "removed", oldLine });
				oldLine++;
			} else if (prefix === "+") {
				rows.push({ kind: "added", newLine });
				newLine++;
			} else {
				throw new Error("Could not align the full-file diff");
			}
		}
	}
	pushContext(oldCount, newCount);
	if (oldLine !== oldCount + 1 || newLine !== newCount + 1) {
		throw new Error("Could not align the full-file diff");
	}
	return rows;
}

/** Pure full-file diff. Both sides are normalized the same way before the patch is parsed. */
export function createFullFileDiff(before: string, after: string): GitTextDiff {
	const oldText = normalizeNewlines(before);
	const newText = normalizeNewlines(after);
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	if (oldText === newText) {
		return {
			kind: "text",
			oldLines,
			newLines,
			rows: oldLines.map((_, index) => ({
				kind: "context",
				oldLine: index + 1,
				newLine: index + 1,
			})),
		};
	}
	// Pi's public patch helper has no abort/timeout argument. Bound its worst
	// edit-grid size before invoking it on the UI thread. Common edges do not
	// contribute: a tiny change in a large file can still be previewed fully.
	let prefix = 0;
	while (
		prefix < oldLines.length && prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) prefix++;
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
		oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
	) suffix++;
	const oldSpan = oldLines.length - prefix - suffix;
	const newSpan = newLines.length - prefix - suffix;
	if (oldSpan * newSpan > MAX_DIFF_CELLS) throw new DiffLimitError();
	const patch = generateUnifiedPatch(PATCH_PATH, oldText, newText, 0);
	const rows = rowsFromPatch(patch, oldLines.length, newLines.length);
	for (const row of rows) {
		if (row.kind !== "context") continue;
		if (oldLines[row.oldLine! - 1] !== newLines[row.newLine! - 1]) {
			throw new Error("Could not align the full-file diff");
		}
	}
	return { kind: "text", oldLines, newLines, rows };
}

function isOid(value: string): boolean {
	return /^[0-9a-f]{4,64}$/i.test(value);
}

function limitError(error: unknown): boolean {
	if (error instanceof DiffLimitError) return true;
	const code = (error as { code?: string }).code;
	return code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function contained(rootReal: string, candidateReal: string): boolean {
	const suffix = relative(rootReal, candidateReal);
	return suffix === "" || (
		!isAbsolute(suffix) &&
		suffix !== ".." &&
		!suffix.startsWith(`..${sep}`) &&
		!suffix.startsWith("../")
	);
}

/**
 * HEAD blob recorded for a rename or a type change.
 * Porcelain's hH field is that blob, which stays valid when the worktree path
 * is not the path stored in HEAD (a staged rename).
 */
function recordedHeadBlob(file: GitChangeFile): string | undefined {
	const object = (file as IdentityFile).headObject;
	if (typeof object !== "string" || !isOid(object) || /^0+$/.test(object)) return undefined;
	if (!file.categories.includes("renamed") && !file.categories.includes("typeChanged")) return undefined;
	return object.toLowerCase();
}

function looksBinary(buffer: Buffer): boolean {
	const length = Math.min(buffer.length, BINARY_PROBE_BYTES);
	for (let index = 0; index < length; index++) {
		const byte = buffer[index];
		if (byte === 0 || byte === 127) return true;
		if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) return true;
	}
	return false;
}

function decodeText(buffer: Buffer): string | undefined {
	if (looksBinary(buffer)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		return undefined;
	}
}

async function gitOutput(root: string, args: string[], input?: Buffer, differencesAllowed = false): Promise<Buffer | undefined> {
	try {
		const output = await runGit(root, args, input, differencesAllowed);
		if (!Buffer.isBuffer(output)) return undefined;
		return output;
	} catch (error) {
		if (limitError(error)) throw new DiffLimitError();
		return undefined;
	}
}

interface ObjectInfo {
	type: string;
	size: number;
}

/** `missing` is a successful answer that the name is absent. A thrown Git command is not. */
async function describeObject(root: string, object: string): Promise<ObjectInfo | "missing" | undefined> {
	const output = await gitOutput(root, ["cat-file", "--batch-check", "-Z"], Buffer.from(`${object}\0`));
	if (!output) return undefined;
	const end = output.indexOf(0);
	if (end < 0) return undefined;
	const header = output.toString("utf8", 0, end);
	if (header.endsWith(" missing")) return "missing";
	const match = /^[0-9a-f]+ (blob|commit|tree|tag) (\d+)$/i.exec(header);
	if (!match) return undefined;
	return { type: match[1].toLowerCase(), size: Number(match[2]) };
}

async function readBlob(root: string, object: string, allowMissing = false): Promise<LoadState> {
	const info = await describeObject(root, object);
	if (info === undefined) return { state: "unavailable" };
	if (info === "missing") return allowMissing ? { state: "text", text: "" } : { state: "unavailable" };
	// A gitlink is a commit, and a directory is a tree. Neither has text lines.
	if (info.type !== "blob") return { state: "unavailable" };
	if (info.size > MAX_BYTES) return { state: "tooLarge" };
	const output = await gitOutput(root, ["cat-file", "--batch", "-Z"], Buffer.from(`${object}\0`));
	if (!output) return { state: "unavailable" };
	const headerEnd = output.indexOf(0);
	if (headerEnd < 0 || output.length < headerEnd + 1 + info.size + 1) return { state: "unavailable" };
	const data = output.subarray(headerEnd + 1, headerEnd + 1 + info.size);
	const text = decodeText(data);
	if (text === undefined) return { state: "binary" };
	return { state: "text", text };
}

async function declaredBinary(root: string, path: string, source?: string): Promise<boolean | undefined> {
	const args = ["check-attr", "-z", "--stdin", "diff"];
	if (source) args.splice(1, 0, "--source", source);
	const output = await gitOutput(root, args, Buffer.from(`${path}\0`));
	if (!output) return undefined;
	const fields = output.toString("utf8").split("\0");
	// path, attribute, value, trailing empty field.
	return fields[2] === "unset";
}

function relativeParts(path: string): string[] | undefined {
	if (!path || path.includes("\0")) return undefined;
	// Git's separator is '/'; a backslash is a literal filename character on POSIX.
	const parts = sep === "\\" ? path.split(/[/\\]/) : path.split("/");
	if (parts.some(part => part === "" || part === "." || part === "..")) return undefined;
	return parts;
}

async function readWorktreeFile(root: string, path: string): Promise<LoadState | "absent"> {
	if (!resolveGitPath(root, path)) return { state: "unavailable" };
	const parts = relativeParts(path);
	if (!parts) return { state: "unavailable" };
	let rootReal: string;
	try {
		rootReal = await realpath(root);
	} catch {
		return { state: "unavailable" };
	}
	let current = root;
	for (let index = 0; index < parts.length; index++) {
		const next = join(current, parts[index]);
		const last = index === parts.length - 1;
		let stat: Awaited<ReturnType<typeof lstat>>;
		try {
			stat = await lstat(next);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
			return { state: "unavailable" };
		}
		if (stat.isSymbolicLink()) {
			if (last) {
				// The file *is* the symlink. Its preview is the link text, never the target bytes.
				try {
					const link = await readlink(next);
					return { state: "text", text: link };
				} catch {
					return { state: "unavailable" };
				}
			}
			let linked: string;
			try {
				linked = await realpath(next);
			} catch {
				return { state: "unavailable" };
			}
			if (!contained(rootReal, linked)) return { state: "unavailable" };
			current = linked;
			continue;
		}
		if (!last) {
			if (!stat.isDirectory()) return { state: "unavailable" };
			current = next;
			continue;
		}
		if (stat.isDirectory()) return { state: "unavailable" };
		if (!stat.isFile()) return { state: "unavailable" };
		let parentReal: string;
		try {
			parentReal = await realpath(current);
		} catch {
			return { state: "unavailable" };
		}
		if (!contained(rootReal, parentReal)) return { state: "unavailable" };
		if (stat.size > MAX_BYTES) return { state: "tooLarge" };
		return readRegularFile(next, stat.size);
	}
	return { state: "unavailable" };
}

/** `O_NOFOLLOW` closes the race where the path becomes a symlink after lstat. */
async function readRegularFile(path: string, size: number): Promise<LoadState> {
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, flags);
	} catch {
		return { state: "unavailable" };
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) return { state: "unavailable" };
		if (stat.size > MAX_BYTES) return { state: "tooLarge" };
		if (stat.size !== size) return { state: "unavailable" };
		const data = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < data.length) {
			const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
			if (bytesRead === 0) return { state: "unavailable" };
			offset += bytesRead;
		}
		const text = decodeText(data);
		if (text === undefined) return { state: "binary" };
		return { state: "text", text };
	} catch (error) {
		if (limitError(error)) return { state: "tooLarge" };
		return { state: "unavailable" };
	} finally {
		await handle.close();
	}
}

async function readHead(root: string): Promise<string | null | undefined> {
	let output: Buffer | undefined;
	try {
		output = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"], undefined, true);
	} catch (error) {
		if (limitError(error)) throw new DiffLimitError();
		// A quiet missing HEAD is exit 1. Any other failure is not an empty history.
		if ((error as { code?: number | string }).code === 1) return null;
		return undefined;
	}
	if (!Buffer.isBuffer(output)) return undefined;
	const hash = output.toString("utf8").trim();
	if (!hash) return null;
	return isOid(hash) ? hash.toLowerCase() : undefined;
}

async function revisionReady(root: string, hash: string): Promise<boolean | undefined> {
	const info = await describeObject(root, hash);
	if (info === undefined) return undefined;
	if (info === "missing") return false;
	return info.type === "commit";
}

function combine(before: LoadState, after: LoadState): GitFileDiff {
	if (before.state === "unavailable" || after.state === "unavailable") return { kind: "unavailable" };
	if (before.state === "tooLarge" || after.state === "tooLarge") return { kind: "tooLarge" };
	if (before.state === "binary" || after.state === "binary") return { kind: "binary" };
	return createFullFileDiff(before.text, after.text);
}

async function applyBinaryAttribute(root: string, path: string, loaded: LoadState, source?: string): Promise<LoadState> {
	if (loaded.state === "tooLarge" || loaded.state === "unavailable" || (loaded.state === "text" && loaded.text === "")) return loaded;
	const binary = await declaredBinary(root, path, source);
	// A failed attribute lookup must not hide text that we already decoded.
	if (binary) return { state: "binary" };
	return loaded;
}

async function readWorkspaceSide(root: string, file: GitChangeFile, head: string | null): Promise<{ before: LoadState; after: LoadState }> {
	const headBlob = recordedHeadBlob(file);
	let before: LoadState;
	if (headBlob) {
		const info = await describeObject(root, headBlob);
		if (info === undefined || info === "missing" || info.type !== "blob") before = { state: "unavailable" };
		else if (info.size > MAX_BYTES) before = { state: "tooLarge" };
		else before = await readBlob(root, headBlob);
		// Status asserts this HEAD blob exists; missing local objects are not empty files.
		if (info === "missing") before = { state: "unavailable" };
	} else if (head) {
		const beforePath = file.originalPath ?? file.path;
		if (!resolveGitPath(root, beforePath)) before = { state: "unavailable" };
		else before = await readBlob(root, `${head}:${beforePath}`, true);
	} else {
		before = { state: "text", text: "" };
	}
	const disk = await readWorktreeFile(root, file.path);
	let after: LoadState;
	if (disk === "absent") after = file.deleted ? { state: "text", text: "" } : { state: "unavailable" };
	else after = disk;
	const attributePath = file.path;
	before = await applyBinaryAttribute(root, file.originalPath ?? attributePath, before, head ?? undefined);
	after = await applyBinaryAttribute(root, attributePath, after);
	return { before, after };
}

async function readCommitSide(root: string, commit: GitCommit, file: GitChangeFile): Promise<{ before: LoadState; after: LoadState } | undefined> {
	if (!isOid(commit.hash)) return undefined;
	const hash = commit.hash.toLowerCase();
	const ready = await revisionReady(root, hash);
	if (ready !== true) return undefined;
	const parents = Array.isArray(commit.parents) ? commit.parents : undefined;
	if (!parents || parents.some(parent => !isOid(parent))) return undefined;
	const parent = parents[0]?.toLowerCase();
	if (parent) {
		const parentReady = await revisionReady(root, parent);
		if (parentReady !== true) return undefined;
	}
	const beforePath = file.originalPath ?? file.path;
	const afterPath = file.path;
	if (!resolveGitPath(root, beforePath) || !resolveGitPath(root, afterPath)) return undefined;
	const before = parent
		? await readBlob(root, `${parent}:${beforePath}`, file.categories.includes("added"))
		: { state: "text", text: "" } satisfies LoadState;
	const after = await readBlob(root, `${hash}:${afterPath}`, file.deleted);
	return {
		before: await applyBinaryAttribute(root, beforePath, before, parent),
		after: await applyBinaryAttribute(root, afterPath, after, hash),
	};
}

export async function readGitFileDiff(root: string, source: GitFileSource, file: GitChangeFile): Promise<GitFileDiff> {
	try {
		if (!file?.path || !resolveGitPath(root, file.path)) return { kind: "unavailable" };
		if (file.originalPath && !resolveGitPath(root, file.originalPath)) return { kind: "unavailable" };
		// The change list already asked Git, which classified this path as binary.
		if (file.kind === "binary") return { kind: "binary" };
		if (source.kind === "workspace") {
			const head = await readHead(root);
			if (head === undefined) return { kind: "unavailable" };
			const sides = await readWorkspaceSide(root, file, head);
			return combine(sides.before, sides.after);
		}
		if (source.kind === "commit") {
			const sides = await readCommitSide(root, source.commit, file);
			if (!sides) return { kind: "unavailable" };
			return combine(sides.before, sides.after);
		}
		return { kind: "unavailable" };
	} catch (error) {
		if (limitError(error)) return { kind: "tooLarge" };
		return { kind: "unavailable" };
	}
}
