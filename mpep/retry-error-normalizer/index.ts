import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";

// Diagnostic text is part of Pi's retry-classification contract, not UI copy.
const INTERRUPTED_RESPONSE_MESSAGE =
    "Responses WebSocket interrupted before a terminal response.";

/**
 * Classify one known transient interruption without implementing a retry loop.
 * Preserve the original diagnostic and every other field of the failed response.
 * Length stops, cancellation, and unrelated errors must keep their own policies.
 */
export function normalizeRetryError(
    message: AssistantMessage,
): AssistantMessage | undefined {
    if (message.stopReason !== "error" ||
        message.errorMessage !== INTERRUPTED_RESPONSE_MESSAGE) {
        return undefined;
    }

    return {
        ...message,
        errorMessage: `WebSocket error: ${message.errorMessage}`,
    };
}

export default function retryErrorNormalizer(pi: ExtensionAPI): void {
    if (!isPluginEnabled("retry-error-normalizer")) return;

    // Pi applies this public replacement before persistence and retry decisions.
    // It remains responsible for retry budgets, backoff, cancellation, and context.
    pi.on("message_end", (event) => {
        if (event.message.role !== "assistant") return;

        const message = normalizeRetryError(event.message);
        if (message) return { message };
    });
}
