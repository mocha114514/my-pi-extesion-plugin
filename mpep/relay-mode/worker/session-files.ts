/**
 * Worker transcript inspection, JSONL completeness validation, crash-safe
 * rebase staging/recovery, orphan discovery, and Windows case-collision checks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalizeFsPath, isSamePath, META_FILE, type WorkerMeta } from "./types.ts";

export function readFirstLine(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const chunks: Buffer[] = [];
		const buf = Buffer.allocUnsafe(4096);
		let totalBytes = 0;
		const MAX_HEADER_BYTES = 1024 * 1024;
		while (totalBytes < MAX_HEADER_BYTES) {
			const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
			if (bytesRead <= 0) break;
			const nlIdx = buf.subarray(0, bytesRead).indexOf(0x0a);
			if (nlIdx !== -1) {
				chunks.push(Buffer.from(buf.subarray(0, nlIdx)));
				break;
			}
			chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
			totalBytes += bytesRead;
		}
		if (chunks.length === 0) return undefined;
		return Buffer.concat(chunks).toString("utf-8").replace(/\r$/, "");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Ignore close errors.
			}
		}
	}
}

export function readSessionHeader(filePath: string): { id?: string; cwd?: string } | undefined {
	const firstLine = readFirstLine(filePath);
	if (!firstLine || !firstLine.trim()) return undefined;
	try {
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown; cwd?: unknown };
		if (header.type !== "session") return undefined;
		return {
			id: typeof header.id === "string" && header.id.trim() ? header.id.trim() : undefined,
			cwd: typeof header.cwd === "string" && header.cwd.trim() ? header.cwd : undefined,
		};
	} catch {
		return undefined;
	}
}

export function fileMatchesSessionId(filePath: string, sessionId: string): boolean {
	const base = path.basename(filePath);
	if (base === `${sessionId}.jsonl` || base.endsWith(`_${sessionId}.jsonl`)) return true;
	const header = readSessionHeader(filePath);
	return header?.id === sessionId;
}

export function hasResumableRebaseArtifacts(dir: string, sessionId: string): boolean {
	try {
		for (const entry of fs.readdirSync(dir)) {
			if (/\.jsonl\.rebased-\d+\.bak$/.test(entry) && entry.includes(sessionId)) {
				return true;
			}
			if (entry.startsWith(".rebase-")) {
				const subDir = path.join(dir, entry);
				try {
					for (const sub of fs.readdirSync(subDir)) {
						if (sub.endsWith(".jsonl") && fileMatchesSessionId(path.join(subDir, sub), sessionId)) {
							return true;
						}
					}
				} catch {
					// Ignore unreadable staging subdir.
				}
			}
		}
	} catch {
		// Ignore.
	}
	return false;
}

export interface JsonlValidationResult {
	valid: boolean;
	entryCount: number;
}

function validateJsonlFile(filePath: string, expectedSessionId: string): JsonlValidationResult {
	let fd: number | undefined;
	try {
		const header = readSessionHeader(filePath);
		if (header?.id !== expectedSessionId) return { valid: false, entryCount: 0 };
		const stat = fs.statSync(filePath);
		if (stat.size <= 0) return { valid: false, entryCount: 0 };
		fd = fs.openSync(filePath, "r");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let pendingParts: Buffer[] = [];
		let lineCount = 0;
		while (true) {
			const n = fs.readSync(fd, chunk, 0, chunk.length, null);
			if (n <= 0) break;
			let start = 0;
			while (start < n) {
				const nl = chunk.subarray(0, n).indexOf(0x0a, start);
				if (nl === -1) {
					pendingParts.push(Buffer.from(chunk.subarray(start, n)));
					break;
				}
				const slice = chunk.subarray(start, nl);
				const lineBuf = pendingParts.length > 0 ? Buffer.concat([...pendingParts, slice]) : slice;
				pendingParts = [];
				const trimmed = lineBuf.toString("utf-8").replace(/\r$/, "").trim();
				if (trimmed) {
					JSON.parse(trimmed);
					lineCount += 1;
				}
				start = nl + 1;
			}
		}
		if (pendingParts.length > 0) {
			const trimmed = Buffer.concat(pendingParts).toString("utf-8").replace(/\r$/, "").trim();
			if (trimmed) {
				JSON.parse(trimmed);
				lineCount += 1;
			}
		}
		return { valid: lineCount > 0, entryCount: Math.max(0, lineCount - 1) };
	} catch {
		return { valid: false, entryCount: 0 };
	} finally {
		if (fd !== undefined) {
			const toClose = fd;
			fd = undefined;
			try {
				fs.closeSync(toClose);
			} catch {
				// Ignore close errors.
			}
		}
	}
}

function isValidCompleteJsonlFile(filePath: string, expectedSessionId: string): boolean {
	return validateJsonlFile(filePath, expectedSessionId).valid;
}

export const REBASE_COMPLETE_FILE = ".complete";

export interface RebaseCompleteMarker {
	target: string;
	entries: number;
}

function isCompletedRebaseStage(
	subDir: string,
	filePath: string,
	expectedSessionId: string,
): { complete: boolean; entryCount: number } {
	try {
		const raw = fs.readFileSync(path.join(subDir, REBASE_COMPLETE_FILE), "utf-8");
		const marker = JSON.parse(raw) as Partial<RebaseCompleteMarker>;
		if (typeof marker.target !== "string" || marker.target !== path.basename(filePath)) {
			return { complete: false, entryCount: 0 };
		}
		if (typeof marker.entries !== "number" || marker.entries < 0) {
			return { complete: false, entryCount: 0 };
		}
		const res = validateJsonlFile(filePath, expectedSessionId);
		return { complete: res.valid && res.entryCount === marker.entries, entryCount: res.entryCount };
	} catch {
		return { complete: false, entryCount: 0 };
	}
}

export function fsyncDirectoryBestEffort(dirPath: string): boolean {
	if (process.platform === "win32") return true;
	let dirFd: number | undefined;
	try {
		dirFd = fs.openSync(dirPath, "r");
		fs.fsyncSync(dirFd);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// Only treat unsupported directory sync errors as benign; propagate real
		// writeback failures (EIO/ENOSPC/EDQUOT) as `false` so backups stay intact.
		return code === "EINVAL" || code === "ENOTSUP" || code === "EBADF" || code === "EROFS" || code === "EACCES" || code === "EISDIR";
	} finally {
		if (dirFd !== undefined) {
			const toClose = dirFd;
			dirFd = undefined;
			try {
				fs.closeSync(toClose);
			} catch {
				// Ignore.
			}
		}
	}
}

export function findMatchingTopLevelJsonls(dir: string, sessionId: string): string[] {
	try {
		const files = fs.readdirSync(dir);
		const matches = files
			.filter((name) => name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`) || (name.endsWith(".jsonl") && name.includes(sessionId)))
			.map((name) => path.join(dir, name));
		matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return matches;
	} catch {
		return [];
	}
}

/**
 * Recover interrupted rebase state ONLY while holding exclusive ownership.
 * Skips full validation on normal artifact-free startups; when rebase staging
 * or missing transcript recovery is needed, picks the newest valid generation
 * (preferring a valid newer stage over an older historical `.bak`), quarantines
 * any damaged live file once replaced, and blocks fresh creation if recoverable
 * data cannot be cleanly restored.
 */
export function recoverStaleRebaseBackups(
	dir: string,
	targetSessionId: string,
): { file?: string; recoveryBlocked?: boolean; reason?: string } {
	try {
		const entries = fs.readdirSync(dir);
		const hasStaging = entries.some((name) => name.startsWith(".rebase-"));
		const hasMatchingBackups = entries.some(
			(name) =>
				/\.jsonl\.rebased-\d+\.bak$/.test(name) &&
				(name.includes(targetSessionId) || readSessionHeader(path.join(dir, name))?.id === targetSessionId),
		);
		const topMatches = findMatchingTopLevelJsonls(dir, targetSessionId);

		// Fast path ONLY for a single unambiguous transcript whose first-line
		// session header ID actually matches targetSessionId, with no staging
		// or backup competition.
		if (
			!hasStaging &&
			!hasMatchingBackups &&
			topMatches.length === 1 &&
			readSessionHeader(topMatches[0]!)?.id === targetSessionId
		) {
			return { file: topMatches[0] };
		}

		const validTopCandidates: Array<{ path: string; entryCount: number }> = [];
		const damagedTopFiles: string[] = [];
		for (const f of topMatches) {
			const check = validateJsonlFile(f, targetSessionId);
			if (check.valid) {
				validTopCandidates.push({ path: f, entryCount: check.entryCount });
			} else {
				damagedTopFiles.push(f);
			}
		}

		const backupCandidates = entries
			.filter((name) => /\.jsonl\.rebased-\d+\.bak$/.test(name))
			.map((name) => path.join(dir, name))
			.filter((full) => path.basename(full).includes(targetSessionId) || readSessionHeader(full)?.id === targetSessionId)
			.map((full) => ({ path: full, mtimeMs: fs.statSync(full).mtimeMs }))
			.sort((a, b) => b.mtimeMs - a.mtimeMs);

		const validBackups: Array<{ path: string; mtimeMs: number; entryCount: number }> = [];
		for (const c of backupCandidates) {
			const check = validateJsonlFile(c.path, targetSessionId);
			if (check.valid) {
				validBackups.push({ ...c, entryCount: check.entryCount });
			}
		}
		validBackups.sort((a, b) => (b.entryCount - a.entryCount) || (b.mtimeMs - a.mtimeMs));
		const validBackup = validBackups[0];

		// Scan completed `.rebase-*` stages BEFORE choosing a live file so a
		// truncated live transcript never prunes a fuller completed staged rebase.
		const completedStages: Array<{ path: string; mtimeMs: number; entryCount: number }> = [];
		for (const entry of entries) {
			if (!entry.startsWith(".rebase-")) continue;
			const subDir = path.join(dir, entry);
			try {
				for (const sub of fs.readdirSync(subDir)) {
					if (!sub.endsWith(".jsonl")) continue;
					const full = path.join(subDir, sub);
					const stageCheck = isCompletedRebaseStage(subDir, full, targetSessionId);
					if (stageCheck.complete) {
						completedStages.push({
							path: full,
							mtimeMs: fs.statSync(full).mtimeMs,
							entryCount: stageCheck.entryCount,
						});
					}
				}
			} catch {
				// Ignore unreadable staging subdir.
			}
		}
		completedStages.sort((a, b) => (b.entryCount - a.entryCount) || (b.mtimeMs - a.mtimeMs));
		const newestStage = completedStages[0];

		const minRequiredEntries = Math.max(
			validBackup?.entryCount ?? 0,
			newestStage?.entryCount ?? 0,
		);

		// Check ALL validated live files (newest first) against both any preserved
		// backup AND any completed rebase stage before concluding no live file wins.
		let validTopFile: string | undefined;
		for (const cand of validTopCandidates) {
			if (cand.entryCount >= minRequiredEntries) {
				validTopFile = cand.path;
				break;
			}
			damagedTopFiles.push(cand.path);
		}

		if (!validTopFile) {
			// Enforce the SAME `minRequiredEntries` floor on backup vs staged replacement
			// so a newer smaller backup never overrides and prunes a fuller completed stage.
			const stageQualifies = Boolean(newestStage && newestStage.entryCount >= minRequiredEntries);
			const backupQualifies = Boolean(validBackup && validBackup.entryCount >= minRequiredEntries);
			const useStageFirst = Boolean(
				stageQualifies &&
				newestStage &&
				(!backupQualifies || !validBackup || newestStage.mtimeMs >= validBackup.mtimeMs),
			);

			let quarantineSeq = 0;
			const quarantineFile = (targetPath: string) => {
				if (fs.existsSync(targetPath)) {
					fs.renameSync(targetPath, `${targetPath}.corrupt-${Date.now()}-${quarantineSeq++}`);
				}
			};

			if (useStageFirst && newestStage) {
				const dest = path.join(dir, path.basename(newestStage.path));
				if (damagedTopFiles.some((d) => isSamePath(d, dest))) {
					quarantineFile(dest);
				}
				if (!fs.existsSync(dest)) {
					fs.renameSync(newestStage.path, dest);
					validTopFile = dest;
				}
			} else if (backupQualifies && validBackup) {
				const dest = validBackup.path.replace(/\.rebased-\d+\.bak$/, "");
				if (damagedTopFiles.some((d) => isSamePath(d, dest))) {
					quarantineFile(dest);
				}
				if (!fs.existsSync(dest)) {
					fs.renameSync(validBackup.path, dest);
					validTopFile = dest;
				}
			}

			// Only quarantine other damaged top-level files when we actually restored a
			// replacement meeting `minRequiredEntries`; otherwise preserve every artifact.
			if (validTopFile) {
				for (const damaged of damagedTopFiles) {
					if (isSamePath(damaged, validTopFile)) continue;
					quarantineFile(damaged);
				}
			}
		} else if (validTopFile) {
			let quarantineSeq = 0;
			for (const damaged of damagedTopFiles) {
				if (isSamePath(damaged, validTopFile)) continue;
				if (fs.existsSync(damaged)) {
					fs.renameSync(damaged, `${damaged}.corrupt-${Date.now()}-${quarantineSeq++}`);
				}
			}
		}

		// Prune `.rebase-*` ONLY when every non-empty `.jsonl` inside it has a
		// verified session header matching `targetSessionId` (never trusting
		// filename substrings alone), and when `!validTopFile` preserve every
		// non-empty staged/backup transcript artifact on disk.
		let hasSalvageableArtifacts = false;
		for (const name of fs.readdirSync(dir)) {
			if (name.startsWith(".rebase-")) {
				const subDir = path.join(dir, name);
				let keepDir = false;
				try {
					for (const sub of fs.readdirSync(subDir)) {
						if (!sub.endsWith(".jsonl")) continue;
						const full = path.join(subDir, sub);
						if (fs.statSync(full).size === 0) continue;
						const headerMatchesTarget = readSessionHeader(full)?.id === targetSessionId;
						if (!validTopFile || !headerMatchesTarget) {
							keepDir = true;
							if (!validTopFile) hasSalvageableArtifacts = true;
							break;
						}
					}
				} catch {
					keepDir = true;
					if (!validTopFile) hasSalvageableArtifacts = true;
				}
				if (!keepDir) {
					fs.rmSync(subDir, { recursive: true, force: true });
				}
			} else if (!validTopFile && /\.jsonl\.rebased-\d+\.bak$/.test(name)) {
				const full = path.join(dir, name);
				if (fs.statSync(full).size > 0) {
					hasSalvageableArtifacts = true;
				}
			}
		}

		if (!validTopFile && (hasSalvageableArtifacts || damagedTopFiles.length > 0)) {
			return {
				recoveryBlocked: true,
				reason: "Preserved recoverable/damaged worker transcript artifacts on disk instead of starting an empty session.",
			};
		}
		return { file: validTopFile };
	} catch (error) {
		return {
			recoveryBlocked: true,
			reason: `Worker session recovery failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function findExistingSessionFile(
	dir: string,
	sessionId: string,
	allowRecovery = false,
): { file?: string; recoveryBlocked?: boolean; reason?: string } {
	if (allowRecovery) {
		return recoverStaleRebaseBackups(dir, sessionId);
	}
	const matches = findMatchingTopLevelJsonls(dir, sessionId);
	return { file: matches[0] };
}


export function discoverOrphanSession(dir: string): { sessionId: string; cwd?: string } | undefined {
	try {
		const entries = fs.readdirSync(dir);
		const jsonlFiles = entries
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => path.join(dir, name));
		jsonlFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		for (const file of jsonlFiles) {
			const header = readSessionHeader(file);
			if (header?.id) {
				return { sessionId: header.id, cwd: header.cwd };
			}
		}

		const backupFiles = entries
			.filter((name) => /\.jsonl\.rebased-\d+\.bak$/.test(name))
			.map((name) => path.join(dir, name));
		backupFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		for (const file of backupFiles) {
			const header = readSessionHeader(file);
			if (header?.id) {
				return { sessionId: header.id, cwd: header.cwd };
			}
		}

		let fallbackStageOrphan: { sessionId: string; cwd?: string } | undefined;
		for (const entry of entries) {
			if (!entry.startsWith(".rebase-")) continue;
			const subDir = path.join(dir, entry);
			try {
				for (const sub of fs.readdirSync(subDir)) {
					if (!sub.endsWith(".jsonl")) continue;
					const full = path.join(subDir, sub);
					const header = readSessionHeader(full);
					if (header?.id) {
						if (isValidCompleteJsonlFile(full, header.id)) {
							return { sessionId: header.id, cwd: header.cwd };
						}
						fallbackStageOrphan ??= { sessionId: header.id, cwd: header.cwd };
					}
				}
			} catch {
				// Ignore unreadable staging subdir.
			}
		}
		if (fallbackStageOrphan) return fallbackStageOrphan;
	} catch {
		// Best-effort orphan recovery only.
	}
	return undefined;
}

/** Walk every ancestor up to the drive/UNC root to detect Windows case-distinct siblings. */
export function hasWindowsCaseCollision(targetPath: string | undefined): boolean {
	if (process.platform !== "win32" || !targetPath) return false;
	let cur = path.resolve(targetPath);
	for (;;) {
		const parent = path.dirname(cur);
		const base = path.basename(cur);
		if (!parent || parent === cur || !base) break;
		try {
			const matches = fs.readdirSync(parent).filter((name) => name.toLowerCase() === base.toLowerCase());
			if (matches.length > 1) return true;
		} catch {
			// Ignore unreadable parent.
		}
		cur = parent;
	}
	return false;
}

/** Read-only check verifying existing worker directory does not belong to another foreground session. */
export function checkExistingSessionIdentityConflict(
	dir: string,
	ephemeral: boolean,
	cwd: string,
	mainSessionFile: string | undefined,
): string | undefined {
	const metaPath = path.join(dir, META_FILE);
	try {
		const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Partial<WorkerMeta>;
		if (typeof parsed.sessionId === "string" && parsed.sessionId.trim()) {
			const parsedMainFile =
				typeof parsed.mainSessionFile === "string" && parsed.mainSessionFile.trim()
					? parsed.mainSessionFile
					: undefined;
			if (
				parsedMainFile &&
				mainSessionFile &&
				canonicalizeFsPath(parsedMainFile) !== canonicalizeFsPath(mainSessionFile)
			) {
				return `Existing worker directory belongs to a different foreground session file (${parsedMainFile}); refusing to overwrite its history.`;
			}
			if (
				!parsedMainFile &&
				!ephemeral &&
				mainSessionFile &&
				(hasWindowsCaseCollision(mainSessionFile) || hasWindowsCaseCollision(cwd))
			) {
				return "Existing legacy worker directory lacks foreground session file identity while case-distinct Windows paths exist; refusing ambiguous reuse.";
			}
			return undefined;
		}
	} catch {
		// Fall through to orphan transcript ambiguity check.
	}
	const orphan = discoverOrphanSession(dir);
	if (
		orphan &&
		!ephemeral &&
		mainSessionFile &&
		(hasWindowsCaseCollision(mainSessionFile) || hasWindowsCaseCollision(cwd))
	) {
		return "Existing orphaned worker transcript lacks foreground session file identity while case-distinct Windows paths exist; refusing ambiguous reuse.";
	}
	return undefined;
}

/**
 * Ensure any resumed worker transcript matches `targetCwd` (both existence and
 * exact canonical path equality) so Pi never opens a worker in an old or
 * untrusted directory while forwarding the new directory's trust approval.
 */
export function ensureSessionMatchesCwd(
	dir: string,
	existingFile: string,
	targetCwd: string,
	meta: WorkerMeta,
	writeMeta: (meta: WorkerMeta) => void,
): { file: string; cwdMatches: boolean } {
	const headerCwd = readSessionHeader(existingFile)?.cwd;
	const targetCanonical = canonicalizeFsPath(targetCwd);
	if (headerCwd && fs.existsSync(headerCwd) && canonicalizeFsPath(headerCwd) === targetCanonical) {
		return { file: existingFile, cwdMatches: true };
	}

	const sourceCheck = validateJsonlFile(existingFile, meta.sessionId);
	const rebaseDir = path.join(dir, `.rebase-${process.pid}-${Date.now()}`);
	try {
		fs.mkdirSync(rebaseDir, { recursive: true });
		const forked = SessionManager.forkFrom(existingFile, targetCwd, rebaseDir, { id: meta.sessionId });
		const stagedFile = forked.getSessionFile() ?? findExistingSessionFile(rebaseDir, meta.sessionId, false).file;
		if (!stagedFile || !fs.existsSync(stagedFile)) {
			throw new Error("Staged rebased session file could not be located.");
		}
		const stagedHeaderCwd = readSessionHeader(stagedFile)?.cwd;
		if (!stagedHeaderCwd || canonicalizeFsPath(stagedHeaderCwd) !== targetCanonical) {
			throw new Error("Staged rebased session cwd did not match target cwd.");
		}
		const stagedCheck = validateJsonlFile(stagedFile, forked.getSessionId());
		if (!stagedCheck.valid) {
			throw new Error("Staged rebased session file failed completeness validation.");
		}
		let syncFd: number | undefined;
		try {
			syncFd = fs.openSync(stagedFile, "r+");
			fs.fsyncSync(syncFd);
			const toClose = syncFd;
			syncFd = undefined;
			fs.closeSync(toClose);
		} finally {
			if (syncFd !== undefined) {
				const toClose = syncFd;
				syncFd = undefined;
				try {
					fs.closeSync(toClose);
				} catch {
					// Ignore.
				}
			}
		}
		fs.writeFileSync(
			path.join(rebaseDir, REBASE_COMPLETE_FILE),
			JSON.stringify({ target: path.basename(stagedFile), entries: stagedCheck.entryCount } satisfies RebaseCompleteMarker),
			"utf-8",
		);

		const targetFile = path.join(dir, path.basename(stagedFile));
		const backupFile = `${existingFile}.rebased-${Date.now()}.bak`;
		fs.renameSync(existingFile, backupFile);
		try {
			fs.renameSync(stagedFile, targetFile);
		} catch (swapErr) {
			if (!fs.existsSync(existingFile) && fs.existsSync(backupFile)) {
				try {
					fs.renameSync(backupFile, existingFile);
				} catch {
					// Keep backup on disk; findExistingSessionFile recovers it automatically.
				}
			}
			throw swapErr;
		}

		meta.sessionId = forked.getSessionId();
		meta.cwd = targetCwd;
		writeMeta(meta);
		const dirSynced = fsyncDirectoryBestEffort(dir);
		const lossless = sourceCheck.valid && stagedCheck.entryCount >= sourceCheck.entryCount;
		if (lossless && dirSynced) {
			fs.rmSync(backupFile, { force: true });
		}
		return {
			file: targetFile,
			cwdMatches: canonicalizeFsPath(readSessionHeader(targetFile)?.cwd ?? "") === targetCanonical,
		};
	} finally {
		fs.rmSync(rebaseDir, { recursive: true, force: true });
	}
}
