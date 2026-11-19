/**
 * Persistent user-level default preference for relay-mode.
 *
 * Stored separately from `relay-mode.md` in `mpep-cache/relay-mode/preferences.json`
 * so toggling the long-term default never modifies hand-edited prompt templates
 * or frontmatter comments.
 *
 * `defaultEnabled` controls ONLY whether newly created sessions (with no
 * per-session state entry yet) start in relay mode automatically. Toggling it
 * never alters the active state of already-open foreground sessions.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { preferencesFilePath } from "./paths.ts";

export interface RelayPreferences {
	defaultEnabled: boolean;
}

interface StoredRelayPreferences {
	version: 1;
	defaultEnabled: boolean;
}

export function loadRelayPreferences(file = preferencesFilePath()): RelayPreferences {
	try {
		const raw = readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
		const parsed = JSON.parse(raw) as Partial<StoredRelayPreferences>;
		if (parsed && typeof parsed === "object" && typeof parsed.defaultEnabled === "boolean") {
			return { defaultEnabled: parsed.defaultEnabled };
		}
	} catch {
		// Missing or malformed preferences file safely falls back to default-off.
	}
	return { defaultEnabled: false };
}

export function saveRelayPreferences(prefs: RelayPreferences, file = preferencesFilePath()): void {
	mkdirSync(dirname(file), { recursive: true });
	const payload: StoredRelayPreferences = {
		version: 1,
		defaultEnabled: Boolean(prefs.defaultEnabled),
	};
	const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
		renameSync(tmp, file);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}
