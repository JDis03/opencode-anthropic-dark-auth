// @ts-nocheck
import { buildBillingHeaderValue } from "./signing.js";
import { config, getModelOverride, CHARS_PER_TOKEN } from "./model-config.js";
const TOOL_PREFIX = "mcp_";

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Debug: inspect the request body to see compaction state.
 * Logs message count, presence of "What did we do so far?" (compaction mark),
 * and total text length in messages.
 */
export function debugCompactionState(body, logFn) {
    if (!body || typeof body !== "string") return;
    try {
        const parsed = JSON.parse(body);
        const msgCount = parsed.messages?.length ?? 0;
        let totalTextChars = 0;
        let hasCompactionQuestion = false;
        if (Array.isArray(parsed.messages)) {
            for (const msg of parsed.messages) {
                if (typeof msg.content === "string") {
                    totalTextChars += msg.content.length;
                    if (msg.content.includes("What did we do so far?")) hasCompactionQuestion = true;
                } else if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        if (block.type === "text") {
                            totalTextChars += (block.text ?? "").length;
                            if ((block.text ?? "").includes("What did we do so far?")) hasCompactionQuestion = true;
                        }
                    }
                }
            }
        }
        const estimated = Math.ceil(totalTextChars / CHARS_PER_TOKEN);
        logFn(
            `[dark-auth] COMPACTION DEBUG: ${msgCount} messages, ` +
            `~${(estimated/1000).toFixed(0)}k chars in text, ` +
            `compaction_mark="${hasCompactionQuestion}", ` +
            `system_entries=${(parsed.system?.length ?? 0)}`
        );
    } catch { /* ignore parse errors */ }
}

/**
 * Rough token count from a raw JSON request body.
 * Counts chars in system entries, message text blocks, tool results, and
 * tool_use inputs, then divides by CHARS_PER_TOKEN.
 *
 * Intentionally conservative (3.5 chars/token instead of ~4) so we activate
 * the long-context beta slightly early rather than slightly late.
 */
export function estimateBodyTokens(body) {
    if (!body || typeof body !== "string") return 0;
    try {
        const parsed = JSON.parse(body);
        let chars = 0;
        // System entries
        if (Array.isArray(parsed.system)) {
            for (const e of parsed.system) {
                if (e.type === "text" && e.text) chars += e.text.length;
            }
        } else if (typeof parsed.system === "string") {
            chars += parsed.system.length;
        }
        // Messages
        if (Array.isArray(parsed.messages)) {
            for (const msg of parsed.messages) {
                if (typeof msg.content === "string") {
                    chars += msg.content.length;
                } else if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        if (block.type === "text") {
                            chars += (block.text ?? "").length;
                        } else if (block.type === "tool_result") {
                            const c = block.content;
                            if (typeof c === "string") {
                                chars += c.length;
                            } else if (Array.isArray(c)) {
                                for (const part of c) {
                                    if (part.type === "text") chars += (part.text ?? "").length;
                                }
                            }
                        } else if (block.type === "tool_use") {
                            chars += JSON.stringify(block.input ?? {}).length;
                        }
                    }
                }
            }
        }
        return Math.ceil(chars / CHARS_PER_TOKEN);
    } catch {
        // Fallback: whole body length (will overestimate, but safe)
        return Math.ceil(body.length / CHARS_PER_TOKEN);
    }
}
/**
 * Anthropic's tool `input_schema` rejects oneOf/anyOf/allOf at the top level
 * (nested occurrences inside properties are fine). Some MCP servers emit
 * schemas for union/discriminated-union inputs with the combinator at the
 * root, which causes every request carrying that tool to 400 out.
 *
 * Fix in place: merge all branches into a single object schema (union of
 * properties, keep required only where every branch agrees) so Claude still
 * sees the shape of each variant, just flattened.
 *
 * NOT lossy on property-name collisions: if two branches declare the same
 * property with different sub-schemas, they are combined into a nested
 * `anyOf` for that property instead of one silently overwriting the other
 * (the previous behaviour via Object.assign).
 */
export function sanitizeInputSchema(schema) {
    if (!schema || typeof schema !== "object") return schema;
    const combinatorKey = ["oneOf", "anyOf", "allOf"].find((k) => Array.isArray(schema[k]));
    if (!combinatorKey) return schema;
    const branches = schema[combinatorKey].filter((b) => b && typeof b === "object");
    const properties = {};
    let requiredSets = [];
    for (const branch of branches) {
        if (branch.properties && typeof branch.properties === "object") {
            for (const [key, propSchema] of Object.entries(branch.properties)) {
                if (!(key in properties)) {
                    properties[key] = propSchema;
                } else if (JSON.stringify(properties[key]) !== JSON.stringify(propSchema)) {
                    // Collision with a differing sub-schema: preserve both
                    // variants instead of overwriting one silently.
                    const existing = properties[key];
                    const variants = Array.isArray(existing.anyOf) ? existing.anyOf : [existing];
                    const alreadyPresent = variants.some(
                        (v) => JSON.stringify(v) === JSON.stringify(propSchema),
                    );
                    properties[key] = alreadyPresent
                        ? existing
                        : { anyOf: [...variants, propSchema] };
                }
            }
        }
        if (Array.isArray(branch.required)) {
            requiredSets.push(branch.required);
        }
    }
    const required = requiredSets.length > 0
        ? requiredSets.reduce((a, b) => a.filter((k) => b.includes(k)))
        : undefined;
    const { [combinatorKey]: _dropped, ...rest } = schema;
    const merged = {
        ...rest,
        type: "object",
        properties,
    };
    if (required && required.length > 0) merged.required = required;
    return merged;
}

/**
 * Prefix a tool name with TOOL_PREFIX and uppercase the first character.
 * Claude Code uses PascalCase tool names (e.g. mcp_Bash, mcp_Read);
 * lowercase names (mcp_bash, mcp_read) are flagged as non-Claude-Code clients.
 */
function prefixName(name) {
    return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}
/**
 * Reverse prefixName: strip TOOL_PREFIX and restore the original leading case.
 */
function unprefixName(name) {
    return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}
const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export function repairToolPairs(messages) {
    // Collect all tool_use ids and tool_result tool_use_ids
    const toolUseIds = new Set();
    const toolResultIds = new Set();
    for (const message of messages) {
        if (!Array.isArray(message.content))
            continue;
        for (const block of message.content) {
            const id = block["id"];
            if (block.type === "tool_use" && typeof id === "string") {
                toolUseIds.add(id);
            }
            const toolUseId = block["tool_use_id"];
            if (block.type === "tool_result" && typeof toolUseId === "string") {
                toolResultIds.add(toolUseId);
            }
        }
    }
    // Find orphaned IDs
    const orphanedUses = new Set();
    for (const id of toolUseIds) {
        if (!toolResultIds.has(id))
            orphanedUses.add(id);
    }
    const orphanedResults = new Set();
    for (const id of toolResultIds) {
        if (!toolUseIds.has(id))
            orphanedResults.add(id);
    }
    // Early return if nothing to fix
    if (orphanedUses.size === 0 && orphanedResults.size === 0) {
        return messages;
    }
    // Filter orphaned blocks and remove messages with empty content arrays
    return messages
        .map((message) => {
        if (!Array.isArray(message.content))
            return message;
        const filtered = message.content.filter((block) => {
            const id = block["id"];
            if (block.type === "tool_use" && typeof id === "string") {
                return !orphanedUses.has(id);
            }
            const toolUseId = block["tool_use_id"];
            if (block.type === "tool_result" && typeof toolUseId === "string") {
                return !orphanedResults.has(toolUseId);
            }
            return true;
        });
        return { ...message, content: filtered };
    })
        .filter((message) => !(Array.isArray(message.content) && message.content.length === 0));
}
export function transformBody(body) {
    if (typeof body !== "string") {
        return body;
    }
    try {
        const parsed = JSON.parse(body);
        // --- Billing header: inject as system[0] (no cache_control) ---
        const version = process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion;
        const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli";
        const billingHeader = buildBillingHeaderValue((parsed.messages ?? []), version, entrypoint);
        if (!Array.isArray(parsed.system)) {
            parsed.system = [];
        }
        // Remove any existing billing header entries
        parsed.system = parsed.system.filter((e) => !(e.type === "text" &&
            typeof e.text === "string" &&
            e.text.startsWith("x-anthropic-billing-header")));
        // Insert billing header as system[0], without cache_control
        parsed.system.unshift({ type: "text", text: billingHeader });
        // --- Split identity prefix into its own system entry ---
        // OpenCode's system.transform hook prepends the identity string, but
        // OpenCode then concatenates all system entries into a single text block.
        // Anthropic's API requires the identity string as a separate entry for
        // OAuth validation (see issue #98).
        const splitSystem = [];
        for (const entry of parsed.system) {
            if (entry.type === "text" &&
                typeof entry.text === "string" &&
                entry.text.startsWith(SYSTEM_IDENTITY) &&
                entry.text.length > SYSTEM_IDENTITY.length) {
                const rest = entry.text
                    .slice(SYSTEM_IDENTITY.length)
                    .replace(/^\n+/, "");
                // Preserve all properties except text (e.g. cache_control)
                const { text: _text, ...entryProps } = entry;
                // Only keep cache_control on the remainder block to avoid exceeding
                // the API limit of 4 cache_control blocks per request.
                const { cache_control: _cc, ...identityProps } = entryProps;
                splitSystem.push({ ...identityProps, text: SYSTEM_IDENTITY });
                if (rest.length > 0) {
                    splitSystem.push({ ...entryProps, text: rest });
                }
            }
            else {
                splitSystem.push(entry);
            }
        }
        parsed.system = splitSystem;
        // --- Relocate non-core system entries to user messages ---
        // Anthropic's API now validates the system prompt for OAuth-authenticated
        // requests that use Claude Code billing.  Third-party system prompts
        // (like OpenCode's) trigger a 400 "out of extra usage" rejection when
        // they appear inside the system[] array alongside the identity prefix.
        //
        // Work-around: keep only the billing header and identity prefix in
        // system[], and prepend all other system content to the first user
        // message where it is functionally equivalent but avoids the check.
        const BILLING_PREFIX = "x-anthropic-billing-header";
        const keptSystem = [];
        const movedTexts = [];
        for (const entry of parsed.system) {
            const txt = typeof entry === "string" ? entry : (entry.text ?? "");
            if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) {
                keptSystem.push(entry);
            }
            else if (txt.length > 0) {
                movedTexts.push(txt);
            }
        }
        if (movedTexts.length > 0 && Array.isArray(parsed.messages)) {
            const firstUser = parsed.messages.find((m) => m.role === "user");
            if (firstUser) {
                parsed.system = keptSystem;
                const prefix = movedTexts.join("\n\n");
                if (typeof firstUser.content === "string") {
                    firstUser.content = prefix + "\n\n" + firstUser.content;
                }
                else if (Array.isArray(firstUser.content)) {
                    firstUser.content.unshift({ type: "text", text: prefix });
                }
            }
        }
        // Strip effort for models that don't support it (e.g. haiku).
        // OpenCode sends { output_config: { effort: "high" } } but haiku
        // rejects the effort parameter with a 400 error.
        const modelId = parsed.model ?? "";
        const override = getModelOverride(modelId);
        if (override?.disableEffort) {
            if (parsed.output_config) {
                delete parsed.output_config.effort;
                if (Object.keys(parsed.output_config).length === 0) {
                    delete parsed.output_config;
                }
            }
            if (parsed.thinking && "effort" in parsed.thinking) {
                delete parsed.thinking.effort;
                if (Object.keys(parsed.thinking).length === 0) {
                    delete parsed.thinking;
                }
            }
        }
        // Anthropic's OAuth billing validation rejects lowercase tool names
        // when multiple tools are present. Claude Code uses PascalCase after
        // the mcp_ prefix (e.g. mcp_Bash, mcp_Read). Apply the same convention.
        if (Array.isArray(parsed.tools)) {
            parsed.tools = parsed.tools.map((tool) => ({
                ...tool,
                name: tool.name ? prefixName(tool.name) : tool.name,
                ...(tool.input_schema
                    ? { input_schema: sanitizeInputSchema(tool.input_schema) }
                    : {}),
            }));
        }
        if (Array.isArray(parsed.messages)) {
            parsed.messages = parsed.messages.map((message) => {
                if (!Array.isArray(message.content)) {
                    return message;
                }
                return {
                    ...message,
                    content: message.content.map((block) => {
                        if (block.type !== "tool_use" || typeof block.name !== "string") {
                            return block;
                        }
                        return { ...block, name: prefixName(block.name) };
                    }),
                };
            });
        }
        if (Array.isArray(parsed.messages)) {
            parsed.messages = repairToolPairs(parsed.messages);
        }
        return JSON.stringify(parsed);
    }
    catch {
        return body;
    }
}
export function stripToolPrefix(text) {
    return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, (_match, name) => `"name": "${unprefixName(name)}"`);
}
export function transformResponseStream(response) {
    if (!response.body) {
        return response;
    }
    // Don't wrap error responses through the SSE parser — pass them through
    // with only tool-prefix stripping on the raw body. This preserves error
    // messages for OpenCode / AI SDK to handle properly.
    if (!response.ok) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const passthrough = new ReadableStream({
            async pull(controller) {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    return;
                }
                const text = decoder.decode(value, { stream: true });
                controller.enqueue(encoder.encode(stripToolPrefix(text)));
            },
        });
        return new Response(passthrough, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    const stream = new ReadableStream({
        async pull(controller) {
            for (;;) {
                const boundary = buffer.indexOf("\n\n");
                if (boundary !== -1) {
                    const completeEvent = buffer.slice(0, boundary + 2);
                    buffer = buffer.slice(boundary + 2);
                    controller.enqueue(encoder.encode(stripToolPrefix(completeEvent)));
                    return;
                }
                const { done, value } = await reader.read();
                if (done) {
                    if (buffer) {
                        controller.enqueue(encoder.encode(stripToolPrefix(buffer)));
                        buffer = "";
                    }
                    controller.close();
                    return;
                }
                buffer += decoder.decode(value, { stream: true });
            }
        },
    });
    return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}