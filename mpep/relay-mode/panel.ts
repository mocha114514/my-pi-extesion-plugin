/**
 * Centered interactive modal panel for controlling relay-mode.
 *
 * Triggered by clicking the `relay mode` indicator on the right side of the
 * editor bottom border. Supports both keyboard and mouse interaction and keeps
 * two controls:
 *   1. Current session relay mode (one-way latch: once enabled in a session,
 *      it stays locked on and cannot be turned off to preserve prompt cache
 *      stability and context continuity).
 *   2. Long-term default for new sessions (persisted to preferences.json;
 *      never alters the currently open window's relay mode state).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
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
	matches?(data: string, action: PanelKey): boolean;
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
		// When relay mode is already locked on for this session, focus the
		// long-term default toggle initially while still allowing navigation to
		// row 0 to read its locked status note.
		if (options.getSessionEnabled()) {
			this.selectedIndex = 1;
		}
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.closed) return;
		const matches = (action: PanelKey): boolean => {
			if (this.options.matches) return this.options.matches(data, action);
			try {
				return getKeybindings().matches(data, action);
			} catch {
				switch (action) {
					case "tui.select.up":
						return matchesKey(data, Key.up);
					case "tui.select.down":
						return matchesKey(data, Key.down);
					case "tui.select.confirm":
						return matchesKey(data, Key.enter);
					case "tui.select.cancel":
						return matchesKey(data, Key.escape);
				}
			}
		};
		// Dispatch configured host keybindings and dedicated close shortcuts
		// BEFORE optional literal aliases (`j`, `k`, `q`) so remapping e.g.
		// Up->`j` / Down->`k` or Cancel works as configured.
		if (
			matches("tui.select.cancel") ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, Key.alt("r"))
		) {
			this.close();
		} else if (matches("tui.select.up")) {
			this.selectedIndex = (this.selectedIndex + OPTION_COUNT - 1) % OPTION_COUNT;
		} else if (matches("tui.select.down")) {
			this.selectedIndex = (this.selectedIndex + 1) % OPTION_COUNT;
		} else if (matches("tui.select.confirm") || matchesKey(data, Key.space) || data === "\n") {
			this.activate();
		} else if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
		} else if (matchesKey(data, Key.end)) {
			this.selectedIndex = OPTION_COUNT - 1;
		} else if (data === "q" || data === "Q") {
			this.close();
		} else if (data === "k") {
			this.selectedIndex = (this.selectedIndex + OPTION_COUNT - 1) % OPTION_COUNT;
		} else if (data === "j") {
			this.selectedIndex = (this.selectedIndex + 1) % OPTION_COUNT;
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
			// If activate() closed the panel (e.g. clicking Done), do not reclaim
			// focus back to the just-hidden panel component.
			return { handled: true, focus: !this.closed, render: !this.closed };
		}
		return undefined;
	}

	render(width: number): string[] {
		this.hitRows.clear();
		if (width <= 0) return [];

		const { theme } = this.options;
		const terminalRows = Math.max(1, Math.trunc(this.options.rows()));
		// Match the overlay's 80% maxHeight cap so compact terminals never clip
		// the second toggle or the Done action beneath the overlay bottom edge.
		const maxLines = Math.max(4, Math.floor(terminalRows * 0.8));
		const framed = width >= 12 && maxLines >= 7;
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

		const on = t("manager.on");
		const off = t("manager.off");
		const stateWidth = Math.max(visibleWidth(on), visibleWidth(off));
		const busy = this.options.isBusy();

		const sessionEnabled = this.options.getSessionEnabled();
		const sessionTag = busy
			? t("relay.panel.updating")
			: sessionEnabled
				? t("relay.panel.sessionLocked")
				: t("relay.panel.sessionOneWayTag");
		const toggles = [
			{
				index: 0,
				enabled: sessionEnabled,
				locked: sessionEnabled,
				baseLabel: t("relay.panel.sessionToggle"),
				priorityTag: sessionTag,
				desc: sessionEnabled
					? t("relay.panel.sessionDescLocked")
					: t("relay.panel.sessionDesc"),
			},
			{
				index: 1,
				enabled: this.options.getDefaultEnabled(),
				locked: false,
				baseLabel: t("relay.panel.defaultToggle"),
				priorityTag: undefined as string | undefined,
				desc: t("relay.panel.defaultDesc"),
			},
		];

		// Format a toggle heading so critical trailing tags (such as the
		// irreversible-enable warning) keep priority over the base label on
		// narrow compact terminals where description lines are omitted.
		const formatHeading = (prefix: string, badge: string, baseLabel: string, tag?: string): string => {
			const head = `${prefix}${badge} `;
			if (!tag) return `${head}${baseLabel}`;
			const full = `${head}${baseLabel} (${tag})`;
			if (visibleWidth(full) <= innerWidth) return full;
			const suffix = ` (${tag})`;
			const labelBudget = innerWidth - visibleWidth(head) - visibleWidth(suffix);
			if (labelBudget >= 4) {
				return `${head}${truncateToWidth(baseLabel, labelBudget, "…")}${suffix}`;
			}
			const compactSuffix = `(${tag})`;
			const compactBudget = innerWidth - visibleWidth(head) - visibleWidth(compactSuffix);
			if (compactBudget >= 2) {
				return `${head}${truncateToWidth(baseLabel, compactBudget, "…")}${compactSuffix}`;
			}
			return `${head}${compactSuffix}`;
		};

		// Compute wrapped descriptions up front so we can gracefully degrade
		// spacing/hint/descriptions when terminal height is tight while keeping
		// both toggles and Done always visible inside `maxLines`.
		const items = toggles.map((item) => {
			const stateLabel = item.enabled ? on : off;
			const padState = " ".repeat(Math.max(0, stateWidth - visibleWidth(stateLabel)));
			const badge = `[${item.enabled ? "✓" : " "} ${stateLabel}${padState}]`;
			const prefix = this.selectedIndex === item.index ? "→ " : "  ";
			const indent = " ".repeat(Math.min(Math.max(0, innerWidth - 1), visibleWidth(prefix) + visibleWidth(badge) + 1));
			const descBudget = Math.max(1, innerWidth - indent.length);
			return {
				...item,
				heading: formatHeading(prefix, badge, item.baseLabel, item.priorityTag),
				indent,
				wrappedDesc: wrapTextWithAnsi(item.desc, descBudget),
				singleDesc: truncateToWidth(item.desc, descBudget, "…"),
			};
		});

		// Base rows: header (1) + 2 toggle headings (2) + separator (framed?1:0) + Done (1) + bottom border (framed?1:0).
		const baseLines = 1 + 2 + (framed ? 1 : 0) + 1 + (framed ? 1 : 0);
		const fullDescLines = items[0]!.wrappedDesc.length + items[1]!.wrappedDesc.length;
		let descMode: "full" | "single" | "none" = "full";
		let includeSpacer = true;
		let includeHint = true;

		if (baseLines + fullDescLines + 2 > maxLines) {
			includeHint = false;
			if (baseLines + fullDescLines + 1 > maxLines) {
				includeSpacer = false;
				if (baseLines + fullDescLines > maxLines) {
					descMode = baseLines + 2 <= maxLines ? "single" : "none";
				}
			}
		}

		const lines: string[] = [];
		const titleText = ` ${t("relay.panel.title")} `;
		if (framed) {
			const label = truncateToWidth(titleText, Math.max(1, width - 2), "…");
			lines.push(border(`╭${label}${"─".repeat(Math.max(0, width - 2 - visibleWidth(label)))}╮`));
		} else {
			lines.push(theme.fg("accent", truncateToWidth(titleText.trim(), width, "…")));
		}

		for (const item of items) {
			const selected = this.selectedIndex === item.index;
			const headingColor = selected ? "accent" : item.enabled ? "success" : "text";
			this.hitRows.set(lines.length, item.index);
			lines.push(frame(theme.fg(headingColor, item.heading)));

			if (descMode === "full") {
				for (const wrapped of item.wrappedDesc) {
					this.hitRows.set(lines.length, item.index);
					lines.push(frame(theme.fg(selected ? "text" : "dim", `${item.indent}${wrapped}`)));
				}
			} else if (descMode === "single") {
				this.hitRows.set(lines.length, item.index);
				lines.push(frame(theme.fg(selected ? "text" : "dim", `${item.indent}${item.singleDesc}`)));
			}
			if (item.index === 0 && includeSpacer) {
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

		if (includeHint) {
			lines.push(frame(theme.fg("dim", t("relay.panel.hint"))));
		}

		if (framed) {
			lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		}
		return lines;
	}

	private activate(): void {
		if (this.selectedIndex === 0) {
			// Once enabled in a session, relay mode is intentionally locked on
			// and cannot be turned off.
			if (this.options.isBusy() || this.options.getSessionEnabled()) return;
			this.options.onToggleSession(true);
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
