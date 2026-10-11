import { join } from "node:path";
import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isPluginEnabled } from "../manager/preferences.ts";
import { t } from "../shared/i18n/index.ts";
import { CitationCollector } from "./citations.ts";
import {
    emptySearchRules,
    loadSearchRules,
    type SearchRules,
} from "./config.ts";
import { injectWebSearch, shouldUseOfficialSearch } from "./payload.ts";

/**
 * Pi added this public hook in 0.99. The repository's older development SDK
 * does not declare it, so describe only this event locally instead of upgrading
 * every extension's dependencies or casting all extension methods to any.
 */
interface ProviderStreamEvent {
    type: "provider_stream_event";
    api: string;
    provider: string;
    model: string;
    data: unknown;
}

interface ProviderStreamHooks {
    on(
        event: "provider_stream_event",
        handler: (
            event: ProviderStreamEvent,
            ctx: ExtensionContext,
        ) => void | Promise<void>,
    ): () => void;
}

export default function responsesOfficialSearchExtension(pi: ExtensionAPI): void {
    if (!isPluginEnabled("responses-OpenAI-offical-search")) return;

    let rules: SearchRules = emptySearchRules();
    let sessionId: string | undefined;
    let generation = 0;
    const collectors = new Map<string, CitationCollector>();

    const clearCitations = () => {
        for (const collector of collectors.values()) collector.clear();
        collectors.clear();
    };

    const reset = () => {
        generation++;
        rules = emptySearchRules();
        sessionId = undefined;
        clearCitations();
    };

    const syncSession = (ctx: ExtensionContext) => {
        const currentId = ctx.sessionManager.getSessionId();
        if (sessionId === currentId) return;
        clearCitations();
        sessionId = currentId;
    };

    const collectorKey = (provider: string, model: string) =>
        JSON.stringify([provider, model]);

    pi.on("session_start", async (_event, ctx) => {
        reset();
        const startupGeneration = generation;
        try {
            const loaded = await loadSearchRules(join(getAgentDir(), "models.json"));
            // A newer startup or shutdown can supersede the asynchronous read.
            if (startupGeneration !== generation) return;
            rules = loaded;
            sessionId = ctx.sessionManager.getSessionId();
        } catch (error) {
            if (startupGeneration !== generation) return;
            ctx.ui.notify(t("responsesSearch.configFailed", {
                error: error instanceof Error ? error.message : "Invalid search configuration",
            }), "error");
        }
    });

    pi.on("before_provider_request", (event, ctx) => {
        syncSession(ctx);
        if (!shouldUseOfficialSearch(ctx.model, rules)) return;
        // No new provider or transport: existing HTTP/WS code sends this payload.
        // The server chooses whether to search; tool_choice is left untouched.
        return injectWebSearch(event.payload);
    });

    const streamHooks = pi as ExtensionAPI & ProviderStreamHooks;
    streamHooks.on("provider_stream_event", (event, ctx) => {
        syncSession(ctx);
        if (!shouldUseOfficialSearch({
            api: event.api,
            provider: event.provider,
            id: event.model,
        }, rules)) return;

        // Raw event ownership stays with the adapter. Capture only citation data;
        // never rewrite the event, the native parser, or the response stream.
        const key = collectorKey(event.provider, event.model);
        let collector = collectors.get(key);
        if (!collector) {
            collector = new CitationCollector(t("responsesSearch.sources"));
            collectors.set(key, collector);
        }
        collector.observe(event.data);
    });

    pi.on("message_end", (event, ctx) => {
        syncSession(ctx);
        const message = event.message;
        if (message.role !== "assistant" || !shouldUseOfficialSearch({
            api: message.api,
            provider: message.provider,
            id: message.model,
        }, rules)) return;

        const collector = collectors.get(collectorKey(message.provider, message.model));
        const patched = collector?.apply(message);
        return patched ? { message: patched } : undefined;
    });

    // Request-local records must not survive an ended/aborted run or reload.
    pi.on("agent_end", clearCitations);
    pi.on("session_shutdown", reset);
}
