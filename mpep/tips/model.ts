/** Immutable session snapshots shared by the AI tool and the management panel. */
export interface Tip {
	id: number;
	content: string;
	createdAt: string;
	updatedAt: string;
	source: "template" | "session";
	/** Filename of the read-only source; absent for session-owned entries. */
	template?: string;
}

export interface TemplateSource {
	kind: "default" | "path" | "model";
	filename: string;
}

export interface LoadedTemplate extends TemplateSource {
	contents: string[];
}

export interface TipsState {
	version: 3;
	tips: Tip[];
	nextId: number;
	templates: TemplateSource[];
	/** Old snapshots have no provenance; never guess which entries were seeds. */
	legacy: boolean;
}

export const emptyState = (): TipsState => ({
	version: 3,
	tips: [],
	nextId: 1,
	templates: [],
	legacy: false,
});

export function parseTipsState(data: unknown): TipsState {
	if (typeof data !== "object" || data === null) throw new Error("Invalid tips snapshot");
	const candidate = data as Partial<Omit<TipsState, "version">> & {
		version?: number;
		selectedTemplate?: unknown;
	};
	if (!Array.isArray(candidate.tips) || !Number.isSafeInteger(candidate.nextId) || candidate.nextId! < 1) {
		throw new Error("Invalid tips snapshot shape");
	}
	const legacy = candidate.version !== 2 && candidate.version !== 3;
	let templates: TemplateSource[] = [];
	if (!legacy && typeof candidate.legacy !== "boolean") throw new Error("Invalid tips template metadata");
	if (candidate.version === 3) {
		if (!Array.isArray(candidate.templates)) throw new Error("Invalid tips templates");
		const kinds = new Set<string>();
		const filenames = new Set<string>();
		templates = candidate.templates.map(source => {
			if (!source || !["default", "path", "model"].includes(source.kind) ||
				typeof source.filename !== "string" || !source.filename ||
				kinds.has(source.kind) || filenames.has(source.filename)) {
				throw new Error("Invalid tips template source");
			}
			kinds.add(source.kind);
			filenames.add(source.filename);
			return { kind: source.kind, filename: source.filename };
		});
		if (kinds.has("default") && templates.length !== 1) throw new Error("Invalid tips fallback combination");
	} else if (candidate.version === 2) {
		if (candidate.selectedTemplate !== null && typeof candidate.selectedTemplate !== "string") {
			throw new Error("Invalid tips template metadata");
		}
		if (typeof candidate.selectedTemplate === "string") {
			const filename = candidate.selectedTemplate;
			// Old manual choices are restored only to recover provenance, then re-resolved.
			const kind = /^(?:tips|Tips)\.md$/.test(filename) ? "default" : "path";
			templates = [{ kind, filename }];
		}
	}
	const ids = new Set<number>();
	const tips = candidate.tips.map((tip): Tip => {
		if (!Number.isSafeInteger(tip?.id) || tip.id < 1 || ids.has(tip.id) || typeof tip.content !== "string") {
			throw new Error("Invalid tip entry");
		}
		if (!legacy && tip.source !== "template" && tip.source !== "session") throw new Error("Invalid tip source");
		const source = legacy ? "session" : tip.source;
		const template = source === "template"
			? candidate.version === 3 ? tip.template : templates[0]?.filename
			: undefined;
		if (source === "template" && !templates.some(item => item.filename === template)) {
			throw new Error("Invalid tip template provenance");
		}
		ids.add(tip.id);
		return {
			id: tip.id,
			content: tip.content,
			createdAt: typeof tip.createdAt === "string" ? tip.createdAt : "",
			updatedAt: typeof tip.updatedAt === "string" ? tip.updatedAt : "",
			source,
			...(template ? { template } : {}),
		};
	});
	return {
		version: 3,
		tips,
		nextId: Math.max(candidate.nextId!, ...tips.map(tip => tip.id + 1)),
		templates,
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
		throw new Error(`Tip #${id} is read-only: imported from ${tip.template}. Templates are selected automatically.`);
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

/** Replace automatic sources without renumbering session tips or unchanged templates. */
export function applyTemplates(state: TipsState, templates: LoadedTemplate[]): TipsState {
	const now = new Date().toISOString();
	let nextId = state.nextId;
	const tips: Tip[] = templates.flatMap(template => {
		const previous = state.tips.filter(tip => tip.source === "template" && tip.template === template.filename);
		if (previous.length === template.contents.length &&
			previous.every((tip, index) => tip.content === template.contents[index])) return previous;
		return template.contents.map(content => ({
			id: nextId++,
			content,
			createdAt: now,
			updatedAt: now,
			source: "template" as const,
			template: template.filename,
		}));
	});
	tips.push(...state.tips.filter(tip => tip.source === "session"));
	const sources = templates.map(({ kind, filename }) => ({ kind, filename }));
	if (tips.length === state.tips.length && tips.every((tip, index) => tip === state.tips[index]) &&
		sources.length === state.templates.length && sources.every((source, index) =>
			source.kind === state.templates[index].kind && source.filename === state.templates[index].filename)) return state;
	return { ...state, tips, nextId, templates: sources };
}
