import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { DELETE_GUARD_CHILD_ENV, type DeleteApprovalRequest } from "../shared/delete-approval.ts";
import { t } from "../shared/i18n/index.ts";
import { ApprovalQueue, askHuman, askSupervisor } from "./approval.ts";
import { detectDeletion } from "./detection.ts";

const SLOT = Symbol.for("mpep.delete-guard.dispose.v1");
const installations = globalThis as unknown as Record<symbol, (() => void) | undefined>;
const blocked = (reason: string) => ({ block: true as const, reason });
const doNotBypass = "Do not automatically retry, disguise the command, or delegate it to a subagent to bypass approval.";

/** Preserve visible content while preventing command text from controlling the terminal. */
function visible(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, char =>
		`\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function describeRequest(request: DeleteApprovalRequest): string {
	const { command: _command, cmd: _cmd, commands: _commands, script: _script, ...other } = request.arguments;
	return [
		t("deleteGuard.tool", { name: request.toolName }),
		t("deleteGuard.cwd", { path: request.cwd }),
		t("deleteGuard.rules", { rules: request.reasons.join(", ") }),
		"",
		request.command,
		...(Object.keys(other).length ? ["", t("deleteGuard.arguments"), JSON.stringify(other, null, 2)] : []),
	].join("\n");
}

export default function deleteGuard(pi: ExtensionAPI): void {
	installations[SLOT]?.();
	if (!isPluginEnabled("delete-guard")) return;

	const child = process.env[DELETE_GUARD_CHILD_ENV] === "1";
	const queue = new ApprovalQueue();
	let active = true;
	let sessionId: string | undefined;
	let lifetime = new AbortController();

	const bind = (ctx: ExtensionContext) => {
		const nextId = ctx.sessionManager.getSessionId();
		if (sessionId === nextId) return;
		lifetime.abort();
		lifetime = new AbortController();
		sessionId = nextId;
	};

	pi.on("tool_call", async (event, ctx) => {
		// Superseded handlers leave new calls to the current installation. Any
		// already-pending call still observes its aborted lifetime below.
		if (!active) return;
		try {
			const intent = detectDeletion(event.toolName, event.input, ctx.cwd);
			if (!intent) return;
			bind(ctx);
			const request: DeleteApprovalRequest = {
				...intent,
				toolCallId: event.toolCallId,
				arguments: structuredClone(event.input),
			};
			const originalInput = JSON.stringify(event.input);
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal;
			if (signal.aborted) return blocked("Deletion approval was cancelled. Nothing was executed.");

			if (child) {
				// The supervisor owns this one pending call, without an approval
				// deadline. Its answer is never cached for a future invocation.
				if (!ctx.hasUI || ctx.mode !== "rpc") return blocked("The supervisor approval channel is unavailable; deletion was not executed.");
				const decision = await askSupervisor(ctx.ui, request, signal);
				if (signal.aborted) return blocked("Child deletion approval was cancelled. Nothing was executed.");
				if (decision.decision !== "approve") {
					return blocked(`Deletion refused by the supervisor: ${decision.reason} ${doNotBypass}`);
				}
				if (JSON.stringify(event.input) !== originalInput) return blocked("Tool arguments changed during approval. The changed command was not approved.");
				return;
			}

			// Serialize only dialogs that are currently pending. Once a call
			// settles, no permission, denial, timeout record or pause is retained.
			return await queue.run(async () => {
				if (signal.aborted || !active) return blocked("Deletion approval was cancelled. Nothing was executed.");
				if (!ctx.hasUI) return blocked("Deletion blocked: no interactive approval UI is available. Nothing was executed.");
				const decision = await askHuman(ctx.ui, visible([
					t("deleteGuard.title"),
					describeRequest(request),
					"",
					t("deleteGuard.hint"),
				].join("\n")), {
					deny: t("deleteGuard.deny"),
					approve: t("deleteGuard.approve"),
				}, signal);
				if (signal.aborted || !active) return blocked("Deletion approval was cancelled. Nothing was executed.");
				if (decision === "timeout") {
					return blocked("Deletion blocked: the user did not respond within 60 seconds and may be away from the window. " +
						"Nothing was executed. This request has ended; any later invocation requires a fresh approval.");
				}
				if (decision === "approved") {
					if (JSON.stringify(event.input) !== originalInput) return blocked("Tool arguments changed during approval. The changed command was not approved.");
					return;
				}
				return blocked(`Deletion ${decision === "denied" ? "rejected by the user" : "cancelled without approval"}. Nothing was executed. ${doNotBypass}`);
			});
		} catch (error) {
			// Pi may continue a tool after an event handler throws. Return an
			// explicit block on detection/UI failures instead of throwing through.
			return blocked(`Deletion approval could not be completed; the operation was NOT executed. ${String(error)} ${doNotBypass}`);
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!active) return;
		return { systemPrompt: `${event.systemPrompt}\n\n` +
			"[MPEP deletion guard] Matching file/directory deletions require per-call approval. " +
			(child
				? "Your supervisor decides; the original tool call waits without an approval timeout. " +
					"For deletions, call the tool directly or omit codemode timeout_ms: an explicit outer script deadline " +
					"is not paused by approval and can cancel the execution before your supervisor answers. "
				: "Your own calls require human approval within 60 seconds; child calls are decided by you through the subagent approval tool. ") +
			"Refused, cancelled, and unanswered calls have not executed. Do not bypass a user's refusal by delegating it, " +
			"changing tools, or hiding the deletion in a script. Each later invocation is approved independently; " +
			"there are no saved permissions or deferred deletion jobs." };
	});

	pi.on("session_start", (_event, ctx) => bind(ctx));
	pi.on("session_shutdown", () => {
		lifetime.abort();
		sessionId = undefined;
	});
	const dispose = () => {
		active = false;
		lifetime.abort();
		if (installations[SLOT] === dispose) delete installations[SLOT];
	};
	installations[SLOT] = dispose;
}
