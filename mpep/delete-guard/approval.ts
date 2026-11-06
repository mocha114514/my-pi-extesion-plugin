import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	DELETE_CANCEL_PREFIX,
	decodeDeleteDecision,
	encodeDeleteRequest,
	type DeleteApprovalDecision,
	type DeleteApprovalRequest,
} from "../shared/delete-approval.ts";

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
	ui: Pick<ExtensionUIContext, "select">,
	title: string,
	labels: { deny: string; approve: string },
	signal: AbortSignal,
): Promise<HumanDecision> {
	if (signal.aborted) return Promise.resolve("cancelled");
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		let settled = false;
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
			signal.removeEventListener("abort", onAbort);
			controller.abort();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// The guard timer is registered before the native UI timer, so an
		// unanswered countdown is classified as timeout, not user cancellation.
		try {
			ui.select(title, [labels.deny, labels.approve], {
				timeout: HUMAN_APPROVAL_TIMEOUT_MS,
				signal: controller.signal,
			}).then(choice => {
				finish(choice === labels.approve ? "approved" : choice === labels.deny ? "denied" : "cancelled");
			}, error => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			});
		} catch (error) {
			settled = true;
			cleanup();
			reject(error);
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
