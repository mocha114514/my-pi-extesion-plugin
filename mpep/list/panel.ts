// Floating checklist panel.
//
// The controller measures the free rows above the editor and calls configure
// before showOverlay or a reposition. configure remembers that width and the
// maximum frame height (the two borders count) and returns the height that
// will actually be drawn. Short lists shrink to their content. Long lists use
// the free space and scroll; nothing is dropped and there is no item cap.
//
// Scroll is counted in rendered lines, not items, and it is remembered for
// the displayed list id. Completing an item keeps the position (clamped if
// the text got shorter). Opening the popup returns to the newest list;
// switching lists resets the viewport and folds the goal and every item.
// History navigation is local to the panel and never writes checklist data.

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getLocale, t } from "../shared/i18n/index.ts";
import { blockedBy, type ListItem, type ListState } from "./model.ts";
import { itemsInDisplayOrder } from "./order.ts";

/** Preferred frame width. The controller still clamps it to the screen. */
export const PANEL_WIDTH = 64;

// Chalk's strikethrough is a no-op when the color level is 0. The title has
// to stay struck through in the rendered cells, so the SGR is written directly:
// 9 turns it on and 29 turns it off without clearing the theme color.
const STRIKE_ON = "\x1b[9m";
const STRIKE_OFF = "\x1b[29m";

type Ink = Parameters<Theme["fg"]>[0];

type FoldTarget =
	| { kind: "goal" }
	| { kind: "item"; id: string };

function columns(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

// Tabs are three columns in pi-tui's visibleWidth. Expand them before wrapping
// so a terminal tab stop cannot push the right border out of the frame.
// CR becomes a line break; other C0 controls are dropped.
function printable(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "   ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function wrapColumns(text: string, width: number): string[] {
	if (width <= 0) return [];
	return wrapTextWithAnsi(printable(text), width)
		.map(line => truncateToWidth(line, width, ""));
}

export class ListPanel implements Component {
	private readonly readState: (listNumber?: number) => ListState | undefined;
	private readonly theme: () => Theme;
	private readonly readCount: () => number;
	// Undefined follows the newest checklist, including newly created lists.
	// A historical number stays pinned while the session gains newer lists.
	private historyNumber: number | undefined;
	private listCount = 0;
	private allocatedWidth = PANEL_WIDTH;
	private maxHeight = 0;
	private configured = false;
	private width = PANEL_WIDTH;
	private scrollOffset = 0;
	private listId: string | undefined;
	private goalExpanded = false;
	private readonly expandedItems = new Set<string>();
	// Body-relative title rows share the wrapped-line cache. Mouse coordinates
	// are translated through scrollOffset, so wrapped and scrolled titles work.
	private readonly titleRows = new Map<number, FoldTarget>();
	// Building the body is the expensive part: every item is cleaned, wrapped,
	// and painted, and wheel events, renders, and repositioning all need the
	// result. store.read() returns the same object until a commit replaces it,
	// so (state, width, theme, locale) is a sound key while fold state is
	// unchanged. Toggling a section invalidates the cache; scrolling only moves
	// the viewport over these cached lines instead of rebuilding them.
	private bodyCache:
		| { state: ListState | undefined; width: number; theme: Theme; locale: string; lines: string[] }
		| undefined;

	constructor(
		readState: (listNumber?: number) => ListState | undefined,
		theme: () => Theme,
		readCount?: () => number,
	) {
		this.readState = readState;
		this.theme = theme;
		// Existing callers without history still expose zero or one checklist.
		this.readCount = readCount ?? (() => this.readState() ? 1 : 0);
	}

	/** Remember the allocated frame and return the height render() will use. */
	configure(width: number, maxHeight: number): number {
		this.configured = true;
		this.allocatedWidth = columns(width);
		this.maxHeight = columns(maxHeight);
		return this.layout(this.allocatedWidth).length;
	}

	invalidate(): void {
		// Drop the cached body lines. Scroll belongs to the list the user is
		// reading, so a theme change must not send them back to the top.
		this.bodyCache = undefined;
	}

	/** Reset content presentation without changing the selected checklist. */
	resetView(): void {
		this.goalExpanded = false;
		this.expandedItems.clear();
		this.scrollOffset = 0;
		this.invalidate();
	}

	/** Start each popup visit at the newest checklist, fully folded. */
	resetNavigation(): void {
		this.historyNumber = undefined;
		this.resetView();
	}

	render(width: number): string[] {
		const given = columns(width);
		const used = this.configured ? Math.min(this.allocatedWidth, given) : given;
		return this.layout(used);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const state = this.readSelected();
			const body = this.measure(state);
			this.scrollOffset += Math.trunc(event.wheelDelta ?? 0);
			this.clamp(body, this.frame(body).viewport);
			// Non-modal: consume the wheel so the transcript behind the panel
			// does not move, but do not take the editor's keyboard focus.
			return { handled: true, focus: false, render: true };
		}
		if (event.type === "click") {
			if (event.button === "left" && !event.shift && !event.alt && !event.ctrl) {
				const state = this.readSelected();
				const body = this.measure(state);
				const { height, viewport } = this.frame(body);
				// Navigation stays on the bottom border as the panel grows or shrinks.
				if (height >= 2 && event.y === height - 1) {
					return { handled: true, focus: false, render: this.navigate(event.x) };
				}
				// Arrows accept rapid repeated clicks; body folds remain single-click only.
				if ((event.clickCount ?? 1) !== 1) {
					return { handled: true, focus: false, render: false };
				}
				this.clamp(body, viewport);
				const inside = event.x > 0 && event.x < this.width - 1 &&
					event.y > 0 && event.y <= viewport;
				const target = inside ? this.titleRows.get(this.scrollOffset + event.y - 1) : undefined;
				if (target) {
					if (target.kind === "goal") {
						this.goalExpanded = !this.goalExpanded;
					} else if (this.expandedItems.has(target.id)) {
						this.expandedItems.delete(target.id);
					} else {
						this.expandedItems.add(target.id);
					}
					this.invalidate();
					return { handled: true, focus: false, render: true };
				}
			}
			// Borders, details, and modified clicks neither dismiss nor focus it.
			return { handled: true, focus: false, render: false };
		}
		// press / drag / release / move stay with the renderer so a drag can
		// select the text. Swallowing them would cancel that gesture.
		return undefined;
	}

	private paint(color: Ink, text: string): string {
		return this.theme().fg(color, text);
	}

	private readSelected(): ListState | undefined {
		this.listCount = columns(this.readCount());
		// A restored session can have fewer lists. If the pinned number is no
		// longer historical, return to the latest rather than an invalid entry.
		if (this.historyNumber !== undefined && this.historyNumber >= this.listCount) {
			this.historyNumber = undefined;
		}
		const state = this.readState(this.historyNumber);
		this.sync(state);
		return state;
	}

	private sync(state: ListState | undefined): void {
		const id = state?.id;
		if (id === this.listId) return;
		this.listId = id;
		// Sync resets folds, not navigation: a historical read must stay pinned.
		this.resetView();
	}

	private navigationButtonWidth(width: number): number {
		// Keep both controls in a narrow popup; extremely small direct renders
		// retain the original clipped border instead of overlapping the buttons.
		if (width < 8) return 0;
		return width >= 14 ? 3 : 1;
	}

	private navigate(x: number): boolean {
		const buttonWidth = this.navigationButtonWidth(this.width);
		if (buttonWidth === 0) return false;
		// Match bottom(): both buttons are right-aligned with one border cell between them.
		const nextStart = this.width - buttonWidth - 1;
		const previousStart = nextStart - buttonWidth - 1;
		const direction = x >= previousStart && x < previousStart + buttonWidth
			? -1
			: x >= nextStart && x < nextStart + buttonWidth ? 1 : 0;
		if (direction === 0) return false;
		const number = (this.historyNumber ?? this.listCount) + direction;
		if (number < 1 || number > this.listCount) return false;
		this.historyNumber = number === this.listCount ? undefined : number;
		this.resetView();
		return true;
	}

	private frame(bodyLength: number): { height: number; viewport: number } {
		if (this.width <= 0) return { height: 0, viewport: 0 };
		const natural = bodyLength + 2;
		const cap = this.configured ? this.maxHeight : natural;
		const height = Math.min(natural, Math.max(0, cap));
		const viewport = height >= 2 ? height - 2 : 0;
		return { height, viewport };
	}

	private clamp(bodyLength: number, viewport: number): void {
		const max = Math.max(0, bodyLength - Math.max(0, viewport));
		if (this.scrollOffset > max) this.scrollOffset = max;
		if (this.scrollOffset < 0) this.scrollOffset = 0;
	}

	private measure(state: ListState | undefined): number {
		if (this.width < 2) return 0;
		return this.body(state, this.width - 2).length;
	}

	private layout(width: number): string[] {
		this.width = width;
		const state = this.readSelected();
		if (width <= 0) return [];

		const inner = width - 2;
		const body = inner > 0 ? this.body(state, inner) : [];
		const frame = this.frame(body.length);
		this.clamp(body.length, frame.viewport);
		if (frame.height <= 0) return [];
		if (frame.height === 1) return [this.seal(this.top(state, width), width, "╮")];

		const visible = body.slice(this.scrollOffset, this.scrollOffset + frame.viewport);
		while (visible.length < frame.viewport) visible.push("");
		const lines = [
			this.top(state, width),
			...visible.map(line => this.row(line, width)),
			this.bottom(body.length, frame.viewport, width),
		];
		return lines.map((line, index) => {
			const right = index === 0 ? "╮" : index === lines.length - 1 ? "╯" : "│";
			return this.seal(line, width, right);
		});
	}

	private body(state: ListState | undefined, width: number): string[] {
		const theme = this.theme();
		const locale = getLocale();
		const cached = this.bodyCache;
		if (
			cached &&
			cached.state === state &&
			cached.width === width &&
			cached.theme === theme &&
			cached.locale === locale
		) {
			return cached.lines;
		}
		const lines = this.bodyLines(state, width);
		this.bodyCache = { state, width, theme, locale, lines };
		return lines;
	}

	private bodyLines(state: ListState | undefined, inner: number): string[] {
		this.titleRows.clear();
		if (!state) return this.wrapped(t("list.empty"), inner, "dim");

		const lines: string[] = [];
		if (state.title.trim().length > 0) {
			lines.push(...this.wrapped(state.title, inner, "text"));
			lines.push("");
		}
		const goalTitle = this.wrapped(
			`${this.goalExpanded ? "▾" : "▸"} ${t("list.goal")}`,
			inner,
			"accent",
		);
		for (let row = 0; row < goalTitle.length; row += 1) {
			this.titleRows.set(lines.length + row, { kind: "goal" });
		}
		lines.push(...goalTitle);
		// Folding is presentation-only: expanding still wraps the complete goal.
		if (this.goalExpanded) {
			lines.push(...this.wrapped(
				state.goal ?? t("list.goalMissing"),
				inner,
				state.goal === undefined ? "warning" : "muted",
			));
		}
		lines.push("");
		if (state.items.length === 0) {
			lines.push(...this.wrapped(t("list.empty"), inner, "dim"));
			return lines;
		}

		const completion = new Map(state.items.map(item => [item.id, item.done] as const));
		let index = 0;
		for (const item of itemsInDisplayOrder(state.items)) {
			if (index > 0) lines.push("");
			lines.push(...this.itemLines(state, item, inner, completion, lines.length));
			index += 1;
		}
		return lines;
	}

	private wrapped(text: string, width: number, color: Ink): string[] {
		return wrapColumns(text, width).map(line => this.paint(color, line));
	}

	private itemLines(
		state: ListState,
		item: ListItem,
		inner: number,
		completion: ReadonlyMap<string, boolean>,
		firstRow: number,
	): string[] {
		const expanded = this.expandedItems.has(item.id);
		const disclosure = this.paint("dim", expanded ? "▾" : "▸");
		const mark = item.done ? "[x]" : "[ ]";
		const prefix = `${disclosure} ${this.paint(item.done ? "dim" : "success", mark)} `;
		const gutter = visibleWidth(prefix);
		// The stable id stays visible, including on a struck completed row.
		// Numbering is not implied by order, so the id is not optional chrome.
		const lines = this.hanging(prefix, `${item.id} ${item.title}`, inner, line =>
			item.done
				? `${STRIKE_ON}${this.paint("dim", line)}${STRIKE_OFF}`
				: this.paint("text", line),
		);

		for (let row = 0; row < lines.length; row += 1) {
			this.titleRows.set(firstRow + row, { kind: "item", id: item.id });
		}
		if (!expanded) return lines;

		// Completed descriptions stay in full. They are dimmed, not struck
		// through, and blank paragraphs are real rows.
		if (item.description.length > 0) {
			lines.push(...this.indented(
				gutter,
				item.description,
				inner,
				line => this.paint(item.done ? "dim" : "muted", line),
			));
		}

		// The full dependency list stays visible after a prerequisite is done.
		// blockedBy is only the ones that are still open.
		if (item.dependsOn.length > 0) {
			lines.push(...this.indented(
				gutter,
				t("list.dependencies", { ids: item.dependsOn.join(", ") }),
				inner,
				line => this.paint("dim", line),
			));
		}
		const waiting = blockedBy(state, item, completion);
		if (waiting.length > 0) {
			lines.push(...this.indented(
				gutter,
				t("list.waiting", { ids: waiting.join(", ") }),
				inner,
				line => this.paint("warning", line),
			));
		}
		return lines;
	}

	private hanging(
		prefix: string,
		text: string,
		inner: number,
		paint: (line: string) => string,
	): string[] {
		if (inner <= 0) return [];
		const gutter = visibleWidth(prefix);
		if (gutter >= inner) return [truncateToWidth(prefix, inner, "")];
		const wrapped = wrapColumns(text, inner - gutter);
		const content = wrapped.length > 0 ? wrapped : [""];
		const hang = " ".repeat(gutter);
		return content.map((line, index) => (index === 0 ? prefix : hang) + paint(line));
	}

	private indented(
		gutter: number,
		text: string,
		inner: number,
		paint: (line: string) => string,
	): string[] {
		if (inner <= 0 || gutter >= inner) return [];
		const hang = " ".repeat(gutter);
		return wrapColumns(text, inner - gutter).map(line => hang + paint(line));
	}

	private top(state: ListState | undefined, width: number): string {
		const items = state?.items ?? [];
		const done = items.filter(item => item.done).length;
		const progress = this.paint("text", t("list.progress", { done, total: items.length }));
		const list = this.paint("accent", "list");
		if (width < 8) return this.rule("╭", "╮", ` ${list} ${progress} `, width);

		const number = this.historyNumber ?? this.listCount;
		const current = this.historyNumber === undefined;
		const color = current ? "accent" : "muted";
		const status = this.paint(color, t(current ? "list.current" : "list.history"));
		const shortStatus = this.paint(color, t(current ? "list.currentShort" : "list.historyShort"));
		const numbered = this.paint("text", `#${number}`);
		const total = this.paint("text", `#${number}/${this.listCount}`);
		const room = width - 2;
		// Prefer full metadata, then drop progress and shorten the identity.
		// Number and status take priority over decoration in narrow terminals.
		const labels = this.listCount > 0
			? [
				` ${list} ${total} ${status} ${progress} `,
				` ${list} ${total} ${status} `,
				` ${list} ${numbered} ${status} `,
				` ${numbered} ${status} `,
				`${numbered}${shortStatus}`,
			]
			: [` ${list} ${progress} `, ` ${list} `, list];
		const label = labels.find(text => visibleWidth(text) <= room) ?? labels[labels.length - 1]!;
		return this.rule("╭", "╮", label, width);
	}

	private bottom(total: number, viewport: number, width: number): string {
		const overflow = viewport > 0 && total > viewport;
		const label = overflow
			? ` ${this.paint("dim", t("list.scroll", {
				start: this.scrollOffset + 1,
				end: this.scrollOffset + viewport,
				total,
			}))} `
			: "";
		const buttonWidth = this.navigationButtonWidth(width);
		if (buttonWidth === 0) return this.rule("╰", "╯", label, width);

		// Reserve the right-hand controls before clipping the scroll indicator.
		const room = width - 2 - 2 * buttonWidth - 1;
		const text = truncateToWidth(label, room, "");
		const fill = this.paint("border", "─".repeat(Math.max(0, room - visibleWidth(text))));
		const number = this.historyNumber ?? this.listCount;
		const previous = buttonWidth === 3 ? "[‹]" : "‹";
		const next = buttonWidth === 3 ? "[›]" : "›";
		return this.paint("border", "╰") + text + fill +
			this.paint(number > 1 ? "accent" : "dim", previous) +
			this.paint("border", "─") +
			this.paint(number < this.listCount ? "accent" : "dim", next) +
			this.paint("border", "╯");
	}

	private rule(left: string, right: string, label: string, width: number): string {
		if (width <= 0) return "";
		if (width === 1) return this.paint("border", right);
		const inner = width - 2;
		const text = truncateToWidth(label, inner, "");
		const fill = "─".repeat(Math.max(0, inner - visibleWidth(text)));
		return this.paint("border", left) + text + this.paint("border", fill + right);
	}

	private row(content: string, width: number): string {
		if (width <= 0) return "";
		if (width === 1) return this.paint("border", "│");
		const inner = width - 2;
		const text = truncateToWidth(content, inner, "");
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
		return this.paint("border", "│") + text + pad + this.paint("border", "│");
	}

	// The right border is the last column even when the content was wider
	// than the allocated frame. A wide character is not allowed to stick out.
	private seal(line: string, width: number, right: string): string {
		if (width <= 0) return "";
		const measured = visibleWidth(line);
		if (measured === width) return line;
		if (measured < width) return line + " ".repeat(width - measured);
		const edge = this.paint("border", right);
		const room = Math.max(0, width - visibleWidth(edge));
		const kept = truncateToWidth(line, room, "");
		const pad = " ".repeat(Math.max(0, room - visibleWidth(kept)));
		return kept + pad + edge;
	}
}
