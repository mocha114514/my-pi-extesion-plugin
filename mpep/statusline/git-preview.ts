/** On-demand, centered Git file browser. No preview I/O runs in the footer's polling loop. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	GIT_CHANGE_CATEGORIES,
	type GitChangeCategory,
	type GitChangeFile,
	readGitChanges,
} from "../shared/git-changes.ts";
import { getLocale, t, type MessageKey } from "../shared/i18n/index.ts";
import { openLocalPath } from "../shared/open-local-path.ts";

type PreviewTheme = Pick<Theme, "fg">;

const CATEGORY_LABELS = {
	modified: "gitPreview.modified",
	added: "gitPreview.added",
	deleted: "gitPreview.deleted",
	renamed: "gitPreview.renamed",
	copied: "gitPreview.copied",
	typeChanged: "gitPreview.typeChanged",
	untracked: "gitPreview.untracked",
	conflicted: "gitPreview.conflicted",
} as const satisfies Record<GitChangeCategory, MessageKey>;

interface PreviewRow {
	text: string;
	category?: GitChangeCategory;
	file?: GitChangeFile;
	/** Content-relative hit range: statistics are not part of the file link. */
	pathStart?: number;
	pathEnd?: number;
}

export interface GitPreviewPanelOptions {
	theme: () => PreviewTheme;
	maxHeight: () => number;
	requestRender: () => void;
	onClose: () => void;
	onOpen: (file: GitChangeFile) => Promise<void>;
}

/** Escape control characters without losing any portion of an unusual Git filename. */
function displayPath(path: string): string {
	return path.replace(/[\u0000-\u001f\u007f-\u009f]/g, character => {
		if (character === "\n") return "\\n";
		if (character === "\r") return "\\r";
		if (character === "\t") return "\\t";
		return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
	});
}

const pathSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Unlike prose wrapping, path wrapping must not discard spaces at a line boundary. */
function wrapPath(path: string, width: number): string[] {
	const rows: string[] = [];
	let line = "";
	let used = 0;
	const append = (part: string) => {
		const cells = visibleWidth(part);
		if (used + cells > width && line) {
			rows.push(line);
			line = "";
			used = 0;
		}
		line += part;
		used += cells;
	};
	for (const { segment } of pathSegments.segment(displayPath(path))) {
		if (visibleWidth(segment) <= width) append(segment);
		else {
			// A two-cell glyph cannot fit a one-cell viewport. Keep its code
			// points readable rather than overflowing or silently dropping it.
			const escaped = Array.from(segment, character => `\\u{${character.codePointAt(0)!.toString(16)}}`).join("");
			for (const character of escaped) append(character);
		}
	}
	if (line || rows.length === 0) rows.push(line);
	return rows;
}

/** Rendering and hit-testing share the same wrapped rows, including after scrolling. */
export class GitPreviewPanel implements Component {
	private readonly options: GitPreviewPanelOptions;
	private files: GitChangeFile[] | undefined;
	private failed = false;
	private notice: string | undefined;
	private readonly expanded = new Set<GitChangeCategory>();
	private scrollOffset = 0;
	private width = 0;
	private viewport = 0;
	private closeStart = Number.POSITIVE_INFINITY;
	private bodyCache:
		| { width: number; theme: PreviewTheme; locale: string; rows: PreviewRow[] }
		| undefined;

	constructor(options: GitPreviewPanelOptions) {
		this.options = options;
	}

	setFiles(files: GitChangeFile[]): void {
		this.files = files;
		this.failed = false;
		this.invalidate();
	}

	setFailed(): void {
		this.failed = true;
		this.invalidate();
	}

	invalidate(): void {
		this.bodyCache = undefined;
	}

	render(width: number): string[] {
		this.width = Math.max(0, Math.floor(width));
		if (this.width === 0) return [];
		if (this.width < 4) {
			this.viewport = 0;
			return [truncateToWidth(t("gitPreview.title", { count: this.files?.length ?? 0 }), this.width, "")];
		}
		const rows = this.body();
		const height = Math.min(rows.length + 2, Math.max(1, Math.floor(this.options.maxHeight())));
		this.viewport = Math.max(0, height - 2);
		this.clampScroll(rows.length);
		const top = this.top();
		if (height === 1) return [top];

		const visible = rows.slice(this.scrollOffset, this.scrollOffset + this.viewport);
		return [top, ...visible.map(row => this.frameRow(row.text)), this.bottom(rows.length)];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.options.onClose();
			return;
		}
		const rows = this.body();
		const page = Math.max(1, this.viewport - 1);
		if (matchesKey(data, "up")) this.scrollOffset--;
		else if (matchesKey(data, "down")) this.scrollOffset++;
		else if (matchesKey(data, "pageUp")) this.scrollOffset -= page;
		else if (matchesKey(data, "pageDown")) this.scrollOffset += page;
		else if (matchesKey(data, "home")) this.scrollOffset = 0;
		else if (matchesKey(data, "end")) this.scrollOffset = rows.length;
		else return;
		this.clampScroll(rows.length);
		this.options.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.scrollOffset += Math.trunc(event.wheelDelta ?? 0);
			this.clampScroll(this.body().length);
			return { handled: true, render: true };
		}
		if (event.button !== "left") return undefined;
		// Claim presses so the renderer reports clicks to this overlay rather
		// than starting a transcript selection underneath the modal.
		if (event.type === "press") return { handled: true };
		if (event.type !== "click") return undefined;
		if (event.shift || event.alt || event.ctrl || (event.clickCount ?? 1) !== 1) {
			return { handled: true, render: false };
		}
		if (event.y === 0 && event.x >= this.closeStart && event.x < this.width - 1) {
			this.options.onClose();
			return { handled: true };
		}
		const inBody = event.y > 0 && event.y <= this.viewport && event.x > 0 && event.x < this.width - 1;
		if (!inBody) return { handled: true, render: false };
		const row = this.body()[this.scrollOffset + event.y - 1];
		if (row?.category) {
			if (this.expanded.has(row.category)) this.expanded.delete(row.category);
			else this.expanded.add(row.category);
			this.notice = undefined;
			this.invalidate();
			return { handled: true, render: true };
		}
		const contentX = event.x - 2;
		if (row?.file && contentX >= row.pathStart! && contentX < row.pathEnd!) {
			void this.open(row.file);
		}
		return { handled: true, render: false };
	}

	private async open(file: GitChangeFile): Promise<void> {
		if (file.deleted) {
			this.notice = t("gitPreview.fileDeleted");
			this.options.requestRender();
			return;
		}
		this.notice = undefined;
		try {
			await this.options.onOpen(file);
		} catch (error) {
			const missing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
			this.notice = missing
				? t("gitPreview.fileDeleted")
				: t("gitPreview.openFailed");
		}
		this.options.requestRender();
	}

	private clampScroll(total: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, total - this.viewport)));
	}

	private body(): PreviewRow[] {
		const width = Math.max(1, this.width - 4);
		const theme = this.options.theme();
		const locale = getLocale();
		if (this.bodyCache?.width === width && this.bodyCache.theme === theme && this.bodyCache.locale === locale) {
			return this.bodyCache.rows;
		}
		const rows: PreviewRow[] = [];
		const message = this.failed
			? t("gitPreview.failed")
			: this.files === undefined
				? t("gitPreview.loading")
				: this.files.length === 0 ? t("gitPreview.empty") : undefined;
		if (message) {
			for (const line of wrapTextWithAnsi(message, width)) {
				rows.push({ text: theme.fg(this.failed ? "error" : "muted", line) });
			}
		} else {
			const files = this.files!;
			let addWidth = 2;
			let deleteWidth = 2;
			for (const file of files) {
				addWidth = Math.max(addWidth, String(file.additions ?? 0).length + 1);
				deleteWidth = Math.max(deleteWidth, String(file.deletions ?? 0).length + 1);
			}
			for (const category of GIT_CHANGE_CATEGORIES) {
				const entries = files.filter(file => file.categories.includes(category));
				if (entries.length === 0) continue;
				const expanded = this.expanded.has(category);
				const label = `${expanded ? "▼" : "▶"} ${t(CATEGORY_LABELS[category])} (${entries.length})`;
				for (const line of wrapTextWithAnsi(label, width)) {
					rows.push({ text: theme.fg(category === "conflicted" ? "error" : "accent", line), category });
				}
				if (!expanded) continue;
				for (const file of entries) rows.push(...this.fileRows(file, width, addWidth, deleteWidth));
			}
		}
		this.bodyCache = { width, theme, locale, rows };
		return rows;
	}

	private fileRows(file: GitChangeFile, width: number, addWidth: number, deleteWidth: number): PreviewRow[] {
		const theme = this.options.theme();
		let stats: string;
		if (file.kind === "text" && file.additions !== null && file.deletions !== null) {
			stats = theme.fg("toolDiffAdded", `+${file.additions}`.padStart(addWidth)) + " " +
				theme.fg("toolDiffRemoved", `-${file.deletions}`.padStart(deleteWidth));
		} else {
			const key = file.kind === "binary"
				? "gitPreview.binary"
				: file.kind === "conflict" ? "gitPreview.conflict" : "gitPreview.unavailable";
			stats = theme.fg(file.kind === "conflict" ? "error" : "muted", t(key));
		}
		const statsWidth = visibleWidth(stats);
		const inline = width - statsWidth - 3 >= 12;
		const indent = Math.min(2, Math.max(0, width - 1));
		const pathWidth = Math.max(1, width - indent - (inline ? statsWidth + 1 : 0));
		// Wrap, never truncate: even long paths remain fully visible and every
		// wrapped path segment opens the original, unescaped filesystem path.
		const paths = wrapPath(file.path, pathWidth);
		const rows = paths.map((path, index): PreviewRow => {
			const suffix = inline && index === 0
				? " ".repeat(Math.max(1, width - indent - visibleWidth(path) - statsWidth)) + stats
				: "";
			return {
				text: " ".repeat(indent) + theme.fg("mdLink", path) + suffix,
				file,
				pathStart: indent,
				pathEnd: indent + visibleWidth(path),
			};
		});
		if (!inline) {
			for (const line of wrapTextWithAnsi(stats, width)) {
				rows.push({ text: " ".repeat(Math.max(0, width - visibleWidth(line))) + line });
			}
		}
		return rows;
	}

	private frameRow(text: string): string {
		const theme = this.options.theme();
		const inner = Math.max(0, this.width - 2);
		const padding = Math.min(1, Math.floor(inner / 2));
		const fitted = truncateToWidth(text, Math.max(0, inner - padding * 2), "");
		return theme.fg("border", "│") + " ".repeat(padding) + fitted +
			" ".repeat(Math.max(0, inner - padding - visibleWidth(fitted))) + theme.fg("border", "│");
	}

	private top(): string {
		const theme = this.options.theme();
		if (this.width === 1) return theme.fg("border", "╭");
		const inner = this.width - 2;
		const close = this.width >= 10 ? " × " : "";
		this.closeStart = close ? this.width - close.length - 1 : Number.POSITIVE_INFINITY;
		const title = truncateToWidth(` ${t("gitPreview.title", { count: this.files?.length ?? 0 })} `, inner - close.length, "");
		return theme.fg("border", "╭") + theme.fg("accent", title) +
			theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(title) - close.length))) +
			theme.fg("muted", close) + theme.fg("border", "╮");
	}

	private bottom(total: number): string {
		const theme = this.options.theme();
		const position = total > this.viewport
			? ` ${this.scrollOffset + 1}–${Math.min(total, this.scrollOffset + this.viewport)}/${total}`
			: "";
		const hint = ` ${this.notice ?? t("gitPreview.hint")}${position} `;
		const inner = Math.max(0, this.width - 2);
		const fitted = truncateToWidth(hint, inner, "");
		return theme.fg("border", "╰") + theme.fg(this.notice ? "warning" : "muted", fitted) +
			theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(fitted))) + "╯");
	}
}

export function showGitPreview(options: {
	tui: TUI;
	theme: () => PreviewTheme;
	root: string;
	onClose: () => void;
}): () => void {
	const { tui, root } = options;
	let closed = false;
	let handle: OverlayHandle | undefined;
	const close = () => {
		if (closed) return;
		closed = true;
		handle?.hide();
		options.onClose();
	};
	const panel = new GitPreviewPanel({
		theme: options.theme,
		maxHeight: () => Math.max(1, Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.8))),
		requestRender: () => { if (!closed) tui.requestRender(); },
		onClose: close,
		onOpen: async file => {
			const path = resolve(root, file.path);
			await lstat(path);
			await openLocalPath(path);
		},
	});
	handle = tui.showOverlay(panel, { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 });
	void readGitChanges(root).then(files => {
		if (closed) return;
		panel.setFiles(files);
		tui.requestRender();
	}).catch(() => {
		if (closed) return;
		panel.setFailed();
		tui.requestRender();
	});
	return close;
}
