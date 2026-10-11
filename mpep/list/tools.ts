import { randomUUID } from "node:crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { t } from "../shared/i18n/index.ts";
import { formatList } from "./format.ts";
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

const readSchema = Type.Object({}, { additionalProperties: false });

interface ListToolDetails {
	list?: ListState;
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
		"The overall goal, completed items and descriptions are retained. Use list_read to inspect the complete checklist.",
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
			"The overall goal, descriptions and completed items remain available until a completed checklist is replaced with a new one.",
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
			"Read the FULL current checklist, including its complete overall goal, every completed item,",
			"all description paragraphs, explicit dependencies and blocking IDs. State survives context compaction.",
			"Legacy checklists explicitly report that no overall goal was recorded.",
			"Revisit the goal to recover the global task and standards;",
			"never infer the live state solely from an older compaction snapshot.",
		].join(" "),
		promptSnippet: "Inspect the full checklist and its overall goal, including completed work and dependencies, even after compaction.",
		parameters: readSchema,
		executionMode: "sequential",
		async execute(_id, _params, signal, _update, ctx) {
			if (signal?.aborted) throw new Error("Checklist read cancelled.");
			const state = getStore(ctx).read();
			return {
				// Full text must be in content: details alone is not visible to the LLM.
				content: [{ type: "text", text: state ? formatList(state) : "No checklist exists yet." }],
				details: { list: state },
			};
		},
		renderCall: (_args, theme) => new Text(theme.fg("accent", "list · read"), 0, 0),
		renderResult: (result, options, theme, context) => renderResult(result, options.expanded, theme, context.isError),
	});
}
