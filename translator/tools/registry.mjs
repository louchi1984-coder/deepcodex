/**
 * Internal tool registry.
 *
 * The translator only executes tools it owns. External Codex/MCP/plugin
 * tool calls are passed through to Codex by adaptive-server.mjs.
 */

import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function execPython(script, args, timeoutMs = 25_000) {
    const scriptPath = resolve(__dirname, script);
    return new Promise((resolve) => {
        const child = execFile("python3", [scriptPath, ...args], {
            timeout: timeoutMs,
            maxBuffer: 2 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            const text = String(stdout || "").trim();
            if (text) { resolve(text); return; }
            resolve(JSON.stringify({ ok: false, error: error?.message || "no output", stderr: String(stderr || "").slice(0, 500) }));
        });
        child.stdin?.end();
    });
}

function roleEnabled(profile, role) {
    const caps = profile?.capabilities || {};
    const strategy = profile?.toolStrategy || {};
    if (role === "web_search" || role === "web_fetch") {
        const route = strategy[role];
        return caps.internalWebTools !== false && (!route || String(route).startsWith("local."));
    }
    return true;
}

export const INTERNAL_TOOLS = {
    web_search_urllib: {
        definition: {
            type: "function",
            function: {
                name: "web_search",
                description: "Search the web using the translator's local urllib DuckDuckGo Lite/HTML fallback. Returns structured ranked results, snippets, search attempts, freshness/relevance hints, and fetched excerpts for the top 2 results.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "The search query." },
                        count: { type: "integer", description: "Max results (default 6, max 10)." },
                    },
                    required: ["query"],
                },
            },
        },
        needs: new Set(["hostedTools"]),
        priority: 10,
        role: "web_search",
        async execute(args) {
            const query = String(args.query || "").trim();
            if (query.length < 2) return JSON.stringify({ ok: false, error: "query too short" });
            const count = Math.min(Math.max(Number(args.count || 6), 1), 10);
            return execPython("web_search_urllib.py", [query, String(count), "--fetch-top", "2"], 25_000);
        },
    },

    web_fetch_urllib: {
        definition: {
            type: "function",
            function: {
                name: "web_fetch",
                description: "Fetch a known URL and extract readable text via urllib HTTP. Best effort; JavaScript-rendered pages may return limited or empty content.",
                parameters: {
                    type: "object",
                    properties: {
                        url: { type: "string", description: "The exact http(s) URL to fetch." },
                    },
                    required: ["url"],
                },
            },
        },
        needs: new Set(["hostedTools"]),
        priority: 10,
        role: "web_fetch",
        async execute(args) {
            const url = String(args.url || "").trim();
            if (!url.startsWith("http")) return JSON.stringify({ ok: false, error: "invalid URL" });
            return execPython("web_fetch.py", [url], 20_000);
        },
    },
};

export function getToolChoiceForRole(role, profile) {
    const caps = profile?.capabilities || {};
    let best = null;
    for (const [, tool] of Object.entries(INTERNAL_TOOLS)) {
        if (tool.role !== role) continue;
        if (!roleEnabled(profile, role)) continue;
        const missing = [...tool.needs].some(need => !caps[need]);
        if (!missing) continue;
        if (!best || (tool.priority || 0) > (best.priority || 0)) best = tool;
    }
    return best;
}

export function toolsToInject(profile) {
    const caps = profile?.capabilities || {};
    const byRole = {};
    for (const [, tool] of Object.entries(INTERNAL_TOOLS)) {
        if (!roleEnabled(profile, tool.role)) continue;
        const missing = [...tool.needs].some(need => !caps[need]);
        if (!missing) continue;
        const role = tool.role;
        if (!byRole[role] || (tool.priority || 0) > (byRole[role].priority || 0)) {
            byRole[role] = tool;
        }
    }
    return Object.values(byRole).map(t => t.definition);
}

export async function executeInternalTool(name, args) {
    if (process.env.NODE_ENV === "test" && typeof globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ === "function") {
        return globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__(name, args);
    }

    const candidates = Object.values(INTERNAL_TOOLS)
        .filter(tool => tool.definition.function.name === name)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const tool of candidates) {
        const result = await tool.execute(args);
        try {
            const parsed = JSON.parse(result);
            if (parsed?.ok === false) continue;
        } catch {}
        return result;
    }

    return JSON.stringify({
        ok: false,
        error: `internal tool unavailable: ${name}`,
        user_visible_guidance: "Search/fetch is temporarily unavailable. Ask the user for a specific URL or try again later.",
    }, null, 2);
}

export function isInternalTool(name) {
    for (const [, tool] of Object.entries(INTERNAL_TOOLS)) {
        if (tool.definition.function.name === name) return true;
    }
    return false;
}
