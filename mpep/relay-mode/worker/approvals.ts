/**
 * Deletion-approval request broker for the symbiotic relay worker.
 *
 * Captures `delete-guard` RPC `select` prompts from the worker, deduplicates by
 * `toolCallId`, tracks pending approval entries, and forwards explicit
 * foreground approve/deny decisions or cancellations back over JSONL-RPC.
 */

import { randomUUID } from "node:crypto";
import {
	DELETE_APPROVAL_PREFIX,
	decodeDeleteRequest,
	type DeleteApprovalDecision,
} from "../../shared/delete-approval.ts";
import type { RpcUIResponder } from "../rpc-client.ts";
import type { PendingApprovalEntry, PendingWorkerApproval } from "./types.ts";

export class WorkerApprovalBroker {
	private pending = new Map<string, PendingApprovalEntry>();
	private seenCalls = new Set<string>();

	get size(): number {
		return this.pending.size;
	}

	clearSeen(): void {
		this.seenCalls.clear();
	}

	list(): PendingWorkerApproval[] {
		return [...this.pending.values()].map((entry) => entry.data);
	}

	tryCaptureDeletePrompt(
		message: Record<string, unknown>,
		respond: RpcUIResponder,
	): PendingWorkerApproval | undefined {
		if (
			message.method !== "select" ||
			typeof message.title !== "string" ||
			!message.title.startsWith(DELETE_APPROVAL_PREFIX)
		) {
			return undefined;
		}

		const request = decodeDeleteRequest(message.title);
		if (
			!request ||
			this.seenCalls.has(request.toolCallId) ||
			!Array.isArray(message.options) ||
			message.options.length !== 2 ||
			message.options[0] !== "deny" ||
			message.options[1] !== "approve" ||
			message.timeout !== undefined
		) {
			return undefined;
		}

		this.seenCalls.add(request.toolCallId);
		const requestId = randomUUID();
		const data: PendingWorkerApproval = {
			requestId,
			requestedAt: Date.now(),
			request,
		};
		this.pending.set(requestId, { data, respond });
		return data;
	}

	decide(
		requestId: string,
		decision: DeleteApprovalDecision["decision"],
		reason: string,
		isWorkerAlive: boolean,
	): PendingWorkerApproval {
		if ((decision !== "approve" && decision !== "deny") || !reason.trim()) {
			throw new Error("Approval decisions require approve/deny and a non-empty reason.");
		}
		const entry = this.pending.get(requestId);
		if (!entry || !isWorkerAlive) {
			throw new Error(`Unknown or expired approval request: ${requestId}`);
		}
		this.pending.delete(requestId);
		if (!entry.respond({ value: JSON.stringify({ decision, reason } satisfies DeleteApprovalDecision) })) {
			throw new Error(`Approval request ${requestId} could not be delivered (worker unreachable).`);
		}
		return entry.data;
	}

	cancel(toolCallId?: string): boolean {
		let removedAny = false;
		for (const [id, entry] of this.pending) {
			if (toolCallId !== undefined && entry.data.request.toolCallId !== toolCallId) continue;
			this.pending.delete(id);
			entry.respond({ cancelled: true });
			removedAny = true;
		}
		return removedAny;
	}
}
