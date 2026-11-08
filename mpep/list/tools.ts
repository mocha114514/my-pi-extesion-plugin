import { randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { t } from "../shared/i18n/index.ts";
import { formatList, type ListReadView } from "./format.ts";
import {
	appendItems,
	blockedBy,
	completeItem,
	createList,
	isComplete,
	updateItem,
	type ListState,
} from "./model.ts";
import type { ListStore } from "./store.ts";

const itemSchema = Type.Object({
	id: Type.String({ description: "Stable item identifier, such as 1.2 or 2.1; not renumbered on completion." }),
	title: Type.String({ description: "Short, non-empty item title." }),
	description: Type.Optional(Type.String({ description: "Full explanatory text below this item; paragraphs are allowed." })),
	dependsOn: Type.Optional(Type.Array(Type.String(), {
		description: "Explicit prerequisite item IDs. Every prerequisite must be done before this item can be completed.",
	})),
}, { additionalProperties: false });

const writeSchema = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("append"),
		Type.Literal("update"),
		Type.Literal("complete"),
	]),
	title: Type.Optional(Type.String({ description: "List title for create, or replacement item title for update." })),
	goal: Type.Optional(Type.String({
		minLength: 1,
		description: [
			"Required for create; the overall goal is fixed for the lifetime of this checklist. Paragraphs are allowed.",
			"Because this goal cannot be edited after creation, write it carefully, completely and accurately.",
			"Create the checklist and write its goal only after all necessary discussion and clarification are complete,",
			"the user has confirmed the overall objective and key requirements, and explicitly authorized work to begin.",
			"Discussion, comparison of options, or agreement with an idea is not by itself authorization to start work.",
			"If questions that could affect the goal remain unresolved, ask the user and do not create the checklist yet.",
			"Before creating the checklist and starting execution, record the overall task, core requirements, expected outcomes,",
			"scope and boundaries, constraints, acceptance criteria, and completion or convergence conditions",
			"already discussed and confirmed with the user.",
			"Write a thorough, precise, self-contained account of the global goal, standards, and execution guidance,",
			"not detailed subtasks, procedural steps, or progress notes; put those in items.",
			"Do not merely repeat the title, enumerate the items, refer to earlier discussion without restating its requirements,",
			"or present unconfirmed assumptions as agreed requirements.",
			"This field preserves the original confirmed objective across repeated context compactions,",
			"preventing ambiguity, omissions, distortion, and drift into local problems or intermediate results.",
			"Revisit it when recovering context, advancing work, and deciding whether the whole task is finished,",
			"rather than relying only on the current item or recent conversation.",
			"Later explicit user-confirmed changes take precedence over this original record; never infer or silently redefine the overall goal.",
		].join(" "),
	})),
	items: Type.Optional(Type.Array(itemSchema, {
		minItems: 1,
		description: "Ordered new items, required for create and append. Creation always starts with unfinished items.",
	})),
	itemId: Type.Optional(Type.String({ description: "Existing item ID, required for update and complete." })),
	description: Type.Optional(Type.String({ description: "Replacement item description for update." })),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Replacement prerequisite IDs for update." })),
}, { additionalProperties: false });

const historySchema = Type.Object({}, { additionalProperties: false });

const readSchema = Type.Object({
	listNumber: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: Number.MAX_SAFE_INTEGER,
		description: "Session checklist number, distinct from task IDs. Omit to read the current checklist. Use list_history to find historical numbers; numbered reads use the same modes and never change the current checklist.",
	})),
	mode: Type.Optional(Type.Union([
		Type.Literal("overview"),
		Type.Literal("items"),
		Type.Literal("full"),
	], {
		default: "overview",
		description: "overview (default) omits item descriptions; items reads selected tasks in full; full reads the entire checklist.",
	})),
	ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		description: "Required only for mode=items. Exact task IDs to read with complete descriptions; unknown IDs cause an error.",
	})),
}, { additionalProperties: false });

interface ListToolDetails {
	list?: ListState;
	listNumber?: number;
	historical?: boolean;
}

interface ListHistoryDetails {
	history: ReturnType<ListStore["history"]>;
	currentNumber?: number;
}

function renderResult(
	result: AgentToolResult<ListToolDetails>,
	expanded: boolean,
	theme: Theme,
	failed: boolean,
): Text {
	const state = result.details?.list;
	const text = expanded || failed
		? result.content.filter(part => part.type === "text").map(part => part.text).join("\n")
		: state ? t("list.progress", {
			done: state.items.filter(item => item.done).length,
			total: state.items.length,
		}) : t("list.empty");
	return new Text(theme.fg(failed ? "error" : "dim", text), 0, 0);
}

function validateWriteArguments(params: Static<typeof writeSchema>): void {
	const fields: Record<typeof params.action, readonly string[]> = {
		create: ["action", "title", "goal", "items"],
		append: ["action", "items"],
		update: ["action", "itemId", "title", "description", "dependsOn"],
		complete: ["action", "itemId"],
	};
	for (const key of Object.keys(params)) {
		if (!fields[params.action].includes(key)) {
			throw new Error(`${params.action} does not accept ${key}. No changes were made.`);
		}
	}
	if (params.action === "update" && params.title === undefined && params.description === undefined && params.dependsOn === undefined) {
		throw new Error("update requires at least one of title, description or dependsOn.");
	}
}

function getReadView(params: Static<typeof readSchema>): ListReadView {
	const mode = params.mode ?? "overview";
	if (mode === "items") {
		if (!params.ids?.length) throw new Error("items mode requires a non-empty ids array.");
		return { mode, ids: params.ids };
	}
	if (params.ids !== undefined) throw new Error("ids is only supported with mode=items.");
	return { mode };
}

function requireList(store: ListStore): ListState {
	const state = store.read();
	if (!state) throw new Error("No checklist exists. Use list_write with action=create first.");
	return state;
}

function summary(state: ListState): string {
	const done = state.items.filter(item => item.done).length;
	const completion = new Map(state.items.map(item => [item.id, item.done] as const));
	const ready = state.items.filter(item => !item.done && blockedBy(state, item, completion).length === 0);
	return [
		`Checklist ${state.id}, revision ${state.revision}: ${done}/${state.items.length} completed.`,
		ready.length > 0 ? `Ready items: ${ready.map(item => item.id).join(", ")}.` : "No unblocked unfinished items.",
		"The overall goal, completed items and descriptions are retained. Use list_read for an overview, or mode=full to inspect the complete checklist.",
	].join("\n");
}

/** Tool text is for the model; the transcript stays compact unless expanded. */
export function registerListTools(
	pi: ExtensionAPI,
	getStore: (ctx: ExtensionContext) => ListStore,
): void {
	pi.registerTool<typeof writeSchema, ListToolDetails>({
		name: "list_write",
		label: "List Write",
		description: [
			"Maintain a persistent, ordered checklist with explanatory descriptions and explicit prerequisite IDs.",
			"create requires title, goal and items; append requires items;",
			"update requires itemId and changed title/description/dependsOn; complete requires itemId.",
			"Every new checklist needs a self-contained, user-confirmed overall goal; it remains fixed until the checklist is replaced.",
			"Only mark an item complete after its actual work and all prerequisites are finished.",
			"All updates are atomic. Invalid/missing/cyclic dependencies are rejected. An unfinished checklist cannot be replaced.",
			"Writes always target the current checklist. Replaced completed checklists remain read-only history, accessible through list_history and list_read.",
		].join(" "),
		promptSnippet: "Create and update a persistent checklist anchored to a confirmed overall goal, with descriptions and enforced dependencies.",
		promptGuidelines: [
			"For multi-step work, complete necessary discussion and clarification, confirm the overall task and key requirements " +
				"with the user, and obtain explicit authorization to begin work before creating the checklist or starting execution. " +
				"Only then create an ordered checklist with a carefully written, complete, accurate and self-contained goal; " +
				"put detailed tasks in items and specify dependencies explicitly.",
			"Discussion, option comparison, or agreement with an idea alone is not authorization to begin work. " +
				"If goal-affecting questions remain unresolved, ask the user and do not create the checklist yet.",
			"After context compaction, revisit the overall goal and use list_read for the live checklist; " +
				"do not let a local problem or an old snapshot redefine the task.",
			"Mark items complete only after their actual work is done. Before completing the final item, " +
				"verify the overall outcome against the goal's acceptance criteria and completion conditions, " +
				"accounting for later explicit user-confirmed changes.",
			"Numeric dotted IDs are displayed in hierarchical order; other IDs keep their positions.",
			"Numbering and display order do not imply dependencies. Fill dependsOn explicitly.",
			"Keep each checklist focused on its confirmed overall goal and within a reasonable, manageable size; " +
				"do not append items endlessly to a single checklist. When every item of the current checklist is " +
				"complete and the user raises a new request whose task is clearly distinct from that finished " +
				"checklist's goal, leave the completed checklist behind and create a fresh checklist with its own " +
				"confirmed goal instead of extending the old one.",
		],
		parameters: writeSchema,
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Checklist update cancelled.");
			validateWriteArguments(params);
			const store = getStore(ctx);
			let next: ListState;
			switch (params.action) {
				case "create": {
					const previous = store.read();
					if (previous && !isComplete(previous)) {
						throw new Error("Finish the existing checklist before creating another one.");
					}
					if (
						params.title === undefined ||
						params.goal === undefined ||
						params.items === undefined
					) {
						throw new Error("create requires title, goal and items.");
					}
					next = createList(randomUUID(), params.title, params.goal, params.items);
					break;
				}
				case "append":
					if (params.items === undefined) throw new Error("append requires items.");
					next = appendItems(requireList(store), params.items);
					break;
				case "update":
					if (params.itemId === undefined) throw new Error("update requires itemId.");
					next = updateItem(requireList(store), params.itemId, {
						title: params.title,
						description: params.description,
						dependsOn: params.dependsOn,
					});
					break;
				case "complete":
					if (params.itemId === undefined) throw new Error("complete requires itemId.");
					next = completeItem(requireList(store), params.itemId);
					break;
			}
			store.commit(next);
			return {
				content: [{ type: "text", text: summary(next) }],
				details: { list: next },
			};
		},
		renderCall: (args, theme) => new Text(theme.fg("accent", `list · ${args.action}`), 0, 0),
		renderResult: (result, options, theme, context) => renderResult(result, options.expanded, theme, context.isError),
	});

	pi.registerTool<typeof readSchema, ListToolDetails>({
		name: "list_read",
		label: "List Read",
		description: [
			"Read the current checklist in three modes. With no arguments, mode defaults to overview.",
			"Optional listNumber selects a session checklist by number; use list_history to discover historical numbers.",
			"Historical checklists are read-only references, not active tasks. Numbered reads never change the current checklist.",
			"overview returns the title, complete overall goal and all task IDs, titles, completion states,",
			"dependencies and blocking IDs, but omits item descriptions.",
			"items requires ids and returns only those tasks with their full descriptions, in checklist display order;",
			"the overall goal is omitted in this mode. Unknown IDs cause an error.",
			"full returns the entire checklist, including the overall goal, every completed task and every description.",
			"State survives context compaction. Legacy checklists explicitly report a missing goal in overview/full.",
			"Revisit the goal to recover the global task and standards; never infer live state solely from an older snapshot.",
		].join(" "),
		promptSnippet: "Read a checklist overview by default, selected full tasks by ID, or the entire checklist with mode=full.",
		promptGuidelines: [
			"Start with list_read overview to recover the complete goal and current task status without all descriptions. " +
				"Use mode=items with ids to read the full descriptions of tasks you will act on; " +
				"use mode=full when every task's details are needed.",
			"For earlier work, first use list_history, then pass its listNumber to list_read with any read mode. " +
				"Omit listNumber to return to the current checklist; historical reads never redirect list_write.",
		],
		parameters: readSchema,
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Checklist read cancelled.");
			const view = getReadView(params);
			const store = getStore(ctx);
			const state = store.read(params.listNumber);
			const listNumber = state ? params.listNumber ?? store.count : undefined;
			const historical = listNumber !== undefined && listNumber !== store.count;
			// Preserve parameterless output exactly. Explicit selections identify
			// historical work before its text, so it cannot be mistaken for live work.
			const selection = params.listNumber === undefined ? ""
				: `Checklist #${listNumber} (${historical ? "historical, read-only; not the current checklist" : "current"}).\n`;
			return {
				// Only the chosen view belongs in model-visible content; details serve the UI.
				content: [{ type: "text", text: state ? selection + formatList(state, view) : "No checklist exists yet." }],
				details: { list: state, listNumber, historical },
			};
		},
		renderCall: (args, theme) => new Text(theme.fg("accent",
			args.listNumber === undefined ? "list · read" : `list · read #${args.listNumber}`,
		), 0, 0),
		renderResult: (result, options, theme, context) => renderResult(result, options.expanded, theme, context.isError),
	});

	pi.registerTool<typeof historySchema, ListHistoryDetails>({
		name: "list_history",
		label: "List History",
		description: [
			"List all historical checklist numbers and titles in this session, oldest first, without their goals or task bodies.",
			"Numbers start at 1 in creation order and remain stable across updates and session resume.",
			"The latest checklist remains current, even when completed; it enters read-only history when a new checklist replaces it.",
			"Pass a returned listNumber to list_read with overview, items, or full to inspect that checklist.",
			"This query never changes the current checklist or writes to the session.",
		].join(" "),
		promptSnippet: "Discover historical checklist numbers and titles before reading earlier work with list_read.",
		parameters: historySchema,
		executionMode: "sequential",
		async execute(_id, _params, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Checklist history query cancelled.");
			const store = getStore(ctx);
			const history = store.history();
			const currentNumber = store.count || undefined;
			const lines = currentNumber === undefined
				? ["No checklist exists yet."]
				: [
					`Current checklist: #${currentNumber} (not archived).`,
					...(history.length ? [
						"Historical checklists (oldest first, read-only):",
						...history.map(entry => `- listNumber: ${entry.listNumber}; title: ${JSON.stringify(entry.title)}`),
						"Use list_read with listNumber and the desired mode to read an entry.",
					] : ["No historical checklists exist yet."]),
				];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { history, currentNumber },
			};
		},
		renderCall: (_args, theme) => new Text(theme.fg("accent", "list · history"), 0, 0),
		renderResult: (result, options, theme, context) => new Text(
			theme.fg(context.isError ? "error" : "dim", options.expanded || context.isError
				? result.content.filter(part => part.type === "text").map(part => part.text).join("\n")
				: `list · history (${result.details?.history.length ?? 0})`),
			0,
			0,
		),
	});
}
