/**
 * Lightweight footer status indicator for the symbiotic relay worker.
 *
 * Uses `ctx.ui.setStatus` so it integrates cleanly with both Pi's built-in
 * footer and MPEP's custom statusline without colliding with widget slots.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { t } from "../shared/i18n/index.ts";
import { formatCompactDuration } from "../shared/duration.ts";
import type { WorkerSnapshot } from "./worker.ts";

const STATUS_KEY = "relay-mode";

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
