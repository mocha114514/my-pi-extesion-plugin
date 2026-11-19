/**
 * Centered interactive modal panel for controlling relay-mode.
 *
 * Triggered by clicking the `relay mode` indicator on the right side of the
 * editor bottom border. Supports both keyboard and mouse interaction and keeps
 * two independent toggles:
 *   1. Current session relay mode (takes effect immediately; disabling stops
 *      the worker gracefully while preserving its session history files).
 *   2. Long-term default for new sessions (persisted to preferences.json;
 *      never alters the currently open window's relay mode state).
 */

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

type PanelKey =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.confirm"
	| "tui.select.cancel";

export interface RelayModePanelOptions {
	theme: Pick<Theme, "fg" | "bold">;
	rows(): number;
	matches(data: string, action: PanelKey): boolean;
	getSessionEnabled(): boolean;
	getDefaultEnabled(): boolean;
	isBusy(): boolean;
	onToggleSession(next: boolean): void;
	onToggleDefault(next: boolean): void;
	close(): void;
}

const OPTION_COUNT = 3; // 0: current session, 1: long-term default, 2: done

export class RelayModePanel implements Component {
	private selectedIndex = 0;
	private hitRows = new Map<number, number>();
	private contentLeft = 0;
	private contentRight = 0;
	private closed = false;
	private lastClickedIndex: number | undefined;
	private readonly options: RelayModePanelOptions;

	constructor(options: RelayModePanelOptions) {
		this.options = options;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.closed) return;
		const matches = (action: PanelKey) => this.options.matches(data, action);
		if (matches("tui.select.cancel") || data === "q" || data === "Q") {
			this.close();
		} else if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
		} else if (matchesKey(data, Key.end)) {
			this.selectedIndex = OPTION_COUNT - 1;
		} else if (matches("tui.select.up") || data === "k") {
			this.selectedIndex = (this.selectedIndex + OPTION_COUNT - 1) % OPTION_COUNT;
		} else if (matches("tui.select.down") || data === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % OPTION_COUNT;
		} else if (matches("tui.select.confirm") || matchesKey(data, Key.space) || data === "\n") {
			this.activate();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return { handled: true, render: false };
		if (event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
		const index =
			event.x >= this.contentLeft && event.x < this.contentRight
				? this.hitRows.get(event.y)
				: undefined;
		if (index === undefined) return undefined;
		if (event.type === "press") {
			return { handled: true, focus: true, render: false };
		}
		if (event.type === "click") {
			if ((event.clickCount ?? 1) > 1 && this.lastClickedIndex === index) {
				return { handled: true, render: false };
			}
			this.lastClickedIndex = index;
			this.selectedIndex = index;
			this.activate();
			return { handled: true, focus: true, render: true };
		}
		return undefined;
	}

	render(width: number): string[] {
		this.hitRows.clear();
		if (width <= 0) return [];

		const { theme } = this.options;
		const budget = Math.max(1, Math.trunc(this.options.rows()));
		const framed = width >= 12 && budget >= 7;
		const innerWidth = Math.max(1, width - (framed ? 4 : 0));
		this.contentLeft = framed ? 1 : 0;
		this.contentRight = width - (framed ? 1 : 0);

		const border = (text: string) => theme.fg("border", text);
		const frame = (text: string) => {
			const clipped = truncateToWidth(text, innerWidth, "…");
			return framed
				? `${border("│")} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${border("│")}`
				: clipped;
		};

		const lines: string[] = [];
		const titleText = ` ${t("relay.panel.title")} `;
		if (framed) {
			const label = truncateToWidth(titleText, Math.max(1, width - 2), "…");
			lines.push(border(`╭${label}${"─".repeat(Math.max(0, width - 2 - visibleWidth(label)))}╮`));
		} else {
			lines.push(theme.fg("accent", truncateToWidth(titleText.trim(), width, "…")));
		}

		const on = t("manager.on");
		const off = t("manager.off");
		const stateWidth = Math.max(visibleWidth(on), visibleWidth(off));
		const busy = this.options.isBusy();

		const toggles = [
			{
				index: 0,
				enabled: this.options.getSessionEnabled(),
				label: busy
					? `${t("relay.panel.sessionToggle")} (${t("relay.panel.updating")})`
					: t("relay.panel.sessionToggle"),
				desc: t("relay.panel.sessionDesc"),
			},
			{
				index: 1,
				enabled: this.options.getDefaultEnabled(),
				label: t("relay.panel.defaultToggle"),
				desc: t("relay.panel.defaultDesc"),
			},
		];

		for (const item of toggles) {
			const selected = this.selectedIndex === item.index;
			const stateLabel = item.enabled ? on : off;
			const padState = " ".repeat(Math.max(0, stateWidth - visibleWidth(stateLabel)));
			const badge = `[${item.enabled ? "✓" : " "} ${stateLabel}${padState}]`;
			const prefix = selected ? "→ " : "  ";
			const heading = `${prefix}${badge} ${item.label}`;
			const headingColor = selected ? "accent" : item.enabled ? "success" : "text";
			this.hitRows.set(lines.length, item.index);
			lines.push(frame(theme.fg(headingColor, heading)));

			const indent = " ".repeat(Math.min(innerWidth - 1, visibleWidth(prefix) + visibleWidth(badge) + 1));
			const descBudget = Math.max(1, innerWidth - indent.length);
			for (const wrapped of wrapTextWithAnsi(item.desc, descBudget)) {
				this.hitRows.set(lines.length, item.index);
				lines.push(frame(theme.fg(selected ? "text" : "dim", `${indent}${wrapped}`)));
			}
			if (item.index === 0) {
				lines.push(frame(""));
			}
		}

		if (framed) {
			lines.push(border(`├${"─".repeat(Math.max(0, width - 2))}┤`));
		}

		const doneSelected = this.selectedIndex === 2;
		const doneLabel = `${doneSelected ? "→ " : "  "}${t("manager.done")}`;
		this.hitRows.set(lines.length, 2);
		lines.push(frame(theme.fg(doneSelected ? "accent" : "text", doneLabel)));

		if (budget >= 12) {
			lines.push(frame(theme.fg("dim", t("relay.panel.hint"))));
		}

		if (framed) {
			lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		}
		return lines;
	}

	private activate(): void {
		if (this.selectedIndex === 0) {
			if (this.options.isBusy()) return;
			this.options.onToggleSession(!this.options.getSessionEnabled());
		} else if (this.selectedIndex === 1) {
			this.options.onToggleDefault(!this.options.getDefaultEnabled());
		} else {
			this.close();
		}
	}

	private close(): void {
		this.closed = true;
		this.options.close();
	}
}
