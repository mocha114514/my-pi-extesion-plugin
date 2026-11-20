/**
 * Relay Mode MPEP extension.
 *
 * Transforms an interactive TUI Pi session into a human-friendly relay &
 * translation front end paired 1:1 with a full-capability symbiotic background
 * worker (`pi --mode rpc`).
 *
 * Key behavior:
 *   - Inactive in headless print/RPC modes and inside the spawned worker itself
 *     (`MPEP_RELAY_WORKER=1`).
 *   - Reads `mpep-cache/relay-mode/relay-mode.md` once per session start / reload.
 *   - Appends static `<relay-mode>` instructions to the foreground system prompt
 *     without invalidating prompt caching.
 *   - Injects passive `<relay-mode-remind>` notices at configured effective
 *     compaction-window percentage milestones and after compaction.
 *   - Automatically starts (or resumes in idle standby) the symbiotic worker on
 *     session start and reaps it on reload/shutdown.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";
import { registerSigintCleanup } from "../shared/sigint.ts";
import { buildReminderMilestones, loadRelayConfig, type RelayConfig } from "./config.ts";
import { RelayModePanel } from "./panel.ts";
import { buildLegacyWindowsWorkerSessionKey, buildWorkerSessionKey } from "./paths.ts";
import { loadRelayPreferences, saveRelayPreferences } from "./preferences.ts";
import { registerRelayTools } from "./tools.ts";
import { createRelayBorderBadge, updateRelayStatusBar, type RelayBorderBadgeHandle } from "./widget.ts";
import {
	cleanupPreservedEphemeralWorkerDir,
	detectPiRuntimeCapabilities,
	isSamePath,
	RELAY_COMPACT_PREFIX,
	RELAY_TRUSTED_CWD_ENV,
	RELAY_WORKER_ENV,
	RelayWorkerManager,
	type ModelDescriptor,
} from "./worker/index.ts";

const LAUNCH_CWD = process.cwd();
const SLOT = Symbol.for("mpep.relay-mode.dispose.v1");
const RETIRING_SLOT = Symbol.for("mpep.relay-mode.retiring.v1");
const WORKER_APIS_SLOT = Symbol.for("mpep.relay-mode.worker-apis.v1");

interface SessionStateFallbackRecord {
	enabled: boolean;
	/**
	 * True on Pi 0.85.1 where a failed `appendEntry()` advances the in-memory
	 * `leafId` without rolling it back. Retrying `appendEntry()` onto a branch
	 * containing that unsaved leaf would persist a child whose parent does not
	 * exist on disk and disconnect the saved conversation.
	 */
	unsafeLegacyLeaf: boolean;
	/**
	 * Specific unsaved in-memory entry IDs created by failed appends on Pi 0.85.1.
	 * If the user later navigates (`/tree`) back to a persisted ancestor or
	 * sibling branch that does not contain any of these IDs, writing is safe again.
	 */
	failedEntryIds?: string[];
	/**
	 * True when a failed legacy append could not capture a specific unsaved leaf
	 * ID (e.g. migrated from an older bare-boolean fallback record), conservatively
	 * blocking retries for this session on Pi 0.85.1.
	 */
	unsafeSessionWide?: boolean;
}

interface SharedLifecycleState {
	active: RelayWorkerManager | undefined;
	retiring: Set<RelayWorkerManager>;
	preservedEphemeralKeys: Set<string>;
	ephemeralTokens: Map<string, string>;
	sessionStateFallback: Map<string, SessionStateFallbackRecord | boolean>;
	/**
	 * Track unsaved Pi 0.85.1 leaf entry IDs independently from
	 * `sessionStateFallback` so that a successful retry on another persisted
	 * branch clears the pending value while still remembering the broken
	 * in-memory entry ID if the user navigates back to it via `/tree`.
	 */
	unsafeLegacyLeafIdsBySession: Map<string, Set<string>>;
	preservedPendingToolsBySession: Map<string, Set<string>>;
	activeEphemeralKey: string | undefined;
	exitListener: (() => void) | undefined;
	unregisterSigint: (() => void) | undefined;
}

const globals = globalThis as unknown as Record<symbol, unknown>;
const installations = globals as Record<symbol, (() => void) | undefined>;
const registeredWorkerApis = (globals[WORKER_APIS_SLOT] ??= new WeakSet<object>()) as WeakSet<object>;

function getSharedLifecycle(): SharedLifecycleState {
	let state = globals[RETIRING_SLOT] as SharedLifecycleState | undefined;
	if (!state) {
		state = {
			active: undefined,
			retiring: new Set<RelayWorkerManager>(),
			preservedEphemeralKeys: new Set<string>(),
			ephemeralTokens: new Map<string, string>(),
			sessionStateFallback: new Map<string, SessionStateFallbackRecord | boolean>(),
			unsafeLegacyLeafIdsBySession: new Map<string, Set<string>>(),
			preservedPendingToolsBySession: new Map<string, Set<string>>(),
			activeEphemeralKey: undefined,
			exitListener: undefined,
			unregisterSigint: undefined,
		};
		globals[RETIRING_SLOT] = state;
	} else {
		if (!state.preservedEphemeralKeys) state.preservedEphemeralKeys = new Set<string>();
		if (!state.ephemeralTokens) state.ephemeralTokens = new Map<string, string>();
		if (!state.sessionStateFallback) state.sessionStateFallback = new Map<string, SessionStateFallbackRecord | boolean>();
		if (!state.unsafeLegacyLeafIdsBySession) {
			state.unsafeLegacyLeafIdsBySession = new Map<string, Set<string>>();
			// Live-upgrade migration: seed the new hazard map from any structured
			// fallback records already retained in `sessionStateFallback` before
			// any read or retry can overwrite or delete them.
			for (const [sid, raw] of state.sessionStateFallback) {
				if (raw && typeof raw === "object" && Array.isArray(raw.failedEntryIds) && raw.failedEntryIds.length > 0) {
					state.unsafeLegacyLeafIdsBySession.set(sid, new Set(raw.failedEntryIds));
				}
			}
		}
		if (!state.preservedPendingToolsBySession) state.preservedPendingToolsBySession = new Map<string, Set<string>>();
	}
	return state;
}

function purgePreservedEphemeralKeys(keepKey?: string): void {
	const state = getSharedLifecycle();
	for (const key of [...state.preservedEphemeralKeys]) {
		if (keepKey && key === keepKey) continue;
		if (cleanupPreservedEphemeralWorkerDir(key, LAUNCH_CWD)) {
			state.preservedEphemeralKeys.delete(key);
		}
	}
}

function maybeDetachGlobalSignalHandlers(): void {
	const state = getSharedLifecycle();
	if (
		state.active ||
		state.retiring.size > 0 ||
		state.preservedEphemeralKeys.size > 0 ||
		!state.exitListener
	) {
		return;
	}
	const listener = state.exitListener;
	state.exitListener = undefined;
	process.off("exit", listener);
	state.unregisterSigint?.();
	state.unregisterSigint = undefined;
}

function trackGlobalRetiringWorker(target: RelayWorkerManager): void {
	const state = getSharedLifecycle();
	if (target.isCleanupCompleted()) {
		state.retiring.delete(target);
		purgePreservedEphemeralKeys(state.activeEphemeralKey);
		maybeDetachGlobalSignalHandlers();
		return;
	}
	state.retiring.add(target);
	attachGlobalSignalHandlers();
	target.onCleanupComplete(() => {
		state.retiring.delete(target);
		purgePreservedEphemeralKeys(state.activeEphemeralKey);
		maybeDetachGlobalSignalHandlers();
	});
}

function disposeAllGlobalWorkersSync(preserveEphemeralForReload = false): void {
	const state = getSharedLifecycle();
	const targets = new Set<RelayWorkerManager>(state.retiring);
	if (state.active) {
		targets.add(state.active);
		state.active = undefined;
	}
	for (const target of targets) {
		if (preserveEphemeralForReload && target.ephemeral) {
			state.preservedEphemeralKeys.add(target.storageKey);
		}
		target.dispose(true, { preserveEphemeralDir: preserveEphemeralForReload });
		if (target.isCleanupCompleted()) {
			state.retiring.delete(target);
		} else {
			// Retain surviving workers across `/reload` until confirmed dead and
			// unlocked so process exit/SIGINT can still run final teardown.
			trackGlobalRetiringWorker(target);
		}
	}
	if (!preserveEphemeralForReload) {
		state.activeEphemeralKey = undefined;
		state.ephemeralTokens.clear();
		state.sessionStateFallback.clear();
		purgePreservedEphemeralKeys();
	}
	maybeDetachGlobalSignalHandlers();
}

function attachGlobalSignalHandlers(): void {
	const state = getSharedLifecycle();
	if (state.exitListener) return;
	const listener = () => disposeAllGlobalWorkersSync(false);
	state.exitListener = listener;
	process.on("exit", listener);
	state.unregisterSigint = registerSigintCleanup(listener);
}

const COMPACT_PENDING_SLOT = Symbol.for("mpep.compact-forewarn.pending");
const DEFAULT_RESERVE_TOKENS = 16_384;
const REMIND_TYPE = "mpep-relay-remind";
const NOTICE_TYPE = "mpep-relay-notice";
const SESSION_STATE_ENTRY = "mpep-relay-mode-state";
const RELAY_TOOL_NAMES = new Set(["relay_send", "relay_status", "relay_control", "relay_approval"]);

interface SessionRelayStateEntry {
	enabled: boolean;
}

/**
 * Determine whether a foreground session should start in relay mode.
 * Explicit per-session state always takes precedence over the long-term default.
 */
export function resolveInitialRelayEnabled(
	sessionState: boolean | undefined,
	defaultEnabled: boolean,
): boolean {
	return sessionState !== undefined ? sessionState : defaultEnabled;
}

interface SessionRelayStateLookup {
	value: boolean | undefined;
	needsPersistence: boolean;
}

/**
 * Normalize a process-global session-state fallback entry (including legacy bare
 * booleans retained across a live `/reload` upgrade from an earlier build) into
 * the structured `SessionStateFallbackRecord` matching the host Pi's rollback
 * semantics.
 */
function getNormalizedSessionFallback(
	sessionId: string | undefined,
	hostRollsBackFailedAppend: boolean,
): SessionStateFallbackRecord | undefined {
	if (!sessionId) return undefined;
	const map = getSharedLifecycle().sessionStateFallback;
	const raw = map.get(sessionId);
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") {
		const migrated: SessionStateFallbackRecord = {
			enabled: raw,
			unsafeLegacyLeaf: !hostRollsBackFailedAppend,
			unsafeSessionWide: !hostRollsBackFailedAppend,
		};
		map.set(sessionId, migrated);
		return migrated;
	}
	if (raw && typeof raw.enabled === "boolean") {
		if (raw.unsafeLegacyLeaf && Array.isArray(raw.failedEntryIds)) {
			for (const id of raw.failedEntryIds) {
				if (typeof id === "string" && id) {
					recordUnsafeLegacyLeafId(sessionId, id);
				}
			}
		}
		return raw;
	}
	return undefined;
}

/**
 * Record an unsaved Pi 0.85.1 entry ID in the session-scoped hazard set so it
 * survives subsequent successful retries on other persisted branches.
 */
function recordUnsafeLegacyLeafId(sessionId: string | undefined, leafId: string): void {
	if (!sessionId || !leafId) return;
	const map = getSharedLifecycle().unsafeLegacyLeafIdsBySession;
	let set = map.get(sessionId);
	if (!set) {
		set = new Set<string>();
		map.set(sessionId, set);
	}
	set.add(leafId);
}

/**
 * Determine whether appending to the current branch on Pi 0.85.1 would attach
 * a child to an unsaved in-memory entry created by an earlier failed append.
 * Checks both the active fallback record AND the durable session-scoped set of
 * failed entry IDs so navigating (`/tree`) back to a previously failed node
 * remains guarded even after a later write succeeded on a persisted branch.
 */
function isCurrentBranchUnsafeLegacy(
	sessionId: string | undefined,
	record: SessionStateFallbackRecord | undefined,
	ctx: ExtensionContext | undefined,
): boolean {
	if (record?.unsafeLegacyLeaf && record.unsafeSessionWide) {
		return true;
	}
	const failedSet = new Set<string>();
	if (sessionId) {
		const tracked = getSharedLifecycle().unsafeLegacyLeafIdsBySession.get(sessionId);
		if (tracked) {
			for (const id of tracked) failedSet.add(id);
		}
	}
	if (record?.unsafeLegacyLeaf && record.failedEntryIds) {
		for (const id of record.failedEntryIds) failedSet.add(id);
	}
	if (failedSet.size === 0) {
		return Boolean(record?.unsafeLegacyLeaf);
	}
	if (!ctx) return true;
	try {
		const branch = ctx.sessionManager.getBranch?.() ?? [];
		for (const entry of branch) {
			const id = (entry as { id?: unknown } | undefined)?.id;
			if (typeof id === "string" && failedSet.has(id)) {
				return true;
			}
		}
		const leafId = ctx.sessionManager.getLeafId?.();
		if (typeof leafId === "string" && failedSet.has(leafId)) {
			return true;
		}
		return false;
	} catch {
		return true;
	}
}

function readSessionRelayState(
	ctx: ExtensionContext,
	sessionId: string | undefined,
	hostRollsBackFailedAppend: boolean,
): SessionRelayStateLookup {
	// If an earlier write for this exact session failed in this process:
	// - Migrate any legacy bare-boolean record first so both reads and writes
	//   observe the same normalized semantics after a live `/reload` upgrade.
	// - On Pi >= 1.5 (`unsafeLegacyLeaf: false`), SessionManager rolled back the
	//   in-memory leaf, so retrying `appendEntry()` once storage recovers is safe.
	// - On Pi 0.85.1 (`unsafeLegacyLeaf: true`), allow retrying ONLY when the
	//   current branch no longer contains any unsaved failed entry (e.g. after `/tree`).
	const fallback = getNormalizedSessionFallback(sessionId, hostRollsBackFailedAppend);
	if (fallback) {
		const blockedOnBranch = isCurrentBranchUnsafeLegacy(sessionId, fallback, ctx);
		return { value: fallback.enabled, needsPersistence: !blockedOnBranch };
	}
	try {
		// Read session entries in append order (rather than only the active tree
		// branch) because relay mode is a session-level toggle: disabling it and
		// navigating to a sibling branch must not resurrect an older `enabled: true`
		// entry on reload.
		const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch?.() ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
			if (entry?.type === "custom" && entry.customType === SESSION_STATE_ENTRY) {
				const data = entry.data as Partial<SessionRelayStateEntry> | undefined;
				if (typeof data?.enabled === "boolean") {
					return { value: data.enabled, needsPersistence: false };
				}
			}
		}
	} catch {
		// Fall back to long-term preference if session entries cannot be inspected.
	}
	return { value: undefined, needsPersistence: true };
}

/**
 * Replay the current branch's recorded system-message tool deltas (matching Pi's
 * `transcript.ts` order: `toolsRemoved` before `toolsAdded` so schema/description
 * updates to the same tool name retain the tool) and return ONLY still-pending
 * non-relay candidates: tools that are either not yet registered OR registered
 * with `exposure === "hidden"` (e.g. disconnected MCP servers). Explicitly
 * excludes registered, non-hidden tools (such as built-ins deliberately disabled
 * by the user before toggling relay mode).
 */
function findPendingBranchTools(
	ctx: ExtensionContext | undefined,
	pi: ExtensionAPI,
	activeOrRevivedNonRelay: ReadonlySet<string>,
): string[] {
	if (!ctx) return [];
	try {
		const branch = ctx.sessionManager.getBranch?.() ?? [];
		const restored = new Set<string>();
		for (const raw of branch) {
			const entry = raw as {
				type?: unknown;
				message?: {
					role?: unknown;
					toolsAdded?: Array<{ name?: unknown }>;
					toolsRemoved?: Array<{ name?: unknown }>;
				};
			};
			if (entry?.type !== "message" || entry.message?.role !== "system") continue;
			// Apply removals BEFORE additions to match Pi's transcript replay semantics.
			for (const tool of entry.message.toolsRemoved ?? []) {
				if (typeof tool?.name === "string") {
					restored.delete(tool.name);
				}
			}
			for (const tool of entry.message.toolsAdded ?? []) {
				if (typeof tool?.name === "string" && !RELAY_TOOL_NAMES.has(tool.name)) {
					restored.add(tool.name);
				}
			}
		}
		if (restored.size === 0) return [];
		const exposureByName = new Map<string, string | undefined>();
		for (const tool of pi.getAllTools?.() ?? []) {
			exposureByName.set(tool.name, (tool as { exposure?: string }).exposure);
		}
		return [...restored].filter((name) => {
			if (activeOrRevivedNonRelay.has(name)) return false;
			// If the tool is already registered and NOT hidden, it is a visible tool
			// that was deliberately deactivated—never classify it as pending.
			if (exposureByName.has(name) && exposureByName.get(name) !== "hidden") {
				return false;
			}
			return true;
		});
	} catch {
		return [];
	}
}

function detectModelOverridesSupport(): boolean {
	try {
		const cliEntry = process.argv[1];
		if (!cliEntry) return true;
		// Check package.json up to 2 levels above the running Pi entry script.
		for (const rel of ["../package.json", "../../package.json"]) {
			try {
				const pkgPath = resolve(dirname(cliEntry), rel);
				const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown; version?: unknown };
				if (pkg.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string") {
					const major = Number.parseInt(pkg.version.split(".")[0] ?? "", 10);
					return Number.isFinite(major) ? major >= 1 : true;
				}
			} catch {
				// Keep probing parent directory.
			}
		}
	} catch {
		// Default to supporting modelOverrides.
	}
	return true;
}

const SUPPORTS_COMPACTION_MODEL_OVERRIDES = detectModelOverridesSupport();

function deepMergePlain(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, val] of Object.entries(over)) {
		if (val && typeof val === "object" && !Array.isArray(val) &&
			result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
			result[key] = deepMergePlain(result[key] as Record<string, unknown>, val as Record<string, unknown>);
		} else {
			result[key] = val;
		}
	}
	return result;
}

function getProjectTrusted(ctx: ExtensionContext): boolean | undefined {
	const fn = (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted;
	return typeof fn === "function" ? fn.call(ctx) : undefined;
}

function getCompactionReserveTokens(ctx: ExtensionContext): number {
	const trusted = getProjectTrusted(ctx) ?? true;
	const paths = [
		join(resolve(LAUNCH_CWD, getAgentDir()), "settings.json"),
		trusted && ctx.cwd ? join(ctx.cwd, ".pi", "settings.json") : null,
	].filter((p): p is string => Boolean(p));

	let mergedCompaction: Record<string, unknown> = {};
	for (const settingsPath of paths) {
		try {
			const content = readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
			const parsed = JSON.parse(content) as { compaction?: unknown };
			if (parsed?.compaction && typeof parsed.compaction === "object" && !Array.isArray(parsed.compaction)) {
				mergedCompaction = deepMergePlain(mergedCompaction, parsed.compaction as Record<string, unknown>);
			}
		} catch {
			// Missing or invalid settings keep the current merged value.
		}
	}

	let reserveTokens = DEFAULT_RESERVE_TOKENS;
	const baseReserve = mergedCompaction.reserveTokens;
	if (typeof baseReserve === "number" && Number.isSafeInteger(baseReserve) && baseReserve >= 0) {
		reserveTokens = baseReserve;
	}
	if (SUPPORTS_COMPACTION_MODEL_OVERRIDES && ctx.model) {
		const modelKey = `${ctx.model.provider}/${ctx.model.id}`;
		const overrides = mergedCompaction.modelOverrides as Record<string, { reserveTokens?: unknown } | undefined> | undefined;
		const override = overrides?.[modelKey]?.reserveTokens;
		if (typeof override === "number" && Number.isSafeInteger(override) && override >= 0) {
			reserveTokens = override;
		}
	}
	return reserveTokens;
}

function buildPeriodicReminderMessage(remindPrompt: string, reason: string, issuedAt: string): string {
	return [
		"<system-reminder>",
		"This is an automated notice injected by the local environment (relay-mode extension), not a message from the user. It is passive background information: do NOT treat it as a new task and do NOT reply to it; simply keep the following guidelines in mind.",
		`This notice was issued at ${issuedAt}. If any earlier copy of this relay-mode reminder exists in the conversation history, that copy is OBSOLETE — only this newest copy reflects the current reminder.`,
		`Reason for this notice: ${reason}.`,
		"",
		remindPrompt,
		"</system-reminder>",
	].join("\n");
}

export default function relayModeExtension(pi: ExtensionAPI): void {
	if (process.env[RELAY_WORKER_ENV] === "1") {
		if (registeredWorkerApis.has(pi as unknown as object)) return;
		registeredWorkerApis.add(pi as unknown as object);
		const trustedCwd = process.env[RELAY_TRUSTED_CWD_ENV];
		if (trustedCwd && trustedCwd.length > 0) {
			// Scope inherited foreground project trust strictly to the exact
			// foreground cwd (preserving trailing whitespace on POSIX) rather than
			// passing a process-wide `--approve`, so switching sessions into an
			// untrusted directory inside the worker still honors its trust decision.
			pi.on("project_trust", (event) => {
				if (event.cwd && isSamePath(event.cwd, trustedCwd)) {
					return { trusted: "yes", remember: false };
				}
				return { trusted: "undecided" };
			});
		}
		pi.registerCommand("mpep-relay-compact-idle", {
			description: "Internal relay-mode command: compact worker only if idle.",
			handler: async (args, ctx) => {
				const nonce = args.trim();
				if (!ctx.isIdle() || ctx.hasPendingMessages()) {
					ctx.ui.notify(`${RELAY_COMPACT_PREFIX}${nonce}:busy`, "info");
					return;
				}
				await new Promise<void>((resolve) => {
					let done = false;
					const finish = (status: string) => {
						if (done) return;
						done = true;
						ctx.ui.notify(`${RELAY_COMPACT_PREFIX}${nonce}:${status}`, "info");
						resolve();
					};
					ctx.compact({
						onComplete: () => finish("ok"),
						onError: (err) => finish(`err:${err.message}`),
					});
				});
			},
		});
		return;
	}
	installations[SLOT]?.();

	if (!isPluginEnabled("relay-mode")) {
		// While the extension is disabled, branch navigations or runs may occur
		// unobserved; immediately discard any carried pending-tool handoff so a
		// later re-enable + `/reload` never replays stale tool names.
		getSharedLifecycle().preservedPendingToolsBySession.clear();
		// Even while disabled, strip historical relay-mode reminders/notices from
		// replayed transcripts so they never direct a non-relay session, and clean
		// up any preserved ephemeral worker state carried over from a reload before
		// the plugin was disabled.
		pi.on("context", (event) => {
			const filtered = event.messages.filter((msg) => {
				const rec = msg as unknown as { role?: unknown; customType?: unknown };
				return !(rec.role === "custom" && (rec.customType === REMIND_TYPE || rec.customType === NOTICE_TYPE));
			});
			if (filtered.length !== event.messages.length) {
				return { messages: filtered };
			}
		});
		const cleanupDisabledState = (incomingSessionId?: string) => {
			const shared = getSharedLifecycle();
			// Drop any preserved ephemeral state not belonging to an active session
			// (the plugin is disabled, so no session needs preserved worker dirs).
			shared.activeEphemeralKey = undefined;
			shared.preservedPendingToolsBySession.clear();
			for (const sid of [...shared.ephemeralTokens.keys()]) {
				if (!incomingSessionId || sid !== incomingSessionId) {
					shared.ephemeralTokens.delete(sid);
				}
			}
			for (const sid of [...shared.sessionStateFallback.keys()]) {
				if (!incomingSessionId || sid !== incomingSessionId) {
					shared.sessionStateFallback.delete(sid);
				}
			}
			for (const sid of [...shared.unsafeLegacyLeafIdsBySession.keys()]) {
				if (!incomingSessionId || sid !== incomingSessionId) {
					shared.unsafeLegacyLeafIdsBySession.delete(sid);
				}
			}
			purgePreservedEphemeralKeys();
			maybeDetachGlobalSignalHandlers();
		};
		pi.on("session_start", (_event, ctx) => {
			cleanupDisabledState(ctx.sessionManager.getSessionId() || undefined);
		});
		pi.on("session_shutdown", (event) => {
			const isReload = (event as { reason?: unknown } | undefined)?.reason === "reload";
			if (!isReload) {
				cleanupDisabledState();
			}
		});
		return;
	}

	let activeInSession = false;
	let currentCtx: ExtensionContext | undefined;
	let currentConfig: RelayConfig | undefined;
	let worker: RelayWorkerManager | undefined;
	let borderBadge: RelayBorderBadgeHandle | undefined;
	let panelOpen = false;
	let panelOpenSeq = 0;
	let activePanelToken = 0;
	let closeActivePanel: (() => void) | undefined;
	let sessionToggleInFlight = false;
	let toggleSeq = 0;
	let transcriptLoadoutRestored = false;
	const preservedPendingTools = new Set<string>();
	let retiringDisposalPromise: Promise<void> | undefined;
	let currentSessionId: string | undefined;
	let currentEphemeralToken: string | undefined;
	let currentPreservedEphemeralKey: string | undefined;
	let milestones: number[] = [];
	const firedMilestones = new Set<number>();
	let pendingResumeNotice: string | undefined;
	let promptHookActiveForRun = false;

	// Defer triggerTurn notices while foreground compaction or tree navigation is running.
	let compactionInFlight = false;
	let treeNavInFlight = false;
	const heldNotices: string[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let treeNavSafetyTimer: ReturnType<typeof setTimeout> | undefined;

	const scheduleFlushHeldNotices = () => {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			if (compactionInFlight || treeNavInFlight) return;
			for (const notice of heldNotices.splice(0)) {
				sendWakeup(notice);
			}
		}, 1_000);
		flushTimer.unref?.();
	};

	const LEGACY_WAKE_POLICY_RE = /^(?:<relay-mode-wakeup-policy>\n[\s\S]*?\n<\/relay-mode-wakeup-policy>\n\n)+/;

	const sendWakeup = (rawContent: string) => {
		if (!activeInSession) return;
		if (compactionInFlight || treeNavInFlight) {
			heldNotices.push(rawContent);
			return;
		}
		if ((globalThis as unknown as Record<symbol, unknown>)[COMPACT_PENDING_SLOT]) {
			try {
				pi.sendMessage(
					{ customType: NOTICE_TYPE, display: false, content: rawContent },
					{ triggerTurn: false },
				);
			} catch {
				// Ignore invalidated context during shutdown.
			}
			return;
		}
		try {
			pi.sendMessage(
				{ customType: NOTICE_TYPE, display: false, content: rawContent },
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch {
			// Ignore invalidated context during reload/shutdown.
		}
	};

	const sendPassiveReminder = (reason: string) => {
		if (!activeInSession || !currentConfig?.remindPrompt) return;
		try {
			pi.sendMessage(
				{
					customType: REMIND_TYPE,
					display: false,
					content: buildPeriodicReminderMessage(
						currentConfig.remindPrompt,
						reason,
						new Date().toISOString(),
					),
				},
				{ triggerTurn: false },
			);
		} catch {
			// Ignore if session context is shutting down.
		}
	};

	const checkReminderMilestones = (ctx: ExtensionContext) => {
		if (!activeInSession || !currentConfig?.remindPrompt || milestones.length === 0) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !usage.contextWindow || usage.contextWindow <= 0) return;

		const reserveTokens = getCompactionReserveTokens(ctx);
		const effectiveWindow = Math.max(1, usage.contextWindow - reserveTokens);
		const percent = Math.floor((usage.tokens / effectiveWindow) * 100);

		let highestReached: number | undefined;
		for (const milestone of milestones) {
			if (percent >= milestone && !firedMilestones.has(milestone)) {
				highestReached = milestone;
			}
		}
		if (highestReached === undefined) return;

		for (const milestone of milestones) {
			if (milestone <= highestReached) firedMilestones.add(milestone);
		}
		sendPassiveReminder(
			`Foreground context usage reached ~${highestReached}% of the effective compaction window (${usage.tokens.toLocaleString("en-US")} / ${effectiveWindow.toLocaleString("en-US")} tokens)`,
		);
	};

	let sessionStartSeq = 0;

	const clearPendingUiAndTimers = () => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (treeNavSafetyTimer) {
			clearTimeout(treeNavSafetyTimer);
			treeNavSafetyTimer = undefined;
		}
		heldNotices.length = 0;
	};

	const runtimeCaps = detectPiRuntimeCapabilities();
	const relayTools = registerRelayTools(
		pi,
		{
			isActive: () => activeInSession,
			getWorker: () => worker,
		},
		{ supportsToolExposure: runtimeCaps.supportsToolExposure },
	);

	// Re-registering tools on Pi >= 1.5 runs `refreshTools()`, which reactivates
	// any allowlisted (`--tools`) non-relay tools that were previously disabled.
	// Capture the pre-toggle non-relay set and prune only unintended revivals so
	// ordinary sessions without `--tools` still avoid calling `setActiveTools()`.
	// When pruning IS needed on shipped Pi 1.5.2 (which clears `_pendingToolNames`
	// on any removal), capture still-pending restored branch tools ONLY when Pi
	// actually restored the transcript loadout (e.g. `/tree` navigation, NOT an
	// explicit `--tools` startup where Pi intentionally skips transcript restore).
	const setExposurePreservingNonRelayTools = (next: "hidden" | "direct") => {
		const beforeNonRelay = new Set(pi.getActiveTools().filter((name) => !RELAY_TOOL_NAMES.has(name)));
		relayTools.setExposure(next);
		const after = pi.getActiveTools();
		const revivedNonRelay = after.some((name) => !RELAY_TOOL_NAMES.has(name) && !beforeNonRelay.has(name));
		if (revivedNonRelay) {
			if (transcriptLoadoutRestored) {
				const activeOrRevivedNonRelay = new Set(
					after.filter((name) => !RELAY_TOOL_NAMES.has(name)),
				);
				for (const pending of findPendingBranchTools(currentCtx, pi, activeOrRevivedNonRelay)) {
					preservedPendingTools.add(pending);
				}
			}
			pi.setActiveTools(after.filter((name) => RELAY_TOOL_NAMES.has(name) || beforeNonRelay.has(name)));
		}
	};

	const reconcilePreservedPendingTools = () => {
		if (preservedPendingTools.size === 0) {
			transcriptLoadoutRestored = false;
			return;
		}
		const active = pi.getActiveTools();
		const activeSet = new Set(active);
		const candidates = [...preservedPendingTools].filter((name) => !activeSet.has(name));
		// Expire the preserved pending loadout at run start, matching Pi 1.5.2's
		// `_pendingToolNames.clear()` at run start (`agent-session.js:1511`).
		preservedPendingTools.clear();
		transcriptLoadoutRestored = false;
		if (currentSessionId) {
			getSharedLifecycle().preservedPendingToolsBySession.delete(currentSessionId);
		}
		if (candidates.length > 0) {
			// Additive-only activation: Pi activates candidates that are now
			// registered, non-hidden, and allowed, while ignoring still-hidden
			// or disallowed names without clearing any active tools.
			pi.setActiveTools([...active, ...candidates]);
		}
	};

	const hideRelayTools = () => {
		setExposurePreservingNonRelayTools("hidden");
		const active = pi.getActiveTools();
		const filtered = active.filter((name) => !RELAY_TOOL_NAMES.has(name));
		if (filtered.length !== active.length) {
			pi.setActiveTools(filtered);
		}
	};

	const syncRelayToolVisibility = () => {
		if (!activeInSession) {
			hideRelayTools();
			return;
		}
		setExposurePreservingNonRelayTools("direct");
		const active = pi.getActiveTools();
		const missing = [...RELAY_TOOL_NAMES].filter((name) => !active.includes(name));
		if (missing.length > 0) {
			pi.setActiveTools([...active, ...missing]);
		}
	};

	const tryAppendSessionState = (enabled: boolean, notifyOnError: boolean): boolean => {
		const shared = getSharedLifecycle();
		// Normalize any legacy bare-boolean record first, then check whether the
		// current branch contains any unsaved failed entry on Pi 0.85.1 (including
		// IDs remembered from earlier failures even after a retry succeeded elsewhere).
		const existingFallback = getNormalizedSessionFallback(
			currentSessionId,
			runtimeCaps.hasSettleCredentialWrites,
		);
		if (isCurrentBranchUnsafeLegacy(currentSessionId, existingFallback, currentCtx)) {
			if (currentSessionId) {
				const trackedIds = shared.unsafeLegacyLeafIdsBySession.get(currentSessionId);
				shared.sessionStateFallback.set(currentSessionId, {
					enabled,
					unsafeLegacyLeaf: true,
					failedEntryIds: trackedIds && trackedIds.size > 0
						? [...trackedIds]
						: existingFallback?.failedEntryIds,
					unsafeSessionWide: existingFallback?.unsafeSessionWide,
				});
			}
			return false;
		}
		const leafBeforeAppend = currentCtx?.sessionManager.getLeafId?.() ?? null;
		try {
			pi.appendEntry(SESSION_STATE_ENTRY, { enabled } satisfies SessionRelayStateEntry);
			if (currentSessionId) {
				// Clear only the pending fallback value; keep `unsafeLegacyLeafIdsBySession`
				// intact so navigating back to an earlier failed node via `/tree` stays guarded.
				shared.sessionStateFallback.delete(currentSessionId);
			}
			return true;
		} catch (error) {
			// Retain an in-process session-scoped fallback across `/reload` so a
			// failed disk/session write never silently flips this open session back.
			// On Pi 0.85.1, record the exact unsaved leaf ID (when advanced) both in
			// the fallback record and in `unsafeLegacyLeafIdsBySession` so writes
			// stay blocked on that node even if another branch later writes safely.
			if (currentSessionId) {
				const legacyHost = !runtimeCaps.hasSettleCredentialWrites;
				const leafAfterAppend = legacyHost ? (currentCtx?.sessionManager.getLeafId?.() ?? null) : null;
				if (legacyHost && typeof leafAfterAppend === "string" && leafAfterAppend !== leafBeforeAppend) {
					recordUnsafeLegacyLeafId(currentSessionId, leafAfterAppend);
				}
				const trackedIds = shared.unsafeLegacyLeafIdsBySession.get(currentSessionId);
				const nextFailedIds = trackedIds && trackedIds.size > 0
					? [...trackedIds]
					: [...(existingFallback?.failedEntryIds ?? [])];
				const unsafeSessionWide = legacyHost
					? Boolean(existingFallback?.unsafeSessionWide || nextFailedIds.length === 0)
					: false;
				shared.sessionStateFallback.set(currentSessionId, {
					enabled,
					unsafeLegacyLeaf: legacyHost,
					failedEntryIds: nextFailedIds.length > 0 ? nextFailedIds : undefined,
					unsafeSessionWide,
				});
			}
			if (notifyOnError) {
				currentCtx?.ui.notify(
					t("relay.panel.saveFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
					"error",
				);
			}
			return false;
		}
	};

	const purgeCurrentPreservedEphemeralDir = () => {
		const shared = getSharedLifecycle();
		if (currentPreservedEphemeralKey) {
			const key = currentPreservedEphemeralKey;
			currentPreservedEphemeralKey = undefined;
			if (shared.activeEphemeralKey === key) {
				shared.activeEphemeralKey = undefined;
			}
			// Keep key in `preservedEphemeralKeys` until cleanup succeeds so a
			// retiring worker releasing its lock later still triggers deletion.
			shared.preservedEphemeralKeys.add(key);
		}
		purgePreservedEphemeralKeys(shared.activeEphemeralKey);
	};

	const disposeBorderBadge = () => {
		closeActivePanel?.();
		closeActivePanel = undefined;
		borderBadge?.dispose();
		borderBadge = undefined;
	};

	const disposeWorkerSync = (preserveEphemeralForReload = false) => {
		clearPendingUiAndTimers();
		disposeBorderBadge();
		const active = worker;
		worker = undefined;
		const shared = getSharedLifecycle();
		if (active && shared.active === active) {
			shared.active = undefined;
		}
		if (active) {
			if (preserveEphemeralForReload && active.ephemeral) {
				shared.preservedEphemeralKeys.add(active.storageKey);
			}
			active.dispose(true, { preserveEphemeralDir: preserveEphemeralForReload });
			if (!active.isCleanupCompleted()) {
				trackGlobalRetiringWorker(active);
			}
		}
		if (!preserveEphemeralForReload) {
			purgeCurrentPreservedEphemeralDir();
		}
		disposeAllGlobalWorkersSync(preserveEphemeralForReload);
		updateRelayStatusBar(currentCtx, undefined);
	};

	const disposeWorkerAsync = async (options?: { preserveEphemeralDir?: boolean }) => {
		const preserve = Boolean(options?.preserveEphemeralDir);
		if (!preserve) {
			sessionStartSeq += 1;
		}
		clearPendingUiAndTimers();
		const old = worker;
		worker = undefined;
		const shared = getSharedLifecycle();
		if (old && shared.active === old) {
			shared.active = undefined;
		}
		const prevDisposal = retiringDisposalPromise;
		const currentDisposal = (async () => {
			if (prevDisposal) {
				await prevDisposal.catch(() => undefined);
			}
			if (old) {
				if (preserve && old.ephemeral) {
					currentPreservedEphemeralKey = old.storageKey;
					shared.activeEphemeralKey = old.storageKey;
					shared.preservedEphemeralKeys.add(old.storageKey);
					attachGlobalSignalHandlers();
				}
				trackGlobalRetiringWorker(old);
				await old.disposeAsync({ preserveEphemeralDir: preserve });
			}
			if (!preserve) {
				if (currentSessionId) {
					shared.ephemeralTokens.delete(currentSessionId);
					shared.sessionStateFallback.delete(currentSessionId);
					shared.unsafeLegacyLeafIdsBySession.delete(currentSessionId);
				}
				shared.activeEphemeralKey = undefined;
				purgeCurrentPreservedEphemeralDir();
			}
			maybeDetachGlobalSignalHandlers();
		})();
		retiringDisposalPromise = currentDisposal;
		try {
			await currentDisposal;
		} finally {
			if (retiringDisposalPromise === currentDisposal) {
				retiringDisposalPromise = undefined;
			}
		}
		updateRelayStatusBar(currentCtx, undefined);
	};

	const activateSessionRelay = async (
		ctx: ExtensionContext,
		expectedSessionSeq: number,
		expectedToggleSeq: number,
		persistEntry: boolean,
	): Promise<boolean> => {
		if (!ctx.hasUI || ctx.mode !== "tui") return false;
		// Wait for any in-flight worker teardown before acquiring locks or changing tools.
		if (retiringDisposalPromise) {
			await retiringDisposalPromise.catch(() => undefined);
		}
		if (expectedSessionSeq !== sessionStartSeq || expectedToggleSeq !== toggleSeq) {
			return false;
		}

		// Expose relay tools as `direct` (Pi >= 1.5 activates newly exposed tools
		// via refreshTools while respecting --tools/--exclude-tools and preserving
		// pending MCP tools and disabled unrelated tools; Pi 0.85.1 activates them
		// via setActiveTools below).
		setExposurePreservingNonRelayTools("direct");
		const activeTools = pi.getActiveTools();
		const missingRelayTools = [...RELAY_TOOL_NAMES].filter((name) => !activeTools.includes(name));
		if (missingRelayTools.length > 0) {
			pi.setActiveTools([...activeTools, ...missingRelayTools]);
		}
		const effectiveActive = new Set(pi.getActiveTools());
		const blockedRelayTools = [...RELAY_TOOL_NAMES].filter((name) => !effectiveActive.has(name));
		if (blockedRelayTools.length > 0) {
			activeInSession = false;
			currentConfig = undefined;
			milestones = [];
			hideRelayTools();
			borderBadge?.sync();
			ctx.ui.notify(
				`Relay mode stayed inactive because required tools are excluded (${blockedRelayTools.join(", ")}).`,
				"warning",
			);
			return false;
		}

		try {
			const config = loadRelayConfig();
			const sessionId = ctx.sessionManager.getSessionId() || `pid-${process.pid}`;
			const sessionFile = ctx.sessionManager.getSessionFile();
			const ephemeral = !sessionFile;
			const shared = getSharedLifecycle();
			if (ephemeral) {
				if (!currentEphemeralToken) {
					currentEphemeralToken = shared.ephemeralTokens.get(sessionId) ?? randomUUID().slice(0, 8);
				}
				shared.ephemeralTokens.set(sessionId, currentEphemeralToken);
			}
			const storageKey = buildWorkerSessionKey(sessionId, sessionFile, currentEphemeralToken);
			const legacyWindowsKey = !ephemeral ? buildLegacyWindowsWorkerSessionKey(sessionId, sessionFile) : undefined;
			const inheritModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const inheritThinking = pi.getThinkingLevel?.() ?? "off";
			const projectTrusted = getProjectTrusted(ctx);
			const availableModels: ModelDescriptor[] = (ctx.modelRegistry?.getAll?.() ?? []).map((m) => ({
				provider: m.provider,
				id: m.id,
				authenticated: ctx.modelRegistry?.hasConfiguredAuth?.(m) ?? true,
			}));

			const verifyApiKeyForProvider = async (provider: string, _apiKey: string): Promise<boolean> => {
				try {
					return ctx.modelRegistry?.getProviderAuthStatus?.(provider)?.source === "runtime";
				} catch {
					return false;
				}
			};

			const instance = new RelayWorkerManager(
				sessionId,
				storageKey,
				ctx.cwd,
				LAUNCH_CWD,
				config,
				inheritModel,
				inheritThinking,
				projectTrusted,
				ephemeral,
				{
					onWakeup: (message) => sendWakeup(message),
					onStateChange: () => {
						if (worker === instance) {
							updateRelayStatusBar(currentCtx, instance.getSnapshot());
						}
					},
				},
				ctx.model?.provider,
				ctx.model?.id,
				availableModels,
				verifyApiKeyForProvider,
				legacyWindowsKey,
				sessionFile,
			);

			// Reclaiming a preserved ephemeral worker directory if the user toggled
			// relay mode off and back on (or reloaded) within the same `--no-session` run.
			if (ephemeral) {
				shared.activeEphemeralKey = storageKey;
			}
			if (currentPreservedEphemeralKey === storageKey) {
				currentPreservedEphemeralKey = undefined;
				shared.preservedEphemeralKeys.delete(storageKey);
			}

			currentConfig = config;
			milestones = buildReminderMilestones(config.remindIntervalPercent);
			if (config.warning) {
				ctx.ui.notify(config.warning, "warning");
			}
			activeInSession = true;
			pendingResumeNotice = undefined;
			firedMilestones.clear();
			worker = instance;
			shared.active = instance;
			attachGlobalSignalHandlers();
			if (persistEntry) {
				tryAppendSessionState(true, true);
			}
			updateRelayStatusBar(ctx, instance.getSnapshot());
			borderBadge?.sync();
			void instance.start();

			if (instance.isResumedSession) {
				pendingResumeNotice =
					`[Relay mode resumed] Your symbiotic background worker (session ${instance.getSnapshot().sessionId}) ` +
					`is warming up in idle standby from the previous session. Use relay_status to check its state or relay_send to continue work.`;
			}
			return true;
		} catch (error) {
			// Roll back tools and session state cleanly so failed activation never
			// leaves relay_* tools active without a backing worker.
			activeInSession = false;
			currentConfig = undefined;
			milestones = [];
			hideRelayTools();
			borderBadge?.sync();
			ctx.ui.notify(
				`Failed to activate relay mode: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}
	};

	const openRelayModePanel = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || ctx.mode !== "tui" || panelOpen) return;
		const openToken = ++panelOpenSeq;
		activePanelToken = openToken;
		panelOpen = true;
		borderBadge?.sync();
		let defaultEnabled = loadRelayPreferences().defaultEnabled;
		let panelTui: { requestRender(): void } | undefined;

		const buildPanel = (
			theme: Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">,
			rows: () => number,
			close: () => void,
			matches?: (data: string, action: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel") => boolean,
		) =>
			new RelayModePanel({
				theme,
				rows,
				matches,
				getSessionEnabled: () => activeInSession,
				getDefaultEnabled: () => defaultEnabled,
				isBusy: () => sessionToggleInFlight,
				onToggleSession: (next) => {
					// Relay mode is a one-way latch per session: once active, it stays
					// locked on to protect prompt cache stability and context continuity.
					const liveCtx = currentCtx;
					if (!liveCtx || sessionToggleInFlight || !next || activeInSession) return;
					const expectedSessionSeq = sessionStartSeq;
					const expectedToggleSeq = ++toggleSeq;
					sessionToggleInFlight = true;
					panelTui?.requestRender();
					void activateSessionRelay(liveCtx, expectedSessionSeq, expectedToggleSeq, true)
						.catch((error) => {
							currentCtx?.ui.notify(
								`Failed to enable relay mode: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						})
						.finally(() => {
							if (expectedToggleSeq === toggleSeq) {
								sessionToggleInFlight = false;
							}
							borderBadge?.sync();
							panelTui?.requestRender();
						});
				},
				onToggleDefault: (next) => {
					try {
						saveRelayPreferences({ defaultEnabled: next });
						defaultEnabled = next;
					} catch (error) {
						currentCtx?.ui.notify(
							t("relay.panel.saveFailed", {
								error: error instanceof Error ? error.message : String(error),
							}),
							"error",
						);
					}
					panelTui?.requestRender();
				},
				close,
			});

		const overlayOptions = {
			anchor: "center" as const,
			width: 68,
			maxHeight: "80%" as const,
			margin: { left: 1, right: 1 },
		};

		// Prefer direct TUI overlay handle (`handle.hide()`) so closing our panel
		// removes ONLY our overlay even if another extension (e.g. `list`) opened a
		// second overlay on top. If the border widget has not yet supplied a TUI,
		// probe synchronously via `setWidget` so legacy Pi 0.85.1 never falls back
		// to `ctx.ui.custom`'s stack-popping `done()`.
		let tui: TUI | undefined = borderBadge?.getTui();
		if (!tui) {
			try {
				const probeKey = "mpep-relay-mode-tui-probe";
				ctx.ui.setWidget(probeKey, (host) => {
					tui = host;
					return { render: () => [], invalidate() {} };
				});
				ctx.ui.setWidget(probeKey, undefined);
			} catch {
				// Ignore probe failures and fall through.
			}
		}

		if (tui) {
			const ownedTui = tui;
			panelTui = ownedTui;
			let overlay: OverlayHandle | undefined;
			let closed = false;
			const closeOverlay = () => {
				if (closed) return;
				closed = true;
				overlay?.hide();
				overlay = undefined;
				if (activePanelToken === openToken) {
					if (closeActivePanel === closeOverlay) closeActivePanel = undefined;
					panelOpen = false;
					panelTui = undefined;
					borderBadge?.sync();
				}
				ownedTui.requestRender();
			};
			closeActivePanel = closeOverlay;
			try {
				const panel = buildPanel(ctx.ui.theme, () => ownedTui.terminal.rows, closeOverlay);
				overlay = ownedTui.showOverlay(panel, overlayOptions);
			} catch (error) {
				closeOverlay();
				ctx.ui.notify(
					`Failed to open relay mode panel: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			return;
		}

		if (!runtimeCaps.supportsOverlayHandleDone) {
			// On Pi 0.85.1 without a direct TUI handle, avoid `ctx.ui.custom({ overlay: true })`
			// whose `done()` pops the global overlay stack top indiscriminately.
			if (activePanelToken === openToken) {
				panelOpen = false;
				panelTui = undefined;
				borderBadge?.sync();
			}
			return;
		}

		// Pi >= 1.5 fallback (where `done()` closes strictly by its own handle).
		let fallbackDone: (() => void) | undefined;
		let fallbackClosed = false;
		const cleanupFallbackState = () => {
			if (activePanelToken !== openToken) return;
			if (closeActivePanel === closeFallback) closeActivePanel = undefined;
			fallbackDone = undefined;
			panelOpen = false;
			const tuiToRender = panelTui;
			panelTui = undefined;
			borderBadge?.sync();
			tuiToRender?.requestRender();
		};
		const closeFallback = () => {
			if (fallbackClosed) return;
			fallbackClosed = true;
			const done = fallbackDone;
			fallbackDone = undefined;
			cleanupFallbackState();
			done?.();
		};
		closeActivePanel = closeFallback;
		try {
			await ctx.ui.custom<void>(
				(hostTui, theme, keys, done) => {
					panelTui = hostTui;
					fallbackDone = done;
					return buildPanel(
						theme,
						() => hostTui.terminal.rows,
						closeFallback,
						(data, action) => keys.matches(data, action),
					);
				},
				{
					overlay: true,
					overlayOptions,
				},
			);
		} finally {
			cleanupFallbackState();
		}
	};

	// Keyboard fallback (Alt+R) for non-fullscreen / mouse-disabled terminals
	// without registering any foreground slash commands.
	pi.registerShortcut("alt+r", {
		description: t("relay.panel.title"),
		handler: (ctx) => {
			currentCtx = ctx;
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			if (panelOpen) {
				closeActivePanel?.();
			} else {
				void openRelayModePanel(ctx);
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const seq = ++sessionStartSeq;
		const startReason = (event as { reason?: unknown } | undefined)?.reason;
		const isReloadStart = startReason === "reload";
		const prev = worker;
		clearPendingUiAndTimers();
		disposeBorderBadge();
		worker = undefined;
		const shared = getSharedLifecycle();
		if (prev && shared.active === prev) {
			shared.active = undefined;
		}
		updateRelayStatusBar(ctx, undefined);

		const incomingSessionId = ctx.sessionManager.getSessionId() || `pid-${process.pid}`;
		const incomingSessionFile = ctx.sessionManager.getSessionFile();
		const incomingEphemeral = !incomingSessionFile;
		const retainedEphemeralToken = incomingEphemeral
			? shared.ephemeralTokens.get(incomingSessionId)
			: undefined;
		const retainedEphemeralKey = retainedEphemeralToken
			? buildWorkerSessionKey(incomingSessionId, undefined, retainedEphemeralToken)
			: undefined;

		currentCtx = ctx;
		currentSessionId = incomingSessionId;
		activeInSession = false;
		currentConfig = undefined;
		milestones = [];
		firedMilestones.clear();
		compactionInFlight = false;
		treeNavInFlight = false;
		pendingResumeNotice = undefined;
		promptHookActiveForRun = false;
		sessionToggleInFlight = false;
		preservedPendingTools.clear();
		if (isReloadStart) {
			const carried = shared.preservedPendingToolsBySession.get(incomingSessionId);
			if (carried && carried.size > 0) {
				for (const name of carried) preservedPendingTools.add(name);
				transcriptLoadoutRestored = true;
			} else {
				transcriptLoadoutRestored = false;
			}
		} else {
			transcriptLoadoutRestored = false;
			shared.preservedPendingToolsBySession.clear();
		}
		currentEphemeralToken = retainedEphemeralToken;
		currentPreservedEphemeralKey = retainedEphemeralKey && shared.preservedEphemeralKeys.has(retainedEphemeralKey)
			? retainedEphemeralKey
			: undefined;
		shared.activeEphemeralKey = retainedEphemeralKey;
		// Remove stale ephemeral tokens from earlier sessions while keeping the
		// current session's token across same-session `/reload`.
		for (const sid of [...shared.ephemeralTokens.keys()]) {
			if (sid !== incomingSessionId || !incomingEphemeral) {
				shared.ephemeralTokens.delete(sid);
			}
		}
		for (const sid of [...shared.sessionStateFallback.keys()]) {
			if (sid !== incomingSessionId) {
				shared.sessionStateFallback.delete(sid);
			}
		}
		for (const sid of [...shared.unsafeLegacyLeafIdsBySession.keys()]) {
			if (sid !== incomingSessionId) {
				shared.unsafeLegacyLeafIdsBySession.delete(sid);
			}
		}

		// Wait for any prior worker teardown (from a prior session or toggle-off)
		// before cleaning stale ephemeral directories or starting a new worker.
		const pendingDisposal = retiringDisposalPromise;
		if (pendingDisposal) {
			await pendingDisposal.catch(() => undefined);
			if (seq !== sessionStartSeq) return;
		}
		if (prev) {
			trackGlobalRetiringWorker(prev);
			await prev.disposeAsync();
			if (seq !== sessionStartSeq) return;
		}
		purgePreservedEphemeralKeys(retainedEphemeralKey);
		maybeDetachGlobalSignalHandlers();

		if (!ctx.hasUI || ctx.mode !== "tui") {
			hideRelayTools();
			return;
		}

		borderBadge = createRelayBorderBadge(ctx, {
			isActive: () => activeInSession,
			isPanelOpen: () => panelOpen,
			onClick: () => {
				if (currentCtx) void openRelayModePanel(currentCtx);
			},
		});

		const sessionLookup = readSessionRelayState(
			ctx,
			incomingSessionId,
			runtimeCaps.hasSettleCredentialWrites,
		);
		const defaultEnabled = loadRelayPreferences().defaultEnabled;
		const shouldEnable = resolveInitialRelayEnabled(sessionLookup.value, defaultEnabled);

		if (!shouldEnable) {
			// Record the session's initial inherited state (or retry a previously
			// failed save once storage recovers) so changing the long-term default
			// later and running `/reload` never alters this open session.
			if (sessionLookup.needsPersistence) {
				tryAppendSessionState(false, true);
			}
			hideRelayTools();
			borderBadge?.sync();
			return;
		}

		const tSeq = ++toggleSeq;
		const activated = await activateSessionRelay(ctx, seq, tSeq, sessionLookup.needsPersistence);
		// Only record default-off when the session had NO explicit state yet;
		// preserve an explicit `enabled: true` fallback across temporary startup failures.
		if (!activated && sessionLookup.value === undefined && sessionLookup.needsPersistence && seq === sessionStartSeq) {
			tryAppendSessionState(false, true);
		}
	});

	pi.on("context", (event) => {
		if (!activeInSession) {
			// If a session previously recorded relay-mode reminders/notices and is later
			// opened without active relay mode (e.g. headless print/RPC or disabled),
			// strip stale relay directives so they do not misdirect the agent.
			const filtered = event.messages.filter((msg) => {
				const rec = msg as unknown as { role?: unknown; customType?: unknown };
				return !(rec.role === "custom" && (rec.customType === REMIND_TYPE || rec.customType === NOTICE_TYPE));
			});
			if (filtered.length !== event.messages.length) {
				return { messages: filtered };
			}
			return;
		}
		// Strip any legacy inline `<relay-mode-wakeup-policy>` blocks persisted by
		// older revisions before optionally appending the current request-only policy.
		let changed = false;
		const cleaned = event.messages.map((msg) => {
			const rec = msg as unknown as { role?: unknown; customType?: unknown; content?: unknown };
			if (rec.role !== "custom" || rec.customType !== NOTICE_TYPE || typeof rec.content !== "string") {
				return msg;
			}
			if (!LEGACY_WAKE_POLICY_RE.test(rec.content)) return msg;
			changed = true;
			return { ...msg, content: rec.content.replace(LEGACY_WAKE_POLICY_RE, "") } as typeof msg;
		});
		const baseMessages = changed ? cleaned : event.messages;

		// Inject a request-only policy message whenever `before_agent_start` did
		// not run with relay mode active (e.g. Pi 0.85.1 custom wakeups OR the user
		// enabled relay mode mid-turn), keeping persisted transcripts clean.
		if (!promptHookActiveForRun && currentConfig?.relayPrompt) {
			return {
				messages: [
					...baseMessages,
					{
						role: "custom",
						customType: NOTICE_TYPE,
						content: `<relay-mode-wakeup-policy>\n${currentConfig.relayPrompt}\n</relay-mode-wakeup-policy>`,
						display: false,
						timestamp: Date.now(),
					} as typeof event.messages[number],
				],
			};
		}
		if (changed) {
			return { messages: baseMessages };
		}
	});

	pi.on("before_agent_start", (event) => {
		reconcilePreservedPendingTools();
		if (!activeInSession || !currentConfig?.relayPrompt) {
			promptHookActiveForRun = false;
			return;
		}
		promptHookActiveForRun = true;
		const resumeNotice = pendingResumeNotice;
		pendingResumeNotice = undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${currentConfig.relayPrompt}`,
			...(resumeNotice ? {
				message: {
					customType: NOTICE_TYPE,
					content: resumeNotice,
					display: false,
				},
			} : {}),
		};
	});

	// Reset only at the logical run settlement boundary (`agent_settled`), NOT
	// on inner `agent_end`, because retries / continuations reuse the active
	// system prompt override without re-running `before_agent_start`.
	pi.on("agent_settled", () => {
		promptHookActiveForRun = false;
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		currentCtx = ctx;
		checkReminderMilestones(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		currentCtx = ctx;
		checkReminderMilestones(ctx);
	});

	pi.on("session_before_compact", () => {
		compactionInFlight = true;
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
	});

	const finishCompaction = (succeeded: boolean) => {
		compactionInFlight = false;
		if (succeeded) {
			firedMilestones.clear();
			sendPassiveReminder("Foreground context compaction just completed");
		}
		scheduleFlushHeldNotices();
	};

	pi.on("session_compact", () => finishCompaction(true));
	pi.on("session_compact_failed", () => finishCompaction(false));

	pi.on("session_before_tree", (event) => {
		treeNavInFlight = true;
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (treeNavSafetyTimer) {
			clearTimeout(treeNavSafetyTimer);
			treeNavSafetyTimer = undefined;
		}
		const release = () => {
			if (!treeNavInFlight) return;
			treeNavInFlight = false;
			if (treeNavSafetyTimer) {
				clearTimeout(treeNavSafetyTimer);
				treeNavSafetyTimer = undefined;
			}
			scheduleFlushHeldNotices();
		};
		const pollIdle = () => {
			treeNavSafetyTimer = undefined;
			if (!treeNavInFlight) return;
			if (currentCtx?.isIdle?.() === true) {
				release();
				return;
			}
			treeNavSafetyTimer = setTimeout(pollIdle, 2_000);
			treeNavSafetyTimer.unref?.();
		};
		event.signal?.addEventListener("abort", () => {
			if (!treeNavInFlight) return;
			if (treeNavSafetyTimer) clearTimeout(treeNavSafetyTimer);
			treeNavSafetyTimer = setTimeout(pollIdle, 100);
			treeNavSafetyTimer.unref?.();
		}, { once: true });
		treeNavSafetyTimer = setTimeout(pollIdle, 2_000);
		treeNavSafetyTimer.unref?.();
	});

	pi.on("session_tree", () => {
		treeNavInFlight = false;
		if (treeNavSafetyTimer) {
			clearTimeout(treeNavSafetyTimer);
			treeNavSafetyTimer = undefined;
		}
		// Pi's `navigateTree()` calls `_restoreToolsFromTranscript()`, replacing
		// any prior branch's pending loadout with the newly selected branch.
		preservedPendingTools.clear();
		if (currentSessionId) {
			getSharedLifecycle().preservedPendingToolsBySession.delete(currentSessionId);
		}
		transcriptLoadoutRestored = true;
		// Re-align `relay_*` tools immediately with this session's current relay state.
		syncRelayToolVisibility();
		scheduleFlushHeldNotices();
	});

	pi.on("input", () => {
		if (treeNavInFlight && currentCtx?.isIdle?.() === true) {
			treeNavInFlight = false;
			if (treeNavSafetyTimer) {
				clearTimeout(treeNavSafetyTimer);
				treeNavSafetyTimer = undefined;
			}
			scheduleFlushHeldNotices();
		}
	});

	pi.on("session_shutdown", async (event) => {
		const isReload = (event as { reason?: unknown } | undefined)?.reason === "reload";
		const sharedForShutdown = getSharedLifecycle();
		if (isReload && currentSessionId && preservedPendingTools.size > 0) {
			sharedForShutdown.preservedPendingToolsBySession.set(
				currentSessionId,
				new Set(preservedPendingTools),
			);
		} else if (!isReload) {
			sharedForShutdown.preservedPendingToolsBySession.clear();
		}
		preservedPendingTools.clear();
		transcriptLoadoutRestored = false;
		activeInSession = false;
		disposeBorderBadge();
		await disposeWorkerAsync({ preserveEphemeralDir: isReload });
		currentCtx = undefined;
	});

	installations[SLOT] = () => {
		// Called when `/reload` installs a fresh extension instance; preserve any
		// same-session `--no-session` ephemeral dir so the reloaded instance can
		// reclaim it (and purge it on switch/exit if the session changed).
		activeInSession = false;
		disposeWorkerSync(true);
		currentCtx = undefined;
		if (installations[SLOT] !== undefined) delete installations[SLOT];
	};
}
