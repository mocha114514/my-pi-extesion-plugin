import type { SearchRules } from "./config.ts";

export interface SearchModel {
    api: string;
    provider: string;
    id: string;
}

/** API identity and the exact provider/model flag are the only model gates. */
export function shouldUseOfficialSearch(
    model: SearchModel | undefined,
    rules: SearchRules,
): boolean {
    return model?.api === "openai-responses" &&
        rules.enabled(model.provider, model.id);
}

/**
 * These are versions of the same hosted tool, not extra search capabilities.
 * Preserve an existing declaration and all of its controls, including previews.
 */
const webSearchType = /^web_search(?:_preview)?(?:_\d{4}_\d{2}_\d{2})?$/;

/** Append a hosted tool without mutating the original payload or tool array. */
export function injectWebSearch(payload: unknown): unknown {
    if (!isRecord(payload)) return payload;
    const tools = payload.tools;
    // Do not repair malformed or unrecognized payloads by discarding fields.
    // Pi/the provider retains responsibility for reporting their own errors.
    if (tools !== undefined && !Array.isArray(tools)) return payload;
    if (tools?.some((tool) =>
        isRecord(tool) && typeof tool.type === "string" && webSearchType.test(tool.type)
    )) return payload;

    return {
        ...payload,
        tools: [
            ...(tools ?? []),
            { type: "web_search" },
        ],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
