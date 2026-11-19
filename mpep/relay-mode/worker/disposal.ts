/**
 * Owner-verified ephemeral worker directory cleanup and detached reaper
 * process spawning for `--no-session` relay workers.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mainSessionDir, workerDir } from "../paths.ts";
import { WorkerDirectoryLock } from "./locks.ts";

/**
 * Hand off owner-verified ephemeral cleanup to a detached helper process
 * when the foreground TUI is about to exit while the killed worker OS
 * process has not yet drained. Requires BOTH locks to currently exist and
 * match `ownerId` before recursively deleting the worker directory.
 */
export function spawnDetachedEphemeralReaper(params: {
	workerPid: number;
	ownerId: string;
	lockPath: string;
	legacyLockPath: string;
	dir: string;
	sessionRootDir: string;
	hadOwnership: boolean;
}): void {
	const script = [
		'const fs = require("node:fs");',
		'const [pidStr, ownerId, lockPath, legacyPath, dirPath, sessionDir, removeDir] = process.argv.slice(1);',
		'const pid = Number(pidStr);',
		'const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; } };',
		'const ownerMatches = (p) => {',
		'  try { return JSON.parse(fs.readFileSync(p, "utf8")).ownerId === ownerId; } catch { return false; }',
		'};',
		'let tries = 0;',
		'const tick = () => {',
		'  if (alive()) {',
		'    if (tries++ < 240) { setTimeout(tick, 250); }',
		'    return;',
		'  }',
		'  const currentlyOwned = ownerMatches(lockPath) && ownerMatches(legacyPath);',
		'  if (removeDir === "1" && currentlyOwned) { try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch {} }',
		'  try { if (ownerMatches(lockPath)) fs.rmSync(lockPath, { force: true }); } catch {}',
		'  try { if (ownerMatches(legacyPath)) fs.rmSync(legacyPath, { force: true }); } catch {}',
		'  if (removeDir === "1" && currentlyOwned) { try { fs.rmdirSync(sessionDir); } catch {} }',
		'};',
		'tick();',
	].join(" ");
	try {
		const helper = spawn(
			process.execPath,
			[
				"-e",
				script,
				String(params.workerPid),
				params.ownerId,
				params.lockPath,
				params.legacyLockPath,
				params.dir,
				params.sessionRootDir,
				params.hadOwnership ? "1" : "0",
			],
			{
				detached: true,
				stdio: "ignore",
			},
		);
		helper.on("error", () => {});
		helper.unref();
	} catch {
		// Best effort fallback; deferred in-process finalizer still covers reload/switch.
	}
}

/**
 * Remove the ephemeral worker directory and empty parent session root if
 * exclusive ownership is currently verified, always releasing locks cleanly.
 */
export function finalizeWorkerDirectoryOwnership(
	dirLock: WorkerDirectoryLock,
	dir: string,
	sessionRootDir: string,
	shouldRemoveEphemeralDir: boolean,
	hadOwnership: boolean,
): void {
	const verifiedOwned = hadOwnership && dirLock.verifyCurrentOwnership().ok;
	if (shouldRemoveEphemeralDir && verifiedOwned) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort cleanup.
		}
	}
	dirLock.releaseOwnership();
	if (shouldRemoveEphemeralDir && verifiedOwned) {
		try {
			fs.rmdirSync(sessionRootDir);
		} catch {
			// Best effort cleanup for --no-session temporary runs when empty.
		}
	}
}

/**
 * Errno-aware absence check: returns `true` ONLY when the filesystem explicitly
 * reports `ENOENT` or `ENOTDIR`. Access/I/O errors (such as `EACCES` on a
 * temporarily untraversable parent directory) return `false` so callers retain
 * retry tracking instead of mistaking an inaccessible transcript for deleted.
 */
function isPathConfirmedAbsent(targetPath: string): boolean {
	try {
		fs.lstatSync(targetPath);
		return false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		return code === "ENOENT" || code === "ENOTDIR";
	}
}

/**
 * Safely remove a preserved `--no-session` ephemeral worker directory on final
 * session shutdown/exit after verifying exclusive lock ownership.
 *
 * Returns `true` if the worker directory is confirmed absent (`ENOENT`/`ENOTDIR`)
 * and `false` if ownership could not yet be acquired or an access/I/O error
 * prevents confirming deletion so callers can retain the key and retry later.
 */
export function cleanupPreservedEphemeralWorkerDir(storageKey: string, launchCwd: string): boolean {
	const sessionRoot = path.resolve(launchCwd, mainSessionDir(storageKey));
	const dir = path.resolve(launchCwd, workerDir(storageKey));
	if (isPathConfirmedAbsent(dir)) {
		try {
			fs.rmdirSync(sessionRoot);
		} catch {
			// Parent directory may not exist or may hold unrelated files; leave it alone.
		}
		return true;
	}
	const lock = new WorkerDirectoryLock(sessionRoot, dir, launchCwd);
	const acquired = lock.acquireOwnership();
	if (!acquired.ok) return false;
	try {
		finalizeWorkerDirectoryOwnership(lock, dir, sessionRoot, true, true);
		// Treat confirmed removal of the owned `worker/` directory as success even
		// if a non-empty parent directory intentionally remains on disk.
		return isPathConfirmedAbsent(dir);
	} catch {
		lock.releaseOwnership();
		return isPathConfirmedAbsent(dir);
	}
}
