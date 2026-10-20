import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { t } from "../shared/i18n/index.ts";

export interface ManagerItem {
	id: string;
	name: string;
	desc: string;
	enabled: boolean;
}

type PanelKey =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.confirm"
	| "tui.select.cancel"
	| "tui.altScreen.top"
	| "tui.altScreen.bottom";

interface PanelOptions {
	items: ManagerItem[];
	theme: Pick<Theme, "fg" | "bold">;
	rows(): number;
	matches(data: string, action: PanelKey): boolean;
	// The controller persists changes and updates items only after a successful write.
	change(changes: Record<string, boolean>, toggledId?: string): void;
	close(): void;
}

interface ContentRow {
	text: string;
	index: number;
}

/** A bounded, modal settings list. Wrapped lines retain their owning item for hit testing. */
export class ManagerPanel implements Component {
	private selectedIndex = 0;
	private scrollOffset = 0;
	private bodyRows: ContentRow[] = [];
	private bodyHeight = 1;
	private renderedWidth = 0;
	private heightBudget = 0;
	private hitRows = new Map<number, number>();
	private contentLeft = 0;
	private contentRight = 0;
	private revealSelection = true;
	private closed = false;
	private lastClickedIndex: number | undefined;
	private readonly options: PanelOptions;

	constructor(options: PanelOptions) {
		this.options = options;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.closed) return;
		const matches = (action: PanelKey) => this.options.matches(data, action);
		if (matches("tui.select.cancel")) {
			this.close();
		} else if (matches("tui.altScreen.top") || matchesKey(data, Key.home)) {
			this.select(0);
			this.scrollOffset = 0;
		} else if (matches("tui.altScreen.bottom") || matchesKey(data, Key.end)) {
			this.select(Math.max(0, this.options.items.length - 1));
			this.scrollOffset = this.maxScroll();
		} else if (matches("tui.select.pageUp")) {
			this.page(-1);
		} else if (matches("tui.select.pageDown")) {
			this.page(1);
		} else if (matches("tui.select.up") || data === "k") {
			this.select(this.selectedIndex - 1);
		} else if (matches("tui.select.down") || data === "j") {
			this.select(this.selectedIndex + 1);
		} else if (matches("tui.select.confirm") || matchesKey(data, Key.space) || data === "\n") {
			this.activate();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return { handled: true, render: false };
		if (event.type === "wheel") {
			const delta = Math.trunc(event.wheelDelta ?? 0);
			this.scrollBy(delta * (event.shift ? this.bodyHeight : 1));
			return { handled: true, render: true };
		}
		if (event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
		const index = event.x >= this.contentLeft && event.x < this.contentRight
			? this.hitRows.get(event.y)
			: undefined;
		if (index === undefined) return undefined;
		if (event.type === "press") {
			// Do not reflow the list on press: click must still hit the row the user saw.
			return { handled: true, focus: true, render: false };
		}
		if (event.type === "click") {
			// TUI click counts survive wheel events at the same screen cell. Only suppress
			// repeated clicks on the same item, not a new item scrolled under the pointer.
			if ((event.clickCount ?? 1) > 1 && this.lastClickedIndex === index) {
				return { handled: true, render: false };
			}
			this.lastClickedIndex = index;
			this.selectedIndex = index;
			this.revealSelection = false;
			this.activate();
			return { handled: true, focus: true, render: true };
		}
		return undefined;
	}

	render(width: number): string[] {
		this.hitRows.clear();
		if (width <= 0) return [];
		const budget = Math.max(1, Math.trunc(this.options.rows()));
		const resized = width !== this.renderedWidth || budget !== this.heightBudget;
		this.renderedWidth = width;
		this.heightBudget = budget;
		const framed = width >= 8 && budget >= 7;
		const fixedActions = budget >= 5;
		const showTitle = budget >= 2;
		const hints = budget >= 14
			? [t("manager.navigationHint"), t("manager.scrollHint")]
			: [];
		const innerWidth = Math.max(1, width - (framed ? 4 : 0));
		this.contentLeft = framed ? 1 : 0;
		this.contentRight = width - (framed ? 1 : 0);
		this.bodyRows = this.buildRows(innerWidth, !fixedActions);
		const chrome = Number(showTitle) + (framed ? 2 : 0) + (fixedActions ? 3 : 0) + hints.length;
		this.bodyHeight = Math.max(1, Math.min(this.bodyRows.length, budget - chrome));
		this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll());
		if (resized || this.revealSelection) this.ensureVisible();
		this.revealSelection = false;

		const { theme, items } = this.options;
		const border = (text: string) => theme.fg("border", text);
		const enabled = items.filter(item => item.enabled).length;
		const summary = t("manager.enabledCount", { enabled, total: items.length });
		const dividerWidth = Math.max(0, width - 2);
		// Reuse the divider row; narrow panels keep the numeric ratio instead of clipping its label.
		const counter = visibleWidth(summary) + 2 <= dividerWidth
			? ` ${summary} `
			: truncateToWidth(`${enabled}/${items.length}`, dividerWidth, "");
		const divider = border(`├${"─".repeat(dividerWidth - visibleWidth(counter))}${counter}┤`);
		const frame = (text: string, right = border("│")) => {
			const clipped = truncateToWidth(text, innerWidth, "…");
			return framed
				? `${border("│")} ${clipped}${" ".repeat(innerWidth - visibleWidth(clipped))} ${right}`
				: clipped;
		};
		const lines: string[] = [];
		const visible = this.bodyRows.slice(this.scrollOffset, this.scrollOffset + this.bodyHeight);
		if (showTitle) {
			const start = (visible[0]?.index ?? 0) + 1;
			const end = (visible.at(-1)?.index ?? 0) + 1;
			const total = items.length + (fixedActions ? 0 : 3);
			const title = ` ${t("manager.title")}  ${start}–${end}/${total} `;
			const label = truncateToWidth(title, width - (framed ? 2 : 0), "…");
			lines.push(framed
				? border(`┌${label}${"─".repeat(width - 2 - visibleWidth(label))}┐`)
				: theme.fg("accent", label));
		}

		const maxScroll = this.maxScroll();
		const thumbSize = Math.max(1, Math.floor(this.bodyHeight ** 2 / Math.max(1, this.bodyRows.length)));
		const thumbTop = maxScroll > 0
			? Math.round(this.scrollOffset / maxScroll * (this.bodyHeight - thumbSize))
			: 0;
		for (let row = 0; row < this.bodyHeight; row++) {
			const content = visible[row];
			const text = content
				? theme.fg(content.index === this.selectedIndex ? "accent" : "text", content.text)
				: "";
			if (content) this.hitRows.set(lines.length, content.index);
			const thumb = maxScroll > 0 && row >= thumbTop && row < thumbTop + thumbSize;
			lines.push(frame(text, thumb ? theme.fg("accent", "┃") : undefined));
		}

		if (framed) lines.push(divider);
		if (fixedActions) {
			for (let action = 0; action < 3; action++) {
				const index = items.length + action;
				this.hitRows.set(lines.length, index);
				lines.push(frame(theme.fg(
					index === this.selectedIndex ? "accent" : "text",
					this.actionLabel(action),
				)));
			}
		}
		for (const hint of hints) lines.push(frame(theme.fg("dim", hint)));
		if (framed) lines.push(border(`└${"─".repeat(width - 2)}┘`));
		return lines;
	}

	private buildRows(width: number, includeActions: boolean): ContentRow[] {
		const rows: ContentRow[] = [];
		const on = t("manager.on");
		const off = t("manager.off");
		const stateWidth = Math.max(visibleWidth(on), visibleWidth(off));
		for (const [index, item] of this.options.items.entries()) {
			const state = item.enabled ? on : off;
			const status = `[${item.enabled ? "✓" : " "} ${state}${" ".repeat(stateWidth - visibleWidth(state))}]`;
			const prefix = index === this.selectedIndex ? "→ " : "  ";
			const lead = `${prefix}${status} `;
			const leadWidth = visibleWidth(lead);
			const text = `${item.name} ── ${item.desc}`;
			// Wrap independently of the status: equal cell widths alone are not enough,
			// since on/off labels contain different word boundaries.
			if (leadWidth >= width) {
				rows.push({ text: lead, index });
				for (const line of wrapTextWithAnsi(text, width)) rows.push({ text: line, index });
			} else {
				const padding = " ".repeat(leadWidth);
				const wrapped = wrapTextWithAnsi(text, width - leadWidth);
				for (const [lineIndex, line] of wrapped.entries()) {
					rows.push({ text: `${lineIndex === 0 ? lead : padding}${line}`, index });
				}
			}
		}
		// Extremely short terminals share one viewport for settings and actions instead of overflowing.
		if (includeActions) {
			for (let action = 0; action < 3; action++) {
				rows.push({ text: this.actionLabel(action), index: this.options.items.length + action });
			}
		}
		return rows;
	}

	private actionLabel(action: number): string {
		const keys = ["manager.enableAll", "manager.disableAll", "manager.done"] as const;
		const prefix = this.selectedIndex === this.options.items.length + action ? "→ " : "  ";
		return `${prefix}${t(keys[action])}`;
	}

	private select(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(this.options.items.length + 2, index));
		this.revealSelection = true;
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.maxScroll(), this.scrollOffset + delta));
		this.revealSelection = false;
	}

	private page(direction: number): void {
		this.scrollBy(direction * this.bodyHeight);
		const first = this.bodyRows[this.scrollOffset];
		if (first) this.selectedIndex = first.index;
	}

	private maxScroll(): number {
		return Math.max(0, this.bodyRows.length - this.bodyHeight);
	}

	private ensureVisible(): void {
		const start = this.bodyRows.findIndex(row => row.index === this.selectedIndex);
		if (start < 0) return; // Fixed footer actions do not move the settings viewport.
		const end = this.bodyRows.findLastIndex(row => row.index === this.selectedIndex) + 1;
		if (start < this.scrollOffset) this.scrollOffset = start;
		else if (end > this.scrollOffset + this.bodyHeight) {
			this.scrollOffset = Math.min(start, end - this.bodyHeight);
		}
		this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll());
	}

	private activate(): void {
		const { items } = this.options;
		const item = items[this.selectedIndex];
		if (item) {
			this.options.change({ [item.id]: !item.enabled }, item.id);
		} else {
			const action = this.selectedIndex - items.length;
			if (action === 2) this.close();
			else this.options.change(Object.fromEntries(items.map(item => [item.id, action === 0])));
		}
	}

	private close(): void {
		this.closed = true;
		this.options.close();
	}
}
