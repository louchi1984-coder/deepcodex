/**
 * Provider Capability Probe
 *
 * Given a base URL + API key, probes the upstream for:
 *   1. Basic chat (must pass)
 *   2. Model list
 *   3. Streaming
 *   4. Tool calls
 *   5. Thinking support
 *
 * Returns a cached profile.  On first launch, probe once and persist;
 * on later launches, re-use the cached profile unless the key/URL changed.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CACHE_DIR = process.env.TRANSLATOR_CACHE_DIR || resolve(process.env.HOME || "/tmp", ".codex-translator");

// ─────────────────────────────────────────────── fingerprint ────────────────

function fingerprint(key) {
    return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function cacheKey(baseUrl, apiKey) {
    const url = baseUrl.replace(/\/+$/, "");
    return `${url}::${fingerprint(apiKey)}`;
}

function cachePath(baseUrl, apiKey) {
    const id = createHash("sha256").update(cacheKey(baseUrl, apiKey)).digest("hex").slice(0, 12);
    return resolve(CACHE_DIR, `profile-${id}.json`);
}

// ─────────────────────────────────────────────── upstream helpers ────────────

async function fetchJSON(url, apiKey, init = {}) {
    const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...(init.headers || {}) };
    let res;
    let text;
    try {
        res = await fetch(url, { ...init, headers });
        text = await res.text();
    } catch (err) {
        if (!hasProxyEnv()) throw err;
        return fetchJSONWithCurl(url, headers, init);
    }
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text };
}

function hasProxyEnv() {
    return Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
}

async function fetchJSONWithCurl(url, headers, init = {}) {
    try {
        return await fetchJSONWithCurlOnce(url, headers, init, process.env);
    } catch (err) {
        if (!hasProxyEnv()) throw err;
        const env = { ...process.env };
        for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
            delete env[key];
        }
        return fetchJSONWithCurlOnce(url, headers, init, env);
    }
}

async function fetchJSONWithCurlOnce(url, headers, init = {}, env = process.env) {
    const method = init.method || (init.body ? "POST" : "GET");
    const args = ["-sS", "-L", "-X", method, "-w", "\n__DEEPCODEX_HTTP_STATUS__:%{http_code}"];
    for (const [key, value] of Object.entries(headers)) {
        args.push("-H", `${key}: ${value}`);
    }
    if (init.body != null) args.push("--data", String(init.body));
    args.push(url);
    const { stdout } = await execFileAsync("curl", args, { env, maxBuffer: 8 * 1024 * 1024 });
    const marker = "\n__DEEPCODEX_HTTP_STATUS__:";
    const index = stdout.lastIndexOf(marker);
    const text = index >= 0 ? stdout.slice(0, index) : stdout;
    const status = index >= 0 ? Number(stdout.slice(index + marker.length).trim()) : 0;
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: status >= 200 && status < 300, status, json, text };
}

// ─────────────────────────────────────────────── probes ─────────────────────

async function probeBasic(baseUrl, apiKey, model) {
    const { ok, json } = await fetchJSON(`${baseUrl}/chat/completions`, apiKey, {
        method: "POST",
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply exactly: ok" }], max_tokens: 16 }),
    });
    return ok && (json?.choices?.[0]?.message?.content != null);
}

async function probeModels(baseUrl, apiKey) {
    const { ok, json } = await fetchJSON(`${baseUrl}/models`, apiKey);
    if (!ok || !Array.isArray(json?.data)) return [];
    return json.data.map(m => m.id).filter(Boolean);
}

async function probeStream(baseUrl, apiKey, model) {
    const body = JSON.stringify({ model, messages: [{ role: "user", content: "Reply exactly: ok" }], max_tokens: 16, stream: true });
    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body,
        });
        return res.ok;
    } catch (err) {
        if (!hasProxyEnv()) throw err;
    }
    const { ok } = await fetchJSONWithCurl(`${baseUrl}/chat/completions`, {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
    }, {
        method: "POST",
        body,
    });
    return ok;
}

async function probeToolCalls(baseUrl, apiKey, model) {
    const { ok, json } = await fetchJSON(`${baseUrl}/chat/completions`, apiKey, {
        method: "POST",
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Call get_time with timezone Asia/Shanghai." }],
            tools: [{ type: "function", function: { name: "get_time", description: "Get time.", parameters: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] } } }],
            tool_choice: "auto",
            max_tokens: 64,
        }),
    });
    return ok && Array.isArray(json?.choices?.[0]?.message?.tool_calls);
}

async function probeThinking(baseUrl, apiKey, model) {
    const { ok } = await fetchJSON(`${baseUrl}/chat/completions`, apiKey, {
        method: "POST",
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply exactly: ok" }], max_tokens: 32, thinking: { type: "enabled" }, reasoning_effort: "high" }),
    });
    return ok;
}

async function probeImageInput(baseUrl, apiKey, model) {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const { ok, json } = await fetchJSON(`${baseUrl}/chat/completions`, apiKey, {
        method: "POST",
        body: JSON.stringify({
            model,
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "Reply exactly: ok" },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${tinyPng}` } },
                ],
            }],
            max_tokens: 16,
        }),
    });
    return ok && (json?.choices?.[0]?.message?.content != null);
}

async function probeImageGeneration(baseUrl, apiKey) {
    const { ok, json } = await fetchJSON(`${baseUrl}/images/generations`, apiKey, {
        method: "POST",
        body: JSON.stringify({ prompt: "a plain blue square", n: 1, size: "256x256" }),
    });
    return ok && Array.isArray(json?.data);
}

// ─────────────────────────────────────────────── vendor detection ────────────

export const PROVIDER_DEFAULTS = {
    deepseek: {
        provider: "deepseek",
        name: "deepseek",
        domain: "api.deepseek.com",
        baseUrl: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-v4-pro",
        fastModel: "deepseek-v4-flash",
        knownModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
        codexModelAliases: { "gpt-5.5": "default", "gpt-5.4": "default", "gpt-5.3-codex": "default", "o3": "default", "o4-mini": "default", "gpt-5.4-mini": "fast", "gpt-5.4-nano": "fast" },
        legacyAliases: {
            "deepseek-chat": { model: "fast", thinking: "disabled" },
            "deepseek-reasoner": { model: "fast", thinking: "enabled" },
        },
        capabilities: { vision: false, imageGeneration: false, hostedTools: false, internalWebTools: true, reasoningReplay: true },
        toolStrategy: { web_search: "local.ddg_urllib", web_fetch: "local.http_fetch", web_time: "local.system_time", web_weather: "replacement.open_meteo", web_image: "fallback.search_or_handoff", image_input: "text_placeholder", image_generation: "manual_handoff" },
    },
    openai: {
        provider: "openai",
        name: "openai",
        domain: "api.openai.com",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o",
        fastModel: "gpt-4o-mini",
        knownModels: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
        codexModelAliases: {},
        legacyAliases: {},
        capabilities: { vision: true, imageGeneration: true, hostedTools: true, internalWebTools: false, reasoningReplay: false },
        toolStrategy: { web_search: "provider.hosted", web_fetch: "provider.hosted", image_input: "provider.vision", image_generation: "provider.hosted" },
    },
};

const VENDORS = [
    PROVIDER_DEFAULTS.deepseek,
    PROVIDER_DEFAULTS.openai,
    { name: "groq", domain: "api.groq.com", defaultModel: "llama-4-maverick-17b-128e-instruct", fastModel: "llama-4-scout-17b-16e-instruct", knownModels: [], vision: false, hostedTools: false, reasoningReplay: false },
    { name: "openrouter", domain: "openrouter.ai", defaultModel: "openai/gpt-4o", fastModel: "openai/gpt-4o-mini", knownModels: [], vision: true, hostedTools: false, reasoningReplay: false },
    { name: "zhipu", domain: "open.bigmodel.cn", defaultModel: "glm-4-plus", fastModel: "glm-4-flash", knownModels: ["glm-4-plus", "glm-4-flash", "glm-4-air"], vision: true, hostedTools: false, reasoningReplay: false },
    { name: "moonshot", domain: "api.moonshot.cn", defaultModel: "moonshot-v1-8k", fastModel: "moonshot-v1-8k", knownModels: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"], vision: false, hostedTools: false, reasoningReplay: false },
    { name: "qwen", domain: "dashscope.aliyuncs.com", defaultModel: "qwen-max", fastModel: "qwen-turbo", knownModels: ["qwen-max", "qwen-plus", "qwen-turbo"], vision: true, hostedTools: false, reasoningReplay: false },
];

function detectVendor(baseUrl) {
    const url = baseUrl.toLowerCase();
    for (const v of VENDORS) {
        if (url.includes(v.domain)) return v;
    }
    // fallback: generic OpenAI-compatible
    return { name: "openai-compatible", domain: "", defaultModel: "gpt-4o", fastModel: "gpt-4o-mini", knownModels: [], vision: false, hostedTools: false, reasoningReplay: false };
}

function envBool(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
    return fallback;
}

// ─────────────────────────────────────────────── capability resolver ─────────

async function resolveCapabilities(baseUrl, apiKey, vendor) {
    const model = vendor.defaultModel;
    const [basic, listedModels, stream, toolCalls, thinking, imageInput, imageGeneration] = await Promise.all([
        probeBasic(baseUrl, apiKey, model),
        probeModels(baseUrl, apiKey),
        probeStream(baseUrl, apiKey, model),
        probeToolCalls(baseUrl, apiKey, model),
        probeThinking(baseUrl, apiKey, model),
        probeImageInput(baseUrl, apiKey, model).catch(() => false),
        probeImageGeneration(baseUrl, apiKey).catch(() => false),
    ]);

    const models = (listedModels.length > 0 ? listedModels : vendor.knownModels).length > 0
        ? (listedModels.length > 0 ? listedModels : vendor.knownModels)
        : [vendor.defaultModel, vendor.fastModel];
    const defaultModel = models.includes(vendor.defaultModel) ? vendor.defaultModel : (models[0] || vendor.defaultModel);
    const fastModel = models.includes(vendor.fastModel) ? vendor.fastModel : defaultModel;

    // Tool strategy: where to route each tool category
    const vendorCaps = vendor.capabilities || {};
    const toolStrategy = { ...(vendor.toolStrategy || {}) };
    if (vendorCaps.hostedTools || vendor.hostedTools) {
        toolStrategy.web_search = "provider.hosted";
        toolStrategy.web_fetch = "provider.hosted";
        toolStrategy.image_generation = "provider.hosted";
    } else if (Object.keys(toolStrategy).length === 0) {
        toolStrategy.web_search = "local.ddg_urllib";
        toolStrategy.web_fetch = "local.http_fetch";
        toolStrategy.web_time = "local.system_time";
        toolStrategy.web_weather = "replacement.open_meteo";
        toolStrategy.web_image = "fallback.search_or_handoff";
    }
    if (!imageInput && toolStrategy.image_input === undefined) toolStrategy.image_input = "text_placeholder";
    if (!imageGeneration) {
        toolStrategy.image_generation = "manual_handoff";
    }

    const detected = {
        models: listedModels,
        basicChat: basic,
        stream,
        toolCalls,
        thinking,
        imageInput,
        imageGeneration,
    };

    const capabilities = {
        basicChat: basic,
        stream,
        toolCalls,
        thinking,
        vision: envBool("TRANSLATOR_CAP_VISION", imageInput || Boolean(vendorCaps.vision ?? vendor.vision)),
        imageGeneration: envBool("TRANSLATOR_CAP_IMAGE_GENERATION", imageGeneration || Boolean(vendorCaps.imageGeneration)),
        hostedTools: envBool("TRANSLATOR_CAP_HOSTED_TOOLS", Boolean(vendorCaps.hostedTools ?? vendor.hostedTools)),
        internalWebTools: envBool("TRANSLATOR_CAP_INTERNAL_WEB_TOOLS", vendorCaps.internalWebTools ?? !(vendorCaps.hostedTools ?? vendor.hostedTools)),
        reasoningReplay: envBool("TRANSLATOR_CAP_REASONING_REPLAY", Boolean(vendorCaps.reasoningReplay ?? vendor.reasoningReplay)),
        nativeStreaming: envBool("TRANSLATOR_CAP_NATIVE_STREAMING", stream),
        streamToolCalls: envBool("TRANSLATOR_CAP_STREAM_TOOL_CALLS", stream && toolCalls),
        streamReasoning: envBool("TRANSLATOR_CAP_STREAM_REASONING", stream && thinking),
    };

    const defaults = {
        baseUrl: vendor.baseUrl || baseUrl,
        defaultModel: vendor.defaultModel,
        fastModel: vendor.fastModel,
        knownModels: vendor.knownModels || [],
        codexModelAliases: vendor.codexModelAliases || {},
        legacyAliases: vendor.legacyAliases || {},
        capabilities: vendorCaps,
        toolStrategy: vendor.toolStrategy || toolStrategy,
    };
    const effective = { ...defaults, baseUrl, models, defaultModel, fastModel, capabilities, toolStrategy };

    return {
        provider: vendor.name || vendor.provider,
        source: "builtin+detected",
        baseUrl,
        model: defaultModel,
        fastModel,
        keyFingerprint: fingerprint(apiKey),
        probedAt: new Date().toISOString(),
        defaults,
        detected,
        effective,
        capabilities,
        toolStrategy,
        models,
        defaultModel,
    };
}

// ─────────────────────────────────────────────── load / store ────────────────

function loadCached(baseUrl, apiKey) {
    const path = cachePath(baseUrl, apiKey);
    if (!existsSync(path)) return null;
    try {
        const raw = readFileSync(path, "utf8");
        return JSON.parse(raw);
    } catch { return null; }
}

function saveCache(baseUrl, apiKey, profile) {
    const path = cachePath(baseUrl, apiKey);
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(profile, null, 2), "utf8");
}

// ─────────────────────────────────────────────── main entry ──────────────────

export async function probeCapabilities(baseUrl, apiKey, { force = false } = {}) {
    if (!force) {
        const cached = loadCached(baseUrl, apiKey);
        if (cached) {
            console.error(`[probe] Using cached profile for ${cached.provider} (probed ${cached.probedAt})`);
            return cached;
        }
    }

    const vendor = detectVendor(baseUrl);
    console.error(`[probe] Detected vendor: ${vendor.name} (${vendor.domain})`);
    console.error(`[probe] Probing ${vendor.defaultModel}...`);

    const profile = await resolveCapabilities(baseUrl, apiKey, vendor);
    saveCache(baseUrl, apiKey, profile);

    console.error(`[probe] Profile ready:`);
    console.error(`  basicChat: ${profile.capabilities.basicChat}`);
    console.error(`  stream:    ${profile.capabilities.stream}`);
    console.error(`  toolCalls: ${profile.capabilities.toolCalls}`);
    console.error(`  thinking:  ${profile.capabilities.thinking}`);
    console.error(`  vision:    ${profile.capabilities.vision}`);
    console.error(`  hosted:    ${profile.capabilities.hostedTools}`);

    return profile;
}

// ─────────────────────────────────────────────── CLI smoke test ──────────────

async function main() {
    const baseUrl = process.argv[2] || process.env.UPSTREAM_URL || "https://api.deepseek.com/v1";
    const apiKey = process.argv[3] || process.env.UPSTREAM_API_KEY || process.env.DEEPSEEK_API_KEY || "";

    if (!apiKey) {
        console.error("Usage: node probe.mjs <baseUrl> <apiKey>");
        process.exit(1);
    }

    const profile = await probeCapabilities(baseUrl, apiKey, { force: true });
    console.log(JSON.stringify(profile, null, 2));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""))) {
    main().catch(err => { console.error(err); process.exit(1); });
}
