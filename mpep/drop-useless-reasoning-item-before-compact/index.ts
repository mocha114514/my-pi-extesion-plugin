import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";
import { buildCleanupBoundaryResult, isEditableBoundary } from "./filter.ts";

type BoundaryHandler = (
	event: unknown,
	ctx: ExtensionContext,
) => { entries: unknown[] } | undefined;

interface EditableBoundaryAPI {
	on(event: "turn_end" | "agent_before_settle", handler: BoundaryHandler): void;
}

/**
 * Omit unproductive thinking-only responses before subsequent compaction and
 * replay. The original messages stay in the transcript for inspection.
 */
export default function dropUselessReasoningBeforeCompact(pi: ExtensionAPI): void {
	if (!isPluginEnabled("drop-useless-reasoning-item-before-compact")) return;

	let warnedUnsupported = false;
	pi.on("session_start", () => {
		warnedUnsupported = false;
	});

	const clean: BoundaryHandler = (event, ctx) => {
		if (!isEditableBoundary(event)) {
			if (!warnedUnsupported) {
				warnedUnsupported = true;
				ctx.ui.notify(t("reasoningCleanup.unsupported"), "warning");
			}
			return undefined;
		}
		return buildCleanupBoundaryResult(event);
	};

	// Workspace SDK 0.85.1 predates the editable boundary typings. Keep this
	// bridge narrow and check the actual payload (verified on Pi 1.1.0), rather
	// than upgrading shared dependencies or writing through sessionManager.
	const boundaries = pi as unknown as EditableBoundaryAPI;
	boundaries.on("turn_end", clean);

	// A fallback for an otherwise unhandled final boundary, not a claim that
	// pre-settlement always precedes native post-run compaction. turn_end is
	// the primary pre-preparation hook. Neither hook drives another model run.
	boundaries.on("agent_before_settle", clean);
}
