/** Immutable session snapshots shared by the AI tool and the management panel. */
export interface Tip {
	id: number;
	content: string;
	createdAt: string;
	updatedAt: string;
	source: "template" | "session";
}

export interface TipsState {
	version: 2;
	tips: Tip[];
	nextId: number;
	selectedTemplate: string | null;
	/** Old snapshots have no provenance; never guess which entries were seeds. */
	legacy: boolean;
}

export const emptyState = (): TipsState => ({
	version: 2,
	tips: [],
	nextId: 1,
	selectedTemplate: null,
	legacy: false,
});

export function parseTipsState(data: unknown): TipsState {
	if (typeof data !== "object" || data === null) throw new Error("Invalid tips snapshot");
	const candidate = data as Partial<TipsState>;
	if (!Array.isArray(candidate.tips) || !Number.isSafeInteger(candidate.nextId) || candidate.nextId! < 1) {
		throw new Error("Invalid tips snapshot shape");
	}
	const legacy = candidate.version !== 2;
	if (!legacy && (
		(candidate.selectedTemplate !== null && typeof candidate.selectedTemplate !== "string") ||
		typeof candidate.legacy !== "boolean"
	)) throw new Error("Invalid tips template metadata");
	const ids = new Set<number>();
	const tips = candidate.tips.map((tip): Tip => {
		if (!Number.isSafeInteger(tip?.id) || tip.id < 1 || ids.has(tip.id) || typeof tip.content !== "string") {
			throw new Error("Invalid tip entry");
		}
		if (!legacy && tip.source !== "template" && tip.source !== "session") {
			throw new Error("Invalid tip source");
		}
		ids.add(tip.id);
		return {
			id: tip.id,
			content: tip.content,
			createdAt: typeof tip.createdAt === "string" ? tip.createdAt : "",
			updatedAt: typeof tip.updatedAt === "string" ? tip.updatedAt : "",
			source: legacy ? "session" : tip.source,
		};
	});
	return {
		version: 2,
		tips,
		nextId: Math.max(candidate.nextId!, ...tips.map(tip => tip.id + 1)),
		selectedTemplate: legacy ? null : candidate.selectedTemplate!,
		legacy: legacy || candidate.legacy === true,
	};
}

function normalizeContent(content: string): string {
	const result = content.trim();
	if (!result) throw new Error("Tip content must not be empty");
	return result;
}

function editableTip(state: TipsState, id: number): Tip {
	const tip = state.tips.find(item => item.id === id);
	if (!tip) throw new Error(`No tip with id ${id}`);
	if (tip.source === "template") {
		throw new Error(`Tip #${id} is read-only: imported from ${state.selectedTemplate}. Use /m-tips to switch templates.`);
	}
	return tip;
}

export function addTip(state: TipsState, content: string): TipsState {
	const now = new Date().toISOString();
	const tip: Tip = {
		id: state.nextId,
		content: normalizeContent(content),
		createdAt: now,
		updatedAt: now,
		source: "session",
	};
	return { ...state, tips: [...state.tips, tip], nextId: state.nextId + 1 };
}

export function updateTip(state: TipsState, id: number, content: string): TipsState {
	const previous = editableTip(state, id);
	const tip = { ...previous, content: normalizeContent(content), updatedAt: new Date().toISOString() };
	return { ...state, tips: state.tips.map(item => item.id === id ? tip : item) };
}

export function removeTip(state: TipsState, id: number): TipsState {
	editableTip(state, id);
	return { ...state, tips: state.tips.filter(item => item.id !== id) };
}

/** Replacing the template never renumbers, edits, or drops session-owned tips. */
export function applyTemplate(state: TipsState, filename: string, contents: string[]): TipsState {
	const now = new Date().toISOString();
	const tips: Tip[] = contents.map((content, index) => ({
		id: state.nextId + index,
		content,
		createdAt: now,
		updatedAt: now,
		source: "template",
	}));
	return {
		...state,
		tips: [...tips, ...state.tips.filter(tip => tip.source === "session")],
		nextId: state.nextId + tips.length,
		selectedTemplate: filename,
		legacy: false,
	};
}
