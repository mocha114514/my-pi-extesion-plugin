import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	Key,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { t } from "../shared/i18n/index.ts";
import type { Tip, TipsState } from "./model.ts";

export interface TipsPanelOptions {
	getState(): TipsState;
	listTemplates(): string[];
	selectTemplate(filename: string): void;
	add(content: string): void;
	update(id: number, content: string): void;
	remove(id: number): void;
	isActive(): boolean;
}

type PanelKey = "tui.select.cancel" | "tui.select.confirm" | "tui.select.up" |
	"tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown" | "tui.input.tab" |
	"tui.input.submit";
type Mode = "list" | "dropdown" | "editor" | "delete";
interface Row { text: string; action?: string }
interface Button { action: string; label: string }
interface Hit { x: number; y: number; width: number; action: string; label?: string }
interface PanelHost {
	tui: TUI;
	theme: Theme;
	matches(data: string, key: PanelKey): boolean;
	close(): void;
	notify(message: string, type: "error" | "warning"): void;
}

// Sanitize display only: the original multiline value is passed to the editor unchanged.
const display = (text: string) => stripTerminalSequences(text)
	.replace(/\r\n?/g, "\n")
	.replace(/\t/g, "    ")
	.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** Editor has a five-line minimum viewport; never let it overflow a short overlay. */
class BoundedEditor extends Editor {
	budget = 1;
	private start = 0;
	private fullHeight = 0;

	override render(width: number): string[] {
		const lines = super.render(width);
		this.fullHeight = lines.length;
		const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
		this.start = Math.min(this.start, Math.max(0, lines.length - this.budget));
		if (cursor >= 0 && cursor < this.start) this.start = cursor;
		if (cursor >= this.start + this.budget) this.start = cursor - this.budget + 1;
		return lines.slice(this.start, this.start + this.budget);
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return super.handleMouse({ ...event, y: event.y + this.start, height: this.fullHeight });
	}

	scroll(delta: number): void {
		// The public Editor API scrolls through cursor navigation, not a scroll setter.
		for (let count = 0; count < Math.min(50, Math.abs(delta)); count++) {
			super.handleInput(delta < 0 ? "\x1b[A" : "\x1b[B");
		}
	}
}

/** One modal owns every mode; no nested dialog can outlive its parent session. */
class TipsPanel implements Component, Focusable {
	private state: TipsState;
	private mode: Mode = "list";
	private templates: string[] = [];
	private selected = "templates";
	private tipId: number | undefined;
	private editor: BoundedEditor | undefined;
	private editorFocus = 0;
	private isFocused = false;
	private closed = false;
	private error = "";
	private scroll = 0;
	private bodyHeight = 1;
	private rows: Row[] = [];
	private targets: string[] = [];
	private hits: Hit[] = [];
	private lastClick: { mode: Mode; action: string } | undefined;
	private reveal = true;
	private previousWidth = 0;
	private previousBudget = 0;
	private editorArea: { x: number; y: number; width: number; height: number } | undefined;

	constructor(private readonly options: TipsPanelOptions, private readonly host: PanelHost) {
		this.state = options.getState();
	}

	get focused(): boolean { return this.isFocused; }
	set focused(value: boolean) {
		this.isFocused = value;
		if (this.editor) this.editor.focused = value && this.mode === "editor" && this.editorFocus === 0;
	}
	invalidate(): void { this.editor?.invalidate(); }
	dispose(): void {
		this.closed = true;
		this.focused = false;
		this.editor = undefined;
	}

	private close(): void {
		if (this.closed) return;
		this.dispose();
		this.host.close();
	}

	private active(): boolean {
		if (this.closed) return false;
		if (this.options.isActive()) return true;
		this.host.notify(t("tips.inactive"), "warning");
		this.close();
		return false;
	}

	private fail(error: unknown): void {
		this.error = t("tips.operationFailed", { error: display(error instanceof Error ? error.message : String(error)) });
		this.host.notify(this.error, "error");
	}

	private change(action: () => void): void {
		// Check immediately before every controller call, including a draft's final Save.
		if (!this.active()) return;
		try {
			action();
			this.state = this.options.getState();
			this.toList();
		} catch (error) {
			this.fail(error);
		}
	}

	private toList(): void {
		this.mode = "list";
		this.editor = undefined;
		this.error = "";
		this.selected = this.tipId !== undefined && this.state.tips.some(tip => tip.id === this.tipId)
			? `tip:${this.tipId}` : "templates";
		this.reveal = true;
	}

	private currentTip(): Tip | undefined {
		return this.state.tips.find(tip => `tip:${tip.id}` === this.selected);
	}

	private edit(tip?: Tip): void {
		if (tip?.source === "template") return;
		this.tipId = tip?.id;
		this.editor = new BoundedEditor(this.host.tui, {
			borderColor: text => this.host.theme.fg("border", text),
			selectList: {
				selectedPrefix: text => this.host.theme.fg("accent", text),
				selectedText: text => this.host.theme.fg("accent", text),
				description: text => this.host.theme.fg("dim", text),
				scrollInfo: text => this.host.theme.fg("dim", text),
				noMatch: text => this.host.theme.fg("dim", text),
			},
		});
		this.editor.disableSubmit = true;
		this.editor.setText(tip?.content ?? "");
		this.mode = "editor";
		this.editorFocus = 0;
		this.error = "";
		this.focused = this.isFocused;
	}

	private cancel(): void {
		if (this.mode === "delete" && this.editor) {
			this.mode = "editor";
			this.editorFocus = 0;
			this.error = "";
			this.focused = this.isFocused;
		} else this.toList();
	}

	private activate(action: string): void {
		if (!this.active()) return;
		if (action === "close") this.close();
		else if (action === "cancel") this.cancel();
		else if (action === "templates") {
			try {
				this.templates = this.options.listTemplates();
				this.mode = "dropdown";
				const index = this.templates.indexOf(this.state.selectedTemplate ?? "");
				this.selected = this.templates.length ? `template:${Math.max(0, index)}` : "cancel";
				this.scroll = 0;
				this.error = "";
				this.reveal = true;
			} catch (error) { this.fail(error); }
		} else if (action.startsWith("template:")) {
			const filename = this.templates[Number(action.slice(9))];
			if (filename !== undefined) this.change(() => this.options.selectTemplate(filename));
		} else if (action === "add") this.edit();
		else if (action.startsWith("tip:")) {
			this.selected = action;
			const tip = this.currentTip();
			if (tip) this.edit(tip);
		} else if (action === "delete") {
			const tip = this.state.tips.find(item => item.id === this.tipId);
			if (tip?.source !== "session") return;
			this.mode = "delete";
			this.selected = "cancel";
			this.scroll = 0;
			this.reveal = true;
			this.error = "";
		} else if (action === "confirmDelete" && this.tipId !== undefined) {
			this.change(() => this.options.remove(this.tipId!));
		} else if (action === "save" && this.editor) {
			const content = this.editor.getExpandedText();
			const id = this.tipId;
			this.change(() => id === undefined ? this.options.add(content) : this.options.update(id, content));
		}
		this.focused = this.isFocused;
	}

	handleInput(data: string): void {
		if (!this.active()) return;
		const match = (key: PanelKey) => this.host.matches(data, key);
		if (match("tui.select.cancel")) {
			if (this.mode === "list") this.close();
			else this.cancel();
		} else if (this.mode === "editor") {
			if (matchesKey(data, Key.ctrl("s"))) this.activate("save");
			else if (match("tui.input.tab") || matchesKey(data, Key.shift("tab"))) {
				const count = this.buttons().length + 1;
				this.editorFocus = (this.editorFocus + (matchesKey(data, Key.shift("tab")) ? count - 1 : 1)) % count;
			} else if (this.editorFocus > 0) {
				if (match("tui.select.confirm") || matchesKey(data, Key.space)) {
					this.activate(this.buttons()[this.editorFocus - 1].action);
				}
			} else {
				// Enter always inserts a newline; only Save/Ctrl+S commits the draft.
				this.editor?.handleInput(match("tui.input.submit") ? "\n" : data);
			}
			this.focused = this.isFocused;
		} else if (match("tui.select.confirm") || matchesKey(data, Key.space)) {
			this.activate(this.selected);
		} else if (this.mode === "list" && (data === "a" || data === "t")) {
			this.activate(data === "a" ? "add" : "templates");
		} else {
			const index = Math.max(0, this.targets.indexOf(this.selected));
			let next = index;
			if (match("tui.select.up") || data === "k" || matchesKey(data, Key.shift("tab"))) next--;
			else if (match("tui.select.down") || data === "j" || match("tui.input.tab")) next++;
			else if (matchesKey(data, Key.home)) next = 0;
			else if (matchesKey(data, Key.end)) next = this.targets.length - 1;
			else if (match("tui.select.pageUp") || match("tui.select.pageDown")) {
				this.scrollBy((match("tui.select.pageUp") ? -1 : 1) * this.bodyHeight);
				this.host.tui.requestRender();
				return;
			}
			this.selected = this.targets[Math.max(0, Math.min(this.targets.length - 1, next))] ?? this.selected;
			this.reveal = next !== index;
		}
		this.host.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!this.active()) return { handled: true, render: false };
		if (event.type === "wheel") {
			const delta = Math.trunc(event.wheelDelta ?? 0) * (event.shift ? this.bodyHeight : 1);
			if (this.mode === "editor") {
				this.editorFocus = 0;
				this.focused = this.isFocused;
				this.editor?.scroll(delta);
			} else this.scrollBy(delta);
			return { handled: true, render: true };
		}
		const area = this.editorArea;
		if (this.mode === "editor" && area && event.y >= area.y && event.y < area.y + area.height &&
			event.x >= area.x && event.x < area.x + area.width) {
			this.editorFocus = 0;
			this.focused = this.isFocused;
			return this.editor?.handleMouse({
				...event, x: event.x - area.x, y: event.y - area.y, width: area.width, height: area.height,
			});
		}
		if (event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
		const hit = this.hits.find(item => event.y === item.y && event.x >= item.x && event.x < item.x + item.width);
		if (!hit) return undefined;
		if (event.type === "press") return { handled: true, focus: true, render: false };
		if (event.type !== "click") return undefined;
		// Suppress double-confirmation, but allow a different item scrolled under the pointer.
		if ((event.clickCount ?? 1) > 1 && this.lastClick &&
			(this.lastClick.mode !== this.mode || this.lastClick.action === hit.action)) {
			return { handled: true, render: false };
		}
		this.lastClick = { mode: this.mode, action: hit.action };
		this.activate(hit.action);
		return { handled: true, focus: true, render: true };
	}

	private scrollBy(delta: number): void {
		this.scroll = Math.max(0, Math.min(Math.max(0, this.rows.length - this.bodyHeight), this.scroll + delta));
		this.reveal = false;
	}

	private buttons(): Button[] {
		if (this.mode === "editor") return [
			{ action: "save", label: t("tips.save") },
			{ action: "cancel", label: t("tips.cancel") },
			...(this.tipId === undefined ? [] : [{ action: "delete", label: t("tips.delete") }]),
		];
		if (this.mode === "delete") return [
			{ action: "confirmDelete", label: t("tips.confirmDelete") },
			{ action: "cancel", label: t("tips.cancel") },
		];
		if (this.mode === "dropdown") return [{ action: "cancel", label: t("tips.back") }];
		return [{ action: "add", label: t("tips.add") }, { action: "close", label: t("tips.close") }];
	}

	private buildRows(width: number): Row[] {
		const rows: Row[] = [];
		const append = (text: string, action?: string, style?: (line: string) => string) => {
			for (const logical of display(text).split("\n")) {
				const wrapped = logical ? wrapTextWithAnsi(logical, width) : [""];
				for (const line of wrapped) rows.push({ text: style ? style(line) : line, action });
			}
		};
		if (this.error) append(this.error, undefined, text => this.host.theme.fg("error", text));
		if (this.mode === "dropdown") {
			append(t("tips.chooseTemplate"));
			if (this.state.legacy) append(t("tips.legacyWarning"));
			if (!this.templates.length) append(t("tips.noTemplates"));
			for (const [index, filename] of this.templates.entries()) {
				append(`${filename === this.state.selectedTemplate ? "✓" : "○"} ${filename}`, `template:${index}`);
			}
		} else if (this.mode === "delete") {
			append(t("tips.deletePrompt", { id: this.tipId! }));
			append(this.state.tips.find(tip => tip.id === this.tipId)?.content ?? "");
		} else {
			append(t("tips.templateSelector", { filename: this.state.selectedTemplate ?? t("tips.noTemplate") }), "templates");
			append(t("tips.immediateHint"), undefined, text => this.host.theme.fg("dim", text));
			for (const source of ["template", "session"] as const) {
				const tips = this.state.tips.filter(tip => tip.source === source);
				append(t(source === "template" ? "tips.templateSection" : "tips.sessionSection", { count: tips.length }), undefined,
					text => this.host.theme.bold(text));
				for (const tip of tips) {
					const action = `tip:${tip.id}`;
					append(`#${tip.id} · ${t(source === "template" ? "tips.readOnly" : "tips.edit")}`, action);
					append(tip.content, action);
					rows.push({ text: "" });
				}
			}
			if (!this.state.tips.length) append(t("tips.empty"));
		}
		return rows;
	}

	render(width: number): string[] {
		this.hits = [];
		this.editorArea = undefined;
		if (width <= 0 || this.closed) return [];
		const budget = Math.max(1, this.host.tui.terminal.rows - 2);
		const { theme } = this.host;
		if (!this.options.isActive()) {
			// Finish outside render so removing the overlay cannot disturb its current frame.
			queueMicrotask(() => {
				if (this.closed) return;
				this.host.notify(t("tips.inactive"), "warning");
				this.close();
			});
			return [truncateToWidth(t("tips.inactive"), width, "")];
		}
		// AI tools may update the notebook while this panel is open. Refresh the list
		// without replacing an editor's unconfirmed draft.
		this.state = this.options.getState();
		const framed = width >= 8 && budget >= 5;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const left = framed ? 2 : 0;
		const frame = (text: string) => {
			const clipped = truncateToWidth(text, inner, "…");
			const padding = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
			return framed ? `${theme.fg("border", "│")} ${clipped}${padding} ${theme.fg("border", "│")}` : clipped;
		};
		const title = t(this.mode === "editor" ? (this.tipId === undefined ? "tips.addTitle" : "tips.editTitle") : "tips.title");
		const lines: string[] = [];
		if (framed) {
			const label = truncateToWidth(` ${title} `, width - 2, "");
			lines.push(theme.fg("border", `┌${label}${"─".repeat(width - 2 - visibleWidth(label))}┐`));
		}

		const buttons = this.buttons();
		const footer: Row[] = [];
		const footerHits: Hit[] = [];
		for (const button of buttons) {
			const label = truncateToWidth(`[ ${button.label} ]`, inner, "…");
			const last = footer.at(-1);
			if (last && visibleWidth(last.text) + 2 + visibleWidth(label) <= inner) {
				footerHits.push({ x: visibleWidth(last.text) + 2, y: footer.length - 1, width: visibleWidth(label), action: button.action, label });
				last.text += `  ${label}`;
			} else {
				footerHits.push({ x: 0, y: footer.length, width: visibleWidth(label), action: button.action, label });
				footer.push({ text: label });
			}
		}
		const chrome = framed ? 2 : 0;
		const fixedFooter = budget - chrome - footer.length >= 1;
		const hint = budget - chrome - (fixedFooter ? footer.length : 0) >= 5
			? t(this.mode === "editor" ? "tips.editorHint" : "tips.navigationHint") : "";
		this.bodyHeight = Math.max(1, budget - chrome - (fixedFooter ? footer.length : 0) - Number(Boolean(hint)));
		if (this.mode === "editor" && this.editor) {
			if (this.error && this.bodyHeight > 1) {
				lines.push(frame(theme.fg("error", this.error)));
				this.bodyHeight--;
			}
			if (!fixedFooter && this.editorFocus > 0) {
				// A one-row terminal can still expose each button with Tab, then click/Enter.
				const button = buttons[this.editorFocus - 1];
				this.hits.push({ x: left, y: lines.length, width: inner, action: button.action });
				lines.push(frame(theme.fg("accent", `[ ${button.label} ]`)));
			} else {
				this.editor.budget = this.bodyHeight;
				const content = this.editor.render(inner);
				this.editorArea = { x: left, y: lines.length, width: inner, height: content.length };
				lines.push(...content.map(frame));
			}
		} else {
			this.rows = this.buildRows(inner);
			const actions = [...new Set(this.rows.flatMap(row => row.action ? [row.action] : []))];
			this.targets = [...actions, ...buttons.map(button => button.action)];
			if (!fixedFooter) for (const button of buttons) this.rows.push({ text: `[ ${button.label} ]`, action: button.action });
			const reveal = this.reveal;
			this.scrollBy(0);
			if (reveal || width !== this.previousWidth || budget !== this.previousBudget) {
				const first = this.rows.findIndex(row => row.action === this.selected);
				const last = this.rows.findLastIndex(row => row.action === this.selected);
				if (first >= 0 && (first < this.scroll || first >= this.scroll + this.bodyHeight)) this.scroll = first;
				else if (first >= 0 && last - first < this.bodyHeight && last >= this.scroll + this.bodyHeight) this.scroll = last - this.bodyHeight + 1;
			}
			this.scrollBy(0);
			for (const row of this.rows.slice(this.scroll, this.scroll + this.bodyHeight)) {
				if (row.action) this.hits.push({ x: left, y: lines.length, width: inner, action: row.action });
				lines.push(frame(row.action === this.selected ? theme.fg("accent", row.text) : row.text));
			}
		}
		if (hint) lines.push(frame(theme.fg("dim", hint)));
		if (fixedFooter) {
			const footerStart = lines.length;
			for (const [index] of footer.entries()) {
				const text = footerHits
					.filter(hit => hit.y === index)
					.map(hit => {
						const active = this.mode === "editor"
							? buttons[this.editorFocus - 1]?.action === hit.action
							: this.selected === hit.action;
						return theme.fg(active ? "accent" : "text", hit.label!);
					})
					.join("  ");
				lines.push(frame(text));
			}
			this.hits.push(...footerHits.map(hit => ({ ...hit, x: hit.x + left, y: hit.y + footerStart })));
		}
		if (framed) lines.push(theme.fg("border", `└${"─".repeat(width - 2)}┘`));
		this.previousWidth = width;
		this.previousBudget = budget;
		return lines.slice(0, budget);
	}
}

export async function openTipsPanel(ctx: ExtensionContext, options: TipsPanelOptions): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(t("tips.uiRequired"), "warning");
		return;
	}
	try {
		if (!options.isActive()) return;
		await ctx.ui.custom<void>((tui, theme, keys, done) => new TipsPanel(options, {
			tui, theme,
			matches: (data, key) => keys.matches(data, key),
			close: () => done(),
			notify: (message, type) => ctx.ui.notify(message, type),
		}), {
			overlay: true,
			overlayOptions: {
				anchor: "center", width: "100%", maxHeight: "100%", margin: { left: 1, right: 1 },
			},
		});
	} catch (error) {
		ctx.ui.notify(t("tips.operationFailed", { error: error instanceof Error ? error.message : String(error) }), "error");
	}
}
