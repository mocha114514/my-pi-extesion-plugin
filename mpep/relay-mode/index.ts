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
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { registerSigintCleanup } from "../shared/sigint.ts";
import { buildReminderMilestones, loadRelayConfig, type RelayConfig } from "./config.ts";
import { buildLegacyWindowsWorkerSessionKey, buildWorkerSessionKey } from "./paths.ts";
import { registerRelayTools } from "./tools.ts";
import { updateRelayStatusBar } from "./widget.ts";
import {
	detectPiRuntimeCapabilities,
	isSamePath,
	RELAY_COMPACT_PREFIX,
	RELAY_TRUSTED_CWD_ENV,
	RELAY_WORKER_ENV,
	RelayWorkerManager,
	type ModelDescriptor,
} from "./worker.ts";

const LAUNCH_CWD = process.cwd();
const SLOT = Symbol.for("mpep.relay-mode.dispose.v1");
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;
const COMPACT_PENDING_SLOT = Symbol.for("mpep.compact-forewarn.pending");
const DEFAULT_RESERVE_TOKENS = 16_384;
const REMIND_TYPE = "mpep-relay-remind";
const NOTICE_TYPE = "mpep-relay-notice";
const RELAY_TOOL_NAMES = new Set(["relay_send", "relay_status", "relay_control", "relay_approval"]);

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
		const trustedCwd = process.env[RELAY_TRUSTED_CWD_ENV]?.trim();
		if (trustedCwd) {
			// Scope inherited foreground project trust strictly to the exact
			// foreground cwd rather than using a process-wide `--approve`, so
			// switching sessions into an untrusted directory inside the worker
			// still honors that destination's trust decision.
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
	const retiringWorkers = new Set<RelayWorkerManager>();
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

	const runtimeCaps = detectPiRuntimeCapabilities();
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

	let exitHookAttached = false;
	let unregisterSigint: (() => void) | undefined;
	const onExitSync = () => {
		disposeWorkerSync();
	};
	const attachSignalHandlers = () => {
		if (exitHookAttached) return;
		exitHookAttached = true;
		process.on("exit", onExitSync);
		unregisterSigint = registerSigintCleanup(disposeWorkerSync);
	};
	const detachSignalHandlers = () => {
		if (!exitHookAttached) return;
		exitHookAttached = false;
		process.off("exit", onExitSync);
		unregisterSigint?.();
		unregisterSigint = undefined;
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

	const maybeDetachSignalHandlers = () => {
		if (!worker && retiringWorkers.size === 0) {
			detachSignalHandlers();
		}
	};

	const trackRetiringWorker = (old: RelayWorkerManager) => {
		if (old.isCleanupCompleted()) {
			maybeDetachSignalHandlers();
			return;
		}
		retiringWorkers.add(old);
		old.onCleanupComplete(() => {
			retiringWorkers.delete(old);
			maybeDetachSignalHandlers();
		});
	};

	const disposeWorkerSync = () => {
		clearPendingUiAndTimers();
		detachSignalHandlers();
		const active = worker;
		worker = undefined;
		const targets = new Set<RelayWorkerManager>(retiringWorkers);
		if (active) targets.add(active);
		retiringWorkers.clear();
		for (const target of targets) {
			target.dispose(true);
		}
		updateRelayStatusBar(currentCtx, undefined);
	};

	const disposeWorkerAsync = async () => {
		sessionStartSeq += 1;
		clearPendingUiAndTimers();
		const old = worker;
		worker = undefined;
		if (old) {
			trackRetiringWorker(old);
			await old.disposeAsync();
		}
		maybeDetachSignalHandlers();
		updateRelayStatusBar(currentCtx, undefined);
	};

	registerRelayTools(pi, {
		isActive: () => activeInSession,
		getWorker: () => worker,
	});

	pi.on("session_start", async (_event, ctx) => {
		const seq = ++sessionStartSeq;
		const prev = worker;
		clearPendingUiAndTimers();
		worker = undefined;
		updateRelayStatusBar(ctx, undefined);

		currentCtx = ctx;
		firedMilestones.clear();
		compactionInFlight = false;
		treeNavInFlight = false;

		if (prev) {
			trackRetiringWorker(prev);
			await prev.disposeAsync();
			if (seq !== sessionStartSeq) return;
		}
		maybeDetachSignalHandlers();

		if (!ctx.hasUI || ctx.mode !== "tui") {
			activeInSession = false;
			currentConfig = undefined;
			milestones = [];
			// Hide relay tools from headless/print sessions.
			const filtered = pi.getActiveTools().filter((name) => !RELAY_TOOL_NAMES.has(name));
			if (filtered.length !== pi.getActiveTools().length) {
				pi.setActiveTools(filtered);
			}
			return;
		}

		activeInSession = true;
		pendingResumeNotice = undefined;
		promptHookActiveForRun = false;
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
			ctx.ui.notify(
				`Relay mode stayed inactive because required tools are excluded (${blockedRelayTools.join(", ")}).`,
				"warning",
			);
			return;
		}

		const config = loadRelayConfig();
		currentConfig = config;
		milestones = buildReminderMilestones(config.remindIntervalPercent);
		if (config.warning) {
			ctx.ui.notify(config.warning, "warning");
		}

		const sessionId = ctx.sessionManager.getSessionId() || `pid-${process.pid}`;
		const sessionFile = ctx.sessionManager.getSessionFile();
		const ephemeral = !sessionFile;
		const storageKey = buildWorkerSessionKey(sessionId, sessionFile, randomUUID().slice(0, 8));
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
		worker = instance;
		attachSignalHandlers();
		updateRelayStatusBar(ctx, instance.getSnapshot());
		void instance.start();

		if (instance.isResumedSession) {
			pendingResumeNotice =
				`[Relay mode resumed] Your symbiotic background worker (session ${instance.getSnapshot().sessionId}) ` +
				`is warming up in idle standby from the previous session. Use relay_status to check its state or relay_send to continue work.`;
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

		// On Pi 0.85.1, idle custom-message wake-up runs skip `before_agent_start`
		// and clear prior system-prompt overrides at `agent_settled`. Inject a
		// request-only policy message for any run where `before_agent_start` did not
		// execute, keeping persisted transcripts and compaction free of duplicated copies.
		if (!runtimeCaps.runsBeforeAgentStartOnCustomWakeup && !promptHookActiveForRun && currentConfig?.relayPrompt) {
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

	pi.on("session_shutdown", async () => {
		activeInSession = false;
		await disposeWorkerAsync();
		currentCtx = undefined;
	});

	installations[SLOT] = () => {
		activeInSession = false;
		disposeWorkerSync();
		currentCtx = undefined;
		if (installations[SLOT] !== undefined) delete installations[SLOT];
	};
}
