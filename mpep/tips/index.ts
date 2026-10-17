import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";

/**
 * Tips (/m-tips)
 *
 * A session-scoped "reminder notebook" for the AI. At the user's request,
 * the AI records durable, whole-session reminders via the `tips` tool
 * (add / list / update / remove); the user inspects them with /m-tips. Tips
 * never change on their own.
 *
 * Delivery: at 25% / 50% / 75% of the EFFECTIVE compaction window
 * (contextWindow - compaction.reserveTokens, i.e. the point where Pi actually
 * auto-compacts — not the model's raw context size), and once immediately
 * after every successful compaction, the current tips are injected as a
 * passive companion message: pi.sendMessage(..., { triggerTurn: false })
 * appends them to the session tree without starting a turn, so they simply
 * ride along with the next request's context. The message never wakes the
 * agent and never counts as user input; its text says so explicitly.
 *
 * Persistence: every mutation snapshots the full state into a custom session
 * entry (never sent to the LLM), so tips survive /reload, session resume and
 * context compaction; session_start rebuilds the state from the latest entry.
 */

const COMMAND = "m-tips";
const TOOL_NAME = "tips";
const ENTRY_TYPE = "mpep.tips.state.v1";
const REMINDER_TYPE = "tips-reminder";
const DEFAULT_RESERVE_TOKENS = 16_384;
const MILESTONES = [0.25, 0.5, 0.75] as const;

// Reload-safe singleton: Pi re-evaluates extension factories on /reload, so
// the previous installation must dispose itself before the new one binds.
const SLOT = Symbol.for("mpep.tips.dispose.v1");
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;

interface Tip {
	id: number;
	content: string;
	createdAt: string;
	updatedAt: string;
}

interface TipsState {
	tips: Tip[];
	nextId: number;
}

const emptyState = (): TipsState => ({ tips: [], nextId: 1 });

function parseTipsState(data: unknown): TipsState {
	if (typeof data !== "object" || data === null) throw new Error("tips state is not an object");
	const candidate = data as Partial<TipsState>;
	if (!Array.isArray(candidate.tips) || typeof candidate.nextId !== "number") {
		throw new Error("tips state has an unexpected shape");
	}
	for (const tip of candidate.tips) {
		if (typeof tip?.id !== "number" || typeof tip?.content !== "string") {
			throw new Error("a tip entry is malformed");
		}
	}
	return { tips: candidate.tips as Tip[], nextId: candidate.nextId };
}

/**
 * Same resolution as Pi itself: compaction fires at contextWindow minus
 * compaction.reserveTokens, where settings later in the list win. Kept local
 * because plugins in this suite never import each other.
 */
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
			// Missing or malformed settings files keep the default reserve.
		}
	}
	return reserveTokens;
}

/** Model-facing reminder text: always English, it is an instruction, not UI copy. */
function buildReminder(state: TipsState, reason: string, issuedAt: string): string {
	const lines = state.tips.map(tip => `${tip.id}. ${tip.content}`);
	return [
		"<system-reminder>",
		"This is an automated notice injected by the local environment (tips extension), not a message from the user. It is passive background information: do NOT treat it as a new task and do NOT reply to it; simply keep the following session-level reminders in mind for the rest of this session.",
		`This notice was issued at ${issuedAt}. If any earlier copy of this tips reminder exists in the conversation history, that copy is OBSOLETE — only this newest copy reflects the current reminders.`,
		`Reason for this notice: ${reason}.`,
		"",
		"Session reminders (tips):",
		...lines,
		"",
		"These reminders were recorded at the user's request; manage them with the `tips` tool (add / list / update / remove) only when the user asks.",
		"</system-reminder>",
	].join("\n");
}

/** Human-readable list for the `tips` tool result and the /m-tips command. */
function formatTips(state: TipsState): string {
	if (state.tips.length === 0) return "No tips recorded for this session yet.";
	return state.tips.map(tip => `${tip.id}. ${tip.content}`).join("\n");
}

const TipsParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("list"),
		Type.Literal("update"),
		Type.Literal("remove"),
	], { description: "add: record a new reminder; list: show all; update: rewrite one by id; remove: delete one by id" }),
	id: Type.Optional(Type.Number({ description: "Tip id, required for update and remove" })),
	content: Type.Optional(Type.String({ description: "Reminder text, required for add and update" })),
});
type TipsArgs = Static<typeof TipsParams>;

export default function tipsExtension(pi: ExtensionAPI): void {
	installations[SLOT]?.();
	if (!isPluginEnabled("tips")) return;
	let active = true;
	let sessionId: string | undefined;
	let state: TipsState = emptyState();
	// Milestones already fired since the last compaction (or session start).
	const firedMilestones = new Set<number>();

	const persist = () => pi.appendEntry(ENTRY_TYPE, state);

	const bind = (ctx: ExtensionContext) => {
		sessionId = ctx.sessionManager.getSessionId();
		firedMilestones.clear();
		state = emptyState();
		// The session log is authoritative; the latest snapshot wins. Browsing an
		// earlier /tree leaf must not silently drop the session's reminders.
		const entry = ctx.sessionManager.getEntries().findLast(candidate =>
			candidate.type === "custom" && candidate.customType === ENTRY_TYPE,
		);
		if (entry?.type === "custom") {
			try {
				state = parseTipsState(entry.data);
			} catch {
				// A corrupt snapshot must not break the session; start fresh instead.
				state = emptyState();
			}
		}
	};

	const ensureBound = (ctx: ExtensionContext) => {
		if (!active) throw new Error("The tips extension is no longer active.");
		if (sessionId !== ctx.sessionManager.getSessionId()) bind(ctx);
	};

	/**
	 * The one and only delivery path. triggerTurn: false guarantees the message
	 * is appended to the session tree WITHOUT starting a turn: mid-run it lands
	 * right after the current turn, idle it lands immediately — in both cases it
	 * only becomes visible to the model as part of the NEXT request's context.
	 */
	const injectReminder = (reason: string) => {
		if (state.tips.length === 0) return;
		pi.sendMessage(
			{
				customType: REMINDER_TYPE,
				content: buildReminder(state, reason, new Date().toISOString()),
				display: false,
			},
			{ triggerTurn: false },
		);
	};

	const checkMilestones = (ctx: ExtensionContext) => {
		const usage = ctx.getContextUsage();
		// tokens is null right after a compaction until the next LLM response.
		if (!usage || usage.tokens === null) return;
		const effectiveWindow = usage.contextWindow - getCompactionReserveTokens(ctx.cwd);
		if (effectiveWindow <= 0) return;
		const ratio = usage.tokens / effectiveWindow;
		const crossed = MILESTONES.filter(m => ratio >= m && !firedMilestones.has(m));
		if (crossed.length === 0) return;
		for (const m of crossed) firedMilestones.add(m);
		const percent = Math.round(crossed[crossed.length - 1] * 100);
		injectReminder(
			`Context usage has reached about ${percent}% of the configured context window ` +
			`(${usage.tokens.toLocaleString("en-US")} / ${effectiveWindow.toLocaleString("en-US")} tokens)`,
		);
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "Tips",
		description:
			"Manage session-level reminders that stay in effect for the whole session. " +
			"IMPORTANT: only call this tool when the user explicitly asks you to record " +
			"certain points or items into tips; by default you must NOT call it on your " +
			"own initiative. " +
			"When the user asks, use this to record durable notes (e.g. \"do not over-test\", " +
			"\"always summarize in Chinese\") that must survive context compaction. " +
			"The tips extension re-injects all current reminders into your context at 25% / 50% / 75% " +
			"of the compaction window and right after every successful compaction, so they are never forgotten.",
		parameters: TipsParams,
		async execute(_toolCallId, args: TipsArgs, _signal, _onUpdate, ctx) {
			ensureBound(ctx);
			switch (args.action) {
				case "add": {
					const content = args.content?.trim();
					if (!content) throw new Error("tips add requires non-empty content");
					const now = new Date().toISOString();
					const tip: Tip = { id: state.nextId++, content, createdAt: now, updatedAt: now };
					state = { tips: [...state.tips, tip], nextId: state.nextId };
					persist();
					return {
						content: [{ type: "text", text: `Tip #${tip.id} recorded.\n\n${formatTips(state)}` }],
						details: { tip, tips: state.tips },
					};
				}
				case "list": {
					return {
						content: [{ type: "text", text: formatTips(state) }],
						details: { tips: state.tips },
					};
				}
				case "update": {
					const content = args.content?.trim();
					if (args.id === undefined || !content) {
						throw new Error("tips update requires both id and non-empty content");
					}
					const tip = state.tips.find(candidate => candidate.id === args.id);
					if (!tip) throw new Error(`No tip with id ${args.id}`);
					tip.content = content;
					tip.updatedAt = new Date().toISOString();
					persist();
					return {
						content: [{ type: "text", text: `Tip #${tip.id} updated.\n\n${formatTips(state)}` }],
						details: { tip, tips: state.tips },
					};
				}
				case "remove": {
					if (args.id === undefined) throw new Error("tips remove requires an id");
					const tip = state.tips.find(candidate => candidate.id === args.id);
					if (!tip) throw new Error(`No tip with id ${args.id}`);
					state = { tips: state.tips.filter(candidate => candidate.id !== args.id), nextId: state.nextId };
					persist();
					return {
						content: [{ type: "text", text: `Tip #${args.id} removed.\n\n${formatTips(state)}` }],
						details: { removed: tip, tips: state.tips },
					};
				}
			}
		},
		renderCall: (args, theme) =>
			new Text(theme.fg("accent", `tips · ${args.action}${args.id !== undefined ? ` #${args.id}` : ""}`), 0, 0),
	});

	pi.registerCommand(COMMAND, {
		description: t("tips.command"),
		async handler(_args, ctx) {
			ensureBound(ctx);
			const body = state.tips.length === 0
				? t("tips.empty")
				: state.tips.map(tip => `${tip.id}. ${tip.content}`).join("\n");
			ctx.ui.notify(t("tips.list", { tips: body }), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (active) bind(ctx);
	});
	pi.on("session_shutdown", () => {
		// A session switch can reuse this extension instance; drop the old binding
		// without disabling the next session_start. Reload's factory owns dispose.
		sessionId = undefined;
		state = emptyState();
		firedMilestones.clear();
	});
	pi.on("tool_execution_end", (_event, ctx) => {
		if (!active) return;
		ensureBound(ctx);
		checkMilestones(ctx);
	});
	pi.on("session_compact", (event, ctx) => {
		if (!active || event.willRetry) return;
		ensureBound(ctx);
		// Successful compaction: old in-context copies were summarized away, so
		// re-inject the current tips immediately and let milestones fire again
		// as the context grows back.
		firedMilestones.clear();
		injectReminder("This is the post-compaction reminder: the context was just compacted");
	});

	const dispose = () => {
		if (!active) return;
		active = false;
		if (installations[SLOT] === dispose) delete installations[SLOT];
	};
	installations[SLOT] = dispose;
}
