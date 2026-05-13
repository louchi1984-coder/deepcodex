#!/usr/bin/env node
/**
 * Adaptive Codex Translator v2
 *
 * ── Architecture ──────────────────────────────────────────────
 * Startup: probe upstream → provider profile (cached)
 * Request: Responses → Chat translation
 *          + inject internal tools for missing capabilities
 *          + dynamically assemble system prompt
 *          + filter hosted-only tools based on profile
 *          + intercept & execute internal tool calls locally
 *          + Chat → Responses SSE streaming
 * ───────────────────────────────────────────────────────────────
 *
 * Internal tools are defined in tools/registry.mjs.  They are
 * injected when the upstream provider lacks a required capability
 * (e.g. hosted web_search), and executed locally when the model
 * calls them — the result goes straight back as a tool message
 * without a round-trip to Codex.
 */

import http from "node:http";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { probeCapabilities } from "./probe.mjs";
import { toolsToInject, executeInternalTool, isInternalTool, getToolChoiceForRole } from "./tools/registry.mjs";
import { buildChatToolsWithRouting } from "./compat-rules.mjs";

// ──────────────────────────────────────────────────── config ─────────────────

const HOST = process.env.TRANSLATOR_HOST || "127.0.0.1";
const PORT = Number(process.env.TRANSLATOR_PORT || 8282);
const UPSTREAM = (process.env.UPSTREAM_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const UPSTREAM_KEY = process.env.UPSTREAM_API_KEY || "";
const PROFILE_PATH = process.env.TRANSLATOR_PROFILE_PATH || "";
const MAX_TOOL_LOOPS = Number(process.env.TRANSLATOR_MAX_TOOL_LOOPS || 12);
const RESPONSES_PATHS = new Set(["/responses", "/v1/responses", "/responses/compact", "/v1/responses/compact"]);
const REASONING_BLOB_PREFIX = "deepcodex.reasoning.hex.v1:";
const DEEPCODEX_DISPLAY_NAME = process.env.DEEPCODEX_DISPLAY_NAME || "娄老师说的对";

const COMPACT_SYSTEM = [
    "You are handling a Codex CONTEXT CHECKPOINT COMPACTION request.",
    "This is not a normal user chat. Do not answer the user's original task.",
    "Write a handoff summary for the next coding agent to continue the same thread.",
    "Output plain text only, not JSON, not tool calls, not acknowledgements.",
    "Preserve concrete facts: current progress, decisions, constraints, user preferences, file paths, commands/tests run, errors, tool/process state, and clear next steps.",
    "Keep names, paths, ports, model/provider choices, and command snippets exact when present.",
    "If the conversation is in Chinese, write the summary in Chinese.",
].join("\n");

let PROFILE = null;

// ──────────────────────────────────────────────────── helpers ────────────────

function fail(res, status, msg) {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ error: { message: msg, type: "gateway_error" } }));
}

function loadProfileFromFile() {
    if (!PROFILE_PATH || !existsSync(PROFILE_PATH)) return null;
    try {
        const profile = JSON.parse(readFileSync(PROFILE_PATH, "utf8"));
        if (profile?.effective) {
            return {
                ...profile,
                ...profile.effective,
                defaults: profile.defaults,
                detected: profile.detected,
                effective: profile.effective,
                capabilities: profile.effective.capabilities || profile.capabilities || {},
                toolStrategy: profile.effective.toolStrategy || profile.toolStrategy || {},
                models: profile.effective.models || profile.models || [],
                defaultModel: profile.effective.defaultModel || profile.defaultModel,
                fastModel: profile.effective.fastModel || profile.fastModel,
            };
        }
        return profile;
    } catch (err) {
        console.error(`[adaptive] Failed to load profile ${PROFILE_PATH}: ${err.message || err}`);
        return null;
    }
}

function deepcodexUser() {
    return {
        object: "user",
        id: "deepcodex-local-user",
        name: DEEPCODEX_DISPLAY_NAME,
        email: DEEPCODEX_DISPLAY_NAME,
        image: null,
        picture: null,
        groups: [],
        accounts: [{
            id: "deepcodex-local-account",
            name: DEEPCODEX_DISPLAY_NAME,
            email: DEEPCODEX_DISPLAY_NAME,
            role: "owner",
            is_default: true,
        }],
    };
}

// ──────────────────────────────────────────────── model mapping ──────────────

const CODEX_TO_MODEL = {
    "gpt-5.5": null, "gpt-5.4": null, "gpt-5.3-codex": null, "o3": null, "o4-mini": null,
    "gpt-5.4-mini": null, "gpt-5.4-nano": null,
};
// Null means "resolve to profile default / fast".  Kept as map for future
// per-vendor overrides.

function resolveModel(model, preferFast = false) {
    const p = PROFILE || {};
    const aliases = p.codexModelAliases || p.defaults?.codexModelAliases || {};
    const alias = aliases?.[model];
    if (alias === "fast") return p.fastModel || p.defaultModel || "deepseek-v4-flash";
    if (alias === "default") return p.defaultModel || "deepseek-v4-pro";
    if (typeof alias === "string" && alias) return alias;
    if (CODEX_TO_MODEL[model] !== undefined) {
        return preferFast ? (p.fastModel || "deepseek-v4-flash") : (p.defaultModel || "deepseek-v4-pro");
    }
    return String(model || "").replace(/\[1m\]|1m$/i, "") || p.defaultModel || "deepseek-v4-pro";
}

// ──────────────────────────────────────────── provider-aware system prompt ───

function buildSystemBlock() {
    const p = PROFILE || {};
    const name = p.provider || "DeepSeek";
    const caps = p.capabilities || {};
    const lines = [];

    lines.push(`You are running through ${name}.`);

    // Capability summary
    const missing = [];
    if (!caps.hostedTools) missing.push("hosted tools");
    if (!caps.vision) missing.push("vision / image understanding");
    if (missing.length > 0) {
        lines.push(`This route does NOT support: ${missing.join(", ")}.`);
        lines.push("When a request needs these capabilities, pause the workflow and ask the user to manually take over. Give a concrete handoff instruction.");
    }

    // Internal tools available
    if (!caps.hostedTools && caps.internalWebTools !== false) {
        const searchChoice = getToolChoiceForRole("web_search", PROFILE);
        const fetchChoice = getToolChoiceForRole("web_fetch", PROFILE);
        const searchDesc = searchChoice?.definition?.function?.description || "Search the web using the translator's local search backend.";
        const fetchDesc = fetchChoice?.definition?.function?.description || "Fetch a known URL using the translator's local fetch backend.";
        lines.push("");
        lines.push("The following internal tools are available (provided by the translator, executed locally):");
        lines.push(`- web_search(query, count?) — ${searchDesc}`);
        lines.push(`- web_fetch(url) — ${fetchDesc}`);
        lines.push("");
        lines.push("Internal web tool usage rules:");
        lines.push("- Use web_search for current facts, recent events, unknown public information, external docs, product/version checks, or anything likely to have changed.");
        lines.push("- Do not use web_search for purely local codebase facts, conversation memory, or information already present in the prompt.");
        lines.push("- Treat web_search as discovery only. After search returns candidate links, use web_fetch on the most relevant original/source pages before making specific claims.");
        lines.push("- Prefer primary sources and official docs. Avoid relying on search result snippets when an original page can be fetched.");
        lines.push("- If search/fetch fails or returns weak evidence, say that web access is unavailable or inconclusive instead of guessing.");
        lines.push("- Include source URLs in the answer whenever web tools materially affect the answer.");
    }

    lines.push("");
    lines.push("Connector / app plugin rule:");
    lines.push("- Installed connector-type plugins are shared from the Codex public host.");
    lines.push("- Some connector plugins expose tools only after the connector has been activated and the host has synced app tools into the current session.");
    lines.push("- If a connector-type plugin is installed but its actual tools are absent from the current thread, do NOT inspect local plugin files, cache files, or guessed MCP registrations to answer.");
    lines.push("- In that case, treat it as: connector metadata exists, but connector tools are not active in this session yet.");
    lines.push("- Do not claim that DeepSeek or this route inherently lacks the connector unless the host explicitly says so.");
    lines.push("- Instead, tell the user the connector likely needs to be connected/reconnected in Codex Settings > Apps & Connectors and then retried in a fresh thread.");
    lines.push("- When an explicit app mention like [$name](app://connector_id) is already present and app tools are available, use them normally.");

    lines.push("");
    lines.push("Workspace rule:");
    lines.push("- This deepcodex route uses its own workspace/state root.");
    lines.push("- Treat the current thread workspace as authoritative.");
    lines.push("- If the user explicitly chooses or creates a directory, do not override it with a guessed default path.");
    lines.push("- Do not assume the same recent-project roots or default workspace layout as standard Codex.");
    lines.push("- Keep workspace/path issues separate from plugin or connector activation issues.");

    lines.push("");
    lines.push("macOS permission-sensitive action rule:");
    lines.push("- When an action may trigger a macOS system prompt or authorization sheet, do not use a very short-lived command.");
    lines.push("- Typical sensitive actions include: starting a local listener/server on localhost or 127.0.0.1, launching a browser/system app, opening local files in external apps, or invoking local renderers that spawn browsers/encoders.");
    lines.push("- For these actions, prefer a stable long-lived process and keep the triggering process alive for at least 15 seconds before assuming failure or cleaning it up.");
    lines.push("- Do not immediately replace a just-started local server with another server on a different port unless the first attempt clearly failed.");
    lines.push("- If a permission prompt may be pending, tell the user to click Allow and wait instead of rapidly retrying with alternate commands.");

    lines.push("");
    lines.push("Markdown formatting rule:");
    lines.push("- When showing a URL or local address, prefer plain text or inline code and do not wrap the URL in bold or other decorative Markdown.");

    return lines.join("\n");
}

// ──────────────────────────────────────────── Responses → Chat translation ───

function shouldNormalizeDeepSeek(body) {
    const provider = String(PROFILE?.provider || "").toLowerCase();
    const model = String(body?.model || "").toLowerCase();
    return provider === "deepseek" || model.includes("deepseek");
}

function normalizeUpstreamBody(body) {
    if (!body || typeof body !== "object") return body;
    if (!shouldNormalizeDeepSeek(body)) return body;
    let b = body;
    const aliases = PROFILE?.legacyAliases || PROFILE?.defaults?.legacyAliases || {};
    const rawAlias = aliases[String(body.model || "").trim().toLowerCase()];
    const alias = rawAlias
        ? { model: rawAlias.model === "fast" ? (PROFILE?.fastModel || "deepseek-v4-flash") : rawAlias.model === "default" ? (PROFILE?.defaultModel || "deepseek-v4-pro") : rawAlias.model, thinkingType: rawAlias.thinking }
        : { "deepseek-chat": { model: "deepseek-v4-flash", thinkingType: "disabled" }, "deepseek-reasoner": { model: "deepseek-v4-flash", thinkingType: "enabled" } }[String(body.model || "").trim().toLowerCase()];
    if (alias) { b = { ...body, model: alias.model }; if (!b.thinking || typeof b.thinking !== "object") b.thinking = { type: alias.thinkingType }; }
    if (!b.thinking || typeof b.thinking !== "object") b = { ...b, thinking: { type: "disabled" } };
    return b;
}

function hasPseudoToolMarkup(content) {
    const text = String(content || "");
    return /<[\s｜|]*DSML[\s｜|]*(tool_calls|invoke|parameter)\b/i.test(text) || /<(tool_calls|invoke|parameter)\b/i.test(text);
}

function stripPseudoToolMarkup(content) {
    return String(content || "")
        .replace(/<[\s｜|]*DSML[\s｜|]*tool_calls>[\s\S]*?<\/[\s｜|]*DSML[\s｜|]*tool_calls>/g, "")
        .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "")
        .trim();
}

function parsePseudoToolCalls(content) {
    const text = String(content || "");
    if (!text.includes("tool_calls") && !text.includes("invoke")) return [];
    const calls = [];
    const invokeRe = /<[\s｜|]*DSML[\s｜|]*invoke\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[\s｜|]*DSML[\s｜|]*invoke>|<invoke\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/g;
    let match;
    while ((match = invokeRe.exec(text))) {
        const name = match[1] || match[3] || "";
        if (!name) continue;
        const body = match[2] || match[4] || "";
        const args = {};
        const paramRe = /<[\s｜|]*DSML[\s｜|]*parameter\b([^>]*)>([\s\S]*?)<\/[\s｜|]*DSML[\s｜|]*parameter>|<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/g;
        let param;
        while ((param = paramRe.exec(body))) {
            const attrs = param[1] || param[3] || "";
            const rawValue = param[2] || param[4] || "";
            const nameMatch = attrs.match(/\bname=["']([^"']+)["']/);
            if (!nameMatch) continue;
            let value = rawValue.trim();
            if (attrs.match(/\b(integer|number)=["']true["']/)) {
                const n = Number(value);
                args[nameMatch[1]] = Number.isFinite(n) ? n : value;
            } else if (attrs.match(/\b(boolean)=["']true["']/)) {
                args[nameMatch[1]] = value === "true";
            } else {
                args[nameMatch[1]] = value;
            }
        }
        calls.push({
            id: `pseudo_${Date.now()}_${calls.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
        });
    }
    return calls;
}

function hasMessageContent(content) {
    if (typeof content === "string") return content.length > 0;
    if (Array.isArray(content)) return content.length > 0;
    return content !== null && content !== undefined;
}

function sanitizeChatMessages(messages) {
    return (messages || []).filter((message) => {
        if (!message || typeof message !== "object") return false;
        if (message.role === "assistant") {
            const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
            return hasTools || hasMessageContent(message.content);
        }
        return true;
    });
}

function missingToolResultMessage(toolCallId) {
    return {
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify({
            ok: false,
            error: "tool_call_interrupted",
            user_visible_guidance: "This tool call did not complete successfully in the previous turn. Continue without assuming a successful tool result.",
        }),
    };
}

function ensureToolCallResponses(messages) {
    const output = [];
    let pendingIds = [];
    let pendingSet = new Set();
    let buffered = [];

    const flushPending = () => {
        if (pendingIds.length === 0) return;
        for (const id of pendingIds) {
            if (!id || !pendingSet.has(id)) continue;
            output.push(missingToolResultMessage(id));
        }
        output.push(...buffered);
        pendingIds = [];
        pendingSet = new Set();
        buffered = [];
    };

    for (const message of messages || []) {
        if (!message || typeof message !== "object") continue;

        if (pendingIds.length > 0) {
            if (message.role === "tool" && message.tool_call_id && pendingSet.has(message.tool_call_id)) {
                output.push(message);
                pendingSet.delete(message.tool_call_id);
                if (pendingSet.size === 0) {
                    output.push(...buffered);
                    pendingIds = [];
                    pendingSet = new Set();
                    buffered = [];
                }
                continue;
            }

            if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                flushPending();
            } else {
                buffered.push(message);
                continue;
            }
        }

        output.push(message);

        if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            pendingIds = message.tool_calls.map(tc => tc?.id).filter(Boolean);
            pendingSet = new Set(pendingIds);
        }
    }

    flushPending();
    return output;
}

function responsesToChatBody(parsed, options = {}) {
    const messages = [];
    const caps = PROFILE?.capabilities || {};
    const noVision = caps.vision !== true;
    const extra = typeof options.extraSystem === "string" ? options.extraSystem.trim() : "";
    const allowTools = options.allowTools !== false && parsed.tool_choice !== "none";
    const injectInternalTools = options.injectInternalTools !== false && allowTools;
    const imageText = "[Image omitted: this route does not support image inspection. Ask the user to describe the image or paste extracted text.]";

    // System prompt
    if (parsed.instructions) messages.push({ role: "system", content: parsed.instructions });
    if (extra) messages.push({ role: "system", content: extra });

    const convertBlock = (c) => {
        if (!c) return null;
        if (c.type === "text" || (c.text && c.type !== "input_image")) return { type: "text", text: c.text || "" };
        if (c.type === "input_image" || c.type === "image" || c.type === "image_url" || c.image_url) {
            if (noVision) return { type: "text", text: imageText };
            const url = c.data ? `data:${c.media_type || "image/jpeg"};base64,${c.data}` : c.image_url || c.url;
            if (url) return { type: "image_url", image_url: { url } };
            return null;
        }
        return null;
    };

    // Input → messages
    if (Array.isArray(parsed.input)) {
        let pendingTC = null; let pendingIds = null; const deferred = [];
        let activeReasoning = "";
        const flushD = () => { if (deferred.length > 0) { messages.push(...deferred); deferred.length = 0; } };
        const ensureF = () => { if (pendingTC) { messages.push(pendingTC); pendingIds = new Set((pendingTC.tool_calls || []).map(tc => tc.id).filter(Boolean)); pendingTC = null; } };

        for (const item of parsed.input) {
            if (item.type === "function_call") {
                if (pendingIds?.size > 0) { flushD(); pendingIds = null; }
                if (!pendingTC) {
                    const last = messages[messages.length - 1];
                    if (last?.role === "assistant" && !last.tool_calls) { pendingTC = messages.pop(); pendingTC.tool_calls = []; pendingTC.content = pendingTC.content || null; }
                    else { pendingTC = { role: "assistant", content: null, tool_calls: [] }; }
                }
                if (activeReasoning && !pendingTC.reasoning_content) pendingTC.reasoning_content = activeReasoning;
                pendingTC.tool_calls.push({ id: item.call_id || item.id || `call_${Date.now()}`, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } });
            } else {
                if (item.type === "message") { ensureF(); flushD(); activeReasoning = ""; const role = item.role === "developer" ? "system" : item.role; let content; if (typeof item.content === "string") content = item.content; else if (Array.isArray(item.content)) { content = item.content.map(convertBlock).filter(Boolean); if (content.length > 0 && content.every(c => c.type === "text")) content = content.map(c => c.text).join("\n"); } if (typeof content === "string" && hasPseudoToolMarkup(content)) content = stripPseudoToolMarkup(content); messages.push({ role, content: content || null }); }
                else if (item.type === "function_call_output") { ensureF(); activeReasoning = ""; const callId = item.call_id || item.id || ""; const tc = typeof item.output === "string" ? item.output : JSON.stringify(item.output); messages.push({ role: "tool", tool_call_id: callId, content: tc }); }
                else if (item.type === "context_compaction") { ensureF(); flushD(); activeReasoning = ""; const text = readableCompactionText(item); if (text) messages.push({ role: "system", content: `Previous Codex context compaction:\n${text}` }); }
                else if (item.type === "reasoning") { activeReasoning = PROFILE?.capabilities?.reasoningReplay === false ? "" : readableReasoningText(item); }
            }
        }
        ensureF(); flushD();
    } else if (typeof parsed.input === "string") {
        messages.push({ role: "user", content: hasPseudoToolMarkup(parsed.input) ? stripPseudoToolMarkup(parsed.input) : parsed.input });
    }

    const body = { model: resolveModel(parsed.model), messages: ensureToolCallResponses(sanitizeChatMessages(messages)), stream: false };

    // Tools: use translation plan with routing metadata.
    //   – function tools forward normally.
    //   – custom/freeform tools (apply_patch) forward as callable schema + routing metadata.
    //   – namespace tools are flattened into collision-safe Chat function names with routing metadata.
    //   – hosted/account-bound tools (web_search, image_generation) are dropped; internal
    //     registry tools may be injected when upstream lacks hosted capabilities.
    const internalDefs = injectInternalTools ? toolsToInject(PROFILE) : [];
    const { tools: chatTools, routing } = buildChatToolsWithRouting(parsed, {
        compact: !allowTools,
        injectInternalTools,
        internalTools: internalDefs,
    });
    if (chatTools.length > 0) body.tools = chatTools;
    if (routing && Object.keys(routing).length > 0) body._routing = routing;

    if (parsed.tool_choice) {
        if (typeof parsed.tool_choice === "string") body.tool_choice = parsed.tool_choice;
        else if (parsed.tool_choice.type === "function" && parsed.tool_choice.function) {
            const requestedName = parsed.tool_choice.function.name;
            const routedName = routing?.[requestedName]?.chatName || requestedName;
            body.tool_choice = { type: "function", function: { name: routedName } };
        }
    }
    if (parsed.max_output_tokens) body.max_completion_tokens = parsed.max_output_tokens;
    if (parsed.temperature !== undefined) body.temperature = parsed.temperature;
    if (parsed.top_p !== undefined) body.top_p = parsed.top_p;

    return body;
}

function prepareCompactChatBody(chatBody) {
    return {
        ...chatBody,
        stream: false,
        tools: undefined,
        tool_choice: "none",
        messages: [
            { role: "system", content: COMPACT_SYSTEM },
            ...(chatBody.messages || []),
        ],
    };
}

function extractAssistantText(json) {
    const msg = json.choices?.[0]?.message || {};
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) return msg.content.map(part => typeof part === "string" ? part : part?.text || "").join("");
    return "";
}

function normalizeCompactSummary(text) {
    let summary = String(text || "").trim();
    const fence = summary.match(/^```(?:json|markdown|text)?\s*([\s\S]*?)\s*```$/i);
    if (fence) summary = fence[1].trim();
    if (summary.startsWith("{") && summary.endsWith("}")) {
        try {
            const parsed = JSON.parse(summary);
            const nested = parsed.summary || parsed.context_compaction || parsed.content || parsed.text;
            if (typeof nested === "string" && nested.trim()) summary = nested.trim();
        } catch {}
    }
    const weak = /^(好的|好|已理解|明白|收到|ok|okay)[，。,.\s]*(我会|会|将|I'll|I will)?/i;
    if (!summary || weak.test(summary) || summary.length < 24) {
        return [
            "Compact summary unavailable: the upstream model returned an acknowledgement or an underspecified summary.",
            "Continue using the remaining thread context and local workspace state; do not assume omitted details were intentionally discarded.",
        ].join("\n");
    }
    return summary;
}

function chatToCompactResponseFormat(json, model) {
    const summary = normalizeCompactSummary(extractAssistantText(json));
    return {
        id: json.id || `resp_${Date.now()}`,
        object: "response",
        created_at: json.created || Math.floor(Date.now() / 1000),
        model,
        status: "completed",
        output: [{ type: "context_compaction", summary }],
        usage: { input_tokens: json.usage?.prompt_tokens || 0, output_tokens: json.usage?.completion_tokens || 0, total_tokens: json.usage?.total_tokens || 0 },
    };
}

function responseId() { return `resp_${randomUUID().replaceAll("-", "")}`; }
function reasoningId() { return `rs_${randomUUID().replaceAll("-", "")}`; }
function messageId() { return `msg_${randomUUID().replaceAll("-", "")}`; }
function functionCallId() { return `fc_${randomUUID().replaceAll("-", "")}`; }

function encodeReasoningContent(content) {
    return REASONING_BLOB_PREFIX + Buffer.from(String(content || ""), "utf8").toString("hex");
}

function decodeReasoningContent(blob) {
    const text = String(blob || "");
    if (!text.startsWith(REASONING_BLOB_PREFIX)) return "";
    const hex = text.slice(REASONING_BLOB_PREFIX.length);
    if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return "";
    try { return Buffer.from(hex, "hex").toString("utf8"); } catch { return ""; }
}

function mapUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    const input = Number(usage.prompt_tokens || 0);
    const output = Number(usage.completion_tokens || 0);
    const total = Number(usage.total_tokens || input + output);
    return {
        input_tokens: input,
        input_tokens_details: {
            cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens || 0),
        },
        output_tokens: output,
        output_tokens_details: {
            reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0),
        },
        total_tokens: total,
    };
}

function responseStatus(finishReason) {
    if (finishReason === "length" || finishReason === "content_filter") return "incomplete";
    return "completed";
}

function incompleteDetails(finishReason) {
    if (finishReason === "length") return { reason: "max_output_tokens" };
    if (finishReason === "content_filter") return { reason: "content_filter" };
    return null;
}

function originalRequestFromArg(original) {
    if (original && typeof original === "object") return original;
    return { model: original || "gpt-5.5" };
}

function readableCompactionText(item) {
    if (!item || typeof item !== "object") return "";
    for (const key of ["summary", "text", "content", "context_compaction"]) {
        const value = item[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (Array.isArray(value)) {
            const text = value.map(part => typeof part === "string" ? part : part?.text || "").join("\n").trim();
            if (text) return text;
        }
    }
    return "";
}

function readableReasoningText(item) {
    if (!item || typeof item !== "object") return "";
    const decoded = decodeReasoningContent(item.encrypted_content);
    if (decoded) return decoded;
    const summary = item.summary;
    if (typeof summary === "string" && summary.trim()) return summary.trim();
    if (Array.isArray(summary)) {
        const text = summary.map(part => typeof part === "string" ? part : part?.text || "").join("\n").trim();
        if (text) return text;
    }
    return "";
}

function responseShell(original, { id = responseId(), created = Math.floor(Date.now() / 1000), model = null, status = "completed", output = [], usage = null, finishReason = null } = {}) {
    const originalRequest = originalRequestFromArg(original);
    return {
        id,
        object: "response",
        created_at: created,
        status,
        error: null,
        incomplete_details: incompleteDetails(finishReason),
        instructions: originalRequest.instructions ?? null,
        max_output_tokens: originalRequest.max_output_tokens ?? null,
        model: model || originalRequest.model || "gpt-5.5",
        output,
        parallel_tool_calls: originalRequest.parallel_tool_calls ?? true,
        previous_response_id: originalRequest.previous_response_id ?? null,
        reasoning: originalRequest.reasoning ?? { effort: null, summary: null },
        store: originalRequest.store ?? false,
        temperature: originalRequest.temperature ?? null,
        text: originalRequest.text ?? { format: { type: "text" } },
        tool_choice: originalRequest.tool_choice ?? "auto",
        tools: originalRequest.tools ?? [],
        top_p: originalRequest.top_p ?? null,
        truncation: originalRequest.truncation ?? "disabled",
        usage,
        user: originalRequest.user ?? null,
        metadata: originalRequest.metadata ?? {},
    };
}

function chatToResponsesFormat(json, original, routing = null) {
    const originalRequest = originalRequestFromArg(original);
    const choice = json.choices?.[0] || {};
    const msg = choice.message || {};
    const output = [];
    const rawContent = typeof msg.content === "string" ? msg.content : "";
    const pseudoCalls = parsePseudoToolCalls(rawContent);
    const pseudoExternalCalls = pseudoCalls.filter(tc => !isInternalTool(tc?.function?.name));
    const content = pseudoCalls.length > 0 ? stripPseudoToolMarkup(rawContent) : msg.content;
    if (msg.reasoning_content) output.push({ type: "reasoning", id: reasoningId(), status: "completed", summary: [], encrypted_content: encodeReasoningContent(msg.reasoning_content) });
    if (content) output.push({ type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: content, annotations: [] }] });
    if (msg.tool_calls) for (const tc of msg.tool_calls) {
        const upstreamName = tc.function?.name || "";
        // Reverse-map upstream Chat tool name → original Codex callable name using routing metadata
        const route = routing?.[upstreamName];
        const codexName = route?.codexName || upstreamName;
        const isCustom = route?.type === "custom";
        let args = tc.function?.arguments || "{}";
        // Unwrap custom tool arguments from the {content: "..."} wrapper
        if (isCustom && args) {
            try {
                const parsed = JSON.parse(args);
                if (typeof parsed.content === "string") args = parsed.content;
            } catch { /* not json, use as-is */ }
        }
        output.push({ type: "function_call", id: functionCallId(), status: "completed", call_id: tc.id || `call_${randomUUID().replaceAll("-", "")}`, name: codexName, arguments: args });
    }
    for (const tc of pseudoExternalCalls) {
        output.push({ type: "function_call", id: functionCallId(), status: "completed", call_id: tc.id || `call_${randomUUID().replaceAll("-", "")}`, name: tc.function?.name || "", arguments: tc.function?.arguments || "{}" });
    }
    if (pseudoCalls.length > 0 && output.length === 0) {
        output.push({ type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: "Internal tool request was intercepted but could not be completed in this turn. Please retry with a narrower request or a specific URL.", annotations: [] }] });
    }
    const finishReason = choice.finish_reason;
    return responseShell(originalRequest, {
        id: json.id || responseId(),
        created: json.created || Math.floor(Date.now() / 1000),
        model: json.model || originalRequest.model || "gpt-5.5",
        status: responseStatus(finishReason),
        output,
        usage: mapUsage(json.usage),
        finishReason,
    });
}

// ──────────────────────────────────────────── internal tool loop ─────────────

async function callUpstreamWithInternalTools(body) {
    const working = { ...body, stream: false, messages: [...(body.messages || [])] };
    const executedInternalCalls = new Set();

    const finalizeWithoutTools = async (reason) => {
        const finalBody = {
            ...working,
            tools: undefined,
            tool_choice: "none",
            messages: [
                { role: "system", content: `Stop calling tools now. Use the tool results already present in the conversation to answer the user. Reason: ${reason}` },
                ...(working.messages || []),
            ],
            stream: false,
        };
        const res = await fetch(`${UPSTREAM}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(UPSTREAM_KEY ? { authorization: `Bearer ${UPSTREAM_KEY}` } : {}) },
            body: JSON.stringify(normalizeUpstreamBody(finalBody)),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        if (res.ok && json) {
            const content = extractAssistantText(json);
            const pseudoCalls = parsePseudoToolCalls(content);
            if (pseudoCalls.length === 0) return { ok: true, status: res.status, json };
        }
        return { ok: true, status: 200, json: makeTextCompletion(working.model, `Tool use stopped because ${reason}. Based on the tool results already collected, provide the best possible answer. If important evidence is missing, say exactly what is missing instead of requesting more tools.`) };
    };

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const res = await fetch(`${UPSTREAM}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(UPSTREAM_KEY ? { authorization: `Bearer ${UPSTREAM_KEY}` } : {}) },
            body: JSON.stringify(normalizeUpstreamBody(working)),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        if (!res.ok) return { ok: false, status: res.status, json, text };

        const msg = json.choices?.[0]?.message || {};
        const standardExternalCalls = (msg.tool_calls || []).filter(tc => !isInternalTool(tc?.function?.name));
        const pseudoCalls = parsePseudoToolCalls(msg.content);
        const pseudoInternalCalls = pseudoCalls.filter(tc => isInternalTool(tc?.function?.name));
        const pseudoExternalCalls = pseudoCalls.filter(tc => !isInternalTool(tc?.function?.name));
        const internalCalls = [
            ...(msg.tool_calls || []).filter(tc => isInternalTool(tc?.function?.name)),
            ...pseudoInternalCalls,
        ];
        if (internalCalls.length === 0) {
            if (pseudoExternalCalls.length > 0) {
                const next = structuredClone(json);
                next.choices[0].message = {
                    ...msg,
                    content: null,
                    tool_calls: [...standardExternalCalls, ...pseudoExternalCalls],
                };
                return { ok: true, status: res.status, json: next };
            }
            return { ok: true, status: res.status, json };
        }

        const repeated = internalCalls.some(tc => {
            const key = `${tc.function?.name || ""}:${tc.function?.arguments || "{}"}`;
            return executedInternalCalls.has(key);
        });
        if (repeated) {
            return finalizeWithoutTools("the model repeated the same internal tool call");
        }

        // Execute internal tools
        const assistantContent = pseudoCalls.length > 0 ? stripPseudoToolMarkup(msg.content) : msg.content;
        working.messages.push({ role: "assistant", content: assistantContent || null, ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}), tool_calls: internalCalls });
        for (const tc of internalCalls) {
            let args = {};
            try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
            const key = `${tc.function?.name || ""}:${tc.function?.arguments || "{}"}`;
            let result;
            try {
                result = await executeInternalTool(tc.function.name, args);
            } catch (error) {
                result = JSON.stringify({
                    ok: false,
                    error: error?.message || String(error || "internal tool failed"),
                    user_visible_guidance: "Internal tool execution failed in the translator. Continue with the partial evidence already available, or ask the user for a narrower request / specific URL.",
                });
            }
            executedInternalCalls.add(key);
            working.messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
    }

    return finalizeWithoutTools("internal tool loop limit reached");
}

function makeTextCompletion(model, content) {
    return { id: `chatcmpl_${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

async function callUpstreamOnce(body) {
    const res = await fetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(UPSTREAM_KEY ? { authorization: `Bearer ${UPSTREAM_KEY}` } : {}) },
        body: JSON.stringify(normalizeUpstreamBody({ ...body, stream: false })),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return res.ok ? { ok: true, status: res.status, json } : { ok: false, status: res.status, json, text };
}

function canUseNativeStreaming(parsed, chatBody, compact) {
    if (compact) return false;
    if (parsed.stream === false) return false;
    if (process.env.TRANSLATOR_NATIVE_STREAMING !== "1") return false;
    if (PROFILE?.capabilities?.nativeStreaming === false) return false;
    if (PROFILE?.capabilities?.internalWebTools !== false && toolsToInject(PROFILE).length > 0) return false;
    if (Array.isArray(chatBody.tools) && chatBody.tools.length > 0) return false;
    return true;
}

// ──────────────────────────────────────────────────── compaction ─────────────

const SESSIONS = new Map();
const WINDOW_MS = 30_000;

function shouldInjectEndTurn(req, body) {
    const sid = req.headers?.["session_id"];
    if (typeof sid !== "string" || !sid) return false;
    const wg = (() => { const v = req.headers?.["x-codex-window-id"]; if (typeof v !== "string" || !v) return null; const n = Number.parseInt(v.split(":").pop(), 10); return Number.isFinite(n) ? n : null; })();
    if (wg === null) return false;
    const now = Date.now();
    let e = SESSIONS.get(sid);
    if (!e) { e = { ts: null, gen: null }; SESSIONS.set(sid, e); }
    const isC = (req?.path || "").endsWith("/compact");
    if (isC) { e.ts = now; e.gen = wg; return false; }
    const r = e.ts !== null && now - e.ts < WINDOW_MS && e.gen !== null && wg > e.gen;
    e.ts = null; e.gen = wg;
    return r;
}

// ──────────────────────────────────────────────────── SSE ────────────────────

function pipeSSE(res, fmt) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", "access-control-allow-origin": "*" });
    const sse = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
    const inProg = { ...fmt, status: "in_progress", output: [] };
    sse("response.created", { type: "response.created", response: inProg });
    let idx = 0;
    for (const item of fmt.output || []) {
        if (item.type === "message") {
            sse("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress", content: [] } });
            if (item.content) for (let ci = 0; ci < item.content.length; ci++) {
                const p = item.content[ci];
                sse("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: idx, content_index: ci, part: { type: "output_text", text: "" } });
                const t = p.text || "";
                for (let i = 0; i < t.length; i += 40) sse("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: idx, content_index: ci, delta: t.slice(i, i + 40) });
                sse("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: idx, content_index: ci, text: t });
                sse("response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: idx, content_index: ci, part: p });
            }
            sse("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
        } else if (item.type === "function_call") {
            sse("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress", arguments: "" } });
            const a = item.arguments || "{}";
            sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: idx, item_id: item.id, call_id: item.call_id, name: item.name, delta: a });
            sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: idx, item_id: item.id, call_id: item.call_id, name: item.name, arguments: a });
            sse("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
        } else {
            sse("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress" } });
            sse("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
        }
        idx++;
    }
    sse("response.completed", { type: "response.completed", response: fmt });
    res.end();
}

function translatedToolParts(tc, routing = null) {
    const upstreamName = tc.function?.name || tc.name || "";
    const route = routing?.[upstreamName];
    const codexName = route?.codexName || upstreamName;
    const isCustom = route?.type === "custom";
    let args = tc.function?.arguments ?? tc.arguments ?? "";
    if (isCustom && args) {
        try {
            const parsed = JSON.parse(args);
            if (typeof parsed.content === "string") args = parsed.content;
        } catch {}
    }
    return { name: codexName, arguments: args, callId: tc.id || tc.call_id || `call_${randomUUID().replaceAll("-", "")}` };
}

function unwrapCustomArguments(args, route) {
    if (route?.type !== "custom" || !args) return args || "";
    try {
        const parsed = JSON.parse(args);
        if (typeof parsed.content === "string") return parsed.content;
    } catch {}
    return args;
}

class ChatToResponsesStreamMapper {
    constructor(original, model, routing = null) {
        this.original = originalRequestFromArg(original);
        this.model = model || this.original.model || "gpt-5.5";
        this.routing = routing;
        this.responseId = responseId();
        this.messageId = messageId();
        this.created = Math.floor(Date.now() / 1000);
        this.started = false;
        this.completed = false;
        this.nextOutputIndex = 0;
        this.text = "";
        this.textOutputIndex = null;
        this.reasoning = null;
        this.toolCalls = new Map();
        this.usage = null;
    }

    allocateOutputIndex() { return this.nextOutputIndex++; }

    currentResponse(status, output = [], usage = null, finishReason = null) {
        return responseShell(this.original, {
            id: this.responseId,
            created: this.created,
            model: this.model,
            status,
            output,
            usage,
            finishReason,
        });
    }

    pushChunk(chunk) {
        const events = [];
        if (!this.started) {
            this.started = true;
            events.push(["response.created", { type: "response.created", response: this.currentResponse("in_progress", [], null) }]);
            events.push(["response.in_progress", { type: "response.in_progress", response: this.currentResponse("in_progress", [], null) }]);
        }

        if (chunk.usage) this.usage = mapUsage(chunk.usage);
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const choice of choices) {
            const delta = choice?.delta || {};
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
                events.push(...this.pushReasoningDelta(delta.reasoning_content));
            }
            if (Array.isArray(delta.tool_calls)) {
                delta.tool_calls.forEach((tc, i) => events.push(...this.pushToolCallDelta(tc, i)));
            }
            if (typeof delta.content === "string" && delta.content.length > 0) {
                events.push(...this.pushTextDelta(delta.content));
            }
            if (choice?.finish_reason && !this.completed) {
                events.push(...this.complete(choice.finish_reason));
            }
        }
        return events;
    }

    pushReasoningDelta(delta) {
        const events = [];
        if (!this.reasoning) {
            this.reasoning = { id: reasoningId(), outputIndex: this.allocateOutputIndex(), content: "", done: false };
            events.push(["response.output_item.added", {
                type: "response.output_item.added",
                output_index: this.reasoning.outputIndex,
                item: { id: this.reasoning.id, type: "reasoning", status: "in_progress", summary: [] },
            }]);
        }
        this.reasoning.content += delta;
        return events;
    }

    pushTextDelta(delta) {
        const events = [];
        if (this.textOutputIndex === null) {
            this.textOutputIndex = this.allocateOutputIndex();
            events.push(["response.output_item.added", {
                type: "response.output_item.added",
                output_index: this.textOutputIndex,
                item: { type: "message", id: this.messageId, role: "assistant", status: "in_progress", content: [] },
            }]);
            events.push(["response.content_part.added", {
                type: "response.content_part.added",
                item_id: this.messageId,
                output_index: this.textOutputIndex,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
            }]);
        }
        this.text += delta;
        events.push(["response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: this.messageId,
            output_index: this.textOutputIndex,
            content_index: 0,
            delta,
        }]);
        return events;
    }

    pushToolCallDelta(delta, fallbackIndex) {
        const index = Number.isInteger(delta?.index) ? delta.index : fallbackIndex;
        let tc = this.toolCalls.get(index);
        if (!tc) {
            tc = { itemId: functionCallId(), callId: delta?.id || `call_${randomUUID().replaceAll("-", "")}`, name: null, arguments: "", emitted: 0, outputIndex: this.allocateOutputIndex(), opened: false };
            this.toolCalls.set(index, tc);
        }
        if (!tc.opened && delta?.id) tc.callId = delta.id;
        const fn = delta?.function || {};
        if (typeof fn.name === "string" && fn.name.length > 0) {
            tc.upstreamName = fn.name;
            tc.route = this.routing?.[fn.name] || null;
            tc.name = translatedToolParts({ id: tc.callId, function: { name: fn.name, arguments: "" } }, this.routing).name;
        }
        if (typeof fn.arguments === "string") tc.arguments += fn.arguments;

        const events = [];
        if (!tc.opened && tc.name) {
            tc.opened = true;
            events.push(["response.output_item.added", {
                type: "response.output_item.added",
                output_index: tc.outputIndex,
                item: { id: tc.itemId, type: "function_call", status: "in_progress", call_id: tc.callId, name: tc.name, arguments: "" },
            }]);
        }
        if (tc.opened && tc.emitted < tc.arguments.length) {
            const argDelta = tc.arguments.slice(tc.emitted);
            tc.emitted = tc.arguments.length;
            events.push(["response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                item_id: tc.itemId,
                output_index: tc.outputIndex,
                call_id: tc.callId,
                name: tc.name,
                delta: argDelta,
            }]);
        }
        return events;
    }

    completedItems() {
        const items = [];
        if (this.reasoning) {
            items.push([this.reasoning.outputIndex, { id: this.reasoning.id, type: "reasoning", status: "completed", summary: [], encrypted_content: encodeReasoningContent(this.reasoning.content) }]);
        }
        if (this.textOutputIndex !== null) {
            items.push([this.textOutputIndex, { type: "message", id: this.messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text: this.text, annotations: [] }] }]);
        }
        for (const tc of this.toolCalls.values()) {
            if (!tc.opened) continue;
            items.push([tc.outputIndex, { id: tc.itemId, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: unwrapCustomArguments(tc.arguments, tc.route) }]);
        }
        return items.sort((a, b) => a[0] - b[0]);
    }

    complete(finishReason = "stop") {
        if (this.completed) return [];
        this.completed = true;
        const events = [];
        if (this.reasoning && !this.reasoning.done) {
            this.reasoning.done = true;
            events.push(["response.output_item.done", {
                type: "response.output_item.done",
                output_index: this.reasoning.outputIndex,
                item: { id: this.reasoning.id, type: "reasoning", status: "completed", summary: [], encrypted_content: encodeReasoningContent(this.reasoning.content) },
            }]);
        }
        if (this.textOutputIndex !== null) {
            const item = { type: "message", id: this.messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text: this.text, annotations: [] }] };
            events.push(["response.output_text.done", { type: "response.output_text.done", item_id: this.messageId, output_index: this.textOutputIndex, content_index: 0, text: this.text }]);
            events.push(["response.content_part.done", { type: "response.content_part.done", item_id: this.messageId, output_index: this.textOutputIndex, content_index: 0, part: item.content[0] }]);
            events.push(["response.output_item.done", { type: "response.output_item.done", output_index: this.textOutputIndex, item }]);
        }
        for (const tc of this.toolCalls.values()) {
            if (!tc.opened) continue;
            const args = unwrapCustomArguments(tc.arguments, tc.route);
            const item = { id: tc.itemId, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: args };
            events.push(["response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: tc.itemId, output_index: tc.outputIndex, call_id: tc.callId, name: tc.name, arguments: args }]);
            events.push(["response.output_item.done", { type: "response.output_item.done", output_index: tc.outputIndex, item }]);
        }
        const output = this.completedItems().map(([, item]) => item);
        events.push(["response.completed", { type: "response.completed", response: this.currentResponse(responseStatus(finishReason), output, this.usage, finishReason) }]);
        return events;
    }
}

async function pipeStreamingChatAsResponses(req, res, body, model, parsed, routing = null) {
    const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(UPSTREAM_KEY ? { authorization: `Bearer ${UPSTREAM_KEY}` } : {}) },
        body: JSON.stringify(normalizeUpstreamBody({ ...body, stream: true })),
    });

    if (!upstream.ok) {
        const text = await upstream.text();
        return fail(res, upstream.status, text ? text.slice(0, 500) : `Upstream ${upstream.status}`);
    }

    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", "access-control-allow-origin": "*" });
    const sse = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
    const mapper = new ChatToResponsesStreamMapper(parsed, model, routing);
    let endTurnChecked = false;
    const emit = (ev, payload) => {
        if (ev === "response.completed" && !endTurnChecked) {
            endTurnChecked = true;
            if (shouldInjectEndTurn(req, parsed)) payload.response.end_turn = false;
        }
        sse(ev, payload);
    };

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
            const dataLines = frame.split("\n").filter(line => line.startsWith("data:"));
            for (const line of dataLines) {
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                let json = null;
                try { json = JSON.parse(data); } catch { continue; }
                for (const [ev, payload] of mapper.pushChunk(json)) emit(ev, payload);
            }
        }
    }
    if (!mapper.completed) {
        for (const [ev, payload] of mapper.complete("stop")) emit(ev, payload);
    }
    res.end();
}

// ──────────────────────────────────────────────────── body ───────────────────

async function readRaw(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let raw = Buffer.concat(chunks);
    const enc = (req.headers["content-encoding"] || "").toLowerCase();
    if (enc === "zstd") try { raw = zlib.zstdDecompressSync(raw); } catch {}
    else if (enc === "gzip") raw = zlib.gunzipSync(raw);
    else if (enc === "deflate") raw = zlib.inflateSync(raw);
    else if (enc === "br") raw = zlib.brotliDecompressSync(raw);
    return raw;
}

// ──────────────────────────────────────────────────── server ─────────────────

async function startup() {
    if (!UPSTREAM_KEY) { console.error("[adaptive] UPSTREAM_API_KEY not set."); return; }
    try {
        PROFILE = loadProfileFromFile() || await probeCapabilities(UPSTREAM, UPSTREAM_KEY);
        const internal = toolsToInject(PROFILE);
        console.error(`[adaptive] Profile: ${PROFILE.provider} / ${PROFILE.defaultModel}`);
        console.error(`[adaptive]   vision=${PROFILE.capabilities.vision} hosted=${PROFILE.capabilities.hostedTools}`);
        console.error(`[adaptive]   internal tools to inject: ${internal.map(t => t.function.name).join(", ") || "none"}`);
    } catch (e) { console.error(`[adaptive] Probe failed: ${e.message}`); }
}

const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,content-encoding" }); return res.end(); }
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify({ ok: true, upstream: UPSTREAM, profile: PROFILE?.provider || "unknown", internalTools: toolsToInject(PROFILE).map(t => t.function.name) }));
    }

    if (req.method === "GET" && (url.pathname === "/backend-api/me" || url.pathname === "/me")) {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify(deepcodexUser()));
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
        const models = PROFILE?.models || ["deepseek-v4-pro", "deepseek-v4-flash", "gpt-5.5", "gpt-5.4-mini"];
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify({ object: "list", data: models.map(id => ({ id, object: "model", created: 1770000000, owned_by: "codex-adaptive" })) }));
    }

    if (req.method === "POST" && RESPONSES_PATHS.has(url.pathname)) {
        try {
            req.path = url.pathname;
            const raw = await readRaw(req);
            let parsed;
            try { parsed = JSON.parse(raw.toString("utf8")); } catch { return fail(res, 400, "Invalid JSON"); }
            if (!parsed || typeof parsed !== "object") return fail(res, 400, "Empty body");

            const compact = url.pathname.endsWith("/compact");
            if (compact) { parsed.stream = false; parsed.store = false; }

            const systemBlock = compact ? "" : buildSystemBlock();
            const chatBody = responsesToChatBody(parsed, {
                extraSystem: systemBlock,
                allowTools: !compact,
                injectInternalTools: !compact,
            });
            chatBody.model = resolveModel(parsed.model);

            // Extract routing metadata from chatBody (must not be sent upstream)
            const routing = chatBody._routing || null;
            delete chatBody._routing;

            if (compact) {
                const upstreamResp = await callUpstreamOnce(prepareCompactChatBody(chatBody));
                if (!upstreamResp.ok) return fail(res, upstreamResp.status, upstreamResp.text ? upstreamResp.text.slice(0, 500) : `Upstream ${upstreamResp.status}`);
                const fmt = chatToCompactResponseFormat(upstreamResp.json, parsed.model || "gpt-5.5");
                shouldInjectEndTurn(req, parsed);
                res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
                return res.end(JSON.stringify(fmt));
            }

            if (canUseNativeStreaming(parsed, chatBody, compact)) {
                return pipeStreamingChatAsResponses(req, res, chatBody, parsed.model || "gpt-5.5", parsed, routing);
            }

            const upstreamResp = await callUpstreamWithInternalTools(chatBody);
            if (!upstreamResp.ok) return fail(res, upstreamResp.status, upstreamResp.text ? upstreamResp.text.slice(0, 500) : `Upstream ${upstreamResp.status}`);

            const fmt = chatToResponsesFormat(upstreamResp.json, parsed, routing);
            if (shouldInjectEndTurn(req, parsed)) fmt.end_turn = false;

            pipeSSE(res, fmt);
        } catch (e) { fail(res, 500, e.message); }
        return;
    }

    fail(res, 404, `Not found: ${req.method} ${url.pathname}`);
});

if (process.env.NODE_ENV !== "test") {
    startup().then(() => server.listen(PORT, HOST, () => console.error(`[adaptive] http://${HOST}:${PORT} → ${UPSTREAM}`)));
}

export { buildSystemBlock, hasPseudoToolMarkup, stripPseudoToolMarkup, parsePseudoToolCalls, responsesToChatBody, callUpstreamWithInternalTools, ChatToResponsesStreamMapper, chatToResponsesFormat, chatToCompactResponseFormat, prepareCompactChatBody, normalizeCompactSummary, canUseNativeStreaming, MAX_TOOL_LOOPS };
