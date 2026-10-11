import { readFile } from "node:fs/promises";
import {
	parseTree,
	type Node,
	type ParseError,
} from "jsonc-parser";

/** Only enabled provider/model IDs survive parsing; no credentials are retained. */
export interface ModelFlagRules {
	readonly providers: ReadonlySet<string>;
	enabled(provider: string, modelId: string): boolean;
}

export interface ModelFlagReader {
	load(path: string): Promise<ModelFlagRules>;
	parse(text: string): ModelFlagRules;
	empty(): ModelFlagRules;
}

/**
 * Read a single boolean feature flag without interpreting API/auth metadata.
 * Explicit modelOverrides win over models[], including false. Missing is off.
 * Readers are independent: an unrelated feature's value cannot enable or break
 * this one. Fixed diagnostic labels must be supplied by code, never documents.
 */
export function createModelFlagReader(
	flag: string,
	description = "model feature rules",
): ModelFlagReader {
	const invalidJson = `Invalid ${description}: invalid JSON.`;
	const malformedStructure = `Invalid ${description}: malformed structure.`;
	const nonBooleanFlag = `Invalid ${description}: ${flag} must be a boolean.`;
	const ambiguousRules =
		`Invalid ${description}: ambiguous duplicate model rules.`;
	const unreadableFile = `Unable to read ${description}.`;

	interface Field {
		name: string;
		value: Node;
	}

	/** Agreed boolean, or `conflict` when duplicate contributions disagree. */
	interface Vote {
		value: boolean;
		conflict: boolean;
	}

	/**
	 * Explicit override vote. `value === undefined` means the override object
	 * exists but has no `flag` field, so it must not clobber the model entry.
	 */
	interface OverrideVote {
		value: boolean | undefined;
		conflict: boolean;
	}

	/**
	 * Load rules from `path`. A missing file is an empty rule set. Any other
	 * read failure throws a fixed message so the original error cannot leak
	 * file contents or a raw credential.
	 */
	async function load(path: string): Promise<ModelFlagRules> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch (error) {
			if (isNotFound(error)) return emptyRules();
			fail(unreadableFile);
		}
		return parse(text);
	}

	/** Parse one JSONC document. Exported so tests can avoid touching disk. */
	function parse(text: string): ModelFlagRules {
		const root = lastFields(parseDocument(text));
		const providersNode = root.get("providers");
		if (providersNode === undefined) return emptyRules();
		if (providersNode.type !== "object") fail(malformedStructure);

		const enabled = new Map<string, ReadonlySet<string>>();
		// Duplicate object keys follow JSON.parse last-key-wins, which is how Pi
		// loads models.json. Shadowed provider blocks must not enable the feature.
		for (const [provider, node] of lastFields(providersNode)) {
			const ids = enabledModels(node);
			if (ids.size > 0) enabled.set(provider, ids);
		}
		return rulesFrom(enabled);
	}

	function emptyRules(): ModelFlagRules {
		return rulesFrom(new Map());
	}

	function rulesFrom(
		enabled: ReadonlyMap<string, ReadonlySet<string>>,
	): ModelFlagRules {
		const providers = new Set<string>();
		const models = new Map<string, ReadonlySet<string>>();
		for (const [provider, ids] of enabled) {
			if (ids.size === 0) continue;
			providers.add(provider);
			models.set(provider, ids);
		}
		return Object.freeze({
			providers,
			enabled(provider: string, modelId: string): boolean {
				return models.get(provider)?.has(modelId) === true;
			},
		});
	}

	function parseDocument(text: string): Node {
		const errors: ParseError[] = [];
		// Pi's stripJsonComments removes // comments and trailing commas, then
		// JSON.parse runs. Accept those commas here; block comments are JSONC too.
		const tree = parseTree(stripLeadingBom(text), errors, {
			allowTrailingComma: true,
		});
		if (!tree || errors.length > 0) fail(invalidJson);
		if (tree.type !== "object") fail(malformedStructure);
		return tree;
	}

	function stripLeadingBom(text: string): string {
		return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	}

	function enabledModels(providerNode: Node): Set<string> {
		if (providerNode.type !== "object") fail(malformedStructure);
		const fields = lastFields(providerNode);
		const models = new Map<string, Vote>();
		const overrides = new Map<string, OverrideVote>();
		const modelNode = fields.get("models");
		const overrideNode = fields.get("modelOverrides");
		if (modelNode !== undefined) readModels(modelNode, models);
		if (overrideNode !== undefined) readOverrides(overrideNode, overrides);
		return resolveEnabled(models, overrides);
	}

	function readModels(node: Node, votes: Map<string, Vote>): void {
		if (node.type !== "array") fail(malformedStructure);
		for (const item of node.children ?? []) {
			if (item.type !== "object") fail(malformedStructure);
			const fields = properties(item);
			voteModel(votes, requireModelId(modelId(fields)), explicitFlag(fields) ?? false);
		}
	}

	function readOverrides(node: Node, votes: Map<string, OverrideVote>): void {
		if (node.type !== "object") fail(malformedStructure);
		for (const field of properties(node)) {
			if (field.value.type !== "object") fail(malformedStructure);
			voteOverride(
				votes,
				requireModelId(field.name),
				explicitFlag(properties(field.value)),
			);
		}
	}

	/**
	 * Model-array duplicates stay visible (JSON.parse does not collapse them).
	 * They error only when no explicit override resolves the disagreement.
	 * Duplicate override keys error when their explicit `flag` values disagree.
	 */
	function resolveEnabled(
		models: ReadonlyMap<string, Vote>,
		overrides: ReadonlyMap<string, OverrideVote>,
	): Set<string> {
		const enabled = new Set<string>();
		const ids = new Set<string>([...models.keys(), ...overrides.keys()]);
		for (const id of ids) {
			const override = overrides.get(id);
			if (override?.conflict) fail(ambiguousRules);
			const model = models.get(id);
			const explicit = override?.value;
			if (explicit === undefined && model?.conflict) fail(ambiguousRules);
			const value = explicit ?? model?.value ?? false;
			if (value === true) enabled.add(id);
		}
		return enabled;
	}

	function voteModel(votes: Map<string, Vote>, id: string, value: boolean): void {
		const current = votes.get(id);
		if (!current) {
			votes.set(id, { value, conflict: false });
			return;
		}
		if (current.value !== value) current.conflict = true;
	}

	function voteOverride(
		votes: Map<string, OverrideVote>,
		id: string,
		value: boolean | undefined,
	): void {
		const current = votes.get(id);
		if (!current) {
			votes.set(id, { value, conflict: false });
			return;
		}
		if (current.value !== value) current.conflict = true;
	}

	function modelId(fields: readonly Field[]): string | undefined {
		let id: string | undefined;
		let seen = false;
		for (const field of fields) {
			if (field.name !== "id") continue;
			const literal = field.value.value;
			if (field.value.type !== "string" || typeof literal !== "string") {
				fail(malformedStructure);
			}
			if (seen && id !== literal) fail(malformedStructure);
			seen = true;
			id = literal;
		}
		return seen ? id : undefined;
	}

	function requireModelId(id: string | undefined): string {
		if (id === undefined || id.length === 0) fail(malformedStructure);
		return id;
	}

	function explicitFlag(fields: readonly Field[]): boolean | undefined {
		let seen = false;
		let value = false;
		for (const field of fields) {
			if (field.name !== flag) continue;
			const literal = field.value.value;
			if (field.value.type !== "boolean" || typeof literal !== "boolean") {
				fail(nonBooleanFlag);
			}
			if (seen && value !== literal) fail(ambiguousRules);
			seen = true;
			value = literal;
		}
		return seen ? value : undefined;
	}

	/** Last assignment wins, matching `JSON.parse` object-key semantics. */
	function lastFields(node: Node): Map<string, Node> {
		const fields = new Map<string, Node>();
		for (const field of properties(node)) fields.set(field.name, field.value);
		return fields;
	}

	function properties(node: Node): Field[] {
		if (node.type !== "object") fail(malformedStructure);
		const fields: Field[] = [];
		for (const child of node.children ?? []) {
			const key = child.children?.[0];
			const value = child.children?.[1];
			if (
				child.type !== "property" ||
				child.children?.length !== 2 ||
				!key ||
				key.type !== "string" ||
				typeof key.value !== "string" ||
				!value
			) {
				fail(malformedStructure);
			}
			fields.push({ name: key.value, value });
		}
		return fields;
	}

	function isNotFound(error: unknown): boolean {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		);
	}

	function fail(message: string): never {
		throw new Error(message);
	}

	return Object.freeze({ load, parse, empty: emptyRules });
}
