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
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { probeCapabilities } from "./probe.mjs";
import { toolsToInject, executeInternalTool, isInternalTool, getToolChoiceForRole } from "./tools/registry.mjs";
import { buildChatToolsWithRouting } from "./compat-rules.mjs";
import { localBackendApiResponse } from "./local-projection/index.mjs";

// ──────────────────────────────────────────────────── config ─────────────────

const HOST = process.env.TRANSLATOR_HOST || "127.0.0.1";
const PORT = Number(process.env.TRANSLATOR_PORT || 8282);
const UPSTREAM = (process.env.UPSTREAM_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const UPSTREAM_KEY = process.env.UPSTREAM_API_KEY || "";
const PROFILE_PATH = process.env.TRANSLATOR_PROFILE_PATH || "";
const MAX_TOOL_LOOPS = Number(process.env.TRANSLATOR_MAX_TOOL_LOOPS || 12);
const MAX_FAKE_TOOL_CLAIM_REPLAYS = Number(process.env.TRANSLATOR_MAX_FAKE_TOOL_CLAIM_REPLAYS || 2);
const MAX_RESTORED_INPUT_ITEMS = Number(process.env.TRANSLATOR_MAX_RESTORED_INPUT_ITEMS || 220);
const MAX_RESTORED_TOOL_CALLS = Number(process.env.TRANSLATOR_MAX_RESTORED_TOOL_CALLS || 6);
const MAX_RESTORED_TOOL_OUTPUT_CHARS = Number(process.env.TRANSLATOR_MAX_RESTORED_TOOL_OUTPUT_CHARS || 4000);
const MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS = Number(process.env.TRANSLATOR_MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS || 1200);
const MAX_RESTORED_SOURCE_OUTPUT_CHARS = Number(process.env.TRANSLATOR_MAX_RESTORED_SOURCE_OUTPUT_CHARS || 1200);
const MAX_RESTORED_DOC_OUTPUT_CHARS = Number(process.env.TRANSLATOR_MAX_RESTORED_DOC_OUTPUT_CHARS || 900);
const DEBUG_UPSTREAM = process.env.DEEPCODEX_DEBUG_UPSTREAM === "1" || process.env.TRANSLATOR_DEBUG_UPSTREAM === "1";
const RESPONSES_PATHS = new Set(["/responses", "/v1/responses", "/responses/compact", "/v1/responses/compact"]);
const REASONING_BLOB_PREFIX = "deepcodex.reasoning.hex.v1:";
const DEEPCODEX_DISPLAY_NAME = process.env.DEEPCODEX_DISPLAY_NAME || "娄老师说的对";
let DEBUG_REQUEST_SEQ = 0;

const CODEX_LOCAL_COMPACT_PROMPT = [
    "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
    "Include:",
    "- The latest user request and the active in-flight task, including short numeric instructions resolved from the immediate context",
    "- The exact files, commands, parameters, and outputs that were just changed or running when compaction happened",
    "- Current progress and key decisions made",
    "- Important context, constraints, or user preferences",
    "- What remains to be done (clear next steps)",
    "- A one-line continuation instruction that says exactly what the next LLM should do first",
    "- Any critical data, examples, or references needed to continue",
    "If there is an active task, explicitly state that the next LLM must not restart from project discovery and must continue from the last concrete action.",
    "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
].join("\n");

const CODEX_CONTEXT_SUMMARY_PREFIX = [
    "Another language model started to solve this problem and produced a summary of its thinking process.",
    "You also have access to the state of the tools that were used by that language model.",
    "Use this to build on the work that has already been done and avoid duplicating work.",
    "Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:",
].join(" ");

let PROFILE = null;

// ──────────────────────────────────────────────────── helpers ────────────────

function fail(res, status, msg) {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ error: { message: msg, type: "gateway_error" } }));
}

function failWithDetails(res, status, failure) {
    const detail = failure && typeof failure === "object" ? failure : { message: String(failure || `HTTP ${status}`) };
    const message = detail.message || `HTTP ${status}`;
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ error: { message, type: detail.type || "gateway_error", details: detail } }));
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

function jsonResponse(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
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

    lines.push("Language rule:");
    lines.push("- If the user writes in Chinese or the conversation is predominantly Chinese, use Simplified Chinese for user-visible answers, exposed reasoning/status text, and progress narration.");
    lines.push("- Keep code identifiers, command names, file paths, API names, and quoted source text in their original language.");
    lines.push("");

    lines.push(`You are running through ${name}.`);

    const hasInternalWebTools = !caps.hostedTools && caps.internalWebTools !== false;

    // Capability summary
    if (!caps.hostedTools) {
        lines.push("This route does NOT support provider-hosted tools such as OpenAI web_search_preview.");
        if (hasInternalWebTools) {
            lines.push("For web search and URL fetching, use the translator-provided internal web_search and web_fetch tools below.");
            lines.push("Do not say web_search or web_fetch is unavailable merely because hosted tools are unsupported.");
        } else {
            lines.push("No translator-provided web tools are configured. If a request needs web access, pause the workflow and ask the user to manually take over.");
        }
    }
    if (!caps.vision) {
        lines.push("This route does NOT support vision / image understanding.");
        lines.push("When a request needs unsupported non-web capabilities, pause the workflow and ask the user to manually take over. Give a concrete handoff instruction.");
    }

    // Internal tools available
    if (hasInternalWebTools) {
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
    lines.push("- Only say web_search or web_fetch is unavailable after an actual web_search/web_fetch tool call returned a failure. Shell/exec_command network failure is not web_search failure.");
    }

    lines.push("");
    lines.push("Tool evidence honesty rule:");
    lines.push("- Never claim that you searched, fetched, opened, read, inspected, or ran something unless a corresponding tool call/result exists in this turn or the provided conversation history.");
    lines.push("- Do not say a search is running in the background. Tool execution is only real when the host/tool result is present.");
    lines.push("- For requests like 找一找, 搜索, 查案例, 看看 GitHub, use an available web_search/web_fetch/browser/shell tool before giving concrete external examples or URLs.");
    lines.push("- If no suitable tool is available or the tool fails, say plainly that you do not have actual search results in this turn and ask for a URL or permission/input as needed.");
    lines.push("- Do not invent URLs, repositories, examples, or source claims from memory when the user asked to search.");
    lines.push("- Never convert shell, curl, npm, browser, or exec_command network failures into \"web_search unavailable\" unless web_search itself was actually called and failed.");
    lines.push("- Do not end a turn with a future-action promise such as \"now I will read\", \"next I will patch\", \"开始读文件\", \"准备打补丁\", or \"继续处理\" unless you emit the matching tool call in the same response.");
    lines.push("- If the next step is to read, inspect, run, edit, patch, write, or verify, call the appropriate tool now. If you cannot call the tool, say exactly why and do not claim the action is about to happen.");
    lines.push("- After a tool failure, either retry with a valid tool call in the same turn or give a final factual blocker. Do not reply only with a promise to retry later.");

    lines.push("");
    lines.push("Local file reading efficiency rule:");
    lines.push("- Do not read large source files or documents in full just to prove you inspected them.");
    lines.push("- Before reading a potentially large file, use wc, rg, grep, ls, or a targeted symbol search to locate relevant sections.");
    lines.push("- Prefer bounded reads such as sed -n on specific line ranges. Read the whole file only when it is clearly small or the user explicitly asks for the full file.");
    lines.push("- If a command output is clipped or too large, narrow the query instead of repeating the full read.");

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
    lines.push("Windows Node command rule:");
    lines.push("- On Windows, never launch npm, npx, pnpm, or yarn through bare Start-Process -FilePath names.");
    lines.push("- Use npm.cmd, npx.cmd, pnpm.cmd, or yarn.cmd explicitly; for long-running tools prefer cmd.exe /d /s /c \"npx.cmd ...\".");
    lines.push("- Do not prepend C:\\Program Files\\nodejs to PATH to find these commands. DeepCodex already provides command shims at the front of PATH.");
    lines.push("- If an existing command uses Start-Process -FilePath \"npx\" or \"npm\", rewrite it to the .cmd executable before running.");

    lines.push("");
    lines.push("Freeform patch tool rule:");
    lines.push("- apply_patch is a freeform patch tool, not a JSON command tool.");
    lines.push("- When using apply_patch through this DeepSeek route, call it with {\"content\":\"*** Begin Patch\\n...\\n*** End Patch\"}; the content value must be the complete patch body.");
    lines.push("- The patch body must use Codex apply_patch grammar exactly: after \"*** Begin Patch\", each file hunk starts with exactly one of \"*** Add File: <path>\", \"*** Delete File: <path>\", or \"*** Update File: <path>\".");
    lines.push("- Inside an update hunk, use \"@@\" or \"@@ <context>\" followed by unchanged lines prefixed with space, removed lines prefixed with \"-\", and added lines prefixed with \"+\".");
    lines.push("- Never use narrative hunk headers such as \"*** Update Projections\", ordinary unified-diff headers such as \"--- a/file\" or \"+++ b/file\", line-number replacement instructions, or Markdown prose inside the patch body.");
    lines.push("- Every apply_patch body must end with a final line exactly equal to \"*** End Patch\".");
    lines.push("- Never call apply_patch with {}, an empty content string, or explanatory text instead of a patch.");
    lines.push("- If an apply_patch call fails because the patch body is missing or invalid, immediately regenerate one valid full patch using the exact grammar above, or stop and explain the blocker.");
    lines.push("- Do not bypass apply_patch by writing or rewriting source files with shell commands merely because apply_patch formatting failed.");

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

function clipForLog(value, limit = 500) {
    let text = "";
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        text = String(value || "");
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function messageContentSummary(content) {
    if (typeof content === "string") return clipForLog(content);
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (!part || typeof part !== "object") return typeof part;
            const type = part.type || "part";
            if (typeof part.text === "string") return `${type}:${clipForLog(part.text, 160)}`;
            if (part.image_url || part.input_image || part.image) return `${type}:[image omitted]`;
            return type;
        }).join(" | ");
    }
    if (content === null || content === undefined) return "";
    return clipForLog(content);
}

function messageSummary(message) {
    if (!message || typeof message !== "object") return null;
    return {
        role: message.role || null,
        content: messageContentSummary(message.content),
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.map(tc => tc?.function?.name || tc?.name || "unknown") : [],
        toolCallId: message.tool_call_id || null,
    };
}

function requestToolNames(tools) {
    return (tools || []).map((tool) => tool?.function?.name || tool?.name || "unknown");
}

function requestSummary(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const lastUser = [...messages].reverse().find(message => message?.role === "user");
    return {
        model: body?.model,
        stream: body?.stream,
        tool_choice: body?.tool_choice,
        thinking: body?.thinking?.type,
        tools_count: tools.length,
        tools: requestToolNames(tools),
        has_web_search: requestToolNames(tools).includes("web_search"),
        has_web_fetch: requestToolNames(tools).includes("web_fetch"),
        messages_count: messages.length,
        message_roles: messages.map(message => message?.role || "unknown"),
        message0: messageSummary(messages[0]),
        last_user: messageSummary(lastUser),
    };
}

function responseSummary(status, json, text = "") {
    const choice = json?.choices?.[0] || {};
    const msg = choice.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    return {
        status,
        finish_reason: choice.finish_reason || null,
        has_tool_calls: toolCalls.length > 0,
        tool_calls: toolCalls.map(tc => tc?.function?.name || tc?.name || "unknown"),
        content: messageContentSummary(msg.content),
        reasoning: typeof msg.reasoning_content === "string" ? clipForLog(msg.reasoning_content, 200) : "",
        usage: json?.usage || null,
        raw: json ? "" : clipForLog(text, 500),
    };
}

function usageDiagnostics(usage) {
    if (!usage || typeof usage !== "object") return null;
    const input = Number(usage.prompt_tokens || 0);
    const output = Number(usage.completion_tokens || 0);
    const hit = Number(
        usage.prompt_cache_hit_tokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        usage.cache_hit_tokens ??
        0
    );
    const miss = Number(usage.prompt_cache_miss_tokens ?? usage.cache_miss_tokens ?? Math.max(0, input - hit));
    const flags = [];
    if (input > 200_000) flags.push("prompt_explosion");
    if (input > 0 && output === 0) flags.push("zero_completion");
    if (input > 0 && hit === 0 && input > 50_000) flags.push("cache_miss_large_prompt");
    return { input, output, total: Number(usage.total_tokens || input + output), cache_hit: hit, cache_miss: miss, flags };
}

function classifyUpstreamFailure(status, text = "", json = null) {
    const message = String(json?.error?.message || text || "");
    const transientStatus = status === 429 || status === 502 || status === 503 || status === 504;
    const transientText = /connection reset|econnreset|etimedout|timeout|temporarily unavailable|overloaded|rate limit|too many requests|bad gateway|service unavailable|gateway timeout/i.test(message);
    const protocolText = /invalid_request_error|messages with role 'tool'|tool_calls must be followed|content should be a string or a list|failed to deserialize|missing field|unsupported.*tool|invalid.*tool|schema/i.test(message);
    const authText = /unauthorized|invalid api key|incorrect api key|authentication|permission denied|forbidden/i.test(message);
    const quotaText = /insufficient quota|billing|payment|required balance|402|quota/i.test(message);
    let type = "upstream_error";
    if (protocolText) type = "protocol_or_translation_error";
    else if (authText) type = "auth_error";
    else if (quotaText || status === 402) type = "quota_or_billing_error";
    else if (transientStatus || transientText) type = "transient_upstream_error";
    return {
        type,
        status,
        retryable: type === "transient_upstream_error",
        message: clipForLog(message || `Upstream ${status}`, 500),
        hint: type === "protocol_or_translation_error"
            ? "Check Responses↔Chat message/tool ordering and schema conversion."
            : type === "transient_upstream_error"
                ? "Upstream/network transient failure; retry is safe only before partial tool output is emitted."
                : "",
        raw_type: json?.error?.type || null,
        raw_code: json?.error?.code || null,
    };
}

function debugUpstreamRequest(label, body) {
    if (!DEBUG_UPSTREAM) return null;
    const id = `${Date.now().toString(36)}-${++DEBUG_REQUEST_SEQ}`;
    console.error(`[adaptive][upstream][${id}][${label}] request ${JSON.stringify(requestSummary(body))}`);
    return id;
}

function debugUpstreamResponse(id, status, json, text) {
    if (!DEBUG_UPSTREAM || !id) return;
    const summary = responseSummary(status, json, text);
    if (json?.usage) summary.usage_diagnostics = usageDiagnostics(json.usage);
    if (status >= 400) summary.failure = classifyUpstreamFailure(status, text, json);
    console.error(`[adaptive][upstream][${id}] response ${JSON.stringify(summary)}`);
}

async function postChatCompletion(body, label) {
    const normalized = normalizeUpstreamBody(body);
    const debugId = debugUpstreamRequest(label, normalized);
    const res = await fetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(UPSTREAM_KEY ? { authorization: `Bearer ${UPSTREAM_KEY}` } : {}) },
        body: JSON.stringify(normalized),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    debugUpstreamResponse(debugId, res.status, json, text);
    return { res, text, json };
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

function sanitizeMarkdownUrlFormatting(content) {
    return String(content || "")
        .replace(/\*\*([^\n*]{0,12})((?:https?:\/\/|localhost:|127\.0\.0\.1:)[^\s*<>()]+?\/?)\*\*/g, "$1$2")
        .replace(/`((?:https?:\/\/|localhost:|127\.0\.0\.1:)[^`\s]+?)\/\*\*`/g, "`$1/`");
}

function clipForPrompt(value, limit = 2000) {
    let text = "";
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        text = String(value || "");
    }
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars]`;
}

function unknownInputItemText(item) {
    if (!item || typeof item !== "object") return "";
    const type = String(item.type || "unknown");
    const safe = { ...item };
    for (const key of ["data", "image", "image_url", "screenshot", "screenshot_bytes", "encrypted_content"]) {
        if (safe[key]) safe[key] = `[${key} omitted]`;
    }
    return [
        `Previous Codex input item (${type}) was preserved by the translator as text because this route has no native mapping for that item type.`,
        clipForPrompt(safe),
    ].join("\n");
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

function normalizeChatContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content;
    if (content === null || content === undefined) return "";
    try { return JSON.stringify(content); } catch { return String(content); }
}

function sanitizeChatMessages(messages) {
    const sanitized = [];
    for (const message of messages || []) {
        if (!message || typeof message !== "object") continue;
        const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        if (message.role === "assistant") {
            if (hasTools) {
                sanitized.push({ ...message, content: normalizeChatContent(message.content) });
            } else if (hasMessageContent(message.content)) {
                sanitized.push({ ...message, content: normalizeChatContent(message.content) });
            }
            continue;
        }
        const content = normalizeChatContent(message.content);
        if (!hasMessageContent(content)) continue;
        sanitized.push({ ...message, content });
    }
    return sanitized;
}

function normalizeMessageRole(role) {
    if (role === "developer") return "system";
    if (role === "system" || role === "user" || role === "assistant" || role === "tool") return role;
    return "system";
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

            if (message.role === "tool") {
                continue;
            }

            if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                flushPending();
            } else {
                buffered.push(message);
                continue;
            }
        }

        if (message.role === "tool") {
            continue;
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
    const inputItems = repairRestoredInput(parsed.input);
    if (Array.isArray(inputItems)) {
        let pendingTC = null; let pendingIds = null; const deferred = [];
        let activeReasoning = "";
        const flushD = () => { if (deferred.length > 0) { messages.push(...deferred); deferred.length = 0; } };
        const ensureF = () => { if (pendingTC) { messages.push(pendingTC); pendingIds = new Set((pendingTC.tool_calls || []).map(tc => tc.id).filter(Boolean)); pendingTC = null; } };

        for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex++) {
            const item = inputItems[itemIndex];
            if (item.type === "function_call" || item.type === "custom_tool_call") {
                if (pendingIds?.size > 0) { flushD(); pendingIds = null; }
                if (!pendingTC) {
                    const last = messages[messages.length - 1];
                    if (last?.role === "assistant" && !last.tool_calls) { pendingTC = messages.pop(); pendingTC.tool_calls = []; pendingTC.content = pendingTC.content || null; }
                    else { pendingTC = { role: "assistant", content: null, tool_calls: [] }; }
                }
                if (activeReasoning && !pendingTC.reasoning_content) pendingTC.reasoning_content = activeReasoning;
                const argumentsText = item.type === "custom_tool_call"
                    ? JSON.stringify({ content: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? "") })
                    : item.arguments || "{}";
                pendingTC.tool_calls.push({ id: item.call_id || item.id || `call_${itemIndex}`, type: "function", function: { name: item.name, arguments: argumentsText } });
            } else {
                if (item.type === "message") { ensureF(); flushD(); activeReasoning = ""; const rawRole = item.role || "user"; const role = normalizeMessageRole(rawRole); let content; if (typeof item.content === "string") content = item.content; else if (Array.isArray(item.content)) { content = item.content.map(convertBlock).filter(Boolean); if (content.length > 0 && content.every(c => c.type === "text")) content = content.map(c => c.text).join("\n"); } if (rawRole && rawRole !== role) content = `[Previous Codex message had unsupported role "${rawRole}"; preserved as ${role}.]\n${content || ""}`; if (typeof content === "string" && role !== "user" && hasPseudoToolMarkup(content)) content = stripPseudoToolMarkup(content); messages.push({ role, content: content || null }); }
                else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") { ensureF(); activeReasoning = ""; const callId = item.call_id || item.id || ""; const tc = typeof item.output === "string" ? item.output : JSON.stringify(item.output); messages.push({ role: "tool", tool_call_id: callId, content: tc }); }
                else if (item.type === "context_compaction") { ensureF(); flushD(); activeReasoning = ""; const text = readableCompactionText(item); if (text) messages.push({ role: "user", content: `${CODEX_CONTEXT_SUMMARY_PREFIX}\n\n${text}` }); }
                else if (item.type === "reasoning") { activeReasoning = PROFILE?.capabilities?.reasoningReplay === false ? "" : readableReasoningText(item); }
                else {
                    ensureF();
                    flushD();
                    activeReasoning = "";
                    const text = unknownInputItemText(item);
                    if (text) messages.push({ role: "system", content: text });
                }
            }
        }
        ensureF(); flushD();
    } else if (typeof parsed.input === "string") {
        messages.push({ role: "user", content: parsed.input });
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
            { role: "system", content: CODEX_LOCAL_COMPACT_PROMPT },
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

function compactFallbackTextFromRequest(original) {
    const req = originalRequestFromArg(original);
    const lines = [];
    const pushText = (label, value) => {
        const text = String(value || "").trim();
        if (text) lines.push(`${label}: ${text}`);
    };
    const textFromContent = (content) => {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map(part => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n");
        }
        return "";
    };
    for (const item of Array.isArray(req.input) ? req.input : []) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "message") {
            pushText(`${item.role || "message"} message`, textFromContent(item.content));
        } else if (item.type === "function_call" || item.type === "custom_tool_call") {
            pushText("tool call", `${item.name || "unknown"} ${item.arguments || item.input || ""}`);
        } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
            pushText(`tool result ${item.call_id || ""}`.trim(), typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""));
        } else if (item.type === "context_compaction") {
            pushText("previous context summary", readableCompactionText(item));
        }
    }
    const text = lines.join("\n\n").trim();
    return text.length > 6000 ? `...[earlier compact input omitted]\n${text.slice(-6000)}` : text;
}

function normalizeCompactSummary(text, fallbackText = "") {
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
        const fallback = String(fallbackText || "").trim();
        if (fallback) {
            return [
                "上游模型没有返回可用的压缩摘要。以下内容从本次 compact 输入中恢复，用于继续当前任务；不要重新做项目发现，优先接着最后一个具体动作继续。",
                "",
                fallback,
            ].join("\n");
        }
        return [
            "Compact summary unavailable: the upstream model returned an acknowledgement or an underspecified summary.",
            "Continue using the remaining thread context and local workspace state; do not assume omitted details were intentionally discarded.",
        ].join("\n");
    }
    return summary;
}

function chatToCompactResponseFormat(json, model, original = null) {
    const summary = normalizeCompactSummary(extractAssistantText(json), compactFallbackTextFromRequest(original));
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
    const cached = Number(
        usage.prompt_tokens_details?.cached_tokens ??
        usage.prompt_cache_hit_tokens ??
        usage.cache_hit_tokens ??
        0
    );
    return {
        input_tokens: input,
        input_tokens_details: {
            cached_tokens: cached,
        },
        output_tokens: output,
        output_tokens_details: {
            reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0),
        },
        total_tokens: total,
    };
}

function estimateInputTokens(parsed) {
    const text = clipForPrompt(parsed, 1_000_000);
    // Conservative local estimate: Codex only needs a stable shape here;
    // upstream-specific tokenization is not available inside the translator.
    return Math.max(1, Math.ceil(text.length / 4));
}

function inputTokensResponse(parsed) {
    const inputTokens = estimateInputTokens(parsed);
    return {
        object: "response.input_tokens",
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
    };
}

function emptyInputItemsResponse() {
    return {
        object: "list",
        data: [],
        first_id: null,
        last_id: null,
        has_more: false,
    };
}

function cancelledResponse(id) {
    return {
        id: id || responseId(),
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "cancelled",
        error: null,
        incomplete_details: null,
        output: [],
        usage: null,
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

function isDamagedCompactionItem(item) {
    return item?.type === "context_compaction" && !item.encrypted_content && !readableCompactionText(item);
}

function damagedCompactionSummary() {
    return [
        "DeepCodex detected a damaged previous context_compaction item with no summary/text/content.",
        "The exact earlier compressed history is unavailable, so noisy restored tool outputs, render logs, image payload records, and developer/system fragments after that damaged checkpoint were omitted before sending context to the model.",
        "Continue from the remaining user/assistant text and current local workspace state. If a concrete file, command, or artifact is missing, inspect the workspace directly instead of assuming the old tool output was reliable.",
    ].join("\n");
}

function clipRestoredToolOutput(item) {
    if (!item || typeof item !== "object" || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) return item;
    const originalOutput = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    const output = normalizeRestoredToolOutput(stripVolatileToolOutput(originalOutput));
    if (output.length <= MAX_RESTORED_TOOL_OUTPUT_CHARS) {
        return output === originalOutput ? item : { ...item, output };
    }
    return {
        ...item,
        output: [
            output.slice(0, MAX_RESTORED_TOOL_OUTPUT_CHARS),
            `...[older tool output clipped by DeepCodex translator: ${output.length - MAX_RESTORED_TOOL_OUTPUT_CHARS} chars omitted]`,
        ].join("\n"),
    };
}

function normalizeRestoredToolOutput(output) {
    const text = String(output || "").trim();
    if (!text) {
        return "[DeepCodex tool result: command completed with no stdout after removing transport noise.]";
    }
    if (isSuccessfulPatchOutput(text)) {
        return summarizeSuccessfulPatchOutput(text);
    }
    if (isImportantToolError(text)) return text;
    const limit = restoredOutputFoldLimit(text);
    if (!limit || text.length <= limit) return text;
    const headChars = Math.floor(limit * 0.62);
    const tailChars = limit - headChars;
    return [
        text.slice(0, headChars).trimEnd(),
        `\n...[DeepCodex folded ${text.length - headChars - tailChars} chars from a long restored tool output to keep prompt cache stable. Re-read the exact file/range if more context is needed.]...\n`,
        text.slice(-tailChars).trimStart(),
    ].join("");
}

function restoredOutputFoldLimit(text) {
    if (looksLikeDocumentationDump(text)) return MAX_RESTORED_DOC_OUTPUT_CHARS;
    if (looksLikeSourceDump(text)) return MAX_RESTORED_SOURCE_OUTPUT_CHARS;
    return 0;
}

function isSuccessfulPatchOutput(text) {
    return /Success\. Updated the following files:/i.test(text) && !isImportantToolError(text.replace(/Success\. Updated the following files:/i, ""));
}

function summarizeSuccessfulPatchOutput(text) {
    const files = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => /^[AMDR]\s+/.test(line))
        .slice(0, 12);
    const suffix = files.length ? `\n${files.join("\n")}` : "";
    return `[DeepCodex tool result: patch applied successfully.${files.length ? " Updated files:" : ""}${suffix}]`;
}

function isImportantToolError(text) {
    return [
        /\b(error|exception|traceback|failed|failure|cannot|can't|syntaxerror|typeerror|referenceerror)\b/i,
        /\b(exit code|code \d+|ERR_|ENOENT|EACCES|EPERM|ECONNREFUSED|timeout)\b/i,
        /apply_patch verification failed/i,
        /\bTS\d{4}\b/,
    ].some(re => re.test(text));
}

function looksLikeSourceDump(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (lines.length < 25) return false;
    const numbered = lines.filter(line => /^\s*\d+[:\t ]/.test(line)).length;
    const codeish = lines.filter(line => /[{}();=<>]|\b(function|const|let|var|import|export|class|return|case|if|else)\b/.test(line)).length;
    return numbered >= 8 || codeish / lines.length > 0.35;
}

function looksLikeDocumentationDump(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    if (text.length < MAX_RESTORED_DOC_OUTPUT_CHARS) return false;
    const headings = lines.filter(line => /^\s{0,3}#{1,6}\s+\S/.test(line)).length;
    const bullets = lines.filter(line => /^\s{0,4}([-*+]|\d+\.)\s+\S/.test(line)).length;
    const markdownSignals = /```|^---$|\b(SKILL|README|Usage|Install|Examples?|Protocol|Reference|指南|用法|安装|示例|协议|参考)\b/im.test(text);
    return headings >= 2 || (markdownSignals && bullets + headings >= 4);
}

function clipRestoredToolCall(item) {
    if (!item || typeof item !== "object" || item.type !== "custom_tool_call") return item;
    const originalInput = typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? "");
    if (originalInput.length <= MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS) return item;
    return {
        ...item,
        input: [
            originalInput.slice(0, MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS),
            `...[older custom tool body clipped by DeepCodex translator: ${originalInput.length - MAX_RESTORED_CUSTOM_TOOL_INPUT_CHARS} chars omitted; use paired tool result and current files as source of truth]`,
        ].join("\n"),
    };
}

function textFromMessageContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map(part => typeof part === "string" ? part : part?.text || "").filter(Boolean).join("\n");
    }
    return "";
}

function stripVolatileToolOutput(output) {
    return String(output || "")
        .split(/\r?\n/)
        .filter(line => ![
            /^Chunk ID:\s*/i,
            /^Wall time:\s*/i,
            /^Process exited with code\s+/i,
            /^Process running with session ID\s+/i,
            /^Original token count:\s*/i,
            /^Output:\s*$/i,
            /^\*\* WARNING: connection is not using a post-quantum key exchange algorithm\./,
            /^\*\* This session may be vulnerable to "store now, decrypt later" attacks\./,
            /^\*\* The server may need to be upgraded\. See https:\/\/openssh\.com\/pq\.html/,
        ].some(re => re.test(line)))
        .join("\n")
        .trim();
}

function restoredToolCallText(item) {
    if (!item || typeof item !== "object") return "";
    const args = item.type === "custom_tool_call"
        ? item.input
        : item.arguments;
    return `${item.name || ""}\n${typeof args === "string" ? args : JSON.stringify(args || "")}`;
}

function isVolatileRestoredToolCall(item) {
    if (!item || typeof item !== "object" || (item.type !== "function_call" && item.type !== "custom_tool_call")) return false;
    if (item.name === "update_plan") return true;
    const text = restoredToolCallText(item);
    if (item.name === "write_stdin" && /\bsession_id\b|\byield_time_ms\b/.test(text)) return true;
    if (item.name === "exec_command" && commandLooksLikeStatusProbe(text)) return true;
    return [
        /\bStart-Sleep\b/i,
        /\bGet-Process\b/i,
        /\bGet-WmiObject\b/i,
        /\bProcessId=\d+/i,
        /\/api\/ps\b/i,
        /\bbench_result\.txt\b/i,
        /\bProcess running with session ID\b/i,
        /\bsession_id\b/i,
    ].some(re => re.test(text));
}

function isVolatileRestoredToolOutput(item) {
    if (!item || typeof item !== "object" || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) return false;
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    return [
        /Process running with session ID/i,
        /stdin is closed for this session/i,
        /Reconnecting\.\.\.\s*\d\/\d/i,
    ].some(re => re.test(output));
}

function isVolatileRestoredMessage(item) {
    if (!item || typeof item !== "object" || item.type !== "message") return false;
    const text = textFromMessageContent(item.content);
    if (completedResultsThenStatusDetour(text)) return true;
    return [
        /^<turn_aborted>/,
        /Reconnecting\.\.\.\s*\d\/\d/i,
        /stream disconnected before completion/i,
        /可能还在跑。*等/i,
        /等会话完成/i,
        /又超时了/i,
        /while \(Get-Process/i,
    ].some(re => re.test(text.trim()));
}

function parseRestoredCommandArgs(item) {
    if (!item || typeof item !== "object" || item.type !== "function_call" || item.name !== "exec_command") return "";
    const raw = item.arguments;
    if (typeof raw !== "string") return "";
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed?.cmd === "string" ? parsed.cmd : "";
    } catch {
        return raw;
    }
}

function commandLooksLikeListing(cmd) {
    return /\b(ls|find|dir|Get-ChildItem|gci)\b/i.test(cmd);
}

function commandLooksLikeRead(cmd) {
    return /\b(cat|type|Get-Content|sed|head|tail|rg)\b/i.test(cmd);
}

function commandLooksLikeWrite(cmd) {
    return /\b(apply_patch|cat\s*>|Set-Content|Out-File|Copy-Item|Move-Item|mkdir|New-Item|touch)\b/i.test(cmd);
}

function commandLooksLikeBuildOrInstall(cmd) {
    return /\b(npm|npx|pnpm|yarn|node|go|python|pip|uv|cargo|remotion|vite|hyperframes)\b/i.test(cmd);
}

function commandLooksLikeStatusProbe(cmd) {
    const text = String(cmd || "");
    return [
        /\b(netstat|lsof|ss)\b/i,
        /\b(Get-Process|tasklist|ps\b|pgrep|pidof|Get-Service|sc\s+query)\b/i,
        /\b(Measure-Object|Select-Object\s+-ExpandProperty\s+Count)\b/i,
        /\b(curl|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]{0,120}\b(health|status|debug\/routes|\/api\/ps|\/version)\b/i,
        /\bfindstr\b[\s\S]{0,80}:\d{2,5}/i,
    ].some(re => re.test(text));
}

function parseExitCode(output) {
    const match = String(output || "").match(/Process exited with code\s+(-?\d+)/i);
    return match ? Number(match[1]) : null;
}

function parseJsonish(value) {
    if (value == null) return null;
    if (typeof value === "object") return value;
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text || !/^[{[]/.test(text)) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function quoteFactValue(value, max = 160) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function extractCleanOutputLines(output) {
    return stripVolatileToolOutput(output)
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !/^Microsoft Windows \[/.test(line))
        .filter(line => !/^\(c\) Microsoft Corporation/i.test(line))
        .filter(line => !/^[A-Za-z0-9_.-]+@[^>]+>/.test(line));
}

function extractLikelyPathFacts(lines) {
    const facts = [];
    for (const line of lines) {
        const value = line.trim();
        if (!value || value.length > 240) continue;
        if (/^(Permission denied|File not found|cannot access|SyntaxError|ParserError|FINDSTR:)/i.test(value)) continue;
        const looksPath = /^(?:[A-Za-z]:\\|\/Users\/|\/home\/|\.\/|\.\.\/|[A-Za-z0-9_.-]+\/)[^\n]+/.test(value);
        const looksProjectName = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{2,80}$/.test(value);
        if (looksPath || looksProjectName) facts.push(value);
        if (facts.length >= 6) break;
    }
    return facts;
}

function summarizeToolCallArgs(call) {
    if (!call) return "";
    const parsed = parseJsonish(call.arguments ?? call.input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = ["app", "target", "targetId", "element", "path", "url", "query", "cmd", "action", "sessionId", "resourceId"];
        const parts = [];
        for (const key of keys) {
            const value = parsed[key];
            if (typeof value === "string" && value.trim()) parts.push(`${key}=${quoteFactValue(value, 70)}`);
            if (typeof value === "number" || typeof value === "boolean") parts.push(`${key}=${String(value)}`);
            if (parts.length >= 3) break;
        }
        if (parts.length) return parts.join(", ");
    }
    if (typeof call.input === "string" && call.input.trim()) return quoteFactValue(call.input, 120);
    if (typeof call.arguments === "string" && call.arguments.trim()) return quoteFactValue(call.arguments, 120);
    return "";
}

function toolOutputLooksFailed(output, parsedOutput) {
    if (parsedOutput && typeof parsedOutput === "object") {
        if (parsedOutput.ok === false || parsedOutput.success === false) return true;
        if (typeof parsedOutput.error === "string" && parsedOutput.error.trim()) return true;
        if (parsedOutput.error && typeof parsedOutput.error === "object") return true;
        if (typeof parsedOutput.status === "string" && /fail|error|denied|unsupported/i.test(parsedOutput.status)) return true;
    }
    return /\b(error|failed|failure|denied|not permitted|unsupported|unavailable|timeout|timed out|exception)\b/i.test(String(output || ""));
}

function toolOutputLooksSuccessful(output, parsedOutput) {
    if (parsedOutput && typeof parsedOutput === "object") {
        if (parsedOutput.ok === true || parsedOutput.success === true || parsedOutput.closed === true) return true;
        if (Array.isArray(parsedOutput)) return true;
        if (Object.keys(parsedOutput).length && !toolOutputLooksFailed(output, parsedOutput)) return true;
    }
    const text = String(output || "").trim();
    return Boolean(text) && !toolOutputLooksFailed(text, parsedOutput);
}

function collectDurableToolFacts(input) {
    if (!Array.isArray(input)) return [];
    const calls = new Map();
    const toolCalls = new Map();
    const facts = new Map();
    function addFact(kind, fact) {
        const text = quoteFactValue(fact, 240);
        if (!text) return;
        if (!facts.has(kind)) facts.set(kind, []);
        const list = facts.get(kind);
        if (!list.includes(text) && list.length < 6) list.push(text);
    }

    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "function_call" && item.name === "exec_command") {
            const callId = item.call_id || item.id;
            if (callId) calls.set(callId, parseRestoredCommandArgs(item));
            if (callId) toolCalls.set(callId, { name: item.name, arguments: item.arguments, input: item.input, type: item.type });
            continue;
        }
        if (item.type === "function_call" || item.type === "custom_tool_call") {
            const callId = item.call_id || item.id;
            if (callId) toolCalls.set(callId, { name: item.name || item.type, arguments: item.arguments, input: item.input, type: item.type });
            continue;
        }
        if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") continue;
        const callId = item.call_id || item.id;
        const cmd = calls.get(callId) || "";
        const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
        const toolCall = toolCalls.get(callId);
        const clean = stripVolatileToolOutput(output);
        const exitCode = parseExitCode(output);
        const ok = exitCode === 0;
        const failed = exitCode !== null && exitCode !== 0;
        const lines = extractCleanOutputLines(output);

        if (ok && commandLooksLikeListing(cmd)) {
            const pathFacts = extractLikelyPathFacts(lines);
            if (pathFacts.length) addFact("workspace", `Listing result from ${quoteFactValue(cmd, 90)}: ${pathFacts.slice(0, 6).join(", ")}`);
        }

        if (ok && commandLooksLikeRead(cmd)) {
            const first = lines.find(line => line && line.length <= 180);
            if (first) addFact("tool-state", `Read command succeeded: ${quoteFactValue(cmd, 120)}`);
        }

        if (ok && commandLooksLikeWrite(cmd)) {
            addFact("tool-state", `Write/change command succeeded: ${quoteFactValue(cmd, 120)}`);
        }

        if (ok && commandLooksLikeBuildOrInstall(cmd)) {
            const first = lines.find(line => line && line.length <= 180);
            addFact("tool-state", `Build/install command succeeded: ${quoteFactValue(cmd, 120)}${first ? ` -> ${quoteFactValue(first, 90)}` : ""}`);
        }

        if (failed && (commandLooksLikeBuildOrInstall(cmd) || commandLooksLikeRead(cmd) || commandLooksLikeListing(cmd))) {
            const failureLine = lines.find(line => /error|failed|cannot|not found|Permission denied|SyntaxError|ParserError|exit/i.test(line)) || lines[0] || `exit ${exitCode}`;
            addFact("tool-state", `Command failed, do not assume success: ${quoteFactValue(cmd, 100)} -> ${quoteFactValue(failureLine, 140)}`);
        }

        if (toolCall && toolCall.type === "function_call" && !["exec_command", "update_plan"].includes(toolCall.name)) {
            const parsedOutput = parseJsonish(item.output);
            const failedTool = exitCode !== null ? exitCode !== 0 : toolOutputLooksFailed(output, parsedOutput);
            const okTool = exitCode === 0 || (exitCode === null && toolOutputLooksSuccessful(output, parsedOutput));
            const name = quoteFactValue(toolCall.name || "tool", 80);
            const args = summarizeToolCallArgs(toolCall);
            if (okTool && !failedTool) {
                addFact("tool-state", `Tool ${name} succeeded${args ? ` (${args})` : ""}`);
            } else if (failedTool) {
                const failureLine = lines.find(line => /error|failed|cannot|not found|Permission denied|unsupported|timeout|denied/i.test(line)) || lines[0] || "failed";
                addFact("tool-state", `Tool ${name} failed, do not assume success${args ? ` (${args})` : ""}: ${quoteFactValue(failureLine, 120)}`);
            }
        }
    }

    return Array.from(facts.entries())
        .flatMap(([kind, values]) => values.map(value => `${kind}: ${value}`))
        .slice(0, 12);
}

function collectTaskLedgerFacts(input) {
    if (!Array.isArray(input)) return [];
    const facts = [];
    const push = (label, text) => {
        const value = quoteFactValue(text, 260);
        if (!value) return;
        const line = `${label}: ${value}`;
        if (!facts.includes(line)) facts.push(line);
    };
    const recentMessages = input
        .filter(item => item?.type === "message" && ["user", "assistant"].includes(item.role))
        .slice(-10);
    const userMessages = recentMessages.filter(item => item.role === "user").map(item => textFromMessageContent(item.content)).filter(Boolean);
    const assistantMessages = recentMessages.filter(item => item.role === "assistant").map(item => textFromMessageContent(item.content)).filter(Boolean);
    const meaningfulUser = userMessages
        .filter(text => !/^<turn_aborted>/.test(text.trim()))
        .filter(text => !/^(继续|好|嗯|可以|ok|OK|你倒是看啊|我操你妈|操你妈的)\s*[。.!！?？]*$/.test(text.trim()));
    const lastTask = meaningfulUser.at(-1);
    if (lastTask) push("current-user-task", lastTask);
    const lastAssistant = assistantMessages.at(-1);
    if (lastAssistant && assistantTextLooksLikeFutureToolPromise(lastAssistant)) {
        push("pending-next-action", lastAssistant);
    }
    const targetHints = [...userMessages, ...assistantMessages].join("\n").match(/(?:[A-Za-z]:\\[^\s"'，。；;]+|\/Users\/[^\s"'，。；;]+|(?:new-chat-\d+|qwen[-_\w]*|gemini[-_\w]*|remotion[-_\w]*|deepcodex[-_\w]*))/g) || [];
    for (const hint of targetHints.slice(-6)) push("target-hint", hint);
    return facts.slice(0, 10);
}

function injectTaskLedgerFacts(input) {
    const isRestoredThread = Array.isArray(input) && input.some(item => item?.type === "context_compaction");
    if (!isRestoredThread) return input;
    const facts = collectTaskLedgerFacts(input);
    if (!facts.length) return input;
    const alreadyPresent = input.some(item => item?.type === "context_compaction" && /DeepCodex task ledger/.test(readableCompactionText(item)));
    if (alreadyPresent) return input;
    return [
        {
            type: "context_compaction",
            summary: [
                "DeepCodex task ledger from recent explicit user/assistant text:",
                ...facts.map(fact => `- ${fact}`),
                "Preserve the task goal and pending next action across compaction. Do not replace the user's target with environment guesses.",
            ].join("\n"),
        },
        ...input,
    ];
}

function injectDurableToolFacts(input) {
    const facts = collectDurableToolFacts(input);
    if (!facts.length) return input;
    const alreadyPresent = input.some(item => item?.type === "context_compaction" && /DeepCodex durable environment facts/.test(readableCompactionText(item)));
    if (alreadyPresent) return input;
    return [
        {
            type: "context_compaction",
            summary: [
                "DeepCodex durable environment facts from verified tool results:",
                ...facts.map(fact => `- ${fact}`),
                "Use these facts before guessing environment details. If a later probe contradicts them, verify with a tool call before changing course.",
            ].join("\n"),
        },
        ...input,
    ];
}

function dropVolatileRestoredItems(input) {
    if (!Array.isArray(input)) return input;
    const volatileIds = new Set();
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if (isVolatileRestoredToolCall(item) || isVolatileRestoredToolOutput(item)) {
            const callId = item.call_id || item.id;
            if (callId) volatileIds.add(callId);
        }
    }

    let omitted = false;
    const filtered = [];
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        const callId = item.call_id || item.id;
        if ((item.type === "function_call" || item.type === "function_call_output" || item.type === "custom_tool_call" || item.type === "custom_tool_call_output") && callId && volatileIds.has(callId)) {
            omitted = true;
            continue;
        }
        if (isVolatileRestoredMessage(item)) {
            omitted = true;
            continue;
        }
        filtered.push(item);
    }

    if (!omitted) return input;
    return [
        {
            type: "context_compaction",
            summary: [
                "DeepCodex omitted volatile restored polling/status transcripts before forwarding this turn upstream.",
                "Dropped items include interrupted-turn markers, reconnect messages, running-session polls, process-status checks, and transport wrapper lines that change every turn and harm prompt-cache stability.",
            ].join("\n"),
        },
        ...filtered,
    ];
}

function pruneRestoredToolTranscripts(input) {
    if (!Array.isArray(input) || MAX_RESTORED_TOOL_CALLS <= 0) return input;

    let activeTurnStart = -1;
    for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i];
        if (item?.type === "message" && item.role === "user") {
            activeTurnStart = i;
            break;
        }
    }
    let activeToolStart = activeTurnStart + 1;
    for (let i = input.length - 1; i > activeTurnStart; i--) {
        const item = input[i];
        if (item?.type === "message" && item.role === "assistant") {
            activeToolStart = i + 1;
            break;
        }
    }

    const keepIds = new Set();
    for (let i = activeToolStart; i < input.length; i++) {
        const item = input[i];
        if (!item || typeof item !== "object") continue;
        if (item.type !== "function_call" && item.type !== "function_call_output" && item.type !== "custom_tool_call" && item.type !== "custom_tool_call_output") continue;
        const callId = item.call_id || item.id;
        if (callId) keepIds.add(callId);
    }

    let olderKept = 0;
    for (let i = activeTurnStart >= 0 ? activeTurnStart - 1 : activeToolStart - 1; i >= 0 && olderKept < MAX_RESTORED_TOOL_CALLS; i--) {
        const item = input[i];
        if (!item || typeof item !== "object") continue;
        if (item.type !== "function_call" && item.type !== "function_call_output" && item.type !== "custom_tool_call" && item.type !== "custom_tool_call_output") continue;
        const callId = item.call_id || item.id;
        if (callId && !keepIds.has(callId)) {
            keepIds.add(callId);
            olderKept += 1;
        }
    }

    if (keepIds.size === 0) return input;

    let omitted = false;
    const pruned = [];
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "function_call" || item.type === "function_call_output" || item.type === "custom_tool_call" || item.type === "custom_tool_call_output") {
            const callId = item.call_id || item.id;
            if (!callId || !keepIds.has(callId)) {
                omitted = true;
                continue;
            }
            pruned.push(clipRestoredToolOutput(clipRestoredToolCall(item)));
            continue;
        }
        pruned.push(item);
    }

    if (!omitted) return pruned;
    return [
        {
            type: "context_compaction",
            summary: [
                "DeepCodex omitted older restored tool transcripts before forwarding this turn upstream.",
                "The latest compaction summary and recent tool results are preserved. For older exact stdout or command details, inspect the workspace or rerun the relevant command.",
            ].join("\n"),
        },
        ...pruned,
    ];
}

function repairRestoredInput(input) {
    if (!Array.isArray(input)) return input;
    input = dropVolatileRestoredItems(input);
    input = injectTaskLedgerFacts(input);
    input = injectDurableToolFacts(input);
    let lastDamaged = -1;
    let lastReadableCompact = -1;
    for (let i = 0; i < input.length; i++) {
        if (isDamagedCompactionItem(input[i])) lastDamaged = i;
        else if (input[i]?.type === "context_compaction" && readableCompactionText(input[i])) lastReadableCompact = i;
    }
    if (lastDamaged < 0 && input.length <= MAX_RESTORED_INPUT_ITEMS) return pruneRestoredToolTranscripts(input);

    const start = Math.max(lastDamaged + 1, input.length - MAX_RESTORED_INPUT_ITEMS);
    const repaired = lastDamaged >= 0
        ? [{ type: "context_compaction", summary: damagedCompactionSummary() }]
        : [];

    if (lastDamaged < 0 && lastReadableCompact >= 0 && lastReadableCompact < start) {
        repaired.push(input[lastReadableCompact]);
    }

    for (let i = start; i < input.length; i++) {
        const item = input[i];
        if (!item || typeof item !== "object") continue;
        if (lastDamaged < 0 && i === lastReadableCompact && repaired.includes(item)) continue;
        if (item.type === "message") {
            if (lastDamaged >= 0 && !["user", "assistant"].includes(item.role)) continue;
            repaired.push(item);
        } else if (item.type === "context_compaction" && readableCompactionText(item)) {
            repaired.push(item);
        } else if (lastDamaged < 0 && (item.type === "function_call" || item.type === "function_call_output" || item.type === "custom_tool_call" || item.type === "custom_tool_call_output" || item.type === "reasoning")) {
            repaired.push(item);
        }
    }
    return pruneRestoredToolTranscripts(repaired);
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

function responseOutputHasToolCall(output) {
    return Array.isArray(output) && output.some(item => item?.type === "function_call" || item?.type === "custom_tool_call");
}

function assistantTextLooksLikeWebToolUnavailableClaim(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return false;
    const namesWebTool = /\bweb[_ -]?(?:search|fetch)\b/i.test(value);
    const namesSearchTool = /(?:搜索|检索|抓取|网页|联网|网络).{0,12}(?:工具|tool)/i.test(value);
    if (!namesWebTool && !namesSearchTool) return false;
    return /(?:不可用|不能用|无法使用|暂时不可用|没有可用|未启用|不可访问|失败|unavailable|not available|disabled|unsupported|not supported|failed)/i.test(value);
}

function assistantTextLooksLikeUnsupportedToolClaim(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    const compact = value.replace(/\s+/g, " ");
    const zhDone = /(?:已|已经|刚才|我(?:已经)?|这里|现在).{0,36}(?:读完|读取|读了|查看|看了|检查|搜到|搜索到|查到|找到|运行|执行|安装|启动|生成|创建|写入|修改|补丁|打上|渲染|导出|移动|复制|删除|下载|打开|跑起来|跑完)/i;
    const zhDoneVerbFirst = /(?:搜到|搜索到|查到|找到|看了|读了|跑完|装好|写好|改好|生成好).{0,80}(?:结果|案例|资料|文件|页面|仓库|showcase|GitHub|官方|内容|数据)/i;
    const enClaim = /\b(?:I\s+(?:have\s+)?(?:installed|started|ran|read|generated|moved|copied|searched|fetched|opened|wrote|patched|downloaded|rendered)|(?:installed|started|ran|read|generated|moved|copied|searched|fetched|opened|wrote|patched|downloaded|rendered)\b)/i;
    return assistantTextLooksLikeFutureToolPromise(compact) || zhDone.test(compact) || zhDoneVerbFirst.test(compact) || enClaim.test(compact);
}

function assistantTextLooksLikeFutureToolPromise(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    const compact = value.replace(/\s+/g, " ");
    const factualBlocker = /(?:需要|必须|请你|用户|否则|不能|无法|还没有|没有|缺少).{0,40}(?:安装|连接|启用|配置|授权|允许|打开|接入).{0,80}(?:否则|不能|无法|才(?:能|可以)|后(?:才|就))/i;
    const explicitSelfAction = /(?:现在|马上|接下来|继续|我来|开始|准备|直接).{0,36}(?:读|读取|查看|检查|搜|搜索|运行|执行|安装|启动|生成|创建|新建|写|写入|修改|补丁|打补丁|patch|渲染|导出|移动|复制|删除|下载|打开|跑|做|搭建|实现|落地|scaffold|skeleton)/i;
    if (factualBlocker.test(compact) && !explicitSelfAction.test(compact)) return false;
    const zhFuture = /(?:先|现在|马上|接下来|继续|我来|开始|准备|直接).{0,36}(?:读|读取|查看|检查|搜|搜索|运行|执行|安装|启动|生成|创建|新建|写|写入|修改|补丁|打补丁|patch|渲染|导出|移动|复制|删除|下载|打开|跑|做|搭建|实现|落地|scaffold|skeleton)/i;
    const zhCommandPromise = /(?:先|现在|马上|接下来|继续|我来|开始|准备|直接|然后|用|使用).{0,48}(?:npm|npx|pnpm|yarn|node|python|pip|powershell|cmd|bash|git|curl|remotion|vite|hyperframes|ffmpeg|magick|robocopy|copy-item|start-process)\b/i;
    const zhThenAction = /(?:确认|检查|看一下|看看|读一下|读完|看完).{0,48}(?:然后|再|后).{0,24}(?:启动|运行|执行|安装|生成|创建|新建|写入|修改|渲染|导出|复制|移动|打开|跑|做|搭建|实现|落地|scaffold|skeleton)/i;
    const danglingActionLeadIn = /(?:看(?:看|一下)?|读(?:取|一下)?|列(?:出|一下)?|检查|打开|运行|执行|启动|安装|创建|新建|写入|修改|搜索|查(?:看|一下)?).{0,48}[：:]\s*$/i;
    const enCommandPromise = /\b(?:I(?:'ll| will| am going to)?|let me|now|next|then|directly)\b.{0,60}\b(?:npm|npx|pnpm|yarn|node|python|pip|powershell|cmd|bash|git|curl|remotion|vite|hyperframes|ffmpeg|magick|robocopy)\b/i;
    const enActionPromise = /\b(?:I(?:'ll| will| am going to)|let me|now|next|then|continue|directly)\b.{0,80}\b(?:use|apply|retry|rerun|read|inspect|check|verify|confirm|get|find|locate|gather|collect|search|fetch|run|execute|install|start|generate|create|write|edit|modify|update|add|insert|wire|patch|render|export|move|copy|delete|download|open|build|implement|finish|fix|scaffold|see|look|examine|trace|follow)\b/i;
    const enDanglingActionLeadIn = /\b(?:let me|I(?:'ll| will| am going to)|now|next|then|continue|directly)\b.{0,120}\b(?:use|apply|retry|rerun|read|inspect|check|verify|confirm|get|find|locate|gather|collect|search|fetch|run|execute|install|start|generate|create|write|edit|modify|update|add|insert|wire|patch|render|export|move|copy|delete|download|open|build|implement|finish|fix|scaffold|see|look|examine|trace|follow)\b.{0,60}[：:]\s*(?:\\d+\\s*)?$/i;
    return zhFuture.test(compact) || zhCommandPromise.test(compact) || zhThenAction.test(compact) || danglingActionLeadIn.test(compact) || enCommandPromise.test(compact) || enActionPromise.test(compact) || enDanglingActionLeadIn.test(compact);
}

function completedResultsThenStatusDetour(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return false;
    const saysResultsReady = /(?:结果|搜索|检索|资料|信息|tool results?|results?).{0,24}(?:已|已经|跑完|完成|够了|就在上面|collected|ready|done|complete)/i.test(value)
        || /(?:已|已经).{0,20}(?:搜索|检索|收集).{0,20}(?:完成|完|到|好)/i.test(value);
    const saysFinalAnswer = /(?:最终|总结|回答|盘点|整理|答复|final|answer|summary)/i.test(value);
    const saysStatusDetour = /(?:确认|检查|看一下|verify|check).{0,36}(?:环境|工具链|连接|进程|端口|daemon|服务|窗口|状态|health|status|toolchain)/i.test(value);
    return saysResultsReady && saysFinalAnswer && saysStatusDetour;
}

function detourBlockedMessage() {
    return [
        "DeepCodex 已拦截这轮回复：模型已经声明结果足够并应进入最终回答，但又发起了状态/环境确认工具调用。",
        "实际要求：除非用户明确要求诊断工具链、进程、端口或窗口，否则不要把辅助环境检查升级成主任务。",
        "请继续时基于已有工具结果直接回答用户的主问题；如果证据不足，只说明缺什么证据。",
    ].join("\n");
}

function blockedToolClaimMessage() {
    return [
        "DeepCodex 已拦截这轮回复：模型声称要执行或已经执行工具动作，但本轮没有实际 tool call。",
        "实际状态：本轮尚未读文件、运行命令、安装依赖、启动服务、生成文件、移动文件或搜索网页。",
        "请继续时必须发起真实工具调用；如果工具不可用，必须明确说明原因。",
    ].join("\n");
}

function webToolUnavailableClaimMessage() {
    return [
        "DeepCodex 已拦截这轮回复：模型声称 web_search/web_fetch 不可用，但本轮或已恢复历史里没有对应的 web_search/web_fetch 失败结果。",
        "实际状态：shell、curl、npm、browser 或 exec_command 的网络失败，不能等同于 web_search/web_fetch 不可用。",
        "请继续时必须真实调用 web_search/web_fetch，或只说明具体哪个已执行工具失败；不能伪造 web_search 结果。",
    ].join("\n");
}

function fakeToolClaimRelayPrompt() {
    return [
        blockedToolClaimMessage(),
        "",
        "这不是最终回答。继续当前任务：如果需要读文件、运行命令、安装依赖、启动服务、生成文件、移动文件或搜索网页，必须现在调用可用工具。",
        "不要再次只用自然语言承诺“我来执行/我直接用命令/我已经完成”。",
        "如果当前路由确实没有所需工具，明确说明哪个工具不可用以及下一步需要用户做什么。",
    ].join("\n");
}

function webToolUnavailableRelayPrompt() {
    return [
        webToolUnavailableClaimMessage(),
        "",
        "这不是最终回答。继续当前任务：如果用户请求搜索/查资料/找案例，必须现在调用 web_search 或 web_fetch。",
        "如果你只运行过 shell/exec_command 并且它访问外网失败，只能说 shell/exec_command 网络访问失败；不要说 web_search 不可用。",
    ].join("\n");
}

function requestHasToolEvidence(originalRequest) {
    const input = Array.isArray(originalRequest?.input) ? originalRequest.input : [];
    return input.some(item => item?.type === "function_call_output" || item?.type === "custom_tool_call_output" || item?.role === "tool");
}

function requestHasToolOutputFor(originalRequest, names = []) {
    const wanted = new Set(names);
    const input = Array.isArray(originalRequest?.input) ? originalRequest.input : [];
    const callNames = new Map();
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if ((item.type === "function_call" || item.type === "custom_tool_call") && item.name) {
            const callId = item.call_id || item.id;
            if (callId) callNames.set(callId, item.name);
        }
        if (item.type === "message" && item.role === "assistant" && Array.isArray(item.tool_calls)) {
            for (const tc of item.tool_calls) {
                const callId = tc?.id || tc?.call_id;
                const name = tc?.function?.name || tc?.name;
                if (callId && name) callNames.set(callId, name);
            }
        }
    }
    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output" && item.role !== "tool") continue;
        const directName = item.name || item.tool_name;
        if (directName && wanted.has(directName)) return true;
        const callId = item.call_id || item.tool_call_id || item.id;
        if (callId && wanted.has(callNames.get(callId))) return true;
    }
    return false;
}

function messagesHaveToolEvidence(messages) {
    return Array.isArray(messages) && messages.some(message => message?.role === "tool");
}

function messagesHaveToolOutputFor(messages, names = []) {
    const wanted = new Set(names);
    const callNames = new Map();
    for (const message of messages || []) {
        if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
        for (const tc of message.tool_calls) {
            const callId = tc?.id || tc?.call_id;
            const name = tc?.function?.name || tc?.name;
            if (callId && name) callNames.set(callId, name);
        }
    }
    for (const message of messages || []) {
        if (message?.role !== "tool") continue;
        const directName = message.name || message.tool_name;
        if (directName && wanted.has(directName)) return true;
        const callId = message.tool_call_id || message.call_id || message.id;
        if (callId && wanted.has(callNames.get(callId))) return true;
    }
    return false;
}

function shouldBlockAssistantToolClaim(text, { hasToolEvidence = false, hasToolCall = false, hasWebToolEvidence = false } = {}) {
    if (hasToolCall) return false;
    if (!assistantTextLooksLikeWebToolUnavailableClaim(text) && assistantTextLooksLikeHonestNoEvidenceBlocker(text)) return false;
    if (assistantTextLooksLikeWebToolUnavailableClaim(text) && !hasWebToolEvidence) return true;
    if (!assistantTextLooksLikeUnsupportedToolClaim(text)) return false;
    // Once the turn already has real tool evidence, completion summaries like
    // "已经读取/已经写入" are legitimate. Still block future-action promises
    // that would otherwise end a turn without actually calling the tool.
    if (hasToolEvidence && !assistantTextLooksLikeFutureToolPromise(text)) return false;
    return true;
}

function assistantTextLooksLikeHonestNoEvidenceBlocker(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return false;
    return /(?:没有|无|尚未|还没|未).{0,16}(?:实际|真实).{0,20}(?:搜索|检索|查看|读取|执行|运行|工具|结果|证据)/i.test(value)
        || /(?:shell|命令|exec_command).{0,24}(?:网络|联网|访问外网).{0,24}(?:失败|不可用|不通)/i.test(value);
}

function blockedToolClaimMessageFor(text, context = {}) {
    if (assistantTextLooksLikeWebToolUnavailableClaim(text) && !context.hasWebToolEvidence) {
        return webToolUnavailableClaimMessage();
    }
    return blockedToolClaimMessage();
}

function fakeToolClaimRelayPromptFor(text, context = {}) {
    if (assistantTextLooksLikeWebToolUnavailableClaim(text) && !context.hasWebToolEvidence) {
        return webToolUnavailableRelayPrompt();
    }
    return fakeToolClaimRelayPrompt();
}

function emptyAssistantRelayPrompt() {
    return [
        "DeepCodex 已拦截空回复：上一轮模型没有返回消息，也没有返回 tool call。",
        "",
        "这不是最终回答。请继续当前任务：如果需要读文件、运行命令、安装依赖、启动服务、生成文件、移动文件或搜索网页，必须现在调用可用工具。",
        "如果已经没有可做动作，请用自然语言给出明确结论，不能空完成。",
    ].join("\n");
}

function emptyAssistantBlockedMessage() {
    return [
        "DeepCodex 已拦截空回复：模型没有返回任何可显示内容，也没有发起 tool call。",
        "实际状态：本轮没有完成新的读取、执行、修改或总结。",
        "请继续时重新发送明确任务，或让模型基于已有结果给出结论。",
    ].join("\n");
}

function guardAssistantToolClaims(output, originalRequest = null) {
    if (responseOutputHasToolCall(output)) return output;
    const request = originalRequestFromArg(originalRequest);
    const hasPriorToolEvidence = requestHasToolEvidence(request);
    const hasWebToolEvidence = requestHasToolOutputFor(request, ["web_search", "web_fetch"]);
    let changed = false;
    const guarded = output.map(item => {
        if (item?.type !== "message" || !Array.isArray(item.content)) return item;
        const nextContent = item.content.map(part => {
            if (part?.type !== "output_text" || !shouldBlockAssistantToolClaim(part.text, { hasToolEvidence: hasPriorToolEvidence, hasWebToolEvidence })) return part;
            changed = true;
            return { ...part, text: blockedToolClaimMessageFor(part.text, { hasWebToolEvidence }) };
        });
        return nextContent === item.content ? item : { ...item, content: nextContent };
    });
    return changed ? guarded : output;
}

function outputTextParts(output) {
    return (output || [])
        .filter(item => item?.type === "message" && Array.isArray(item.content))
        .flatMap(item => item.content)
        .filter(part => part?.type === "output_text")
        .map(part => part.text || "")
        .filter(Boolean);
}

function outputToolCalls(output) {
    return (output || []).filter(item => item?.type === "function_call" || item?.type === "custom_tool_call");
}

function toolCallLooksLikeStatusProbe(item) {
    if (!item || item.type !== "function_call") return false;
    if (item.name !== "exec_command") return false;
    return commandLooksLikeStatusProbe(parseRestoredCommandArgs(item));
}

function guardCompletionStatusDetours(output) {
    const toolCalls = outputToolCalls(output);
    if (!toolCalls.length) return output;
    const text = outputTextParts(output).join("\n");
    if (!completedResultsThenStatusDetour(text)) return output;
    const statusProbeCalls = toolCalls.filter(toolCallLooksLikeStatusProbe);
    if (!statusProbeCalls.length || statusProbeCalls.length !== toolCalls.length) return output;
    return [{
        type: "message",
        id: messageId(),
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: detourBlockedMessage(), annotations: [] }],
    }];
}

function chatToResponsesFormat(json, original, routing = null) {
    const originalRequest = originalRequestFromArg(original);
    const choice = json.choices?.[0] || {};
    const msg = choice.message || {};
    const output = [];
    const rawContent = typeof msg.content === "string" ? msg.content : "";
    const pseudoCalls = parsePseudoToolCalls(rawContent);
    const pseudoExternalCalls = pseudoCalls.filter(tc => !isInternalTool(tc?.function?.name));
    const content = sanitizeMarkdownUrlFormatting(pseudoCalls.length > 0 ? stripPseudoToolMarkup(rawContent) : msg.content);
    if (msg.reasoning_content) output.push({ type: "reasoning", id: reasoningId(), status: "completed", summary: [], encrypted_content: encodeReasoningContent(msg.reasoning_content) });
    if (content) output.push({ type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: content, annotations: [] }] });
    if (msg.tool_calls) for (const tc of msg.tool_calls) {
        const upstreamName = tc.function?.name || "";
        // Reverse-map upstream Chat tool name → original Codex callable name using routing metadata
        const route = routing?.[upstreamName];
        const codexName = route?.codexName || upstreamName;
        const isCustom = route?.type === "custom";
        let args = tc.function?.arguments || "{}";
        if (customArgumentsAreInvalid(args, route)) {
            output.push({ type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: invalidCustomToolMessage(codexName), annotations: [] }] });
            continue;
        }
        // Unwrap custom tool arguments from the {content: "..."} wrapper
        if (isCustom && args) {
            try {
                const parsed = JSON.parse(args);
                if (typeof parsed.content === "string") args = parsed.content;
            } catch { /* not json, use as-is */ }
        }
        if (isCustom) {
            output.push({ type: "custom_tool_call", id: functionCallId(), status: "completed", call_id: tc.id || `call_${randomUUID().replaceAll("-", "")}`, name: codexName, input: args });
        } else {
            output.push({ type: "function_call", id: functionCallId(), status: "completed", call_id: tc.id || `call_${randomUUID().replaceAll("-", "")}`, name: codexName, arguments: args });
        }
    }
    for (const tc of pseudoExternalCalls) {
        output.push({ type: "function_call", id: functionCallId(), status: "completed", call_id: tc.id || `call_${randomUUID().replaceAll("-", "")}`, name: tc.function?.name || "", arguments: tc.function?.arguments || "{}" });
    }
    if (pseudoCalls.length > 0 && output.length === 0) {
        output.push({ type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: "Internal tool request was intercepted but could not be completed in this turn. Please retry with a narrower request or a specific URL.", annotations: [] }] });
    }
    const finishReason = choice.finish_reason;
    const guardedOutput = guardAssistantToolClaims(guardCompletionStatusDetours(output), originalRequest);
    return responseShell(originalRequest, {
        id: json.id || responseId(),
        created: json.created || Math.floor(Date.now() / 1000),
        model: json.model || originalRequest.model || "gpt-5.5",
        status: responseStatus(finishReason),
        output: guardedOutput,
        usage: mapUsage(json.usage),
        finishReason,
    });
}

// ──────────────────────────────────────────── internal tool loop ─────────────

async function callUpstreamWithInternalTools(body) {
    const working = { ...body, stream: false, messages: [...(body.messages || [])] };
    const executedInternalCalls = new Set();
    let fakeToolClaimReplays = 0;
    let emptyAssistantReplays = 0;

    const toolLoopReasonText = (reason) => {
        if (reason === "repeated_internal_tool_call") return "模型重复请求了同一个内部工具";
        if (reason === "internal_tool_loop_limit") return "内部工具调用次数已达到上限";
        return "内部工具调用已停止";
    };

    const toolResultSummary = () => {
        const results = (working.messages || [])
            .filter(message => message?.role === "tool")
            .slice(-4)
            .map((message, index) => {
                const content = clipForLog(message.content || "", 1200);
                return `工具结果 ${index + 1} (${message.tool_call_id || "unknown"}): ${content}`;
            })
            .join("\n\n");
        return results || "没有可用的工具结果。";
    };

    const finalizeWithoutTools = async (reason) => {
        const reasonText = toolLoopReasonText(reason);
        const finalBody = {
            ...working,
            tools: undefined,
            tool_choice: "none",
            messages: [
                { role: "system", content: `Internal web tool use has been stopped: ${reasonText}. You must now answer the user directly from the existing tool messages. Do not call web_search, web_fetch, or emit DSML/tool markup. If the evidence is insufficient, say what is missing in natural language.` },
                ...(working.messages || []),
                { role: "user", content: `工具调用已结束。请直接根据上面的 tool 结果回答我，不要再次请求 web_search/web_fetch，也不要输出 DSML/tool_calls 标记。如果证据不足，请用自然语言说明缺少什么。` },
            ],
            stream: false,
        };
        const { res, text, json } = await postChatCompletion(finalBody, "internal-finalize");
        if (res.ok && json) {
            const content = extractAssistantText(json);
            const pseudoCalls = parsePseudoToolCalls(content);
            const msg = json.choices?.[0]?.message || {};
            const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
            if (pseudoCalls.length === 0 && toolCalls.length === 0 && String(content || "").trim()) {
                return { ok: true, status: res.status, json };
            }
        }
        const fallback = [
            `${reasonText}，DeepCodex 已停止继续调用工具，避免陷入重复循环。`,
            "",
            "已有工具结果摘要：",
            toolResultSummary(),
            "",
            "模型没有基于这些结果完成最终总结。请重试一个更具体的问题，或直接提供要抓取的 URL。",
        ].join("\n");
        return { ok: true, status: 200, json: makeTextCompletion(working.model, fallback) };
    };

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
        const { res, text, json } = await postChatCompletion(working, `internal-loop-${loop + 1}`);
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
            const hasExternalCalls = standardExternalCalls.length > 0 || pseudoExternalCalls.length > 0;
            const assistantText = extractAssistantText(json);
            const hasToolEvidence = messagesHaveToolEvidence(working.messages);
            const hasWebToolEvidence = messagesHaveToolOutputFor(working.messages, ["web_search", "web_fetch"]);
            if (!hasExternalCalls && !String(assistantText || "").trim()) {
                if (emptyAssistantReplays < 1) {
                    emptyAssistantReplays += 1;
                    working.messages.push({ role: "user", content: emptyAssistantRelayPrompt() });
                    continue;
                }
                return { ok: true, status: 200, json: makeTextCompletion(working.model, emptyAssistantBlockedMessage()) };
            }
            const shouldRelayFakeClaim = shouldBlockAssistantToolClaim(assistantText, {
                hasToolEvidence,
                hasWebToolEvidence,
                hasToolCall: hasExternalCalls,
            });
            if (shouldRelayFakeClaim) {
                if (fakeToolClaimReplays < MAX_FAKE_TOOL_CLAIM_REPLAYS) {
                    fakeToolClaimReplays += 1;
                    working.messages.push({ role: "assistant", content: assistantText || "" });
                    working.messages.push({ role: "user", content: fakeToolClaimRelayPromptFor(assistantText, { hasWebToolEvidence }) });
                    continue;
                }
                return { ok: true, status: 200, json: makeTextCompletion(working.model, blockedToolClaimMessageFor(assistantText, { hasWebToolEvidence })) };
            }
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
            return finalizeWithoutTools("repeated_internal_tool_call");
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

    return finalizeWithoutTools("internal_tool_loop_limit");
}

function makeTextCompletion(model, content) {
    return { id: `chatcmpl_${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

async function callUpstreamOnce(body) {
    const { res, text, json } = await postChatCompletion({ ...body, stream: false }, "once");
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
    sse("response.in_progress", { type: "response.in_progress", response: inProg });
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
        } else if (item.type === "custom_tool_call") {
            sse("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { ...item, status: "in_progress", input: "" } });
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

function invalidCustomToolMessage(name) {
    const tool = name || "custom/freeform tool";
    return [
        `${tool} requires a complete freeform patch/tool body, not empty JSON.`,
        "Regenerate a valid patch body and call the tool with {\"content\":\"*** Begin Patch\\n...\\n*** End Patch\"}.",
        "For apply_patch, each file hunk must start with exactly one of \"*** Add File:\", \"*** Delete File:\", or \"*** Update File:\" and the final line must be exactly \"*** End Patch\".",
        "Do not use narrative headers, ordinary unified diff headers (---/+++), or line-number replacement prose inside the patch body.",
        "Do not bypass this by writing source files with shell commands just because the freeform tool call was malformed.",
    ].join("\n");
}

function customArgumentsAreInvalid(args, route) {
    if (route?.type !== "custom") return false;
    const text = String(args ?? "").trim();
    if (!text) return true;
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") return false;
        if (Object.keys(parsed).length === 0) return true;
        if (Object.prototype.hasOwnProperty.call(parsed, "content")) {
            return typeof parsed.content !== "string" || parsed.content.trim().length === 0;
        }
        return true;
    } catch {
        return false;
    }
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
            const itemType = tc.route?.type === "custom" ? "custom_tool_call" : "function_call";
            const item = itemType === "custom_tool_call"
                ? { id: tc.itemId, type: itemType, status: "in_progress", call_id: tc.callId, name: tc.name, input: "" }
                : { id: tc.itemId, type: itemType, status: "in_progress", call_id: tc.callId, name: tc.name, arguments: "" };
            events.push(["response.output_item.added", {
                type: "response.output_item.added",
                output_index: tc.outputIndex,
                item,
            }]);
        }
        if (tc.route?.type !== "custom" && tc.opened && tc.emitted < tc.arguments.length) {
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
            const hasWebToolEvidence = requestHasToolOutputFor(this.original, ["web_search", "web_fetch"]);
            const text = shouldBlockAssistantToolClaim(this.text, {
                hasToolEvidence: requestHasToolEvidence(this.original),
                hasToolCall: this.toolCalls.size > 0,
                hasWebToolEvidence,
            })
                ? blockedToolClaimMessageFor(this.text, { hasWebToolEvidence })
                : sanitizeMarkdownUrlFormatting(this.text);
            items.push([this.textOutputIndex, { type: "message", id: this.messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }]);
        }
        for (const tc of this.toolCalls.values()) {
            if (!tc.opened) continue;
            if (customArgumentsAreInvalid(tc.arguments, tc.route)) {
                items.push([tc.outputIndex, { type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: invalidCustomToolMessage(tc.name), annotations: [] }] }]);
                continue;
            }
            const args = unwrapCustomArguments(tc.arguments, tc.route);
            const item = tc.route?.type === "custom"
                ? { id: tc.itemId, type: "custom_tool_call", status: "completed", call_id: tc.callId, name: tc.name, input: args }
                : { id: tc.itemId, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: args };
            items.push([tc.outputIndex, item]);
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
            const hasWebToolEvidence = requestHasToolOutputFor(this.original, ["web_search", "web_fetch"]);
            const text = shouldBlockAssistantToolClaim(this.text, {
                hasToolEvidence: requestHasToolEvidence(this.original),
                hasToolCall: this.toolCalls.size > 0,
                hasWebToolEvidence,
            })
                ? blockedToolClaimMessageFor(this.text, { hasWebToolEvidence })
                : sanitizeMarkdownUrlFormatting(this.text);
            const item = { type: "message", id: this.messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
            events.push(["response.output_text.done", { type: "response.output_text.done", item_id: this.messageId, output_index: this.textOutputIndex, content_index: 0, text }]);
            events.push(["response.content_part.done", { type: "response.content_part.done", item_id: this.messageId, output_index: this.textOutputIndex, content_index: 0, part: item.content[0] }]);
            events.push(["response.output_item.done", { type: "response.output_item.done", output_index: this.textOutputIndex, item }]);
        }
        for (const tc of this.toolCalls.values()) {
            if (!tc.opened) continue;
            if (customArgumentsAreInvalid(tc.arguments, tc.route)) {
                const item = { type: "message", id: messageId(), role: "assistant", status: "completed", content: [{ type: "output_text", text: invalidCustomToolMessage(tc.name), annotations: [] }] };
                events.push(["response.output_item.done", { type: "response.output_item.done", output_index: tc.outputIndex, item }]);
                continue;
            }
            const args = unwrapCustomArguments(tc.arguments, tc.route);
            const isCustom = tc.route?.type === "custom";
            const item = isCustom
                ? { id: tc.itemId, type: "custom_tool_call", status: "completed", call_id: tc.callId, name: tc.name, input: args }
                : { id: tc.itemId, type: "function_call", status: "completed", call_id: tc.callId, name: tc.name, arguments: args };
            if (!isCustom) {
                events.push(["response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: tc.itemId, output_index: tc.outputIndex, call_id: tc.callId, name: tc.name, arguments: args }]);
            }
            events.push(["response.output_item.done", { type: "response.output_item.done", output_index: tc.outputIndex, item }]);
        }
        const output = this.completedItems().map(([, item]) => item);
        events.push(["response.completed", { type: "response.completed", response: this.currentResponse(responseStatus(finishReason), output, this.usage, finishReason) }]);
        return events;
    }
}

async function pipeStreamingChatAsResponses(req, res, body, model, parsed, routing = null) {
    const upstreamBody = normalizeUpstreamBody({ ...body, stream: true });
    const debugId = debugUpstreamRequest("native-stream", upstreamBody);
    const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(UPSTREAM_KEY ? { authorization: `Bearer ${UPSTREAM_KEY}` } : {}) },
        body: JSON.stringify(upstreamBody),
    });
    debugUpstreamResponse(debugId, upstream.status, null, upstream.ok ? "streaming response opened" : "");

    if (!upstream.ok) {
        const text = await upstream.text();
        debugUpstreamResponse(debugId, upstream.status, null, text);
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
    try {
        if (enc === "zstd") {
            if (typeof zlib.zstdDecompressSync !== "function") {
                const error = new Error("This Node.js runtime does not support zstd request decompression. Install Node.js 23+ or use the bundled/recommended runtime.");
                error.statusCode = 415;
                throw error;
            }
            raw = zlib.zstdDecompressSync(raw);
        } else if (enc === "gzip") raw = zlib.gunzipSync(raw);
        else if (enc === "deflate") raw = zlib.inflateSync(raw);
        else if (enc === "br") raw = zlib.brotliDecompressSync(raw);
    } catch (error) {
        if (!error.statusCode) error.statusCode = 400;
        error.message = `Failed to decode request body (${enc || "identity"}): ${error.message || error}`;
        throw error;
    }
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
        return jsonResponse(res, 200, deepcodexUser());
    }

    const localBackend = localBackendApiResponse(req.method, url.pathname);
    if (localBackend) {
        return jsonResponse(res, 200, localBackend);
    }

    if (req.method === "GET" && (url.pathname === "/models" || url.pathname === "/v1/models")) {
        const models = PROFILE?.models || ["deepseek-v4-pro", "deepseek-v4-flash", "gpt-5.5", "gpt-5.4-mini"];
        return jsonResponse(res, 200, { object: "list", data: models.map(id => ({ id, object: "model", created: 1770000000, owned_by: "codex-adaptive" })) });
    }

    if (req.method === "POST" && (url.pathname === "/chat/completions" || url.pathname === "/v1/chat/completions")) {
        try {
            const raw = await readRaw(req);
            let parsed;
            try { parsed = JSON.parse(raw.toString("utf8")); } catch { return fail(res, 400, "Invalid JSON"); }
            const upstreamResp = await postChatCompletion(parsed, "chat-compat");
            if (!upstreamResp.res.ok) {
                const failure = classifyUpstreamFailure(upstreamResp.res.status, upstreamResp.text, upstreamResp.json);
                console.error(`[adaptive][chat-compat] upstream failure ${JSON.stringify(failure)}`);
                return failWithDetails(res, upstreamResp.res.status, failure);
            }
            res.writeHead(upstreamResp.res.status, { "content-type": "application/json", "access-control-allow-origin": "*" });
            return res.end(JSON.stringify(upstreamResp.json));
        } catch (e) {
            return fail(res, e.statusCode || 500, e.message);
        }
    }

    if (req.method === "POST" && (url.pathname === "/responses/input_tokens" || url.pathname === "/v1/responses/input_tokens")) {
        try {
            const raw = await readRaw(req);
            let parsed = {};
            if (raw.length > 0) {
                try { parsed = JSON.parse(raw.toString("utf8")); } catch { return fail(res, 400, "Invalid JSON"); }
            }
            res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
            return res.end(JSON.stringify(inputTokensResponse(parsed)));
        } catch (e) {
            return fail(res, e.statusCode || 500, e.message);
        }
    }

    const responseItemMatch = url.pathname.match(/^\/(?:v1\/)?responses\/([^/]+)\/input_items$/);
    if (req.method === "GET" && responseItemMatch) {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify(emptyInputItemsResponse()));
    }

    const responseCancelMatch = url.pathname.match(/^\/(?:v1\/)?responses\/([^/]+)\/cancel$/);
    if (req.method === "POST" && responseCancelMatch) {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify(cancelledResponse(responseCancelMatch[1])));
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
                if (!upstreamResp.ok) return failWithDetails(res, upstreamResp.status, classifyUpstreamFailure(upstreamResp.status, upstreamResp.text, upstreamResp.json));
                const fmt = chatToCompactResponseFormat(upstreamResp.json, parsed.model || "gpt-5.5", parsed);
                shouldInjectEndTurn(req, parsed);
                res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
                return res.end(JSON.stringify(fmt));
            }

            if (canUseNativeStreaming(parsed, chatBody, compact)) {
                return pipeStreamingChatAsResponses(req, res, chatBody, parsed.model || "gpt-5.5", parsed, routing);
            }

            const upstreamResp = await callUpstreamWithInternalTools(chatBody);
            if (!upstreamResp.ok) return failWithDetails(res, upstreamResp.status, classifyUpstreamFailure(upstreamResp.status, upstreamResp.text, upstreamResp.json));

            const fmt = chatToResponsesFormat(upstreamResp.json, parsed, routing);
            if (shouldInjectEndTurn(req, parsed)) fmt.end_turn = false;

            pipeSSE(res, fmt);
        } catch (e) { fail(res, e.statusCode || 500, e.message); }
        return;
    }

    console.error(`[adaptive] 404 local route ${req.method} ${url.pathname}`);
    fail(res, 404, `Not found: ${req.method} ${url.pathname}`);
});

function isMainModule() {
    const entry = process.argv[1] ? resolvePath(process.argv[1]) : "";
    return entry && entry === fileURLToPath(import.meta.url);
}

if (process.env.NODE_ENV !== "test" && isMainModule()) {
    server.listen(PORT, HOST, () => {
        console.error(`[adaptive] http://${HOST}:${PORT} → ${UPSTREAM}`);
        startup();
    });
}

export { buildSystemBlock, hasPseudoToolMarkup, stripPseudoToolMarkup, sanitizeMarkdownUrlFormatting, parsePseudoToolCalls, responsesToChatBody, callUpstreamWithInternalTools, ChatToResponsesStreamMapper, chatToResponsesFormat, chatToCompactResponseFormat, prepareCompactChatBody, normalizeCompactSummary, canUseNativeStreaming, inputTokensResponse, unknownInputItemText, usageDiagnostics, classifyUpstreamFailure, localBackendApiResponse, MAX_TOOL_LOOPS };
