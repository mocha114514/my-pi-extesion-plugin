import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	visibleWidth,
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

type StatusPosition = "left" | "right";

interface StatusSlot {
	token: symbol;
	component: Component;
}

/** One physical row shared by independently enabled extensions. */
class EditorStatusRow implements Component {
	readonly slots = new Map<StatusPosition, StatusSlot>();
	private leftHit: { slot: StatusSlot; width: number } | undefined;

	constructor(readonly tui: TUI) {}

	invalidate(): void {
		this.leftHit = undefined;
		for (const slot of this.slots.values()) slot.component.invalidate();
	}

	render(width: number): string[] {
		this.leftHit = undefined;
		if (width <= 0) return [];

		const left = this.slots.get("left");
		const right = this.slots.get("right");
		const rightText = right?.component.render(width)[0] ?? "";
		const rightWidth = visibleWidth(rightText);
		// Keep the model right-aligned; constrain the indicator instead of wrapping.
		const leftBudget = Math.max(0, width - rightWidth - (rightText ? 1 : 0));
		const leftText = leftBudget > 0 ? left?.component.render(leftBudget)[0] ?? "" : "";
		const leftWidth = visibleWidth(leftText);
		if (left && leftWidth > 0) this.leftHit = { slot: left, width: leftWidth };

		if (!rightText) return leftText ? [leftText] : [];
		const padding = " ".repeat(Math.max(0, width - leftWidth - rightWidth));
		return [`${leftText}${padding}${rightText}`];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const hit = this.leftHit;
		if (
			!hit || this.slots.get("left") !== hit.slot ||
			event.y !== 0 || event.x < 0 || event.x >= hit.width
		) return undefined;
		// Preserve absolute screen coordinates so the subagent panel still opens
		// directly above this row, but do not make the padding/model clickable.
		return hit.slot.component.handleMouse?.({ ...event, width: hit.width, height: 1 });
	}
}

const WIDGET_KEY = "mpep-editor-status";
const REGISTRY = Symbol.for("mpep.editor-status-row.mounts.v1");
const shared = globalThis as typeof globalThis & {
	[REGISTRY]?: WeakMap<TUI, EditorStatusRow>;
};
// Pi evaluates shared source separately for each extension (moduleCache: false).
// The actual TUI, rather than a short-lived ExtensionContext, identifies the row.
const mounts = shared[REGISTRY] ??= new WeakMap<TUI, EditorStatusRow>();

/** Mount a single-line slot without coupling either extension to the other. */
export function setEditorStatusSlot(
	ui: ExtensionUIContext,
	position: StatusPosition,
	create: (tui: TUI) => Component,
): { dispose(): void } {
	const token = Symbol(position);
	let row: EditorStatusRow | undefined;

	ui.setWidget(WIDGET_KEY, tui => {
		row = mounts.get(tui);
		if (!row) {
			row = new EditorStatusRow(tui);
			mounts.set(tui, row);
		}
		row.slots.set(position, { token, component: create(tui) });
		row.invalidate();
		// Deliberately no widget-level dispose: Pi replaces this same widget key
		// when another slot joins. Each slot owns only its explicit teardown.
		return row;
	}, { placement: "aboveEditor" });

	return {
		dispose() {
			// A replaced slot's old owner must not remove the fresh contribution.
			if (!row || row.slots.get(position)?.token !== token) return;
			row.slots.delete(position);
			row.invalidate();
			if (row.slots.size === 0) {
				mounts.delete(row.tui);
				ui.setWidget(WIDGET_KEY, undefined);
			} else {
				row.tui.requestRender();
			}
		},
	};
}
