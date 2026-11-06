/**
 * Narrow wire contract between the deletion guard and the subagent RPC host.
 *
 * Pi already transports select dialogs and their responses over JSONL. A marked
 * title carries the structured request without adding a second IPC channel.
 * Only MPEP-spawned children use this envelope; normal human dialogs stay native.
 * Neither a request nor a cancellation grants permission to run a command.
 */
export const DELETE_GUARD_CHILD_ENV = "MPEP_DELETE_GUARD_CHILD";
export const DELETE_APPROVAL_PREFIX = "mpep.delete-guard.request.v1:";
export const DELETE_CANCEL_PREFIX = "mpep.delete-guard.cancel.v1:";

export interface DeleteApprovalRequest {
	toolCallId: string;
	toolName: string;
	cwd: string;
	command: string;
	reasons: string[];
	arguments: Record<string, unknown>;
}

export interface DeleteApprovalDecision {
	decision: "approve" | "deny";
	reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function encodeDeleteRequest(request: DeleteApprovalRequest): string {
	return DELETE_APPROVAL_PREFIX + JSON.stringify(request);
}

export function decodeDeleteRequest(title: unknown): DeleteApprovalRequest | undefined {
	if (typeof title !== "string" || !title.startsWith(DELETE_APPROVAL_PREFIX)) return;
	try {
		const value: unknown = JSON.parse(title.slice(DELETE_APPROVAL_PREFIX.length));
		if (!isRecord(value)) return;
		if (!["toolCallId", "toolName", "cwd", "command"].every(key =>
			typeof value[key] === "string" && value[key].length > 0,
		)) return;
		if (!Array.isArray(value.reasons) || value.reasons.length === 0 ||
			!value.reasons.every(reason => typeof reason === "string")) return;
		if (!isRecord(value.arguments)) return;
		return value as unknown as DeleteApprovalRequest;
	} catch {
		return;
	}
}

export function decodeDeleteDecision(value: unknown): DeleteApprovalDecision | undefined {
	if (typeof value !== "string") return;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed) || (parsed.decision !== "approve" && parsed.decision !== "deny") ||
			typeof parsed.reason !== "string" || !parsed.reason.trim()) return;
		return { decision: parsed.decision, reason: parsed.reason };
	} catch {
		// Missing, cancelled, malformed, or unrecognized answers are never approval.
		return;
	}
}
