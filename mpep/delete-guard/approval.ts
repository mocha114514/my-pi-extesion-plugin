import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	DELETE_CANCEL_PREFIX,
	decodeDeleteDecision,
	encodeDeleteRequest,
	type DeleteApprovalDecision,
	type DeleteApprovalRequest,
} from "../shared/delete-approval.ts";
import { DeleteApprovalPanel, type DeleteApprovalPrompt } from "./panel.ts";

export const HUMAN_APPROVAL_TIMEOUT_MS = 60_000;
export type HumanDecision = "approved" | "denied" | "cancelled" | "timeout";

/** One visible human dialog at a time; queued requests do not spend their 60s. */
export class ApprovalQueue {
	private tail: Promise<void> = Promise.resolve();

	run<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.then(work);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}
}

/**
 * Keep a real deadline in addition to Pi's visual countdown. An RPC UI that
 * ignores the native timeout must not leave human approval pending forever.
 * The first option is denial, so pressing Enter never approves by default.
 */
export function askHuman(
	ui: Pick<ExtensionUIContext, "select" | "custom">,
	prompt: DeleteApprovalPrompt,
	signal: AbortSignal,
	mode: ExtensionContext["mode"],
): Promise<HumanDecision> {
	if (signal.aborted) return Promise.resolve("cancelled");
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		const deadline = Date.now() + HUMAN_APPROVAL_TIMEOUT_MS;
		let settled = false;
		let closePanel: (() => void) | undefined;
		let refreshTimer: ReturnType<typeof setInterval> | undefined;
		const finish = (decision: HumanDecision) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(decision);
		};
		const onAbort = () => finish("cancelled");
		const timer = setTimeout(() => finish("timeout"), HUMAN_APPROVAL_TIMEOUT_MS);
		const cleanup = () => {
			clearTimeout(timer);
			clearInterval(refreshTimer);
			signal.removeEventListener("abort", onAbort);
			controller.abort();
			closePanel?.();
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// Register the real deadline before opening either UI. Scrolling and
		// redraws never extend it, and an unanswered dialog remains a timeout.
		try {
			let choice: Promise<string | undefined>;
			if (mode === "tui") {
				let cancelPanel: (() => void) | undefined;
				choice = ui.custom<string | undefined>((tui, theme, keys, done) => {
					const panel = new DeleteApprovalPanel({
						prompt,
						theme,
						rows: () => tui.terminal.rows,
						remainingSeconds: () => Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)),
						matches: (data, action) => keys.matches(data, action),
						choose: done,
					});
					cancelPanel = () => {
						panel.dispose();
						done(undefined);
					};
					if (!settled) refreshTimer = setInterval(() => tui.requestRender(), 1_000);
					return panel;
				}, {
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "100%",
						maxHeight: "100%",
						margin: { left: 1, right: 1 },
					},
					onHandle: () => {
						// Pi mounts custom components asynchronously. Do not call
						// done before mounting: it could hide an unrelated overlay.
						closePanel = cancelPanel;
						if (settled) closePanel?.();
					},
				});
			} else {
				// RPC clients own their UI and cannot render terminal components.
				choice = ui.select(`${prompt.title}\n${prompt.body}`, [prompt.labels.deny, prompt.labels.approve], {
					timeout: HUMAN_APPROVAL_TIMEOUT_MS,
					signal: controller.signal,
				});
			}
			choice.then(value => {
				finish(value === prompt.labels.approve ? "approved" : value === prompt.labels.deny ? "denied" : "cancelled");
			}, fail);
		} catch (error) {
			fail(error);
		}
	});
}

/**
 * Child approvals intentionally have NO deadline. The original tool_call stays
 * suspended until the supervisor answers; abort/shutdown is cancellation, not
 * an approval timeout. Cancellation also retires the parent's pending record.
 * This does not remove a caller's independent execution deadline (e.g. an
 * explicit codemode timeout_ms). Pi exposes an agent-run signal here, not the
 * nested tool's signal; its execution layer still rejects cancelled calls after
 * the hook returns. The child prompt therefore recommends direct tool calls or
 * omitting an outer deadline when human/supervisor latency must be unbounded.
 */
export async function askSupervisor(
	ui: Pick<ExtensionUIContext, "select" | "notify">,
	request: DeleteApprovalRequest,
	signal: AbortSignal,
): Promise<DeleteApprovalDecision> {
	const cancelled = { decision: "deny", reason: "The child deletion approval was cancelled; nothing was executed." } as const;
	if (signal.aborted) return cancelled;
	let onAbort: () => void = () => {};
	const aborted = new Promise<undefined>(resolve => {
		onAbort = () => {
			try { ui.notify(DELETE_CANCEL_PREFIX + request.toolCallId, "info"); }
			catch { /* A closing transport cannot authorize the pending deletion. */ }
			resolve(undefined);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const response = await Promise.race([
			ui.select(encodeDeleteRequest(request), ["deny", "approve"], { signal }),
			aborted,
		]);
		if (signal.aborted) return cancelled;
		return decodeDeleteDecision(response) ?? {
			decision: "deny",
			reason: "No valid supervisor approval was received. The deletion was not executed; do not bypass approval.",
		};
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
