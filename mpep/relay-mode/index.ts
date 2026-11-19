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
import type { OverlayHandle } from "@earendil-works/pi-tui";
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

interface SharedLifecycleState {
	active: RelayWorkerManager | undefined;
	retiring: Set<RelayWorkerManager>;
	preservedEphemeralKeys: Set<string>;
	ephemeralTokens: Map<string, string>;
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
			activeEphemeralKey: undefined,
			exitListener: undefined,
			unregisterSigint: undefined,
		};
		globals[RETIRING_SLOT] = state;
	} else {
		if (!state.preservedEphemeralKeys) state.preservedEphemeralKeys = new Set<string>();
		if (!state.ephemeralTokens) state.ephemeralTokens = new Map<string, string>();
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
		target.dispose(true);
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

function readSessionRelayState(ctx: ExtensionContext): boolean | undefined {
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
					return data.enabled;
				}
			}
		}
	} catch {
		// Fall back to long-term preference if session entries cannot be inspected.
	}
	return undefined;
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
		// Even while disabled, strip historical relay-mode reminders/notices from
		// replayed transcripts so they never direct a non-relay session.
		pi.on("context", (event) => {
			const filtered = event.messages.filter((msg) => {
				const rec = msg as unknown as { role?: unknown; customType?: unknown };
				return !(rec.role === "custom" && (rec.customType === REMIND_TYPE || rec.customType === NOTICE_TYPE));
			});
			if (filtered.length !== event.messages.length) {
				return { messages: filtered };
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
	let closeActivePanel: (() => void) | undefined;
	let sessionToggleInFlight = false;
	let toggleSeq = 0;
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

	const hideRelayTools = () => {
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
		const active = pi.getActiveTools();
		const missing = [...RELAY_TOOL_NAMES].filter((name) => !active.includes(name));
		if (missing.length > 0) {
			pi.setActiveTools([...active, ...missing]);
		}
	};

	const tryAppendSessionState = (enabled: boolean, notifyOnError: boolean) => {
		try {
			pi.appendEntry(SESSION_STATE_ENTRY, { enabled } satisfies SessionRelayStateEntry);
		} catch (error) {
			if (notifyOnError) {
				currentCtx?.ui.notify(
					t("relay.panel.saveFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
					"error",
				);
			}
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
			active.dispose(true);
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

	const deactivateSessionRelay = async (
		expectedSessionSeq: number,
		expectedToggleSeq: number,
		persistEntry: boolean,
	): Promise<void> => {
		activeInSession = false;
		currentConfig = undefined;
		milestones = [];
		firedMilestones.clear();
		pendingResumeNotice = undefined;
		// Keep `promptHookActiveForRun` intact until `agent_settled` so any mid-run
		// LLM requests know to emit a request-only deactivation override in `context`.
		hideRelayTools();
		if (persistEntry) {
			tryAppendSessionState(false, true);
		}
		borderBadge?.sync();
		await disposeWorkerAsync({ preserveEphemeralDir: true });
		if (expectedSessionSeq === sessionStartSeq && expectedToggleSeq === toggleSeq) {
			borderBadge?.sync();
		}
	};

	const openRelayModePanel = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || ctx.mode !== "tui" || panelOpen) return;
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
					const liveCtx = currentCtx;
					if (!liveCtx || sessionToggleInFlight || next === activeInSession) return;
					const expectedSessionSeq = sessionStartSeq;
					const expectedToggleSeq = ++toggleSeq;
					sessionToggleInFlight = true;
					panelTui?.requestRender();
					const task = next
						? activateSessionRelay(liveCtx, expectedSessionSeq, expectedToggleSeq, true)
						: deactivateSessionRelay(expectedSessionSeq, expectedToggleSeq, true);
					void task
						.catch((error) => {
							currentCtx?.ui.notify(
								`Failed to toggle relay mode: ${error instanceof Error ? error.message : String(error)}`,
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
		// second overlay on top (Pi 0.85.1's ctx.ui.custom `done()` pops stack top).
		const tui = borderBadge?.getTui();
		if (tui) {
			panelTui = tui;
			let overlay: OverlayHandle | undefined;
			let closed = false;
			const closeOverlay = () => {
				if (closed) return;
				closed = true;
				overlay?.hide();
				overlay = undefined;
				if (closeActivePanel === closeOverlay) closeActivePanel = undefined;
				panelOpen = false;
				panelTui = undefined;
				borderBadge?.sync();
				tui.requestRender();
			};
			closeActivePanel = closeOverlay;
			try {
				const panel = buildPanel(ctx.ui.theme, () => tui.terminal.rows, closeOverlay);
				overlay = tui.showOverlay(panel, overlayOptions);
			} catch (error) {
				closeOverlay();
				ctx.ui.notify(
					`Failed to open relay mode panel: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			return;
		}

		// Fallback when border widget has not captured a TUI instance yet.
		let fallbackDone: (() => void) | undefined;
		let fallbackHandle: OverlayHandle | undefined;
		const closeFallback = () => {
			if (fallbackHandle) {
				const h = fallbackHandle;
				fallbackHandle = undefined;
				h.hide();
			}
			fallbackDone?.();
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
						() => done(),
						(data, action) => keys.matches(data, action),
					);
				},
				{
					overlay: true,
					overlayOptions,
					onHandle: (handle) => {
						fallbackHandle = handle;
					},
				},
			);
		} finally {
			if (closeActivePanel === closeFallback) closeActivePanel = undefined;
			fallbackDone = undefined;
			fallbackHandle = undefined;
			panelOpen = false;
			panelTui = undefined;
			borderBadge?.sync();
		}
	};

	registerRelayTools(pi, {
		isActive: () => activeInSession,
		getWorker: () => worker,
	});

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

	pi.on("session_start", async (_event, ctx) => {
		const seq = ++sessionStartSeq;
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

		const sessionOverride = readSessionRelayState(ctx);
		const defaultEnabled = loadRelayPreferences().defaultEnabled;
		const shouldEnable = resolveInitialRelayEnabled(sessionOverride, defaultEnabled);

		if (!shouldEnable) {
			// Record the session's initial inherited state so changing the long-term
			// default later and running `/reload` never alters this open session.
			if (sessionOverride === undefined) {
				tryAppendSessionState(false, false);
			}
			hideRelayTools();
			borderBadge?.sync();
			return;
		}

		const tSeq = ++toggleSeq;
		const activated = await activateSessionRelay(ctx, seq, tSeq, sessionOverride === undefined);
		if (!activated && sessionOverride === undefined && seq === sessionStartSeq) {
			tryAppendSessionState(false, false);
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
			// If the user disabled relay mode mid-turn after `before_agent_start`
			// already appended `<relay-mode>` to the active systemPrompt, add a
			// request-only override so the model immediately stops calling relay_*
			// tools on remaining turns of this run.
			if (promptHookActiveForRun) {
				return {
					messages: [
						...filtered,
						{
							role: "custom",
							customType: NOTICE_TYPE,
							content:
								"[Relay mode disabled] The user disabled relay mode during this run. " +
								"Do NOT call any relay_* tools; handle the user's request directly.",
							display: false,
							timestamp: Date.now(),
						} as typeof event.messages[number],
					],
				};
			}
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
		if (!activeInSession || !currentConfig?.relayPrompt) return;
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
		// Pi's `navigateTree()` runs `_restoreToolsFromTranscript()`, which can
		// re-expose or deactivate `relay_*` tools from an older branch. Re-align
		// them immediately with this session's current relay-mode state.
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
