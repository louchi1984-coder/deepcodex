#!/usr/bin/env node
import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);
const nodeBin = process.env.NODE_BIN || process.execPath;
const iconPath = path.join(root, "assets", "codex-deepseek-icon-final.png");
const baseUrl = (process.env.UPSTREAM_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const profilePath = process.env.DEEPCODEX_PROVIDER_PROFILE || path.join(root, "codex-home-deepseek-app", "provider-profile.json");
const serverOnly = process.env.DEEPCODEX_SETUP_SERVER_ONLY === "1";
const requestedPort = Number(process.env.DEEPCODEX_SETUP_PORT || 0);

const tests = [
  { id: "connect", label: "连接 DeepSeek", critical: true, run: testDeepSeekConnection },
  { id: "vision", label: "测试读图能力", critical: false, run: testVisionSupport },
];

let currentProfile = null;

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 32) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function testKey(key) {
  if (!/^sk-[A-Za-z0-9._-]{16,}$/.test(key)) {
    throw new Error("看起来不像 DeepSeek API key");
  }
}

async function testDeepSeekConnection(key) {
  await testKey(key);
  const result = await checkModelsEndpoint(key);
  if (result.status === 401 || result.status === 403) throw new Error("DeepSeek API key 无效或无权限");
  if (!result.ok) throw new Error(result.error || `DeepSeek 连接失败 (${result.status || "unknown"})`);
  currentProfile = defaultDeepSeekProfile(key);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(currentProfile, null, 2));
  return { detail: `${currentProfile.provider} / ${currentProfile.defaultModel}` };
}

async function testVisionSupport(key) {
  if (!currentProfile) currentProfile = defaultDeepSeekProfile(key);
  const result = await probeImageInputEndpoint(key, currentProfile.defaultModel || "deepseek-v4-pro");
  if (!result.ok) {
    throw new NonCriticalUnsupported(result.error || "当前上游未通过读图探测");
  }
  currentProfile.capabilities.vision = true;
  currentProfile.capabilities.imageGeneration = currentProfile.capabilities.imageGeneration || false;
  currentProfile.detected.imageInput = true;
  currentProfile.defaults.capabilities.vision = true;
  currentProfile.effective.capabilities.vision = true;
  currentProfile.toolStrategy.image_input = "provider.vision";
  currentProfile.effective.toolStrategy.image_input = "provider.vision";
  currentProfile.probedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(currentProfile, null, 2));
  return { detail: "已启用图片理解" };
}

async function checkModelsEndpoint(key) {
  const url = `${baseUrl}/models`;
  const args = ["-sS", "-L", "-X", "GET", "-w", "\n__DEEPCODEX_HTTP_STATUS__:%{http_code}", "-H", `authorization: Bearer ${key}`, url];
  for (const env of [process.env, withoutProxyEnv(process.env)]) {
    try {
      const { stdout } = await execFileAsync("curl", args, { env, maxBuffer: 1024 * 1024 });
      const marker = "\n__DEEPCODEX_HTTP_STATUS__:";
      const index = stdout.lastIndexOf(marker);
      const body = index >= 0 ? stdout.slice(0, index) : stdout;
      const status = index >= 0 ? Number(stdout.slice(index + marker.length).trim()) : 0;
      let json = null;
      try { json = JSON.parse(body); } catch {}
      return { ok: status >= 200 && status < 300, status, json };
    } catch (err) {
      if (env !== process.env) return { ok: false, status: 0, error: err.message || String(err) };
    }
  }
  return { ok: false, status: 0, error: "DeepSeek 连接失败" };
}

async function probeImageInputEndpoint(key, model) {
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const payload = {
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Reply exactly: ok" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${tinyPng}` } },
      ],
    }],
    max_tokens: 16,
  };
  const url = `${baseUrl}/chat/completions`;
  const args = [
    "-sS", "-L", "-X", "POST",
    "-w", "\n__DEEPCODEX_HTTP_STATUS__:%{http_code}",
    "-H", `authorization: Bearer ${key}`,
    "-H", "content-type: application/json",
    "--data", JSON.stringify(payload),
    url,
  ];
  for (const env of [process.env, withoutProxyEnv(process.env)]) {
    try {
      const { stdout } = await execFileAsync("curl", args, { env, maxBuffer: 1024 * 1024 });
      const marker = "\n__DEEPCODEX_HTTP_STATUS__:";
      const index = stdout.lastIndexOf(marker);
      const body = index >= 0 ? stdout.slice(0, index) : stdout;
      const status = index >= 0 ? Number(stdout.slice(index + marker.length).trim()) : 0;
      let json = null;
      try { json = JSON.parse(body); } catch {}
      const content = json?.choices?.[0]?.message?.content;
      if (status >= 200 && status < 300 && content != null) {
        return { ok: true, status, json };
      }
      const message = json?.error?.message || body.trim() || `HTTP ${status || "unknown"}`;
      return { ok: false, status, error: message };
    } catch (err) {
      if (env !== process.env) return { ok: false, status: 0, error: err.message || String(err) };
    }
  }
  return { ok: false, status: 0, error: "读图探测失败" };
}

function withoutProxyEnv(source) {
  const env = { ...source };
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) delete env[key];
  return env;
}

function defaultDeepSeekProfile(key) {
  const keyFingerprint = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const capabilities = {
    basicChat: true,
    stream: true,
    toolCalls: true,
    thinking: true,
    vision: false,
    imageGeneration: false,
    hostedTools: false,
    internalWebTools: true,
    reasoningReplay: true,
    nativeStreaming: true,
    streamToolCalls: true,
    streamReasoning: true,
  };
  const toolStrategy = {
    web_search: "local.ddg_urllib",
    web_fetch: "local.http_fetch",
    web_time: "local.system_time",
    web_weather: "replacement.open_meteo",
    web_image: "fallback.search_or_handoff",
    image_input: "text_placeholder",
    image_generation: "manual_handoff",
  };
  const defaults = {
    baseUrl,
    defaultModel: "deepseek-v4-pro",
    fastModel: "deepseek-v4-flash",
    knownModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    codexModelAliases: {
      "gpt-5.5": "default",
      "gpt-5.4": "default",
      "gpt-5.3-codex": "default",
      "o3": "default",
      "o4-mini": "default",
      "gpt-5.4-mini": "fast",
      "gpt-5.4-nano": "fast",
    },
    legacyAliases: {
      "deepseek-chat": { model: "fast", thinking: "disabled" },
      "deepseek-reasoner": { model: "fast", thinking: "enabled" },
    },
    capabilities: {
      vision: false,
      imageGeneration: false,
      hostedTools: false,
      internalWebTools: true,
      reasoningReplay: true,
    },
    toolStrategy,
  };
  return {
    provider: "deepseek",
    source: "builtin",
    baseUrl,
    model: "deepseek-v4-pro",
    fastModel: "deepseek-v4-flash",
    keyFingerprint,
    probedAt: new Date().toISOString(),
    defaults,
    detected: {
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      basicChat: true,
      stream: true,
      toolCalls: true,
      thinking: true,
      imageInput: false,
      imageGeneration: false,
    },
    effective: {
      ...defaults,
      capabilities,
      toolStrategy,
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    },
    capabilities,
    toolStrategy,
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    defaultModel: "deepseek-v4-pro",
  };
}

class NonCriticalUnsupported extends Error {
  constructor(message) {
    super(message);
    this.name = "NonCriticalUnsupported";
  }
}

function page() {
  const iconUrl = fs.existsSync(iconPath) ? "/icon.png" : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DeepCodex Setup</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #171a1f;
      --muted: #68707c;
      --line: #dfe3ea;
      --blue: #2563eb;
      --green: #16a34a;
      --red: #dc2626;
      --amber: #d97706;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    }
    main {
      width: min(560px, calc(100vw - 32px));
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      box-shadow: 0 14px 42px rgba(20, 30, 50, .12);
      padding: 18px 20px 16px;
    }
    .tagline {
      margin: 0 0 10px;
      color: #4b5563;
      font-size: 12px;
      font-weight: 650;
      text-align: right;
    }
    header { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
    .logo {
      width: 44px; height: 44px; border-radius: 11px;
      display: grid; place-items: center; overflow: hidden;
      background: #edf2ff; border: 1px solid #dbe4ff;
    }
    .logo img { width: 100%; height: 100%; object-fit: cover; }
    h1 { margin: 0; font-size: 24px; line-height: 1.05; letter-spacing: 0; }
    .sub { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
    label { display: block; font-weight: 650; margin-bottom: 6px; font-size: 13px; }
    .row { display: flex; gap: 10px; }
    input {
      flex: 1;
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 0 12px;
      font-size: 14px;
      outline: none;
    }
    input:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37, 99, 235, .14); }
    button {
      height: 34px;
      border: 0;
      border-radius: 7px;
      background: var(--blue);
      color: white;
      padding: 0 18px;
      font-size: 14px;
      font-weight: 650;
      cursor: pointer;
    }
    button:disabled { opacity: .55; cursor: default; }
    .summary {
      margin-top: 18px;
      min-height: 36px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.4;
    }
    @media (max-width: 640px) {
      main { width: calc(100vw - 24px); }
      .checks { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <p class="tagline">@娄老师说的对</p>
    <header>
      <div class="logo">${iconUrl ? `<img src="${iconUrl}" alt="">` : "D"}</div>
      <div>
        <h1>DeepCodex</h1>
      <p class="sub">首次需输入 DeepSeek API key，连通后自动保存</p>
      </div>
    </header>
    <form id="form">
      <label for="key">DeepSeek API key</label>
      <div class="row">
        <input id="key" name="key" type="password" autocomplete="off" placeholder="sk-..." autofocus>
        <button id="start" type="submit">开始测试</button>
      </div>
    </form>
    <div class="summary" id="summary"></div>
  </main>
  <script>
    const summary = document.getElementById("summary");
    const button = document.getElementById("start");
    function setStatus(text) {
      summary.textContent = text;
    }
    document.getElementById("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const key = document.getElementById("key").value.trim();
      if (!key) return;
      button.disabled = true;
      setStatus("正在测试 DeepSeek API key...");
      const res = await fetch("/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key })
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "start" && event.id === "connect") setStatus("正在测试 DeepSeek API key...");
          if (event.type === "pass" && event.id === "connect") setStatus("正在测试读图能力...");
          if (event.type === "start" && event.id === "vision") setStatus("正在测试读图能力...");
          if (event.type === "pass" && event.id === "vision") setStatus("读图能力测试完成");
          if (event.type === "unsupported" && event.id === "vision") setStatus("当前上游不支持读图，已按文本模式接入");
          if (event.type === "fail") setStatus(event.error || "连接失败，请检查 API key。");
          if (event.type === "done") {
            setStatus(event.ok ? "连接成功，正在启动 DeepCodex..." : "连接失败，请检查 API key。");
            button.disabled = false;
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

let completed = false;
let finalKey = "";

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page());
    return;
  }

  if (req.method === "GET" && req.url === "/icon.png" && fs.existsSync(iconPath)) {
    res.writeHead(200, { "content-type": "image/png" });
    fs.createReadStream(iconPath).pipe(res);
    return;
  }

  if (req.method === "POST" && req.url === "/run") {
    let key = "";
    try {
      key = JSON.parse(await readBody(req)).key?.trim() || "";
    } catch {
      json(res, 400, { error: "Bad request" });
      return;
    }

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store"
    });

    let ok = true;
    for (const test of tests) {
      res.write(JSON.stringify({ type: "start", id: test.id }) + "\n");
      try {
        const result = await test.run(key);
        res.write(JSON.stringify({ type: "pass", id: test.id, detail: result?.detail || "" }) + "\n");
      } catch (err) {
        if (err?.name === "NonCriticalUnsupported" || test.critical === false) {
          res.write(JSON.stringify({ type: "unsupported", id: test.id, error: err.message || String(err) }) + "\n");
        } else {
          ok = false;
          res.write(JSON.stringify({ type: "fail", id: test.id, error: err.message || String(err) }) + "\n");
          break;
        }
      }
    }
    res.write(JSON.stringify({ type: "done", ok }) + "\n");
    res.end();

    if (ok) {
      completed = true;
      finalKey = key;
      setTimeout(() => server.close(), 700);
    }
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(requestedPort, "127.0.0.1", () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  if (serverOnly) {
    process.stderr.write(`DEEPCODEX_SETUP_URL=${url}\n`);
  } else {
    const opener = spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true });
    opener.unref();
  }
});

server.on("close", () => {
  if (completed) {
    process.stdout.write(finalKey);
    process.exit(0);
  }
  process.exit(1);
});
