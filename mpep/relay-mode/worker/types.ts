/**
 * Shared constants, data structures, and pure path/text utilities for the
 * relay-mode background worker subsystem.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RpcUIResponder } from "../rpc-client.ts";
import type { DeleteApprovalRequest } from "../../shared/delete-approval.ts";

export const RELAY_WORKER_ENV = "MPEP_RELAY_WORKER";
export const RELAY_TRUSTED_CWD_ENV = "MPEP_RELAY_TRUSTED_CWD";

export type WorkerStatus =
	| "starting"
	| "idle"
	| "running"
	| "retrying"
	| "compacting"
	| "waiting_approval"
	| "stalled"
	| "error"
	| "crashed";

export interface WorkerMeta {
	sessionId: string;
	cwd: string;
	mainSessionFile?: string;
	model?: string;
	thinking?: string;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
}

export interface WorkerActivityItem {
	type: "text" | "toolCall" | "toolResult" | "event";
	text: string;
	isError?: boolean;
}

export interface PendingWorkerApproval {
	requestId: string;
	requestedAt: number;
	request: DeleteApprovalRequest;
}

export interface WorkerSnapshot {
	status: WorkerStatus;
	alive: boolean;
	sessionId: string;
	cwd: string;
	model?: string;
	thinking?: string;
	contextTokens: number | null;
	contextWindow?: number;
	turns: number;
	activeTool?: string;
	runStartedAt?: number;
	lastActivityAt?: number;
	silenceSeconds: number;
	stallTimeoutSeconds: number;
	retryAttempt?: number;
	retryReason?: string;
	lastError?: string;
	lastStderr?: string;
	finalOutput: string;
	recentItems: WorkerActivityItem[];
	pendingApprovals: PendingWorkerApproval[];
}

export interface PendingApprovalEntry {
	data: PendingWorkerApproval;
	respond: RpcUIResponder;
}

export const META_FILE = "meta.json";
export const LOCK_FILE = "owner.lock";
export const LEGACY_LOCK_FILE = "owner.lock.json";
export const RELAY_COMPACT_PREFIX = "MPEP_RELAY_COMPACT:";
export const MAX_ACTIVITY_ITEMS = 25;
export const HEARTBEAT_TICK_MS = 5_000;
export const RPC_PROBE_INTERVAL_MS = 30_000;
export const SETTLE_CONFIRM_MS = 350;
export const MAX_SETTLE_RETRIES = 10;
export const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface ModelDescriptor {
	provider: string;
	id: string;
	authenticated?: boolean;
}

export interface OwnerLock {
	ownerId: string;
	pid: number;
	foregroundPid?: number;
	workerPid?: number;
	migratedFromOwnerId?: string;
	createdAt: number;
}

export interface RelayWorkerHooks {
	onWakeup(message: string): void;
	onStateChange(): void;
}

export function canonicalizeFsPath(targetPath: string): string {
	const resolved = path.resolve(targetPath);
	let canonical = resolved;
	try {
		canonical = fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved);
	} catch {
		const parent = path.dirname(resolved);
		if (parent !== resolved) {
			try {
				const realParent = fs.realpathSync.native?.(parent) ?? fs.realpathSync(parent);
				canonical = path.join(realParent, path.basename(resolved));
			} catch {
				canonical = resolved;
			}
		}
	}
	// Preserve directory casing (Windows NTFS supports per-directory case
	// sensitivity); normalize only Windows drive-letter casing.
	return process.platform === "win32"
		? canonical.replace(/^[A-Z]:/, (d) => d.toLowerCase())
		: canonical;
}

export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function truncateLine(text: string, maxLength = 140): string {
	const firstLine = text.split("\n")[0] ?? "";
	if (firstLine.length <= maxLength) return firstLine;
	return `${firstLine.slice(0, maxLength - 3)}...`;
}

/** Strip ANSI escapes and control characters before putting child process output into wakeups. */
export function sanitizeControlText(text: string, maxLength = 180): string {
	const cleaned = text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/[\x00-\x1f\x7f\x80-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function normalizeWindowsShellPath(filePath: string): string {
	if (process.platform !== "win32") return filePath;
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\") ?? "";
	return `${match[1]!.toUpperCase()}:\\${suffix}`;
}

export function isPathInsideDir(targetPath: string, baseDir: string): boolean {
	const canonBase = canonicalizeFsPath(baseDir);
	const canonTarget = canonicalizeFsPath(targetPath);
	// Preserve exact case from canonicalizeFsPath() so case-sensitive NTFS
	// sibling directories on Windows cannot fold into `baseDir` via path.relative().
	const prefix = canonBase.endsWith(path.sep) ? canonBase : `${canonBase}${path.sep}`;
	return canonTarget.length > prefix.length && canonTarget.startsWith(prefix);
}

export function isSamePath(a: string, b: string): boolean {
	try {
		const sa = fs.statSync(a, { bigint: true });
		const sb = fs.statSync(b, { bigint: true });
		if (sa.dev === sb.dev && sa.ino !== 0n && sa.ino === sb.ino) return true;
	} catch {
		// Fall back to canonical path comparison if one path does not exist.
	}
	return canonicalizeFsPath(a) === canonicalizeFsPath(b);
}
