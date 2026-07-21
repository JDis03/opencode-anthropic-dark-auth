// @ts-nocheck
export const config = {
    ccVersion: "2.1.112",
    baseBetas: [
        "claude-code-20250219",
        "oauth-2025-04-20",
        "interleaved-thinking-2025-05-14",
        "prompt-caching-scope-2026-01-05",
        "context-management-2025-06-27",
        "advisor-tool-2026-03-01",
    ],
    longContextBetas: [
        "context-1m-2025-08-07",
        "interleaved-thinking-2025-05-14",
    ],
    modelOverrides: {
        haiku: {
            exclude: ["interleaved-thinking-2025-05-14"],
            disableEffort: true,
        },
        "4-6-fast": {
            add: ["effort-2025-11-24"],
        },
        "4-6": {
            add: ["effort-2025-11-24"],
        },
        "4-7": {
            add: ["effort-2025-11-24"],
        },
        "4-8-fast": {
            add: ["effort-2025-11-24"],
        },
        "4-8": {
            add: ["effort-2025-11-24"],
        },
        "sonnet-5": {
            add: ["effort-2025-11-24"],
        },
    },
};
/**
 * Find the override entry matching a model ID.
 * Keys are matched via includes() against the lowercased model ID.
 *
 * First-match-wins: if multiple keys match, only the first (by insertion
 * order) is returned. List more specific keys before broader ones
 * (e.g. "opus-4-6" before "opus") so they take priority.
 */
export function getModelOverride(modelId) {
    const lower = modelId.toLowerCase();
    for (const [pattern, override] of Object.entries(config.modelOverrides)) {
        if (lower.includes(pattern))
            return override;
    }
    return null;
}

// ─── Context / cost tracking ──────────────────────────────────────────────────

/** Chars per token — conservative estimate (3.5 vs ~4 for pure English) */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Token thresholds that drive plugin behaviour.
 *
 *  LONG_CONTEXT_BETA  — add context-1m-2025-08-07 beta header so Anthropic
 *                        accepts >100k-token requests without rejecting them.
 *  WARN_INFO          — log to console: entering programmatic-credit territory.
 *  WARN_MODERATE      — log warning: meaningful credit spend per request.
 *  WARN_CRITICAL      — log critical: this one request alone can eat a large
 *                        chunk of the $20/mo programmatic credit pool.
 */
export const TOKEN_THRESHOLDS = {
    LONG_CONTEXT_BETA: 150_000,  // solo activar cuando realmente se acerca al límite de 200k
    WARN_INFO:        150_000,   // coincide con el beta — avisar al mismo tiempo
    WARN_MODERATE:    200_000,   // límite real del plan Pro sin usage credits
    WARN_CRITICAL:    400_000,
};

/**
 * Approximate programmatic-credit cost in USD / million input tokens.
 * Ordered most-specific first so the first match wins.
 */
export const MODEL_COSTS = [
    ["fable",    { input: 10.0, output: 50.0 }],
    ["opus-4-8", { input:  5.0, output: 25.0 }],
    ["opus-4-7", { input:  5.0, output: 25.0 }],
    ["opus-4-6", { input:  3.0, output: 15.0 }],
    ["sonnet-5", { input:  3.0, output: 15.0 }],
    ["sonnet",   { input:  3.0, output: 15.0 }],
    ["haiku",    { input:  1.0, output:  5.0 }],
];

/** Returns cost info for a model ID, or null if unknown. */
export function getModelCost(modelId) {
    const lower = modelId.toLowerCase();
    for (const [pattern, cost] of MODEL_COSTS) {
        if (lower.includes(pattern)) return cost;
    }
    return null;
}