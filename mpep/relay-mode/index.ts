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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { buildReminderMilestones, loadRelayConfig, type RelayConfig } from "./config.ts";
import { registerRelayTools } from "./tools.ts";
import { updateRelayStatusBar } from "./widget.ts";
import { RELAY_WORKER_ENV, RelayWorkerManager } from "./worker.ts";

const SLOT = Symbol.for("mpep.relay-mode.dispose.v1");
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;
const COMPACT_PENDING_SLOT = Symbol.for("mpep.compact-forewarn.pending");
const DEFAULT_RESERVE_TOKENS = 16_384;
const REMIND_TYPE = "mpep-relay-remind";
const NOTICE_TYPE = "mpep-relay-notice";
const RELAY_TOOL_NAMES = new Set(["relay_send", "relay_status", "relay_control", "relay_approval"]);

function getCompactionReserveTokens(cwd?: string): number {
	const paths = [
		join(getAgentDir(), "settings.json"),
		cwd ? join(cwd, ".pi", "settings.json") : null,
	].filter((p): p is string => Boolean(p));

	let reserveTokens = DEFAULT_RESERVE_TOKENS;
	for (const settingsPath of paths) {
		try {
			const content = readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
			const parsed = JSON.parse(content);
			const reserve = parsed?.compaction?.reserveTokens;
			if (typeof reserve === "number" && reserve >= 0) {
				reserveTokens = reserve;
			}
		} catch {
			// Missing or invalid settings keep the default reserve.
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
	if (process.env[RELAY_WORKER_ENV] === "1") return;
	if (!isPluginEnabled("relay-mode")) return;
	installations[SLOT]?.();

	let activeInSession = false;
	let currentCtx: ExtensionContext | undefined;
	let currentConfig: RelayConfig | undefined;
	let worker: RelayWorkerManager | undefined;
	let milestones: number[] = [];
	const firedMilestones = new Set<number>();
	let pendingResumeNotice: string | undefined;
	let hasSeenPromptInSession = false;

	// Defer triggerTurn notices while compaction is running to avoid starting a turn mid-compaction.
	let compactionInFlight = false;
	const compactionHeldNotices: string[] = [];
	let compactionFlushTimer: ReturnType<typeof setTimeout> | undefined;

	const sendWakeup = (rawContent: string) => {
		if (!activeInSession) return;
		// Pi 0.85.1's sendMessage({ triggerTurn: true }) skips before_agent_start when idle.
		// If a startup failure wakes the foreground before any user prompt has run, attach a
		// concise relay role prefix so the foreground agent knows its role and relay tools.
		const content = !hasSeenPromptInSession && currentConfig?.relayPrompt
			? `[Relay Mode active — you are the user-facing relay/translator paired with a symbiotic background worker. Use relay_status / relay_control / relay_send / relay_approval, and explain clearly to the user.]\n\n${rawContent}`
			: rawContent;
		if (compactionInFlight) {
			compactionHeldNotices.push(content);
			return;
		}
		if ((globalThis as unknown as Record<symbol, unknown>)[COMPACT_PENDING_SLOT]) {
			try {
				pi.sendMessage(
					{ customType: NOTICE_TYPE, display: false, content },
					{ triggerTurn: false },
				);
			} catch {
				// Ignore invalidated context during shutdown.
			}
			return;
		}
		try {
			pi.sendMessage(
				{ customType: NOTICE_TYPE, display: false, content },
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

		const reserveTokens = getCompactionReserveTokens(ctx.cwd);
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

	const disposeWorker = (sync: boolean) => {
		if (compactionFlushTimer) {
			clearTimeout(compactionFlushTimer);
			compactionFlushTimer = undefined;
		}
		compactionHeldNotices.length = 0;
		const old = worker;
		worker = undefined;
		old?.dispose(sync);
		updateRelayStatusBar(currentCtx, undefined);
	};

	registerRelayTools(pi, {
		isActive: () => activeInSession,
		getWorker: () => worker,
	});

	pi.on("session_start", (_event, ctx) => {
		disposeWorker(false);
		currentCtx = ctx;
		firedMilestones.clear();
		compactionInFlight = false;

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
		hasSeenPromptInSession = false;
		const activeTools = pi.getActiveTools();
		const missingRelayTools = [...RELAY_TOOL_NAMES].filter((name) => !activeTools.includes(name));
		if (missingRelayTools.length > 0) {
			pi.setActiveTools([...activeTools, ...missingRelayTools]);
		}

		const config = loadRelayConfig();
		currentConfig = config;
		milestones = buildReminderMilestones(config.remindIntervalPercent);
		if (config.warning) {
			ctx.ui.notify(config.warning, "warning");
		}

		const sessionId = ctx.sessionManager.getSessionId() || `pid-${process.pid}`;
		const ephemeral = !ctx.sessionManager.getSessionFile();
		const inheritModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const inheritThinking = pi.getThinkingLevel?.() ?? "off";

		const instance = new RelayWorkerManager(
			sessionId,
			ctx.cwd,
			config,
			inheritModel,
			inheritThinking,
			ephemeral,
			{
				onWakeup: (message) => sendWakeup(message),
				onStateChange: () => {
					if (worker === instance) {
						updateRelayStatusBar(currentCtx, instance.getSnapshot());
					}
				},
			},
		);
		worker = instance;
		updateRelayStatusBar(ctx, instance.getSnapshot());
		void instance.start();

		if (instance.isResumedSession) {
			pendingResumeNotice =
				`[Relay mode resumed] Your symbiotic background worker (session ${instance.getSnapshot().sessionId}) ` +
				`is warming up in idle standby from the previous session. Use relay_status to check its state or relay_send to continue work.`;
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!activeInSession || !currentConfig?.relayPrompt) return;
		hasSeenPromptInSession = true;
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
		if (compactionFlushTimer) {
			clearTimeout(compactionFlushTimer);
			compactionFlushTimer = undefined;
		}
	});

	const finishCompaction = (succeeded: boolean) => {
		compactionInFlight = false;
		if (succeeded) {
			firedMilestones.clear();
			sendPassiveReminder("Foreground context compaction just completed");
		}
		if (compactionFlushTimer) clearTimeout(compactionFlushTimer);
		compactionFlushTimer = setTimeout(() => {
			compactionFlushTimer = undefined;
			if (compactionInFlight) return;
			for (const notice of compactionHeldNotices.splice(0)) {
				sendWakeup(notice);
			}
		}, 1_000);
		compactionFlushTimer.unref?.();
	};

	pi.on("session_compact", () => finishCompaction(true));
	pi.on("session_compact_failed", () => finishCompaction(false));

	const killSync = () => {
		disposeWorker(true);
	};
	process.on("exit", killSync);
	const onSigint = () => {
		process.off("SIGINT", onSigint);
		killSync();
		process.kill(process.pid, "SIGINT");
	};
	const onSigterm = () => {
		process.off("SIGTERM", onSigterm);
		killSync();
		process.kill(process.pid, "SIGTERM");
	};
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	pi.on("session_shutdown", () => {
		activeInSession = false;
		disposeWorker(true);
		currentCtx = undefined;
	});

	installations[SLOT] = () => {
		process.off("exit", killSync);
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		activeInSession = false;
		disposeWorker(true);
		currentCtx = undefined;
		if (installations[SLOT] !== undefined) delete installations[SLOT];
	};
}
