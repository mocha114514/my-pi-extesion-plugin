/**
 * Directory layout for the relay-mode plugin.
 *
 * All persistent configuration and worker session data live under MPEP's
 * shared cache directory so package updates never overwrite user edits:
 *
 *   mpep-cache/relay-mode/
 *   ├── relay-mode.md                     user-editable config & prompts
 *   └── sessions/
 *       └── <main-session-id>/            one folder per foreground session
 *           └── worker/                   symbiotic singleton worker state
 *               ├── meta.json             worker metadata & error snapshot
 *               └── <uuid>.jsonl          worker Pi session transcript
 */

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getCacheDir } from "../shared/paths.ts";

/**
 * Resolve a session file path into a stable filesystem-aware identity
 * (handles un-flushed files via their parent dir and lowercases on Windows).
 */
function canonicalizeSessionFilePath(sessionFile: string): string {
	const abs = resolve(sessionFile);
	let canonical = abs;
	try {
		canonical = realpathSync.native?.(abs) ?? realpathSync(abs);
	} catch {
		try {
			const realParent = realpathSync.native?.(dirname(abs)) ?? realpathSync(dirname(abs));
			canonical = join(realParent, basename(abs));
		} catch {
			canonical = abs;
		}
	}
	// Preserve directory/file casing (NTFS supports per-directory case sensitivity),
	// normalizing only Windows drive letter case.
	return process.platform === "win32"
		? canonical.replace(/^[A-Z]:/, (d) => d.toLowerCase())
		: canonical;
}

/**
 * Keep directory names filesystem-safe across platforms. Pure `[a-zA-Z0-9_-]`
 * IDs (such as UUIDs) stay unchanged; any sanitized ID adds a short hash
 * suffix to avoid collisions like `a.b` vs `a_b`.
 */
export function sanitizeId(id: string): string {
	const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (cleaned === id && id.length > 0) return id;
	const suffix = createHash("sha256").update(id).digest("hex").slice(0, 6);
	return `${cleaned || "session"}-${suffix}`;
}

/**
 * Derive an isolated cache directory key for the owning foreground session.
 * - Persistent sessions hash the canonical `.jsonl` path so two projects using
 *   the same custom `--session-id` never share or overwrite each other's worker,
 *   and Windows path-casing variants always map to the same worker.
 * - Ephemeral (`--no-session`) sessions receive a unique per-instance key so
 *   closing one ephemeral run can never delete another session's saved worker.
 */
export function buildWorkerSessionKey(
	sessionId: string,
	sessionFile: string | undefined,
	ephemeralToken?: string,
): string {
	const base = sanitizeId(sessionId);
	if (sessionFile && sessionFile.trim()) {
		const canonical = canonicalizeSessionFilePath(sessionFile.trim());
		const fileHash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
		return `${base}-${fileHash}`;
	}
	const token = ephemeralToken ? sanitizeId(ephemeralToken) : String(process.pid);
	return `ephemeral-${base}-${token}`;
}

export function relayModeRoot(): string {
	return join(getCacheDir(), "relay-mode");
}

export function configFilePath(): string {
	return join(relayModeRoot(), "relay-mode.md");
}

export function sessionsDir(): string {
	return join(relayModeRoot(), "sessions");
}

export function mainSessionDir(mainSessionId: string): string {
	return join(sessionsDir(), sanitizeId(mainSessionId));
}

export function workerDir(mainSessionId: string): string {
	return join(mainSessionDir(mainSessionId), "worker");
}

export function ensureRelayDirs(): void {
	mkdirSync(relayModeRoot(), { recursive: true });
	mkdirSync(sessionsDir(), { recursive: true });
}
