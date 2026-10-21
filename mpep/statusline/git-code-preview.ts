/** Read-only, full-file diff overlay. Markers never become part of source text. */
import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	matchesKey,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { GitChangeFile } from "../shared/git-changes.ts";
import {
	type GitFileDiff,
	type GitFileSource,
	type GitTextDiff,
	readGitFileDiff,
} from "../shared/git-file-diff.ts";
import { t } from "../shared/i18n/index.ts";
import {
	buildDiffOverview,
	DIFF_OVERVIEW_WIDTH,
	type DiffOverviewBucket,
} from "./git-diff-overview.ts";
import { displayPath } from "./git-preview-format.ts";

type CodeTheme = Pick<Theme, "fg" | "bg" | "getBgAnsi">;

export interface GitCodePreviewOptions {
	theme: () => CodeTheme;
	maxHeight: () => number;
	requestRender: () => void;
	onClose: () => void;
	path: string;
	source: GitFileSource;
	/** Injectable for focused rendering tests; production uses Pi's highlighter. */
	highlight?: (code: string, language?: string) => string[];
}

interface HighlightedFile {
	theme: CodeTheme;
	before: string[];
	after: string[];
	maxWidth: number;
}

/** Expand tabs relative to the source column, not to the marker/frame columns. */
export function displayCodeLine(line: string): string {
	let result = "";
	let start = 0;
	let columns = 0;
	for (const match of line.matchAll(/[\u0000-\u001f\u007f-\u009f]/g)) {
		const prefix = line.slice(start, match.index);
		result += prefix;
		columns += visibleWidth(prefix);
		const char = match[0];
		const replacement = char === "\t"
			? " ".repeat(4 - columns % 4)
			: char === "\r" ? "\\r" : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
		result += replacement;
		columns += replacement.length;
		start = match.index + char.length;
	}
	return result + line.slice(start);
}

/** Keep the invisible remainder of a clipped wide glyph in the column grid. */
export function sliceCodeLine(line: string, start: number, width: number): string {
	if (width <= 0) return "";
	const leading = start > 0
		? Math.min(width, Math.max(0, visibleWidth(sliceByColumn(line, 0, start)) - start))
		: 0;
	return " ".repeat(leading) + sliceByColumn(line, start, width, true);
}

export class GitCodePreviewPanel implements Component {
	private readonly options: GitCodePreviewOptions;
	private data: GitFileDiff | undefined;
	private failed = false;
	private highlighted: HighlightedFile | undefined;
	private width = 0;
	private viewport = 0;
	private vertical = 0;
	private horizontal = 0;
	private closeStart = Number.POSITIVE_INFINITY;
	private overviewStart = Number.POSITIVE_INFINITY;
	private overview: DiffOverviewBucket[] = [];

	constructor(options: GitCodePreviewOptions) {
		this.options = options;
	}

	setData(data: GitFileDiff): void {
		this.data = data;
		this.failed = false;
		this.invalidate();
	}

	setFailed(): void {
		this.failed = true;
		this.invalidate();
	}

	invalidate(): void {
		this.highlighted = undefined;
		this.overview = [];
	}

	render(width: number): string[] {
		this.width = Math.max(0, Math.floor(width));
		this.viewport = 0;
		this.overviewStart = Number.POSITIVE_INFINITY;
		if (this.width === 0) return [];
		if (this.width < 4) {
			return [truncateToWidth(displayPath(this.options.path), this.width, "")];
		}
		const text = this.data?.kind === "text" ? this.data : undefined;
		const message = text?.rows.length ? undefined : this.message();
		const messages = message ? wrapTextWithAnsi(message, Math.max(1, this.width - 4)) : [];
		const count = text?.rows.length || messages.length;
		// Keep the full available height even for short files so the track stays clickable.
		const height = Math.max(1, Math.floor(this.options.maxHeight()));
		this.viewport = Math.max(0, height - 2);
		this.clamp(count);
		if (height === 1) return [this.top()];

		const overviewWidth = text?.rows.length && this.width >= 10 && this.viewport > 0
			? DIFF_OVERVIEW_WIDTH : 0;
		if (overviewWidth && text) {
			this.overviewStart = this.width - 1 - overviewWidth;
			// Reuse the full-file aggregation while scrolling; rebuild only for data/height changes.
			if (this.overview.length !== this.viewport) {
				this.overview = buildDiffOverview(text.rows, this.viewport);
			}
		}

		const lines: string[] = [];
		if (text && text.rows.length) {
			const highlighted = this.highlight(text);
			const codeWidth = Math.max(0, this.width - 6 - overviewWidth);
			this.horizontal = Math.min(this.horizontal, Math.max(0, highlighted.maxWidth - codeWidth));
			for (const row of text.rows.slice(this.vertical, this.vertical + this.viewport)) {
				const source = row.kind === "removed"
					? highlighted.before[(row.oldLine ?? 1) - 1]
					: highlighted.after[(row.newLine ?? 1) - 1];
				const code = sliceCodeLine(source ?? "", this.horizontal, codeWidth);
				const theme = this.options.theme();
				const marker = row.kind === "added"
					? theme.fg("toolDiffAdded", "+ ")
					: row.kind === "removed" ? theme.fg("toolDiffRemoved", "- ") : "  ";
				lines.push(this.frame(marker + code, row.kind, lines.length));
			}
		} else {
			for (const line of messages.slice(this.vertical, this.vertical + this.viewport)) {
				lines.push(this.frame(this.options.theme().fg(this.failed ? "error" : "muted", line)));
			}
		}
		while (lines.length < this.viewport) {
			lines.push(this.frame("", undefined, lines.length));
		}
		return [this.top(), ...lines, this.bottom(count)];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.options.onClose();
			return;
		}
		const page = Math.max(1, this.viewport - 1);
		if (matchesKey(data, "up")) this.vertical--;
		else if (matchesKey(data, "down")) this.vertical++;
		else if (matchesKey(data, "pageUp")) this.vertical -= page;
		else if (matchesKey(data, "pageDown")) this.vertical += page;
		else if (matchesKey(data, "home")) this.vertical = 0;
		else if (matchesKey(data, "end")) this.vertical = this.rowCount();
		else if (matchesKey(data, "left")) this.horizontal = Math.max(0, this.horizontal - 4);
		else if (matchesKey(data, "right")) this.horizontal += 4;
		else return;
		this.clamp(this.rowCount());
		this.options.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = Math.trunc(event.wheelDelta ?? 0);
			if (event.shift) this.horizontal = Math.max(0, this.horizontal + delta * 4);
			else this.vertical += delta;
			this.clamp(this.rowCount());
			return { handled: true, render: true };
		}
		if (event.button !== "left") return undefined;
		if (event.type === "press") return { handled: true };
		if (event.type !== "click") return undefined;
		if (event.y === 0 && event.x >= this.closeStart && event.x < this.width - 1) {
			this.options.onClose();
		} else if (event.x >= this.overviewStart && event.x < this.width - 1 &&
			event.y >= 1 && event.y <= this.viewport) {
			const bucket = this.overview[event.y - 1];
			if (bucket) {
				// Prefer the clicked change lane, but keep both columns useful for sparse changes.
				const change = event.x === this.overviewStart
					? bucket.removed ?? bucket.added
					: bucket.added ?? bucket.removed;
				const proportional = Math.round(
					(event.y - 1) * (this.rowCount() - 1) / Math.max(1, this.viewport - 1),
				);
				this.vertical = (change ?? proportional) - Math.floor(this.viewport / 2);
				this.clamp(this.rowCount());
				return { handled: true, render: true };
			}
		}
		return { handled: true };
	}

	private rowCount(): number {
		if (this.data?.kind === "text" && this.data.rows.length) return this.data.rows.length;
		return wrapTextWithAnsi(this.message(), Math.max(1, this.width - 4)).length;
	}

	private message(): string {
		if (this.failed) return t("gitPreview.codeFailed");
		if (!this.data) return t("gitPreview.codeLoading");
		if (this.data.kind === "binary") return t("gitPreview.codeBinary");
		if (this.data.kind === "tooLarge") return t("gitPreview.codeTooLarge");
		if (this.data.kind === "unavailable") return t("gitPreview.codeUnavailable");
		return t("gitPreview.codeEmpty");
	}

	private clamp(count: number): void {
		this.vertical = Math.max(0, Math.min(this.vertical, Math.max(0, count - this.viewport)));
	}

	private overviewCell(index: number): string {
		const bucket = this.overview[index];
		if (!bucket) return "";
		const theme = this.options.theme();
		const removed = theme.fg(
			bucket.removed === undefined ? "borderMuted" : "toolDiffRemoved",
			bucket.removed === undefined ? "│" : "▐",
		);
		const added = theme.fg(
			bucket.added === undefined ? "borderMuted" : "toolDiffAdded",
			bucket.added === undefined ? "│" : "▌",
		);
		const cells = removed + added;
		// Half blocks expose the viewport background even when both change lanes are filled.
		const visible = bucket.start < this.vertical + this.viewport && bucket.end > this.vertical;
		return visible ? theme.bg("selectedBg", cells) : cells;
	}

	private highlight(data: GitTextDiff): HighlightedFile {
		const theme = this.options.theme();
		if (this.highlighted?.theme === theme) return this.highlighted;
		const before = data.oldLines.map(displayCodeLine);
		const after = data.newLines.map(displayCodeLine);
		const language = getLanguageFromPath(this.options.path);
		const colorize = (lines: string[]): string[] => {
			try {
				const colored = (this.options.highlight ?? highlightCode)(lines.join("\n"), language);
				// Pi can split a multi-line token without repeating its opening ANSI
				// style. Carry that state so every independently framed row is colored.
				return wrapTextWithAnsi(colored.join("\n"), Number.MAX_SAFE_INTEGER);
			} catch {
				return lines;
			}
		};
		// Highlight each complete version independently. Highlighting isolated
		// diff rows would lose multi-line comment/string state at hunk borders.
		this.highlighted = {
			theme,
			before: colorize(before),
			after: colorize(after),
			maxWidth: [...before, ...after].reduce((max, line) => Math.max(max, visibleWidth(line)), 0),
		};
		return this.highlighted;
	}

	private frame(text: string, kind?: "context" | "added" | "removed", overviewRow?: number): string {
		const theme = this.options.theme();
		const overview = Number.isFinite(this.overviewStart) && overviewRow !== undefined
			? this.overviewCell(overviewRow) : "";
		// Reserve the track before clipping or painting code; diff backgrounds stop here too.
		const inner = Math.max(0, this.width - 2 - visibleWidth(overview));
		const padding = Math.min(1, Math.floor(inner / 2));
		const content = truncateToWidth(text, Math.max(0, inner - padding * 2), "");
		let line = " ".repeat(padding) + content;
		line += " ".repeat(Math.max(0, inner - visibleWidth(line)));
		if (kind === "added" || kind === "removed") {
			const color = kind === "added" ? "toolSuccessBg" : "toolErrorBg";
			// Reapply our background after a token/column slicer resets styling.
			// Foreground token colors remain untouched by this separate layer.
			line = theme.bg(color, line.replace(/\u001b\[(?:0|49)?m/g, reset => reset + theme.getBgAnsi(color)));
		}
		return theme.fg("border", "│") + line + overview + theme.fg("border", "│");
	}

	private top(): string {
		const theme = this.options.theme();
		const inner = Math.max(0, this.width - 2);
		const close = this.width >= 10 ? " × " : "";
		this.closeStart = close ? this.width - close.length - 1 : Number.POSITIVE_INFINITY;
		const source = this.options.source.kind === "workspace"
			? t("gitPreview.workspace")
			: this.options.source.commit.hash.slice(0, 8);
		const title = truncateToWidth(` ${source} · ${displayPath(this.options.path)} `, Math.max(0, inner - close.length), "");
		return theme.fg("border", "╭") + theme.fg("accent", title) +
			theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(title) - close.length))) +
			theme.fg("muted", close) + theme.fg("border", "╮");
	}

	private bottom(count: number): string {
		const theme = this.options.theme();
		const position = count > 0 ? ` · ${this.vertical + 1}–${Math.min(count, this.vertical + this.viewport)}/${count}` : "";
		const column = this.horizontal > 0 ? ` · ↔ ${this.horizontal}` : "";
		const hint = truncateToWidth(` ${t("gitPreview.codeHint")}${position}${column} `, this.width - 2, "");
		return theme.fg("border", "╰") + theme.fg("muted", hint) +
			theme.fg("border", "─".repeat(Math.max(0, this.width - 2 - visibleWidth(hint))) + "╯");
	}
}

export function showGitCodePreview(options: {
	tui: TUI;
	theme: () => CodeTheme;
	root: string;
	file: GitChangeFile;
	source: GitFileSource;
	onClose: () => void;
}): () => void {
	let closed = false;
	let handle: OverlayHandle | undefined;
	const close = () => {
		if (closed) return;
		closed = true;
		handle?.hide();
		options.onClose();
	};
	const panel = new GitCodePreviewPanel({
		theme: options.theme,
		maxHeight: () => Math.max(1, Math.min(options.tui.terminal.rows - 2, Math.floor(options.tui.terminal.rows * 0.9))),
		requestRender: () => { if (!closed) options.tui.requestRender(); },
		onClose: close,
		path: options.file.path,
		source: options.source,
	});
	handle = options.tui.showOverlay(panel, { anchor: "center", width: "96%", maxHeight: "90%", margin: 1 });
	void readGitFileDiff(options.root, options.source, options.file).then(data => {
		if (closed) return;
		panel.setData(data);
		options.tui.requestRender();
	}).catch(() => {
		if (closed) return;
		panel.setFailed();
		options.tui.requestRender();
	});
	return close;
}
