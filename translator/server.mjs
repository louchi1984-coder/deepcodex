#!/usr/bin/env node
/**
 * Codex DeepSeek Translator — standalone Responses ↔ Chat protocol bridge.
 *
 * Receives zstd/gzip-compressed OpenAI Responses API requests from Codex,
 * translates them to Chat Completions format, forwards to the upstream
 * (DeepSeek or a proxy like one-api/LiteLLM), and translates the result
 * back to Responses format (including SSE streaming).
 *
 * Zero dependencies on CliGate's account/key/routing modules.
 */

import http from "node:http";
import zlib from "node:zlib";

const HOST = process.env.TRANSLATOR_HOST || "127.0.0.1";
const PORT = Number(process.env.TRANSLATOR_PORT || 8282);
const UPSTREAM = process.env.UPSTREAM_URL || "https://api.deepseek.com/v1";
const UPSTREAM_KEY = process.env.UPSTREAM_API_KEY || process.env.DEEPSEEK_API_KEY || "";
const INTERNAL_TOOL_MAX_LOOPS = 3;

// ────────────────────────────────────────────────────────────────── helpers ──

function fail(res, status, message) {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ error: { message, type: "gateway_error" } }));
}

function stripSlash(s) { return String(s).replace(/\/+$/, ""); }



// ──────────────────────────────────────────────────── model mapping ──────────

const CODEX_TO_DEEPSEEK = {
    "gpt-5.5": "deepseek-v4-pro",
    "gpt-5.4": "deepseek-v4-pro",
    "gpt-5.3-codex": "deepseek-v4-pro",
    "o3": "deepseek-v4-pro",
    "o4-mini": "deepseek-v4-pro",
    "gpt-5.4-mini": "deepseek-v4-flash",
    "gpt-5.4-nano": "deepseek-v4-flash",
};
const LEGACY_ALIASES = {
    "deepseek-chat": { model: "deepseek-v4-flash", thinkingType: "disabled" },
    "deepseek-reasoner": { model: "deepseek-v4-flash", thinkingType: "enabled" },
};
const UNSUPPORTED_SUFFIXES = /\[1m\]|1m$/i;

function resolveModel(model) {
    if (!model) return "deepseek-v4-pro";
    const slug = CODEX_TO_DEEPSEEK[model];
    if (slug) return slug;
    const cleaned = model.replace(UNSUPPORTED_SUFFIXES, "");
    const alias = LEGACY_ALIASES[cleaned];
    if (alias) return alias.model;
    return cleaned || "deepseek-v4-pro";
}

function normalizeDeepSeekRequestBody(body) {
    if (!body || typeof body !== "object") return body;
    let b = body;
    const alias = LEGACY_ALIASES[String(body.model || "").trim().toLowerCase()];
    if (alias) {
        b = { ...body, model: alias.model };
        if (!b.thinking || typeof b.thinking !== "object") b.thinking = { type: alias.thinkingType };
    }
    if (!b.thinking || typeof b.thinking !== "object") {
        b = { ...b, thinking: { type: "disabled" } };
    }
    return b;
}

// ──────────────────────────────────────────── compaction / end_turn ──────────

const SESSIONS = new Map();
const CONTINUATION_WINDOW_MS = 30_000;
const SESSION_GC_TTL_MS = 5 * 60_000;

function gcSessions(now) {
    for (const [k, v] of SESSIONS) {
        if (now - (v.touchedAt || 0) > SESSION_GC_TTL_MS) SESSIONS.delete(k);
    }
}

function parseWindowGen(headerValue) {
    if (typeof headerValue !== "string" || headerValue.length === 0) return null;
    const tail = headerValue.split(":").pop();
    const n = Number.parseInt(tail, 10);
    return Number.isFinite(n) ? n : null;
}

function isCompactionRequest(req, body) {
    if (typeof req?.path === "string" && req.path.endsWith("/compact")) return true;
    const tools = body && Array.isArray(body.tools) ? body.tools : [];
    return tools.length === 0;
}

function shouldInjectEndTurnFalse(req, body) {
    if (!req || !body) return false;
    const sessionId = req.headers && req.headers["session_id"];
    if (typeof sessionId !== "string" || sessionId.length === 0) return false;
    const windowGen = parseWindowGen(req.headers["x-codex-window-id"]);
    if (windowGen === null) return false;
    const now = Date.now();
    gcSessions(now);
    let entry = SESSIONS.get(sessionId);
    if (!entry) { entry = { pendingAt: null, lastWindowGen: null, touchedAt: now }; SESSIONS.set(sessionId, entry); }
    entry.touchedAt = now;
    if (isCompactionRequest(req, body)) { entry.pendingAt = now; entry.lastWindowGen = windowGen; return false; }
    const pendingAt = entry.pendingAt;
    const lastGen = entry.lastWindowGen;
    const isAutoContinuation = pendingAt !== null && now - pendingAt < CONTINUATION_WINDOW_MS && lastGen !== null && windowGen > lastGen;
    entry.pendingAt = null;
    entry.lastWindowGen = windowGen;
    return isAutoContinuation;
}

function applyEndTurnFalse(obj) {
    if (obj && typeof obj === "object") obj.end_turn = false;
    return obj;
}

// ──────────────────────────────────────────── Responses ⇄ Chat translation ──

const HOSTED_ONLY_TOOL_TYPES = new Set(["web_search", "web_search_preview", "image_generation", "code_interpreter"]);

const DEEPSEEK_CODEX_LIMITATIONS_SYSTEM = [
    "DeepSeek Codex route limitations:",
    "You are running through a DeepSeek text-only API key. Treat this as a provider capability limit, not a Codex/plugin limit.",
    "Use local tools, installed skills, and plugins when they are available and do not require unsupported provider capabilities.",
    "Do not assume images, image generation, official account authorization, or remote connector permissions are unavailable unless the current request actually needs them and the tool/provider path fails or lacks that capability.",
    "When the current request needs a capability this provider path cannot handle, pause the workflow and ask the user to manually take over that step.",
    "Give a concrete handoff instruction, such as asking the user to describe the image, paste extracted text/results, complete an official-account authorization step, or run the step in a capable route and return with the result.",
    "For Computer Use or repeated screen-reading workflows, explain that manual takeover is impractical because they require a continuous screenshot-feedback loop over many steps; ask the user to use a vision-capable route for that workflow.",
].join(" ");

const DEEPSEEK_LOCAL_SEARCH_SYSTEM = [
    "DeepCodex local search workflow:",
    "You do not have official hosted WebSearch on this DeepSeek route.",
    "When the user asks to search the web, use the injected web_search/web_fetch tools provided by the translator.",
    "Do not try Wikipedia, Baidu, Bing, Sogou, Google scraping, dokobot, Browser/Browser Use, or ad-hoc Python search snippets before those translator tools.",
    "This executor uses Python urllib with DuckDuckGo Lite/HTML and returns JSON fields such as title, url, snippet, source, date, fetched, snippet_only, weak_relevance, fetch_error, page_title, and excerpt.",
    "Base your answer only on returned snippets/excerpts. Do not claim you read a page body when snippet_only is true or fetch_error is set.",
    "For weather, product prices, sports schedules, and other fast-changing structured data, treat results as uncertain unless the returned data includes a reliable timestamp or fetched page excerpt.",
    "If results are weak, stale, blocked, JS-only, or missing, say so and ask the user for a URL, manual verification, or a more capable route instead of inventing facts.",
    "Do not use Jina, Bing, or Baidu as default urllib fallbacks.",
].join(" ");

function responsesToChatBody(parsed, options = {}) {
    const messages = [];
    const textOnlyImages = options.textOnlyImages === true;
    const extraSystemInstructions = typeof options.extraSystemInstructions === "string" ? options.extraSystemInstructions.trim() : "";
    const imageHandoffText = "[Image omitted: this DeepSeek text-only route cannot inspect images. Ask the user to describe the image, paste OCR text, or provide the specific visual details needed before continuing.]";

    if (parsed.instructions) messages.push({ role: "system", content: parsed.instructions });
    if (extraSystemInstructions) messages.push({ role: "system", content: extraSystemInstructions });

    const convertBlock = (c) => {
        if (!c) return null;
        if (c.type === "text" || (c.text && c.type !== "input_image")) return { type: "text", text: c.text || "" };
        if (c.type === "input_image" || c.type === "image") {
            if (textOnlyImages) return { type: "text", text: imageHandoffText };
            if (c.data) return { type: "image_url", image_url: { url: `data:${c.media_type || "image/jpeg"};base64,${c.data}` } };
            if (c.image_url) return { type: "image_url", image_url: { url: c.image_url } };
            if (c.url) return { type: "image_url", image_url: { url: c.url } };
            return null;
        }
        if (c.type === "image_url" || c.image_url) {
            if (textOnlyImages) return { type: "text", text: imageHandoffText };
            return { type: "image_url", image_url: c.image_url || { url: c.url } };
        }
        return null;
    };

    if (Array.isArray(parsed.input)) {
        let pendingToolCalls = null;
        let pendingToolCallIds = null;
        let deferredMessages = [];

        const flushDeferred = () => { if (deferredMessages.length > 0) { messages.push(...deferredMessages); deferredMessages = []; } };
        const ensureFlushed = () => {
            if (pendingToolCalls) {
                messages.push(pendingToolCalls);
                pendingToolCallIds = new Set((pendingToolCalls.tool_calls || []).map(tc => tc.id).filter(Boolean));
                pendingToolCalls = null;
            }
        };

        for (const item of parsed.input) {
            if (item.type === "function_call") {
                if (pendingToolCallIds?.size > 0) { flushDeferred(); pendingToolCallIds = null; }
                if (!pendingToolCalls) {
                    const last = messages[messages.length - 1];
                    if (last?.role === "assistant" && !last.tool_calls) {
                        pendingToolCalls = messages.pop();
                        pendingToolCalls.tool_calls = [];
                        pendingToolCalls.content = pendingToolCalls.content || null;
                    } else {
                        pendingToolCalls = { role: "assistant", content: null, tool_calls: [] };
                    }
                }
                pendingToolCalls.tool_calls.push({
                    id: item.call_id || item.id || `call_${Date.now()}`,
                    type: "function",
                    function: { name: item.name, arguments: item.arguments || "{}" },
                });
            } else {
                if (item.type === "message") {
                    ensureFlushed();
                    flushDeferred();
                    const role = item.role === "developer" ? "system" : item.role;
                    let content;
                    if (typeof item.content === "string") {
                        content = item.content;
                    } else if (Array.isArray(item.content)) {
                        content = item.content.map(convertBlock).filter(Boolean);
                        if (content.length > 0 && content.every(c => c.type === "text")) {
                            content = content.map(c => c.text).join("\n");
                        }
                    }
                    messages.push({ role, content: content || null });
                } else if (item.type === "function_call_output") {
                    ensureFlushed();
                    const callId = item.call_id || item.id || "";
                    if (item.output) {
                        let toolContent = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
                        messages.push({ role: "tool", tool_call_id: callId, content: toolContent });
                    }
                } else if (item.type === "reasoning") {
                    // Not echoed back by Codex; skip but log presence
                }
            }
        }
        ensureFlushed();
        flushDeferred();
    } else if (typeof parsed.input === "string") {
        messages.push({ role: "user", content: parsed.input });
    }

    const body = { model: resolveModel(parsed.model), messages, stream: false };

    // Tools
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        const kept = [];
        for (const t of parsed.tools) {
            if (HOSTED_ONLY_TOOL_TYPES.has(t.type)) continue;
            const fnName = t.name || t.function?.name || "";
            if (!fnName) continue;
            kept.push({
                type: "function",
                function: {
                    name: fnName,
                    description: t.description || t.function?.description || "",
                    parameters: t.parameters || t.function?.parameters || { type: "object", properties: {} },
                },
            });
        }
        if (kept.length > 0) body.tools = kept;
    }

    // tool_choice
    if (parsed.tool_choice) {
        if (typeof parsed.tool_choice === "string") body.tool_choice = parsed.tool_choice;
        else if (parsed.tool_choice.type === "function" && parsed.tool_choice.function) {
            body.tool_choice = { type: "function", function: { name: parsed.tool_choice.function.name } };
        }
    }

    if (parsed.max_output_tokens) body.max_completion_tokens = parsed.max_output_tokens;
    if (parsed.temperature !== undefined) body.temperature = parsed.temperature;
    if (parsed.top_p !== undefined) body.top_p = parsed.top_p;

    return body;
}

function chatToResponsesFormat(chatResponse, model) {
    const choice = chatResponse.choices?.[0];
    const msg = choice?.message || {};
    const output = [];

    if (msg.reasoning_content) {
        output.push({ type: "reasoning", id: `rs_${Date.now()}`, summary: [{ type: "summary_text", text: String(msg.reasoning_content) }] });
    }
    if (msg.content) {
        output.push({ type: "message", id: `msg_${Date.now()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: msg.content }] });
    }
    if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
            output.push({ type: "function_call", id: tc.id, call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || "{}" });
        }
    }

    return {
        id: chatResponse.id || `resp_${Date.now()}`,
        object: "response",
        created_at: chatResponse.created || Math.floor(Date.now() / 1000),
        model: model,
        status: "completed",
        output,
        usage: { input_tokens: chatResponse.usage?.prompt_tokens || 0, output_tokens: chatResponse.usage?.completion_tokens || 0, total_tokens: chatResponse.usage?.total_tokens || 0 },
    };
}

// ──────────────────────────────────────────────────────── SSE emitter ────────

function pipeSSE(res, responsesFormat) {
    res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "access-control-allow-origin": "*",
    });

    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const inProgress = { ...responsesFormat, status: "in_progress", output: [] };
    sse("response.created", { type: "response.created", response: inProgress });

    let outputIndex = 0;
    for (const item of responsesFormat.output || []) {
        if (item.type === "message") {
            const msgItem = { ...item, status: "in_progress", content: [] };
            sse("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item: msgItem });

            if (item.content) {
                for (let ci = 0; ci < item.content.length; ci++) {
                    const part = item.content[ci];
                    sse("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: outputIndex, content_index: ci, part: { type: "output_text", text: "" } });

                    const text = part.text || "";
                    const CHUNK_SIZE = 40;
                    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
                        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: outputIndex, content_index: ci, delta: text.slice(i, i + CHUNK_SIZE) });
                    }
                    sse("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: outputIndex, content_index: ci, text });
                    sse("response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: outputIndex, content_index: ci, part });
                }
            }
            sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
        } else if (item.type === "function_call") {
            const fcItem = { ...item, status: "in_progress", arguments: "" };
            sse("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item: fcItem });
            const args = item.arguments || "{}";
            sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: outputIndex, item_id: item.id, call_id: item.call_id, name: item.name, delta: args });
            sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: outputIndex, item_id: item.id, call_id: item.call_id, name: item.name, arguments: args });
            sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
        } else {
            // custom_tool_call, apply_patch_call, shell_call, mcp_call, reasoning, etc.
            const interim = { ...item, status: "in_progress" };
            sse("response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item: interim });
            sse("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
        }
        outputIndex++;
    }

    sse("response.completed", { type: "response.completed", response: responsesFormat });
    res.end();
}

// ────────────────────────────────────────────────────── body decoding ────────

async function readRawBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const enc = (req.headers["content-encoding"] || "").toLowerCase();
    if (enc === "zstd") {
        try { return zlib.zstdDecompressSync(raw); } catch { return raw; }
    }
    if (enc === "gzip") return zlib.gunzipSync(raw);
    if (enc === "deflate") return zlib.inflateSync(raw);
    if (enc === "br") return zlib.brotliDecompressSync(raw);
    return raw;
}

// ─────────────────────────────────────────────────────── upstream call ───────

async function callUpstream(body) {
    const url = `${stripSlash(UPSTREAM)}/chat/completions`;
    const upstreamBody = normalizeDeepSeekRequestBody(body);
    const headers = { "content-type": "application/json" };
    if (UPSTREAM_KEY) headers["authorization"] = `Bearer ${UPSTREAM_KEY}`;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text };
}

// ──────────────────────────────────────────────────────── HTTP server ────────

const server = http.createServer(async (req, res) => {
    // CORS
    if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,content-encoding" });
        return res.end();
    }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify({ ok: true, upstream: UPSTREAM }));
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        return res.end(JSON.stringify({ object: "list", data: ["deepseek-v4-pro", "deepseek-v4-flash", "gpt-5.5", "gpt-5.4-mini"].map(id => ({ id, object: "model", created: 1770000000, owned_by: "codex-deepseek-translator" })) }));
    }

    if ((req.method === "POST" && url.pathname === "/v1/responses") || url.pathname === "/responses") {
        try {
            const raw = await readRawBody(req);
            let parsed;
            try { parsed = JSON.parse(raw.toString("utf8")); } catch { return fail(res, 400, "Invalid JSON body"); }
            if (!parsed || typeof parsed !== "object") return fail(res, 400, "Empty body");

            const isCompact = url.pathname.endsWith("/compact");
            const originalModel = parsed.model || "gpt-5.5";

            // Compaction: force non-streaming, short answer
            if (isCompact) {
                parsed.stream = false;
                parsed.store = false;
                parsed.max_output_tokens = Math.min(parsed.max_output_tokens || 1024, 1024);
            }

            const options = { textOnlyImages: true, extraSystemInstructions: `${DEEPSEEK_CODEX_LIMITATIONS_SYSTEM}\n\n${DEEPSEEK_LOCAL_SEARCH_SYSTEM}` };
            const chatBody = responsesToChatBody(parsed, options);
            chatBody.model = resolveModel(parsed.model);

            const resp = await callUpstream(chatBody);
            if (!resp.ok) {
                return fail(res, resp.status, resp.text ? resp.text.slice(0, 500) : `Upstream error ${resp.status}`);
            }

            const responsesFormat = chatToResponsesFormat(resp.json, originalModel);

            // Inject end_turn if compaction continuation
            const injectEndTurn = shouldInjectEndTurnFalse(req, parsed);
            if (injectEndTurn) applyEndTurnFalse(responsesFormat);

            pipeSSE(res, responsesFormat);
        } catch (e) {
            fail(res, 500, e.message);
        }
        return;
    }

    fail(res, 404, `Not found: ${req.method} ${url.pathname}`);
});

server.listen(PORT, HOST, () => {
    console.log(`Translator listening on http://${HOST}:${PORT}`);
    console.log(`Upstream: ${UPSTREAM}`);
});

export { responsesToChatBody, chatToResponsesFormat, normalizeDeepSeekRequestBody, resolveModel };
