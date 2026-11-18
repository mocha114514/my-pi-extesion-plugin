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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getCacheDir } from "../shared/paths.ts";

/**
 * Keep directory names filesystem-safe across platforms. Pure `[a-zA-Z0-9_-]`
 * IDs (such as UUIDs) stay unchanged; any sanitized ID adds a short hash
 * suffix to avoid collisions like `a.b` vs `a_b`.
 */
export function sanitizeId(id: string): string {
	const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (cleaned === id && cleaned.length > 0) return id;
	const suffix = createHash("sha256").update(id).digest("hex").slice(0, 6);
	return `${cleaned || "session"}-${suffix}`;
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
