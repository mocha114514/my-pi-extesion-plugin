// Hover preview and click-to-open for path-link chips.

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getOsc8LinkAtColumn,
	type OverlayHandle,
	truncateToWidth,
	TuiAltScreen,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { openLocalPath } from "../shared/open-local-path.ts";
import { decodePathHref, isCompletePath, isWebHref, resolveOpenTarget } from "./paths.ts";

type PathTheme = Pick<Theme, "fg">;

interface TuiInternals {
	previousScreen?: string[];
	handleViewportInput?: (data: string) => { consume?: boolean } | undefined;
	openUrl?: (url: string) => void;
	flash?: (message: string, durationMs?: number) => void;
	isOverlayFocused?: () => boolean;
}

const ATTACHED = Symbol.for("mpep.path-links.attached");
const HOVER_DELAY_MS = 160;

class PathPreview implements Component {
	private readonly path: string;
	private readonly theme: () => PathTheme;

	constructor(path: string, theme: () => PathTheme) {
		this.path = path.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 8) return [];
		const theme = this.theme();
		const inner = width - 4;
		const body = wrapTextWithAnsi(this.path, Math.max(1, inner));
		const visible = body.slice(0, 8);
		if (body.length > 8) visible[7] = truncateToWidth(`${visible[7]}...`, inner, "...");
		const top = `\u250c${"\u2500".repeat(Math.max(0, width - 2))}\u2510`;
		return [
			theme.fg("border", top),
			...visible.map((line) => {
				const text = truncateToWidth(line, inner, "");
				return (
					theme.fg("border", "\u2502 ") +
					theme.fg("text", text + " ".repeat(Math.max(0, inner - visibleWidth(text)))) +
					theme.fg("border", " \u2502")
				);
			}),
			theme.fg("border", `\u2514${"\u2500".repeat(width - 2)}\u2518`),
		];
	}
}

interface PointerState {
	dragged: boolean;
}

export function installPathLinkInteraction(options: { theme(): PathTheme }): { attach(tui: TUI): boolean; dispose(): void } {
	const attachments = new Map<TuiAltScreen, () => void>();
	const originalSetLayoutRoot = TuiAltScreen.prototype.setLayoutRoot;
	let disposed = false;

	const attach = (reference: TUI): boolean => {
		const tui = reference.valueOf();
		if (disposed || !(tui instanceof TuiAltScreen)) return false;
		if (attachments.has(tui)) return true;

		const internals = tui as unknown as TuiInternals;
		if (typeof internals.handleViewportInput !== "function") return false;
		if (Reflect.get(tui, ATTACHED)) return true;

		const pointer: PointerState = { dragged: false };
		let preview: OverlayHandle | undefined;
		let previewTimer: ReturnType<typeof setTimeout> | undefined;
		let pendingHref: string | undefined;

		const hidePreview = () => {
			if (previewTimer) clearTimeout(previewTimer);
			previewTimer = undefined;
			pendingHref = undefined;
			preview?.hide();
			preview = undefined;
		};

		const showPreview = (path: string, x: number, y: number) => {
			if (internals.isOverlayFocused?.()) return;
			const width = Math.min(72, Math.max(16, Math.min(tui.terminal.columns - 2, visibleWidth(path) + 4)));
			if (width < 12) return;
			const component = new PathPreview(path, options.theme);
			const height = component.render(width).length;
			const col = Math.max(0, Math.min(x - Math.floor(width / 2), tui.terminal.columns - width));
			const row = y - height >= 0 ? y - height : Math.min(y + 1, Math.max(0, tui.terminal.rows - height));
			preview = tui.showOverlay(component, {
				width,
				maxHeight: height,
				col,
				row,
				nonCapturing: true,
			});
		};

		const originalInput = internals.handleViewportInput;
		const wrappedInput = (data: string): { consume?: boolean } | undefined => {
			const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
			if (!mouse) {
				hidePreview();
				return originalInput.call(tui, data);
			}
			const button = Number(mouse[1]);
			const x = Number(mouse[2]) - 1;
			const y = Number(mouse[3]) - 1;
			const release = mouse[4] === "m";
			const motion = (button & 32) !== 0;
			const line = internals.previousScreen?.[Math.max(0, Math.min((internals.previousScreen?.length ?? 1) - 1, y))] ?? "";
			const href = getOsc8LinkAtColumn(line, Math.max(0, x));
			const preview = decodePathHref(href) ?? (isWebHref(href) ? href : undefined);

			if (motion && (button & 3) === 3) {
				if (!preview || internals.isOverlayFocused?.()) {
					hidePreview();
				} else if (pendingHref !== href) {
					hidePreview();
					pendingHref = href;
					previewTimer = setTimeout(() => {
						previewTimer = undefined;
						if (pendingHref !== href || !preview) return;
						showPreview(preview, x, y);
					}, HOVER_DELAY_MS);
					previewTimer.unref();
				}
			} else {
				if (!motion && !release) {
					pointer.dragged = false;
				} else if (motion) {
					pointer.dragged = true;
				}
				hidePreview();
			}
			return originalInput.call(tui, data);
		};
		internals.handleViewportInput = wrappedInput;

		const originalOpenUrl = internals.openUrl;
		function wrappedOpenUrl(url: string): void {
			const path = decodePathHref(url);
			if (!path) {
				originalOpenUrl?.(url);
				return;
			}
			if (pointer.dragged || !isCompletePath(path)) return;
			void openLocalPath(resolveOpenTarget(path)).catch(() => {});
		}
		internals.openUrl = wrappedOpenUrl;

		const restore = () => {
			hidePreview();
			if (internals.handleViewportInput === wrappedInput) internals.handleViewportInput = originalInput;
			if (internals.openUrl === wrappedOpenUrl) internals.openUrl = originalOpenUrl;
			Reflect.deleteProperty(tui, ATTACHED);
		};

		Reflect.set(tui, ATTACHED, true);
		attachments.set(tui, restore);
		return true;
	};

	const setLayoutRoot = function (this: TuiAltScreen, component: Parameters<TuiAltScreen["setLayoutRoot"]>[0]): void {
		originalSetLayoutRoot.call(this, component);
		if (component) attach(this);
	};
	TuiAltScreen.prototype.setLayoutRoot = setLayoutRoot;

	return {
		attach,
		dispose() {
			if (disposed) return;
			disposed = true;
			if (TuiAltScreen.prototype.setLayoutRoot === setLayoutRoot) TuiAltScreen.prototype.setLayoutRoot = originalSetLayoutRoot;
			for (const restore of attachments.values()) restore();
			attachments.clear();
		},
	};
}
