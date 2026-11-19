/**
 * Dual-lock exclusive directory ownership and legacy Windows worker-dir
 * migration for the symbiotic relay worker.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { mainSessionDir, sessionsDir, workerDir } from "../paths.ts";
import { hasWindowsCaseCollision, readSessionHeader } from "./session-files.ts";
import {
	canonicalizeFsPath,
	isPidAlive,
	LEGACY_LOCK_FILE,
	LOCK_FILE,
	META_FILE,
	type OwnerLock,
	type WorkerMeta,
} from "./types.ts";

export interface LegacyMigrationParams {
	legacyKey: string;
	cwd: string;
	mainSessionFile?: string;
}

export class WorkerDirectoryLock {
	readonly ownerId = randomUUID();
	readonly sessionRootDir: string;
	readonly dir: string;
	readonly lockPath: string;
	readonly legacyLockPath: string;
	readonly launchCwd: string;

	ownsDirectory = false;
	private provisionalLockOwned = false;
	private hasTrackedLockAttempt = false;
	migrationBlocked = false;
	migrationBlockedHolderPid: number | undefined;

	constructor(sessionRootDir: string, dir: string, launchCwd: string) {
		this.sessionRootDir = sessionRootDir;
		this.dir = dir;
		this.lockPath = path.join(sessionRootDir, LOCK_FILE);
		this.legacyLockPath = path.join(dir, LEGACY_LOCK_FILE);
		this.launchCwd = launchCwd;
	}

	migrateLegacyWindowsWorkerDir(params: LegacyMigrationParams): boolean {
		const targetSession = this.sessionRootDir;
		const legacySession = path.resolve(this.launchCwd, mainSessionDir(params.legacyKey));
		if (fs.existsSync(targetSession) || !fs.existsSync(legacySession)) return true;
		const legacyWorker = path.resolve(this.launchCwd, workerDir(params.legacyKey));
		if (!fs.existsSync(legacyWorker)) return true;
		const legacyLock = path.join(legacySession, LOCK_FILE);
		const legacyWorkerLock = path.join(legacyWorker, LEGACY_LOCK_FILE);

		const lock = this.acquireLockPair(legacyLock, legacyWorkerLock, legacyWorker);
		if (!lock.ok) {
			// Block initialization even when holderPid is unknown (e.g. unreadable
			// primary lock while secondary lock has a live holder) so we never
			// create a fresh target directory that strands legacy history.
			this.migrationBlocked = true;
			this.migrationBlockedHolderPid = lock.holderPid;
			return false;
		}
		let migrated = false;
		try {
			let legacyCwd: string | undefined;
			let legacyMainSessionFile: string | undefined;
			const metaPath = path.join(legacyWorker, META_FILE);
			if (fs.existsSync(metaPath)) {
				const parsedMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Partial<WorkerMeta>;
				if (typeof parsedMeta.cwd === "string") legacyCwd = parsedMeta.cwd;
				if (typeof parsedMeta.mainSessionFile === "string" && parsedMeta.mainSessionFile.trim()) {
					legacyMainSessionFile = parsedMeta.mainSessionFile;
				}
			}
			if (!legacyCwd) {
				for (const name of fs.readdirSync(legacyWorker)) {
					if (!name.endsWith(".jsonl")) continue;
					const hdrCwd = readSessionHeader(path.join(legacyWorker, name))?.cwd;
					if (hdrCwd) {
						legacyCwd = hdrCwd;
						break;
					}
				}
			}
			if (!legacyCwd || canonicalizeFsPath(legacyCwd) !== canonicalizeFsPath(params.cwd)) {
				return true;
			}
			if (legacyMainSessionFile) {
				if (
					!params.mainSessionFile ||
					canonicalizeFsPath(legacyMainSessionFile) !== canonicalizeFsPath(params.mainSessionFile)
				) {
					return true;
				}
			} else if (
				!params.mainSessionFile ||
				hasWindowsCaseCollision(params.mainSessionFile) ||
				hasWindowsCaseCollision(params.cwd)
			) {
				// Pre-existing legacy metadata lacked `mainSessionFile`, and case-sensitive
				// NTFS siblings make the legacy hash ambiguous; preserve the legacy dir.
				return true;
			}
			fs.mkdirSync(path.resolve(this.launchCwd, sessionsDir()), { recursive: true });
			fs.renameSync(legacySession, targetSession);
			migrated = true;
			this.ownsDirectory = true;
			this.hasTrackedLockAttempt = true;
			this.migrationBlocked = false;
			this.migrationBlockedHolderPid = undefined;
			return true;
		} catch {
			// If legacy directory still exists and target has not been created
			// (e.g. transient Windows AV/index lock during renameSync), keep
			// migration blocked so we do not create a fresh empty target dir
			// and strand legacy history; acquireOwnership() will retry.
			if (fs.existsSync(legacySession) && !fs.existsSync(targetSession)) {
				this.migrationBlocked = true;
				this.migrationBlockedHolderPid = undefined;
				return false;
			}
			return true;
		} finally {
			if (!migrated) {
				this.releaseOwnedFile(legacyWorkerLock);
				this.releaseOwnedFile(legacyLock);
			}
		}
	}

	private sleepSync(ms: number): void {
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		} catch {
			const until = Date.now() + ms;
			while (Date.now() < until) {
				// Fallback busy-wait if SharedArrayBuffer is unavailable.
			}
		}
	}

	private isLockEntryAlive(lock: Partial<OwnerLock>): number | undefined {
		for (const candidate of [lock.pid, lock.foregroundPid, lock.workerPid]) {
			if (typeof candidate === "number" && candidate !== process.pid && isPidAlive(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private linkStrictPrepopulatedFile(targetPath: string, payload: string): "ok" | "exists" | "no_hardlink" | "error" {
		const tmp = `${targetPath}.${process.pid}.${this.ownerId}.tmp`;
		let fd: number | undefined;
		try {
			fd = fs.openSync(tmp, "wx");
			fs.writeFileSync(fd, payload, "utf-8");
			const toClose = fd;
			fd = undefined;
			fs.closeSync(toClose);
			try {
				fs.linkSync(tmp, targetPath);
				return "ok";
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "EEXIST") return "exists";
				if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") return "no_hardlink";
				return "error";
			}
		} catch {
			return "error";
		} finally {
			if (fd !== undefined) {
				const toClose = fd;
				fd = undefined;
				try {
					fs.closeSync(toClose);
				} catch {
					// Ignore.
				}
			}
			fs.rmSync(tmp, { force: true });
		}
	}

	private exclusiveCreatePrepopulatedFile(targetPath: string, payload: string): "ok" | "exists" | "error" {
		let fd: number | undefined;
		try {
			fd = fs.openSync(targetPath, "wx");
		} catch (wxErr) {
			return (wxErr as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "error";
		}
		try {
			fs.writeFileSync(fd, payload, "utf-8");
			// Clear tracked fd BEFORE closeSync so an EIO/EDQUOT close failure
			// never closes the already-released descriptor number a second time.
			const toClose = fd;
			fd = undefined;
			fs.closeSync(toClose);
			return "ok";
		} catch {
			if (fd !== undefined) {
				const toClose = fd;
				fd = undefined;
				try {
					fs.closeSync(toClose);
				} catch {
					// Ignore.
				}
			}
			try {
				fs.unlinkSync(targetPath);
			} catch {
				// Ignore.
			}
			return "error";
		}
	}

	private linkPrepopulatedFile(targetPath: string, payload: string): "ok" | "exists" | "error" {
		const strict = this.linkStrictPrepopulatedFile(targetPath, payload);
		if (strict !== "no_hardlink") return strict;
		return this.exclusiveCreatePrepopulatedFile(targetPath, payload);
	}

	private releaseOwnedFile(targetPath: string): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(targetPath, "utf-8")) as Partial<OwnerLock>;
			if (parsed.ownerId === this.ownerId) {
				fs.unlinkSync(targetPath);
			}
		} catch {
			// Best effort cleanup; never delete another owner's marker.
		}
	}

	/**
	 * Acquire a reclaim marker atomically via pre-populated `linkSync`, waiting
	 * on live contenders and directory mutexes (`0bd7085`), and reclaiming ONLY
	 * markers whose JSON explicitly proves a dead PID.
	 */
	private acquireMarkerExclusive(markerPath: string, payload: string): boolean {
		for (let attempt = 0; attempt < 8; attempt++) {
			const status = this.linkPrepopulatedFile(markerPath, payload);
			if (status === "ok") return true;
			if (status === "error") return false;

			try {
				const stat = fs.statSync(markerPath);
				if (stat.isDirectory()) {
					// Revision 0bd7085 holds `owner.lock.reclaim` via mkdirSync; never delete it.
					this.sleepSync(25);
					continue;
				}
				const raw = fs.readFileSync(markerPath, "utf-8");
				if (!raw.trim()) {
					// Empty file may be a live legacy writer mid-write; wait and never delete unverified.
					this.sleepSync(25);
					continue;
				}
				let holder: Partial<OwnerLock>;
				try {
					holder = JSON.parse(raw) as Partial<OwnerLock>;
				} catch {
					this.sleepSync(25);
					continue;
				}
				if (holder.ownerId === this.ownerId) return true;
				if (typeof holder.pid !== "number" || (holder.pid !== process.pid && isPidAlive(holder.pid))) {
					this.sleepSync(25);
					continue;
				}
				// Proven dead PID holder: serialize cleanup via per-dead-owner suffix.
				const holderTag = String(holder.ownerId ?? "dead").replace(/[^a-zA-Z0-9_-]/g, "_");
				const guardPath = `${markerPath}.gc.${holderTag}`;
				if (this.linkPrepopulatedFile(guardPath, payload) === "ok") {
					try {
						const recheck = JSON.parse(fs.readFileSync(markerPath, "utf-8")) as Partial<OwnerLock>;
						if (recheck.ownerId === holder.ownerId) {
							fs.unlinkSync(markerPath);
						}
					} catch {
						// Ignore if already gone.
					} finally {
						this.releaseOwnedFile(guardPath);
					}
					continue;
				}
			} catch {
				// Marker vanished; retry.
			}
			this.sleepSync(25);
		}
		return false;
	}

	private readDeadLegacyOwnerId(legacyLockPath = this.legacyLockPath): string | undefined {
		try {
			const raw = fs.readFileSync(legacyLockPath, "utf-8");
			if (!raw.trim()) return undefined;
			const parsed = JSON.parse(raw) as Partial<OwnerLock>;
			if (typeof parsed.pid !== "number") return undefined;
			if (this.isLockEntryAlive(parsed) !== undefined) return undefined;
			return typeof parsed.ownerId === "string" && parsed.ownerId.trim() ? parsed.ownerId : undefined;
		} catch {
			return undefined;
		}
	}

	private acquireLegacyLockExclusive(
		allowedOwnerIds?: ReadonlySet<string>,
		legacyLockPath = this.legacyLockPath,
		workerDirPath = this.dir,
	): { ok: true } | { ok: false; holderPid?: number } {
		fs.mkdirSync(workerDirPath, { recursive: true });
		const payload = JSON.stringify({
			ownerId: this.ownerId,
			pid: process.pid,
			foregroundPid: process.pid,
			createdAt: Date.now(),
		} satisfies OwnerLock);

		for (let attempt = 0; attempt < 5; attempt++) {
			const status = this.linkPrepopulatedFile(legacyLockPath, payload);
			if (status === "ok") return { ok: true };
			if (status === "error") return { ok: false };

			let existingOwnerId: string | undefined;
			let deadTag: string | undefined;
			try {
				const raw = fs.readFileSync(legacyLockPath, "utf-8");
				if (!raw.trim()) {
					this.sleepSync(40);
					continue;
				}
				const existing = JSON.parse(raw) as Partial<OwnerLock>;
				if (existing.ownerId === this.ownerId) return { ok: true };
				if (typeof existing.pid !== "number") {
					this.sleepSync(40);
					continue;
				}
				const livePid = this.isLockEntryAlive(existing);
				if (livePid !== undefined) {
					return { ok: false, holderPid: livePid };
				}
				existingOwnerId = typeof existing.ownerId === "string" && existing.ownerId.trim()
					? existing.ownerId
					: undefined;
				if (!existingOwnerId || !allowedOwnerIds?.has(existingOwnerId)) {
					return { ok: false };
				}
				deadTag = existingOwnerId.replace(/[^a-zA-Z0-9_-]/g, "_");
			} catch {
				this.sleepSync(40);
				continue;
			}

			const reclaimLegacy = `${legacyLockPath}.reclaim.${deadTag}`;
			if (!this.acquireMarkerExclusive(reclaimLegacy, payload)) {
				this.sleepSync(25);
				continue;
			}
			try {
				const recheck = JSON.parse(fs.readFileSync(legacyLockPath, "utf-8")) as Partial<OwnerLock>;
				if (typeof recheck.pid !== "number") {
					return { ok: false };
				}
				const livePid = this.isLockEntryAlive(recheck);
				if (livePid !== undefined) {
					return { ok: false, holderPid: livePid };
				}
				if (recheck.ownerId === existingOwnerId) {
					fs.unlinkSync(legacyLockPath);
				}
			} catch {
				// Leave unverified lock untouched; fail closed on retry/exhaustion.
			} finally {
				this.releaseOwnedFile(reclaimLegacy);
			}
		}
		return { ok: false };
	}

	private cleanupStaleReclaimArtifacts(dir: string, lockBase: string, currentOwnerId?: string): void {
		try {
			for (const entry of fs.readdirSync(dir)) {
				if (!entry.startsWith(`${lockBase}.reclaim.`)) continue;
				const full = path.join(dir, entry);
				try {
					const stat = fs.statSync(full);
					if (stat.isDirectory()) continue;
					const raw = fs.readFileSync(full, "utf-8");
					if (!raw.trim()) continue;
					const rec = JSON.parse(raw) as Partial<OwnerLock>;
					const suffixId = entry.slice(`${lockBase}.reclaim.`.length);
					const deadHolder = typeof rec.pid === "number" && !isPidAlive(rec.pid);
					if (deadHolder || (currentOwnerId && suffixId !== currentOwnerId && Date.now() - stat.mtimeMs > 60_000)) {
						fs.rmSync(full, { force: true });
					}
				} catch {
					// Leave alone if unreadable/changing.
				}
			}
		} catch {
			// Ignore scan errors.
		}
	}

	/**
	 * Enforce a single live owner per persistent worker directory using atomic
	 * pre-populated hard-link creation, shared `owner.lock.reclaim` mutex across
	 * both stale takeovers and no-hard-link fallbacks, per-dead-owner reclaim
	 * markers released in `finally`, and exclusive `worker/owner.lock.json`.
	 */
	verifyCurrentOwnership(): { ok: true } | { ok: false; holderPid?: number } {
		try {
			const mainLock = JSON.parse(fs.readFileSync(this.lockPath, "utf-8")) as Partial<OwnerLock>;
			const legacyLock = JSON.parse(fs.readFileSync(this.legacyLockPath, "utf-8")) as Partial<OwnerLock>;
			if (mainLock.ownerId === this.ownerId && legacyLock.ownerId === this.ownerId) {
				return { ok: true };
			}
			const holderPid = this.isLockEntryAlive(mainLock) ?? this.isLockEntryAlive(legacyLock);
			this.ownsDirectory = false;
			if (mainLock.ownerId !== this.ownerId) {
				this.provisionalLockOwned = false;
			}
			this.hasTrackedLockAttempt =
				this.hasTrackedLockAttempt ||
				mainLock.ownerId === this.ownerId ||
				legacyLock.ownerId === this.ownerId;
			return { ok: false, holderPid };
		} catch {
			this.ownsDirectory = false;
			this.hasTrackedLockAttempt = true;
			return { ok: false };
		}
	}

	acquireOwnership(
		retryMigration?: () => boolean,
	): { ok: true; continuousOwnership: boolean } | { ok: false; holderPid?: number } {
		if (this.migrationBlocked) {
			this.migrationBlocked = false;
			this.migrationBlockedHolderPid = undefined;
			if (retryMigration && !retryMigration()) {
				return { ok: false, holderPid: this.migrationBlockedHolderPid };
			}
			if (this.migrationBlocked) {
				return { ok: false, holderPid: this.migrationBlockedHolderPid };
			}
			if (this.ownsDirectory) {
				return { ok: true, continuousOwnership: false };
			}
		}
		if (this.ownsDirectory) {
			const current = this.verifyCurrentOwnership();
			if (current.ok) return { ok: true, continuousOwnership: true };
			if (current.holderPid !== undefined) return current;
			// Ownership was stolen/lost while cached; continue into full re-acquisition.
		}
		this.hasTrackedLockAttempt = true;
		const res = this.acquireLockPair(this.lockPath, this.legacyLockPath, this.dir, true);
		if (res.ok) {
			this.ownsDirectory = true;
		}
		return { ...res, continuousOwnership: false } as
			| { ok: true; continuousOwnership: boolean }
			| { ok: false; holderPid?: number };
	}

	acquireLockPair(
		lockPath: string,
		legacyLockPath: string,
		workerDirPath: string,
		trackProvisional = false,
	): { ok: true } | { ok: false; holderPid?: number } {
		const lockParent = path.dirname(lockPath);
		fs.mkdirSync(lockParent, { recursive: true });
		this.cleanupStaleReclaimArtifacts(lockParent, path.basename(lockPath));
		this.cleanupStaleReclaimArtifacts(workerDirPath, path.basename(legacyLockPath));

		const payload = JSON.stringify({
			ownerId: this.ownerId,
			pid: process.pid,
			foregroundPid: process.pid,
			createdAt: Date.now(),
		} satisfies OwnerLock);
		const legacySharedReclaim = `${lockPath}.reclaim`;

		for (let attempt = 0; attempt < 5; attempt++) {
			const strictLink = this.linkStrictPrepopulatedFile(lockPath, payload);
			if (strictLink === "error") return { ok: false };

			if (strictLink === "ok") {
				let legacyRes = this.acquireLegacyLockExclusive(undefined, legacyLockPath, workerDirPath);
				if (!legacyRes.ok && legacyRes.holderPid === undefined) {
					// Recover a verified dead orphan `worker/owner.lock.json` left after a
					// crash between primary and legacy lock unlinks.
					const orphanLegacyId = this.readDeadLegacyOwnerId(legacyLockPath);
					if (orphanLegacyId) {
						legacyRes = this.acquireLegacyLockExclusive(new Set([orphanLegacyId]), legacyLockPath, workerDirPath);
					}
				}
				if (!legacyRes.ok) {
					this.releaseOwnedFile(lockPath);
					return legacyRes;
				}
				return { ok: true };
			}

			if (strictLink === "no_hardlink") {
				// On filesystems without hard links, hold `owner.lock.reclaim` before
				// creating `owner.lock` via `openSync("wx")` so a concurrent `5f774dc`
				// reclaimer cannot overwrite our lock with `renameSync`.
				if (!this.acquireMarkerExclusive(legacySharedReclaim, payload)) {
					this.sleepSync(25);
					continue;
				}
				try {
					const fallbackCreate = this.exclusiveCreatePrepopulatedFile(lockPath, payload);
					if (fallbackCreate === "error") return { ok: false };
					if (fallbackCreate === "ok") {
						let legacyRes = this.acquireLegacyLockExclusive(undefined, legacyLockPath, workerDirPath);
						if (!legacyRes.ok && legacyRes.holderPid === undefined) {
							const orphanLegacyId = this.readDeadLegacyOwnerId(legacyLockPath);
							if (orphanLegacyId) {
								legacyRes = this.acquireLegacyLockExclusive(new Set([orphanLegacyId]), legacyLockPath, workerDirPath);
							}
						}
						if (!legacyRes.ok) {
							this.releaseOwnedFile(lockPath);
							return legacyRes;
						}
						return { ok: true };
					}
				} finally {
					this.releaseOwnedFile(legacySharedReclaim);
				}
			}

			let existingRaw: string;
			try {
				existingRaw = fs.readFileSync(lockPath, "utf-8");
			} catch {
				this.sleepSync(15);
				continue;
			}

			let deadTag: string | undefined;
			let deadOwnerId: string | undefined;
			let priorMigratedOwnerId: string | undefined;
			try {
				if (!existingRaw.trim()) {
					this.sleepSync(40);
					continue;
				}
				const existing = JSON.parse(existingRaw) as Partial<OwnerLock>;
				if (existing.ownerId === this.ownerId) {
					const retryAllowed = new Set<string>();
					if (typeof existing.migratedFromOwnerId === "string" && existing.migratedFromOwnerId.trim()) {
						retryAllowed.add(existing.migratedFromOwnerId);
					}
					const orphanLegacyId = this.readDeadLegacyOwnerId(legacyLockPath);
					if (orphanLegacyId) retryAllowed.add(orphanLegacyId);
					const legacyRes = this.acquireLegacyLockExclusive(
						retryAllowed.size > 0 ? retryAllowed : undefined,
						legacyLockPath,
						workerDirPath,
					);
					if (!legacyRes.ok) return legacyRes;
					if (trackProvisional) {
						this.updateLockWorkerPid(undefined, true);
						this.provisionalLockOwned = false;
					}
					return { ok: true };
				}
				if (typeof existing.pid !== "number") {
					this.sleepSync(40);
					continue;
				}
				const livePid = this.isLockEntryAlive(existing);
				if (livePid !== undefined) {
					return { ok: false, holderPid: livePid };
				}
				if (typeof existing.ownerId === "string" && existing.ownerId.trim()) {
					deadOwnerId = existing.ownerId;
				}
				if (typeof existing.migratedFromOwnerId === "string" && existing.migratedFromOwnerId.trim()) {
					priorMigratedOwnerId = existing.migratedFromOwnerId;
				}
				deadTag = (deadOwnerId ?? `pid-${existing.pid}`).replace(/[^a-zA-Z0-9_-]/g, "_");
			} catch {
				this.sleepSync(40);
				continue;
			}

			// Acquire BOTH the 5f774dc-compatible `owner.lock.reclaim` marker AND
			// the per-dead-owner marker so mixed revisions serialize stale takeovers.
			if (!this.acquireMarkerExclusive(legacySharedReclaim, payload)) {
				this.sleepSync(25);
				continue;
			}
			try {
				const reclaimMutex = `${lockPath}.reclaim.${deadTag}`;
				if (!this.acquireMarkerExclusive(reclaimMutex, payload)) {
					this.sleepSync(25);
					continue;
				}
				try {
					let recheckOwnerId: string | undefined;
					let recheckMigrated: string | undefined;
					try {
						const recheckRaw = fs.readFileSync(lockPath, "utf-8");
						const recheck = JSON.parse(recheckRaw) as Partial<OwnerLock>;
						recheckOwnerId = typeof recheck.ownerId === "string" ? recheck.ownerId : undefined;
						recheckMigrated = typeof recheck.migratedFromOwnerId === "string" ? recheck.migratedFromOwnerId : undefined;
						if (typeof recheck.pid !== "number") {
							return { ok: false };
						}
						const livePid = this.isLockEntryAlive(recheck);
						if (livePid !== undefined) {
							return { ok: false, holderPid: livePid };
						}
					} catch {
						return { ok: false };
					}
					if (deadOwnerId !== undefined && recheckOwnerId !== deadOwnerId) {
						continue;
					}
					// Record migratedFromOwnerId while replacing owner.lock so if this process
					// crashes before updating worker/owner.lock.json, the next reclaimer can
					// cleanly finish migrating the two-lock pair.
					const rootLegacyId = recheckMigrated ?? priorMigratedOwnerId ?? recheckOwnerId ?? deadOwnerId;
					const takeoverPayload = JSON.stringify({
						ownerId: this.ownerId,
						pid: process.pid,
						foregroundPid: process.pid,
						...(rootLegacyId ? { migratedFromOwnerId: rootLegacyId } : {}),
						createdAt: Date.now(),
					} satisfies OwnerLock);
					try {
						fs.unlinkSync(lockPath);
					} catch (unlinkErr) {
						if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
							this.sleepSync(15);
							continue;
						}
					}
					if (this.linkPrepopulatedFile(lockPath, takeoverPayload) !== "ok") {
						continue;
					}
					const verified = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as Partial<OwnerLock>;
					if (verified.ownerId !== this.ownerId) {
						return { ok: false };
					}
					if (trackProvisional) {
						this.provisionalLockOwned = true;
					}
					const allowedLegacyIds = new Set<string>();
					if (recheckOwnerId) allowedLegacyIds.add(recheckOwnerId);
					if (deadOwnerId) allowedLegacyIds.add(deadOwnerId);
					if (rootLegacyId) allowedLegacyIds.add(rootLegacyId);
					// Also include any verified dead legacy lock left behind when a previous
					// acquirer crashed between creating primary `owner.lock` and claiming
					// `worker/owner.lock.json`.
					const orphanLegacyId = this.readDeadLegacyOwnerId(legacyLockPath);
					if (orphanLegacyId) allowedLegacyIds.add(orphanLegacyId);
					const legacyRes = this.acquireLegacyLockExclusive(allowedLegacyIds, legacyLockPath, workerDirPath);
					if (!legacyRes.ok) {
						if (legacyRes.holderPid !== undefined) {
							this.releaseOwnedFile(lockPath);
							if (trackProvisional) this.provisionalLockOwned = false;
						}
						return legacyRes;
					}
					if (trackProvisional) {
						this.updateLockWorkerPid(undefined, true);
						this.provisionalLockOwned = false;
					}
					this.cleanupStaleReclaimArtifacts(lockParent, path.basename(lockPath), this.ownerId);
					this.cleanupStaleReclaimArtifacts(workerDirPath, path.basename(legacyLockPath), this.ownerId);
					return { ok: true };
				} finally {
					this.releaseOwnedFile(reclaimMutex);
				}
			} catch {
				this.sleepSync(15);
			} finally {
				this.releaseOwnedFile(legacySharedReclaim);
			}
		}
		return { ok: false };
	}

	updateLockWorkerPid(workerPid: number | undefined, allowBeforeOwned = false): boolean {
		if (!this.ownsDirectory && !allowBeforeOwned) return true;
		// Publish `pid` as the live workerPid while running so older lock readers
		// (`b1865d2`, `98838f7`) that only inspect `existing.pid` also refuse takeover
		// if the foreground process dies before the worker finishes shutting down.
		const payload = JSON.stringify({
			ownerId: this.ownerId,
			pid: workerPid ?? process.pid,
			foregroundPid: process.pid,
			...(workerPid !== undefined ? { workerPid } : {}),
			createdAt: Date.now(),
		} satisfies OwnerLock);
		let allOk = true;
		for (const target of [this.lockPath, this.legacyLockPath]) {
			let fd: number | undefined;
			const tmp = `${target}.${process.pid}.${this.ownerId}.upd.tmp`;
			try {
				const existing = JSON.parse(fs.readFileSync(target, "utf-8")) as Partial<OwnerLock>;
				if (existing.ownerId !== this.ownerId) {
					allOk = false;
					continue;
				}
				fd = fs.openSync(tmp, "wx");
				fs.writeFileSync(fd, payload, "utf-8");
				const toClose = fd;
				fd = undefined;
				fs.closeSync(toClose);
				fs.renameSync(tmp, target);
			} catch {
				allOk = false;
				if (fd !== undefined) {
					const toClose = fd;
					fd = undefined;
					try {
						fs.closeSync(toClose);
					} catch {
						// Ignore.
					}
				}
				fs.rmSync(tmp, { force: true });
			}
		}
		return allOk;
	}

	private rollbackProvisionalLockPreservingProvenance(): void {
		try {
			const raw = fs.readFileSync(this.lockPath, "utf-8");
			const existing = JSON.parse(raw) as Partial<OwnerLock>;
			if (existing.ownerId !== this.ownerId) return;
			if (typeof existing.migratedFromOwnerId === "string" && existing.migratedFromOwnerId.trim()) {
				// Preserve dead legacy ownerId provenance with an invalid dead PID (-1)
				// so the next manager can finish reclaiming `worker/owner.lock.json`
				// while our live foreground PID no longer blocks anyone.
				const placeholder = JSON.stringify({
					ownerId: existing.migratedFromOwnerId,
					pid: -1,
					createdAt: typeof existing.createdAt === "number" ? existing.createdAt : Date.now(),
				} satisfies OwnerLock);
				const tmp = `${this.lockPath}.${process.pid}.${this.ownerId}.rollback.tmp`;
				let fd: number | undefined;
				try {
					fd = fs.openSync(tmp, "wx");
					fs.writeFileSync(fd, placeholder, "utf-8");
					const toClose = fd;
					fd = undefined;
					fs.closeSync(toClose);
					fs.renameSync(tmp, this.lockPath);
					return;
				} catch {
					if (fd !== undefined) {
						const toClose = fd;
						fd = undefined;
						try {
							fs.closeSync(toClose);
						} catch {
							// Ignore.
						}
					}
					fs.rmSync(tmp, { force: true });
					// Keep the provenance-bearing main lock intact if rollback write failed
					// so the next owner can still read `migratedFromOwnerId`.
					return;
				}
			}
			this.releaseOwnedFile(this.lockPath);
		} catch {
			// Best effort rollback.
		}
	}

	releaseOwnership(): void {
		if (!this.ownsDirectory && !this.provisionalLockOwned && !this.hasTrackedLockAttempt) return;
		const wasFullOwner = this.ownsDirectory;
		const wasProvisional = this.provisionalLockOwned;
		this.ownsDirectory = false;
		this.provisionalLockOwned = false;
		this.hasTrackedLockAttempt = false;
		if (!wasFullOwner && wasProvisional) {
			this.rollbackProvisionalLockPreservingProvenance();
		} else {
			this.releaseOwnedFile(this.lockPath);
		}
		this.releaseOwnedFile(this.legacyLockPath);
	}
}
