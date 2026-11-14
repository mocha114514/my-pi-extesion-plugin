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

export interface DeleteApprovalPrompt {
	title: string;
	body: string;
	labels: { deny: string; approve: string };
}

type PanelKey =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.confirm"
	| "tui.select.cancel";

interface PanelOptions {
	prompt: DeleteApprovalPrompt;
	theme: Pick<Theme, "fg" | "bold">;
	rows(): number;
	remainingSeconds(): number;
	matches(data: string, action: PanelKey): boolean;
	choose(choice: string | undefined): void;
}

/** A bounded command viewport with approval actions that never scroll away. */
export class DeleteApprovalPanel implements Component {
	private readonly options: PanelOptions;
	private selectedIndex = 0;
	private optionCount = 2;
	private scrollOffset = 0;
	private bodyLines: string[] = [];
	private bodyHeight = 0;
	private bodyTop = 0;
	private contentLeft = 0;
	private contentRight = 0;
	private wrappedWidth = 0;
	private readonly actionRows = new Map<number, number>();
	private closed = false;

	constructor(options: PanelOptions) {
		this.options = options;
	}

	invalidate(): void {
		this.wrappedWidth = 0;
	}

	dispose(): void {
		this.closed = true;
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const matches = (action: PanelKey) => this.options.matches(data, action);
		if (matches("tui.select.cancel")) {
			this.finish(undefined);
		} else if (matches("tui.select.pageUp")) {
			this.scrollBy(-this.bodyHeight);
		} else if (matches("tui.select.pageDown")) {
			this.scrollBy(this.bodyHeight);
		} else if (matchesKey(data, Key.home)) {
			this.scrollBy(-this.bodyLines.length);
		} else if (matchesKey(data, Key.end)) {
			this.scrollBy(this.bodyLines.length);
		} else if (matches("tui.select.up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (matches("tui.select.down") || data === "j") {
			this.selectedIndex = Math.min(this.optionCount - 1, this.selectedIndex + 1);
		} else if (matches("tui.select.confirm") || data === "\n") {
			this.finish(this.labels()[this.selectedIndex]);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return { handled: true, render: false };
		const inside = event.x >= this.contentLeft && event.x < this.contentRight;
		if (event.type === "wheel") {
			const previous = this.scrollOffset;
			if (inside && event.y >= this.bodyTop && event.y < this.bodyTop + this.bodyHeight) {
				this.scrollBy(Math.trunc(event.wheelDelta ?? 0));
			}
			// Consume wheel input over the entire dialog, including its fixed
			// actions. It must neither change the decision nor scroll the chat.
			return { handled: true, focus: false, render: this.scrollOffset !== previous };
		}
		if (!inside || event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
		const index = this.actionRows.get(event.y);
		if (index === undefined) return undefined;
		if (event.type === "press") return { handled: true, focus: true, render: false };
		if (event.type === "click") {
			this.finish(this.labels()[index]);
			return { handled: true, render: false };
		}
		// Leave command text press/drag/release events available for selection.
		return undefined;
	}

	render(width: number): string[] {
		this.actionRows.clear();
		if (width <= 0) return [];
		const budget = Math.max(1, Math.trunc(this.options.rows()));
		const framed = width >= 8 && budget >= 7;
		const showTitle = budget >= 5;
		const showPosition = budget >= 6;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		this.contentLeft = framed ? 2 : 0;
		this.contentRight = this.contentLeft + inner;
		// If even the two actions cannot fit, only denial remains actionable.
		this.optionCount = Math.min(2, budget);
		this.selectedIndex = Math.min(this.selectedIndex, this.optionCount - 1);
		if (inner !== this.wrappedWidth) {
			// Commands are already escaped by the guard. Expand tabs to match
			// pi-tui's cell width, so terminal tab stops cannot break wrapping.
			this.bodyLines = wrapTextWithAnsi(this.options.prompt.body.replace(/\t/g, "   "), inner);
			this.wrappedWidth = inner;
		}
		const chrome = (framed ? 2 : 0) + Number(showTitle) + Number(showPosition) + this.optionCount;
		this.bodyHeight = Math.max(0, Math.min(this.bodyLines.length, budget - chrome));
		this.scrollBy(0);

		const { theme, prompt } = this.options;
		const border = (text: string) => theme.fg("border", text);
		const frame = (text: string) => {
			const clipped = truncateToWidth(text, inner, "");
			return framed
				? `${border("│")} ${clipped}${" ".repeat(inner - visibleWidth(clipped))} ${border("│")}`
				: clipped;
		};
		const lines: string[] = [];
		if (framed) lines.push(border(`┌${"─".repeat(width - 2)}┐`));
		if (showTitle) {
			const countdown = `${this.options.remainingSeconds()}s`;
			const title = truncateToWidth(prompt.title, Math.max(0, inner - visibleWidth(countdown) - 1), "…");
			lines.push(frame(theme.fg("accent", theme.bold(`${title} ${countdown}`))));
		}
		this.bodyTop = lines.length;
		for (const line of this.bodyLines.slice(this.scrollOffset, this.scrollOffset + this.bodyHeight)) {
			lines.push(frame(theme.fg("text", line)));
		}
		if (showPosition) {
			const start = this.scrollOffset + 1;
			const end = this.scrollOffset + this.bodyHeight;
			const up = this.scrollOffset > 0 ? "↑" : " ";
			const down = end < this.bodyLines.length ? "↓" : " ";
			lines.push(frame(theme.fg("dim", `${up} ${start}–${end}/${this.bodyLines.length} ${down}`)));
		}
		for (const [index, label] of this.labels().slice(0, this.optionCount).entries()) {
			this.actionRows.set(lines.length, index);
			const selected = index === this.selectedIndex;
			lines.push(frame(theme.fg(selected ? "accent" : "text", `${selected ? "→" : " "} ${label}`)));
		}
		if (framed) lines.push(border(`└${"─".repeat(width - 2)}┘`));
		return lines;
	}

	private labels(): string[] {
		const { deny, approve } = this.options.prompt.labels;
		return [deny, approve];
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(
			this.scrollOffset + delta,
			Math.max(0, this.bodyLines.length - this.bodyHeight),
		));
	}

	private finish(choice: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.options.choose(choice);
	}
}
