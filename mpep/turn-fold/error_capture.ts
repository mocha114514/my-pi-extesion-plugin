import { InteractiveMode, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { observePiError } from "./turn_state_manager.ts";

interface ErrorHost {
	ui: { requestRender(): void };
	lastStatusSpacer?: unknown;
	lastStatusText?: unknown;
	showError(message: string): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
}

const patchSlot = Symbol.for("mpep.turn-fold.error-capture");
const patches = globalThis as unknown as Record<symbol, (() => void) | undefined>;

function captureError(host: ErrorHost, message: string): boolean {
	if (!observePiError(message)) return false;
	// Native errors append chat components, which breaks showStatus's consecutive
	// notification de-duplication. Preserve that boundary even without a chat row:
	// info(A), error(E), info(B) must remain A -> E -> B, not rewrite A into B.
	host.lastStatusSpacer = undefined;
	host.lastStatusText = undefined;
	return true;
}

/**
 * Pi's runtime errors bypass assistant messages and write directly to the chat.
 * Claim them at the UI write boundary, leaving the underlying events, retry
 * policy, and session untouched. Like status notifications, these diagnostics
 * are transient: only persisted assistant errors can be rebuilt from history.
 */
export function installErrorCapture(): () => void {
	patches[patchSlot]?.();
	const prototype = InteractiveMode.prototype as unknown as ErrorHost;
	const originalShowError = prototype.showError;
	const originalHandleEvent = prototype.handleEvent;
	let showingCancellation = false;

	const showError = function (this: ErrorHost, message: string): void {
		if (!showingCancellation && captureError(this, message)) {
			this.ui.requestRender();
			return;
		}
		// No owning group (or a user cancellation): retain Pi's standalone notice.
		originalShowError.call(this, message);
	};
	const handleEvent = function (this: ErrorHost, event: AgentSessionEvent): Promise<void> {
		if (
			event.type === "compaction_end" &&
			event.reason !== "manual" &&
			!event.aborted &&
			!event.result &&
			event.errorMessage &&
			captureError(this, event.errorMessage)
		) {
			// Automatic compaction writes a raw error Text rather than using showError.
			// Remove only that UI diagnostic from the delegated copy; Pi still performs
			// its normal indicator cleanup, queue flushing, and render request.
			return originalHandleEvent.call(this, { ...event, errorMessage: undefined });
		}

		// These two native branches synchronously call showError for cancellation.
		// Keep their notices visible, but do not count a deliberate stop as failure.
		const previous = showingCancellation;
		showingCancellation =
			previous ||
			(event.type === "compaction_end" && event.aborted === true) ||
			(event.type === "auto_retry_end" && event.finalError === "Retry cancelled");
		try {
			return originalHandleEvent.call(this, event);
		} finally {
			showingCancellation = previous;
		}
	};
	prototype.showError = showError;
	prototype.handleEvent = handleEvent;

	const dispose = () => {
		if (prototype.showError === showError) prototype.showError = originalShowError;
		if (prototype.handleEvent === handleEvent) prototype.handleEvent = originalHandleEvent;
		if (patches[patchSlot] === dispose) delete patches[patchSlot];
	};
	patches[patchSlot] = dispose;
	return dispose;
}
