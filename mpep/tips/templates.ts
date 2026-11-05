import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, parse } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { TemplateSource } from "./model.ts";

/** Only a leading, closed frontmatter block is metadata, never a reminder list. */
function parseDocument(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
	const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const lines = text.split("\n");
	if (lines[0].trimEnd() !== "---") return { frontmatter: {}, body: text };
	const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
	if (end < 0) throw new Error("Tips frontmatter is missing its closing --- delimiter");
	const { frontmatter } = parseFrontmatter(`---\n${lines.slice(1, end).join("\n")}\n---\n`);
	if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
		throw new Error("Tips frontmatter must be a YAML mapping");
	}
	return { frontmatter, body: lines.slice(end + 1).join("\n") };
}

/** Preserve the original flat, unordered-list format; exclude all metadata. */
export function parseTemplate(markdown: string): string[] {
	return parseDocument(markdown).body
		.split(/\r?\n/)
		.map(line => /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
		.filter(Boolean);
}

export function listTemplates(directory: string): string[] {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const names = entries.filter(entry => entry.isFile()).map(entry => entry.name);
	// On case-sensitive filesystems, the canonical name wins over the legacy alias.
	const defaultName = names.includes("tips.md") ? "tips.md" : names.includes("Tips.md") ? "Tips.md" : undefined;
	return [
		...(defaultName ? [defaultName] : []),
		...names.filter(name => /^(?:tips|Tips)-(path|model)-.+\.md$/.test(name)).sort((a, b) => a.localeCompare(b)),
	];
}

export function defaultTemplate(names: string[]): string | undefined {
	return names.find(name => name === "tips.md" || name === "Tips.md");
}

export interface TemplateSelection {
	templates: TemplateSource[];
	conflicts: { kind: "path" | "model"; target: string; filenames: string[] }[];
	errors: { filename: string; message: string }[];
}

/** Compare complete directory names, without resolving symlinks or walking parents. */
function directoryKey(value: string): string {
	if (!isAbsolute(value)) throw new Error(`Tips path must be an absolute directory: ${value}`);
	let key = normalize(value);
	const root = parse(key).root;
	// A rooted Windows path without a drive or UNC share is not fully qualified.
	if (process.platform === "win32" && root === "\\") {
		throw new Error(`Tips path must include a drive or UNC share: ${value}`);
	}
	if (key.length > root.length) {
		key = key.replace(process.platform === "win32" ? /[\\/]+$/ : /\/+$/, "");
	}
	return process.platform === "win32" ? key.toLowerCase() : key;
}

/** Resolve each category independently; ambiguous categories never load multiple files. */
export function selectTemplates(directory: string, cwd: string, model?: string): TemplateSelection {
	const names = listTemplates(directory);
	const fallback = defaultTemplate(names);
	const result: TemplateSelection = { templates: [], conflicts: [], errors: [] };
	const targets = { path: directoryKey(cwd), model };
	const matches: Record<"path" | "model", string[]> = { path: [], model: [] };
	for (const filename of names) {
		// The global default never participates in matching, regardless of metadata.
		if (filename === fallback) continue;
		const kind = /^(?:tips|Tips)-path-/.test(filename) ? "path" : "model";
		try {
			const { frontmatter } = parseDocument(readFileSync(join(directory, filename), "utf8"));
			const other = kind === "path" ? "model" : "path";
			if (frontmatter[other] !== undefined) {
				throw new Error(`A tips-${kind}-*.md template must not contain a ${other} field`);
			}
			const values = frontmatter[kind];
			if (!Array.isArray(values) || !values.every(value => typeof value === "string")) {
				throw new Error(`Tips frontmatter ${kind} must be a list of strings`);
			}
			const keys = kind === "path" ? values.map(value => directoryKey(value)) : values;
			if (kind === "model" && !keys.every(value => /^[^/\s]+\/\S+$/.test(value))) {
				throw new Error("Tips model must use provider/modelId without whitespace");
			}
			// Repeated values within one file still count as a single match.
			if (targets[kind] !== undefined && keys.includes(targets[kind])) matches[kind].push(filename);
		} catch (error) {
			result.errors.push({ filename, message: error instanceof Error ? error.message : String(error) });
		}
	}
	for (const kind of ["path", "model"] as const) {
		if (matches[kind].length === 1) result.templates.push({ kind, filename: matches[kind][0] });
		else if (matches[kind].length > 1) {
			result.conflicts.push({ kind, target: targets[kind]!, filenames: matches[kind] });
		}
	}
	// Preserve conflict fallback, but never displace a valid match in the other category.
	if (result.templates.length === 0 && fallback) result.templates.push({ kind: "default", filename: fallback });
	return result;
}

/** Only a currently listed regular file may be loaded; never accept arbitrary paths. */
export function readTemplate(directory: string, filename: string): string[] {
	if (!listTemplates(directory).includes(filename)) {
		throw new Error(`Tips template is no longer available: ${filename}`);
	}
	return parseTemplate(readFileSync(join(directory, filename), "utf8"));
}
