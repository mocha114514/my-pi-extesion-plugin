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
import { getCacheDir } from "../shared/paths.ts";
import {
	addTip,
	applyTemplate,
	emptyState,
	parseTipsState,
	removeTip,
	updateTip,
	type TipsState,
} from "./model.ts";
import { openTipsPanel } from "./panel.ts";
import { listTemplates, readTemplate, selectInitialTemplate } from "./templates.ts";

/**
 * Session-level reminders, managed by the AI tool or the /m-tips panel.
 * Template entries are read-only; session entries are editable. Full immutable
 * snapshots (including provenance and the selected template) survive reload,
 * resume, and compaction without changing any user-authored Markdown files.
 *
 * Delivery is passive: updates, 25% / 50% / 75% compaction-window milestones,
 * and successful compaction send a reminder without triggering an agent turn.
 */

const COMMAND = "m-tips";
const TOOL_NAME = "tips";
// Keep the entry type stable so existing sessions remain discoverable; data is versioned separately.
const ENTRY_TYPE = "mpep.tips.state.v1";
const REMINDER_TYPE = "tips-reminder";
const DEFAULT_RESERVE_TOKENS = 16_384;
const MILESTONES = [0.25, 0.5, 0.75] as const;

// Reload-safe singleton: Pi re-evaluates extension factories on /reload, so
// the previous installation must dispose itself before the new one binds.
const SLOT = Symbol.for("mpep.tips.dispose.v1");
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;

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
	const lines = state.tips.length > 0
		? state.tips.map(tip => `${tip.id}. ${tip.source === "template" ? "[template, read-only] " : ""}${tip.content}`)
		: ["No tips remain in this session. All tips in earlier notices are withdrawn."];
	return [
		"<system-reminder>",
		"This is an automated notice injected by the local environment (tips extension), not a message from the user. It is passive background information: do NOT treat it as a new task and do NOT reply to it; simply keep the following session-level reminders in mind for the rest of this session.",
		`This notice was issued at ${issuedAt}. If any earlier copy of this tips reminder exists in the conversation history, that copy is OBSOLETE — only this newest copy reflects the current reminders.`,
		`Reason for this notice: ${reason}.`,
		"",
		"Session reminders (tips):",
		...lines,
		"",
		"Manage session-owned reminders with the `tips` tool (add / list / update / remove) only when the user asks. Template reminders are read-only; the user can switch templates through /m-tips.",
		"</system-reminder>",
	].join("\n");
}

/** Include provenance so the model can choose editable IDs without guessing. */
function formatTips(state: TipsState): string {
	if (state.tips.length === 0) return "No tips recorded for this session yet.";
	return state.tips.map(tip =>
		`${tip.id}. [${tip.source === "template" ? `read-only: ${state.selectedTemplate}` : "session"}] ${tip.content}`,
	).join("\n");
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

	const templateDirectory = join(getCacheDir(), "tips");
	const persist = () => pi.appendEntry(ENTRY_TYPE, state);

	/** The latest session-wide snapshot wins, even when browsing an older tree leaf. */
	const bind = (ctx: ExtensionContext): boolean => {
		sessionId = ctx.sessionManager.getSessionId();
		firedMilestones.clear();
		state = emptyState();
		const entry = ctx.sessionManager.getEntries().findLast(candidate =>
			candidate.type === "custom" && candidate.customType === ENTRY_TYPE,
		);
		if (entry?.type === "custom") {
			try {
				state = parseTipsState(entry.data);
				// Freeze the migration once: legacy entries remain editable, never inferred seeds.
				if ((entry.data as { version?: number }).version !== 2) persist();
			} catch {
				state = emptyState();
				ctx.ui.notify(t("tips.restoreError"), "warning");
			}
			return false;
		}
		try {
			const selection = selectInitialTemplate(templateDirectory, ctx.cwd);
			for (const error of selection.errors) {
				ctx.ui.notify(t("tips.templateError", { error: `${error.filename}: ${error.message}` }), "warning");
			}
			if (selection.conflicts.length > 0) {
				ctx.ui.notify(t("tips.templateConflict", {
					directory: ctx.cwd,
					files: selection.conflicts.join(", "),
				}), "error");
			}
			const filename = selection.filename;
			if (filename) state = applyTemplate(state, filename, readTemplate(templateDirectory, filename));
		} catch (error) {
			ctx.ui.notify(t("tips.templateError", { error: String(error) }), "warning");
		}
		// Persist even an empty notebook, so reload cannot silently import new defaults.
		persist();
		return state.tips.length > 0;
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
	const injectReminder = (reason: string, includeEmpty = false) => {
		if (state.tips.length === 0 && !includeEmpty) return;
		pi.sendMessage(
			{
				customType: REMINDER_TYPE,
				content: buildReminder(state, reason, new Date().toISOString()),
				display: false,
			},
			{ triggerTurn: false },
		);
	};

	/** Do not publish a new in-memory state unless its durable snapshot was accepted. */
	const commit = (next: TipsState, reason: string) => {
		pi.appendEntry(ENTRY_TYPE, next);
		state = next;
		// An empty update must explicitly invalidate reminders already present in context.
		injectReminder(reason, true);
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
			"of the compaction window and right after every successful compaction, so they are never forgotten. " +
			"Template-imported tips are read-only: update/remove can only change session-owned tips. " +
			"The user can switch the current session's template or edit session tips via /m-tips.",
		parameters: TipsParams,
		async execute(_toolCallId, args: TipsArgs, _signal, _onUpdate, ctx) {
			ensureBound(ctx);
			switch (args.action) {
				case "add": {
					const next = addTip(state, args.content ?? "");
					const tip = next.tips[next.tips.length - 1];
					commit(next, "A session tip was added at the user's request");
					return {
						content: [{ type: "text", text: `Tip #${tip.id} recorded.\n\n${formatTips(state)}` }],
						details: { tip, tips: state.tips },
					};
				}
				case "list":
					return {
						content: [{ type: "text", text: formatTips(state) }],
						details: { tips: state.tips, selectedTemplate: state.selectedTemplate },
					};
				case "update": {
					if (args.id === undefined) throw new Error("tips update requires an id");
					commit(updateTip(state, args.id, args.content ?? ""), "A session tip was updated at the user's request");
					const tip = state.tips.find(candidate => candidate.id === args.id)!;
					return {
						content: [{ type: "text", text: `Tip #${tip.id} updated.\n\n${formatTips(state)}` }],
						details: { tip, tips: state.tips },
					};
				}
				case "remove": {
					if (args.id === undefined) throw new Error("tips remove requires an id");
					const tip = state.tips.find(candidate => candidate.id === args.id);
					commit(removeTip(state, args.id), "A session tip was removed at the user's request");
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
			if (!ctx.hasUI) {
				ctx.ui.notify(t("tips.uiRequired"), "warning");
				return;
			}
			const owner = sessionId;
			const isCurrent = () => active && sessionId === owner && ctx.sessionManager.getSessionId() === owner;
			const requireCurrent = () => {
				if (!isCurrent()) throw new Error("This tips panel belongs to an inactive session");
			};
			await openTipsPanel(ctx, {
				getState: () => state,
				isActive: isCurrent,
				listTemplates: () => listTemplates(templateDirectory),
				selectTemplate: filename => {
					requireCurrent();
					const contents = readTemplate(templateDirectory, filename);
					commit(applyTemplate(state, filename, contents), `The user selected the ${filename} tips template for this session`);
				},
				add: content => {
					requireCurrent();
					commit(addTip(state, content), "The user added a session tip through /m-tips");
				},
				update: (id, content) => {
					requireCurrent();
					commit(updateTip(state, id, content), "The user edited a session tip through /m-tips");
				},
				remove: id => {
					requireCurrent();
					commit(removeTip(state, id), "The user removed a session tip through /m-tips");
				},
			});
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (!active) return;
		// Seed tips only exist on a fresh session; inject them right away so the
		// model sees them from the first request instead of waiting for the
		// 25% context milestone.
		if (bind(ctx)) {
			injectReminder(`This is the session-start reminder: default tips were loaded from ${state.selectedTemplate}`);
		}
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
