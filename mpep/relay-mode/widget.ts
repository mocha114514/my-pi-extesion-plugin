/**
 * TUI visual indicators for relay-mode:
 *   1. Footer status badge (`updateRelayStatusBar`) reporting live worker state.
 *   2. Editor bottom-right border button (`createRelayBorderBadge`) displaying
 *      `relay mode` in muted gray when inactive and a multi-color breathing
 *      glow (randomly rotating to a fresh color at each dark trough) when
 *      active, opening the interactive settings modal on click.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createEditorBorder, type EditorBorderHandle } from "../shared/editor-border.ts";
import { formatCompactDuration } from "../shared/duration.ts";
import { t } from "../shared/i18n/index.ts";
import type { WorkerSnapshot } from "./worker/index.ts";

const STATUS_KEY = "relay-mode";
const BORDER_WIDGET_KEY = "mpep-relay-mode-border";
const LABEL_TEXT = "relay mode";
const BREATH_TICK_MS = 100;
const BREATH_STEPS_PER_CYCLE = 28; // ~2.8s per full dim -> bright -> dim cycle

type Rgb = readonly [number, number, number];

/** Soft dim baseline close to muted border text so color transitions at the trough feel seamless. */
const TROUGH_RGB: Rgb = [110, 118, 130];

/** Curated luminous palette cycled randomly after every full breathing cycle. */
export const BREATH_PALETTE: readonly Rgb[] = [
	[56, 189, 248], // sky cyan
	[52, 211, 153], // mint emerald
	[167, 139, 250], // soft violet
	[251, 113, 133], // coral rose
	[251, 191, 36], // warm amber
	[96, 165, 250], // azure blue
	[45, 212, 191], // teal
	[232, 121, 249], // orchid fuchsia
];

/**
 * Pure state machine driving smooth cosine breathing brightness and trough-only
 * random color rotation (exported for direct unit verification).
 */
export class BreathingColorController {
	private phase = 0;
	private colorIndex: number;
	private readonly rng: () => number;

	constructor(rng: () => number = Math.random) {
		this.rng = rng;
		this.colorIndex = this.pickInitialIndex();
	}

	private pickInitialIndex(): number {
		return Math.floor(this.rng() * BREATH_PALETTE.length) % BREATH_PALETTE.length;
	}

	private pickNextColorIndex(previous: number): number {
		if (BREATH_PALETTE.length <= 1) return 0;
		const offset = 1 + (Math.floor(this.rng() * (BREATH_PALETTE.length - 1)) % (BREATH_PALETTE.length - 1));
		return (previous + offset) % BREATH_PALETTE.length;
	}

	getColorIndex(): number {
		return this.colorIndex;
	}

	/** Advance one frame; rotate to a new random color whenever a full cycle returns to the dark trough. */
	step(): void {
		this.phase += (2 * Math.PI) / BREATH_STEPS_PER_CYCLE;
		if (this.phase >= 2 * Math.PI) {
			this.phase %= 2 * Math.PI;
			this.colorIndex = this.pickNextColorIndex(this.colorIndex);
		}
	}

	reset(): void {
		this.phase = 0;
		this.colorIndex = this.pickNextColorIndex(this.colorIndex);
	}

	currentRgb(): Rgb {
		// Smooth cosine wave: 0 at start trough -> 1 at peak -> 0 at end trough.
		const intensity = (1 - Math.cos(this.phase)) / 2;
		const peak = BREATH_PALETTE[this.colorIndex] ?? BREATH_PALETTE[0]!;
		return [
			Math.round(TROUGH_RGB[0] + (peak[0] - TROUGH_RGB[0]) * intensity),
			Math.round(TROUGH_RGB[1] + (peak[1] - TROUGH_RGB[1]) * intensity),
			Math.round(TROUGH_RGB[2] + (peak[2] - TROUGH_RGB[2]) * intensity),
		];
	}

	render(text: string): string {
		const [r, g, b] = this.currentRgb();
		return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
	}
}

export interface RelayBorderBadgeOptions {
	isActive(): boolean;
	isPanelOpen(): boolean;
	onClick(): void;
}

export interface RelayBorderBadgeHandle {
	sync(): void;
	dispose(): void;
}

/**
 * Mount the `relay mode` indicator on the right side of the editor's bottom
 * border. Inactive sessions render static muted text (zero timer overhead);
 * active sessions run the multi-color breathing glow and stop the timer
 * immediately upon deactivation or disposal.
 */
export function createRelayBorderBadge(
	ctx: ExtensionContext,
	options: RelayBorderBadgeOptions,
): RelayBorderBadgeHandle | undefined {
	if (!ctx.hasUI || ctx.mode !== "tui") return undefined;

	let tui: TUI | undefined;
	let border: EditorBorderHandle | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	const breather = new BreathingColorController();

	const stopTimer = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	};

	const syncTimer = () => {
		if (disposed || !options.isActive()) {
			stopTimer();
			return;
		}
		if (timer) return;
		breather.reset();
		timer = setInterval(() => {
			if (disposed || !options.isActive()) {
				stopTimer();
				return;
			}
			breather.step();
			tui?.requestRender();
		}, BREATH_TICK_MS);
		timer.unref?.();
	};

	const renderLabel = (): string => {
		if (options.isActive()) {
			return breather.render(LABEL_TEXT);
		}
		return ctx.ui.theme.fg(options.isPanelOpen() ? "accent" : "muted", LABEL_TEXT);
	};

	ctx.ui.setWidget(BORDER_WIDGET_KEY, (host) => {
		tui = host;
		border?.dispose();
		border = createEditorBorder(host, {
			position: "bottom-right",
			label: renderLabel,
			onClick: () => {
				if (!disposed) options.onClick();
			},
		});
		border.sync();
		syncTimer();
		return {
			render: () => {
				border?.sync();
				return [];
			},
			invalidate() {},
		};
	});

	return {
		sync() {
			if (disposed) return;
			border?.sync();
			syncTimer();
			tui?.requestRender();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			stopTimer();
			border?.dispose();
			border = undefined;
			tui = undefined;
			ctx.ui.setWidget(BORDER_WIDGET_KEY, undefined);
		},
	};
}

/** Strip ANSI escape codes and control chars so worker tool names/paths cannot spoof TUI styling. */
function sanitizeTerminalText(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/[\x00-\x1f\x7f\x80-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function updateRelayStatusBar(ctx: ExtensionContext | undefined, snapshot: WorkerSnapshot | undefined): void {
	if (!ctx?.hasUI || ctx.mode !== "tui") return;
	if (!snapshot) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const elapsed = snapshot.runStartedAt
		? ` ${formatCompactDuration(Math.max(0, (Date.now() - snapshot.runStartedAt) / 1000))}`
		: "";

	let badge: string;
	switch (snapshot.status) {
		case "starting":
			badge = theme.fg("dim", t("relay.status.starting"));
			break;
		case "idle":
			badge = theme.fg("dim", t("relay.status.idle"));
			break;
		case "running": {
			const cleanTool = snapshot.activeTool ? sanitizeTerminalText(snapshot.activeTool) : "";
			const tool = cleanTool ? ` ${cleanTool}` : "";
			badge = theme.fg("success", `${t("relay.status.running")}${tool}${elapsed}`);
			break;
		}
		case "retrying":
			badge = theme.fg("warning", t("relay.status.retrying", { attempt: snapshot.retryAttempt ?? 1 }));
			break;
		case "compacting":
			badge = theme.fg("accent", t("relay.status.compacting"));
			break;
		case "waiting_approval":
			badge = theme.fg("warning", t("relay.status.waitingApproval"));
			break;
		case "stalled":
		case "error":
		case "crashed":
			badge = theme.fg("error", t("relay.status.abnormal", { status: snapshot.status }));
			break;
	}

	ctx.ui.setStatus(STATUS_KEY, badge);
}
