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
import {
	GIT_CHANGE_CATEGORIES,
	type GitChangeCategory,
	type GitChangeFile,
	readGitChanges,
} from "../shared/git-changes.ts";
import { getLocale, t, type MessageKey } from "../shared/i18n/index.ts";
import type { GitFileSource } from "../shared/git-file-diff.ts";
import { type GitCommit, type GitHistoryPage, readCommitChanges, readGitHistory } from "../shared/git-history.ts";
import { showGitCodePreview } from "./git-code-preview.ts";
import { displayPath, wrapPath } from "./git-preview-format.ts";

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

interface PreviewSection {
	id: string;
	source: GitFileSource;
	expanded: boolean;
	categories: Set<GitChangeCategory>;
	files?: GitChangeFile[];
	loading?: boolean;
	failed?: boolean;
}

interface PreviewRow {
	key: string;
	text: string;
	section?: PreviewSection;
	category?: GitChangeCategory;
	file?: GitChangeFile;
	history?: boolean;
	/** Content-relative hit range: statistics are not part of the file link. */
	pathStart?: number;
	pathEnd?: number;
}

export interface GitPreviewPanelOptions {
	theme: () => PreviewTheme;
	maxHeight: () => number;
	requestRender: () => void;
	onClose: () => void;
	onOpen: (file: GitChangeFile, source: GitFileSource) => Promise<void>;
	loadHistory: (options: { anchor?: string; skip: number; limit: number }) => Promise<GitHistoryPage>;
	loadCommit: (commit: GitCommit) => Promise<GitChangeFile[]>;
}

/** Rendering and hit-testing share the same wrapped rows, including after scrolling. */
export class GitPreviewPanel implements Component {
	private readonly options: GitPreviewPanelOptions;
	private readonly workspace: PreviewSection = {
		id: "workspace",
		source: { kind: "workspace" },
		expanded: true,
		categories: new Set(),
	};
	/** Oldest first on screen; Git's pagination remains newest first. */
	private readonly commits: PreviewSection[] = [];
	private historyLoading = false;
	private historyFailed = false;
	private hasMore = true;
	private anchor: string | undefined;
	private loaded = 0;
	private disposed = false;
	private initialPosition = true;
	private scrollAnchor: { key: string; offset: number } | undefined;
	private notice: string | undefined;
	private scrollOffset = 0;
	private width = 0;
	private viewport = 0;
	private trailingPadding = 0;
	private closeStart = Number.POSITIVE_INFINITY;
	private bodyCache:
		| { width: number; theme: PreviewTheme; locale: string; rows: PreviewRow[] }
		| undefined;

	constructor(options: GitPreviewPanelOptions) {
		this.options = options;
	}

	start(): void {
		void this.loadMore();
	}

	dispose(): void {
		this.disposed = true;
	}

	setFiles(files: GitChangeFile[]): void {
		this.workspace.files = files;
		this.workspace.failed = false;
		this.invalidate();
	}

	setFailed(): void {
		this.workspace.failed = true;
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
			return [truncateToWidth(t("gitPreview.title"), this.width, "")];
		}
		const rows = this.body();
		// A fixed viewport prevents the centered modal from moving as pages arrive.
		const height = Math.max(1, Math.floor(this.options.maxHeight()));
		const previousViewport = this.viewport;
		this.viewport = Math.max(0, height - 2);
		if (this.viewport !== previousViewport) {
			this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, rows.length - 1));
			this.trailingPadding = Math.max(0, this.scrollOffset + this.viewport - rows.length);
		}
		this.applyScrollAnchor(rows);
		if (this.initialPosition) {
			const workspace = rows.findIndex(row => row.key === "workspace:header:0");
			this.scrollOffset = Math.max(0, Math.min(workspace, rows.length - this.viewport));
			this.trailingPadding = 0;
			if (!this.historyLoading && (this.workspace.files || this.workspace.failed)) this.initialPosition = false;
		}
		this.clampScroll(rows.length);
		const top = this.top();
		if (height === 1) return [top];
		const visible = rows.slice(this.scrollOffset, this.scrollOffset + this.viewport).map(row => row.text);
		while (visible.length < this.viewport) visible.push("");
		return [top, ...visible.map(line => this.frameRow(line)), this.bottom(rows.length)];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.options.onClose();
			return;
		}
		const page = Math.max(1, this.viewport - 1);
		let delta: number;
		if (matchesKey(data, "up")) delta = -1;
		else if (matchesKey(data, "down")) delta = 1;
		else if (matchesKey(data, "pageUp")) delta = -page;
		else if (matchesKey(data, "pageDown")) delta = page;
		else if (matchesKey(data, "home")) delta = -this.body().length;
		else if (matchesKey(data, "end")) delta = this.body().length;
		else return;
		this.scroll(delta);
		this.options.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			this.scroll(Math.trunc(event.wheelDelta ?? 0));
			return { handled: true, render: true };
		}
		if (event.button !== "left") return undefined;
		// Claim presses so clicks belong to the overlay, not the transcript.
		if (event.type === "press") return { handled: true };
		if (event.type !== "click") return undefined;
		if (event.shift || event.alt || event.ctrl) return { handled: true };
		const clicks = event.clickCount ?? 1;
		if (event.y === 0 && event.x >= this.closeStart && event.x < this.width - 1) {
			if (clicks === 1) this.options.onClose();
			return { handled: true };
		}
		const inBody = event.y > 0 && event.y <= this.viewport && event.x > 0 && event.x < this.width - 1;
		if (!inBody) return { handled: true };
		const row = this.body()[this.scrollOffset + event.y - 1];
		if (row?.history) {
			if (clicks === 1) void this.loadMore();
			return { handled: true, render: true };
		}
		if (row?.section && !row.category && !row.file) {
			if (clicks === 2) this.toggle(row.section);
			return { handled: true, render: clicks === 2 };
		}
		if (row?.section && row.category && clicks === 1) {
			const expanded = row.section.categories;
			if (expanded.has(row.category)) expanded.delete(row.category);
			else expanded.add(row.category);
			this.notice = undefined;
			this.invalidate();
			return { handled: true, render: true };
		}
		const contentX = event.x - 2;
		if (clicks === 1 && row?.file && row.section && contentX >= row.pathStart! && contentX < row.pathEnd!) {
			void this.open(row.file, row.section.source);
		}
		return { handled: true };
	}

	private applyScrollAnchor(rows: PreviewRow[]): void {
		const anchor = this.scrollAnchor;
		if (!anchor) return;
		const position = rows.findIndex(row => row.key === anchor.key);
		if (position >= 0) {
			this.scrollOffset = Math.max(0, position - anchor.offset);
			this.trailingPadding = Math.max(0, this.scrollOffset + this.viewport - rows.length);
		}
		this.scrollAnchor = undefined;
	}

	private scroll(delta: number): void {
		this.applyScrollAnchor(this.body());
		this.initialPosition = false;
		this.scrollAnchor = undefined;
		this.scrollOffset += delta;
		this.clampScroll(this.body().length);
		if (delta < 0 && this.scrollOffset === 0) void this.loadMore();
	}

	private async loadMore(): Promise<void> {
		if (this.disposed || this.historyLoading || !this.hasMore) return;
		this.historyLoading = true;
		this.historyFailed = false;
		this.invalidate();
		this.options.requestRender();
		try {
			const page = await this.options.loadHistory({ anchor: this.anchor, skip: this.loaded, limit: 10 });
			if (this.disposed) return;
			// Capture at completion, not request time: the user may scroll while
			// Git runs. Stable row keys keep that exact viewport after prepending.
			this.rememberPosition();
			this.anchor = page.anchor;
			this.loaded += page.commits.length;
			this.hasMore = page.hasMore;
			this.commits.unshift(...page.commits.toReversed().map((commit): PreviewSection => ({
				id: commit.hash,
				source: { kind: "commit", commit },
				expanded: false,
				categories: new Set(),
			})));
		} catch {
			if (this.disposed) return;
			this.historyFailed = true;
		} finally {
			if (!this.disposed) {
				this.historyLoading = false;
				this.invalidate();
				this.options.requestRender();
			}
		}
	}

	private rememberPosition(): void {
		if (this.initialPosition || this.scrollAnchor) return;
		const rows = this.body();
		let index = this.scrollOffset;
		// The history status stays at the absolute top. Anchor the first
		// real row below it so newly inserted commits do not replace the view.
		while (rows[index]?.history) index++;
		const row = rows[index];
		if (row) this.scrollAnchor = { key: row.key, offset: index - this.scrollOffset };
	}

	private toggle(section: PreviewSection): void {
		this.initialPosition = false;
		section.expanded = !section.expanded;
		this.notice = undefined;
		this.invalidate();
		if (section.expanded && section.source.kind === "commit" && !section.files && !section.loading) {
			void this.loadSection(section);
		}
	}

	private async loadSection(section: PreviewSection): Promise<void> {
		if (section.source.kind !== "commit") return;
		section.loading = true;
		section.failed = false;
		this.invalidate();
		this.options.requestRender();
		try {
			const files = await this.options.loadCommit(section.source.commit);
			if (this.disposed) return;
			this.rememberPosition();
			section.files = files;
		} catch {
			if (this.disposed) return;
			section.failed = true;
		} finally {
			if (!this.disposed) {
				section.loading = false;
				this.invalidate();
				this.options.requestRender();
			}
		}
	}

	private async open(file: GitChangeFile, source: GitFileSource): Promise<void> {
		this.notice = undefined;
		try {
			await this.options.onOpen(file, source);
		} catch {
			if (!this.disposed) this.notice = t("gitPreview.openFailed");
		}
		if (!this.disposed) this.options.requestRender();
	}

	private clampScroll(total: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, total + this.trailingPadding - this.viewport)));
	}

	private body(): PreviewRow[] {
		const width = Math.max(1, this.width - 4);
		const theme = this.options.theme();
		const locale = getLocale();
		if (this.bodyCache?.width === width && this.bodyCache.theme === theme && this.bodyCache.locale === locale) {
			return this.bodyCache.rows;
		}
		const key = this.historyLoading
			? "gitPreview.historyLoading"
			: this.historyFailed ? "gitPreview.historyFailed"
				: this.hasMore ? "gitPreview.historyMore" : "gitPreview.historyEnd";
		const rows = wrapTextWithAnsi(t(key), width).map((line, index): PreviewRow => ({
			key: `history:${index}`,
			text: theme.fg(this.historyFailed ? "warning" : "muted", line),
			history: true,
		}));
		for (const section of [...this.commits, this.workspace]) this.sectionRows(section, width, rows);
		this.bodyCache = { width, theme, locale, rows };
		return rows;
	}

	private sectionRows(section: PreviewSection, width: number, rows: PreviewRow[]): void {
		const theme = this.options.theme();
		const label = section.source.kind === "workspace"
			? t("gitPreview.workspace")
			: `${section.source.commit.hash.slice(0, 8)} · ${section.source.commit.date} · ${displayPath(section.source.commit.subject)}`;
		const count = section.files ? ` (${section.files.length})` : "";
		const header = `${section.expanded ? "▼" : "▶"} ${label}${count}`;
		wrapTextWithAnsi(header, width).forEach((line, index) => {
			rows.push({ key: `${section.id}:header:${index}`, text: theme.fg("accent", line), section });
		});
		if (!section.expanded) return;
		const message = section.failed
			? t("gitPreview.failed")
			: !section.files ? t("gitPreview.loading")
				: section.files.length === 0 ? t("gitPreview.empty") : undefined;
		if (message) {
			wrapTextWithAnsi(message, Math.max(1, width - 2)).forEach((line, index) => {
				rows.push({
					key: `${section.id}:message:${index}`,
					text: " ".repeat(Math.min(2, width - 1)) + theme.fg(section.failed ? "error" : "muted", line),
				});
			});
			return;
		}
		const files = section.files!;
		let addWidth = 2;
		let deleteWidth = 2;
		for (const file of files) {
			addWidth = Math.max(addWidth, String(file.additions ?? 0).length + 1);
			deleteWidth = Math.max(deleteWidth, String(file.deletions ?? 0).length + 1);
		}
		for (const category of GIT_CHANGE_CATEGORIES) {
			const entries = files.filter(file => file.categories.includes(category));
			if (entries.length === 0) continue;
			const expanded = section.categories.has(category);
			const categoryLabel = `${expanded ? "▼" : "▶"} ${t(CATEGORY_LABELS[category])} (${entries.length})`;
			const indent = Math.min(2, Math.max(0, width - 1));
			wrapTextWithAnsi(categoryLabel, Math.max(1, width - indent)).forEach((line, index) => {
				rows.push({
					key: `${section.id}:${category}:header:${index}`,
					text: " ".repeat(indent) + theme.fg(category === "conflicted" ? "error" : "accent", line),
					section,
					category,
				});
			});
			if (!expanded) continue;
			for (const file of entries) rows.push(...this.fileRows(section, category, file, width, addWidth, deleteWidth));
		}
	}

	private fileRows(
		section: PreviewSection,
		category: GitChangeCategory,
		file: GitChangeFile,
		width: number,
		addWidth: number,
		deleteWidth: number,
	): PreviewRow[] {
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
		const indent = Math.min(4, Math.max(0, width - 1));
		const inline = width - indent - statsWidth - 1 >= 12;
		const pathWidth = Math.max(1, width - indent - (inline ? statsWidth + 1 : 0));
		const prefix = `${section.id}:${category}:${file.path}`;
		const rows = wrapPath(file.path, pathWidth).map((path, index): PreviewRow => {
			const suffix = inline && index === 0
				? " ".repeat(Math.max(1, width - indent - visibleWidth(path) - statsWidth)) + stats
				: "";
			return {
				key: `${prefix}:path:${index}`,
				text: " ".repeat(indent) + theme.fg("mdLink", path) + suffix,
				section,
				file,
				pathStart: indent,
				pathEnd: indent + visibleWidth(path),
			};
		});
		if (!inline) {
			wrapTextWithAnsi(stats, width).forEach((line, index) => {
				rows.push({
					key: `${prefix}:stats:${index}`,
					text: " ".repeat(Math.max(0, width - visibleWidth(line))) + line,
				});
			});
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
		const inner = Math.max(0, this.width - 2);
		const close = this.width >= 10 ? " × " : "";
		this.closeStart = close ? this.width - close.length - 1 : Number.POSITIVE_INFINITY;
		const title = truncateToWidth(` ${t("gitPreview.title")} `, Math.max(0, inner - close.length), "");
		return theme.fg("border", "╭") + theme.fg("accent", title) +
			theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(title) - close.length))) +
			theme.fg("muted", close) + theme.fg("border", "╮");
	}

	private bottom(total: number): string {
		const theme = this.options.theme();
		const position = total > this.viewport || this.scrollOffset > 0
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
	theme: () => Pick<Theme, "fg" | "bg" | "getBgAnsi">;
	root: string;
	onClose: () => void;
}): () => void {
	const { tui, root } = options;
	let closed = false;
	let handle: OverlayHandle | undefined;
	let closeFile: (() => void) | undefined;
	const close = () => {
		if (closed) return;
		closed = true;
		panel.dispose();
		closeFile?.();
		handle?.hide();
		options.onClose();
	};
	const panel = new GitPreviewPanel({
		theme: options.theme,
		maxHeight: () => Math.max(1, Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.8))),
		requestRender: () => { if (!closed) tui.requestRender(); },
		onClose: close,
		loadHistory: page => readGitHistory(root, page),
		loadCommit: commit => readCommitChanges(root, commit),
		onOpen: async (file, source) => {
			if (closed) return;
			closeFile?.();
			closeFile = showGitCodePreview({
				tui,
				theme: options.theme,
				root,
				file,
				source,
				onClose: () => { closeFile = undefined; },
			});
		},
	});
	handle = tui.showOverlay(panel, { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 });
	panel.start();
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
