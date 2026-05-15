#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

const port = Number(process.argv[2] || process.env.DEEPCODEX_CDP_PORT || 58317);
const scriptPath = process.argv[3] || new URL("./deepcodex-plugin-unlock-inject.js", import.meta.url).pathname;
const attempts = Number(process.env.DEEPCODEX_CDP_ATTEMPTS || 40);
const delayMs = Number(process.env.DEEPCODEX_CDP_DELAY_MS || 500);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 3000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${response.statusCode} ${response.statusMessage}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`Timed out fetching ${url}.`));
    });
    request.on("error", reject);
  });
}

function pickTarget(targets) {
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  return pages.find((target) => `${target.title || ""} ${target.url || ""}`.toLowerCase().includes("codex")) || pages[0] || null;
}

class LocalWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }

  async open() {
    const key = crypto.randomBytes(16).toString("base64");
    const path = `${this.url.pathname}${this.url.search}`;
    this.socket = net.createConnection({ host: this.url.hostname, port: Number(this.url.port) });
    this.socket.on("error", (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out opening ${this.url.href}.`)), 5000);
      this.socket.once("connect", () => {
        this.socket.write([
          `GET ${path} HTTP/1.1`,
          `Host: ${this.url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });
      const onHandshake = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const split = this.buffer.indexOf("\r\n\r\n");
        if (split === -1) return;
        const header = this.buffer.slice(0, split).toString("utf8");
        this.buffer = this.buffer.slice(split + 4);
        this.socket.off("data", onHandshake);
        this.socket.on("data", (data) => this.onData(data));
        clearTimeout(timer);
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          reject(new Error(`WebSocket upgrade failed: ${header.split("\r\n")[0]}`));
          return;
        }
        this.parseFrames();
        resolve();
      };
      this.socket.off("data", this.onData);
      this.socket.on("data", onHandshake);
      this.socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.parseFrames();
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        length = high * 2 ** 32 + low;
        offset += 8;
      }
      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      let payload = this.buffer.slice(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = this.buffer.slice(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.slice(offset + maskLength + length);
      const opcode = first & 0x0f;
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode !== 0x1) continue;
      this.handleMessage(payload.toString("utf8"));
    }
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message);
  }

  sendText(text) {
    const payload = Buffer.from(text, "utf8");
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  call(id, method, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response id ${id} (${method}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendText(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket?.end(); } catch {}
    try { this.socket?.destroy(); } catch {}
  }
}

async function injectOnce() {
  const targets = await json(`http://127.0.0.1:${port}/json`);
  const target = pickTarget(targets);
  if (!target) throw new Error("No Codex page target found.");
  const source = fs.readFileSync(scriptPath, "utf8");
  const ws = new LocalWebSocket(target.webSocketDebuggerUrl);
  await ws.open();
  let id = 1;
  await ws.call(id++, "Runtime.enable");
  await ws.call(id++, "Page.enable");
  await ws.call(id++, "Page.addScriptToEvaluateOnNewDocument", { source });
  await ws.call(id++, "Runtime.evaluate", { expression: source, awaitPromise: false, allowUnsafeEvalBlockedByCSP: true });
  ws.close();
  return target;
}

let lastError;
for (let i = 0; i < attempts; i++) {
  try {
    const target = await injectOnce();
    console.log(JSON.stringify({ ok: true, port, target: { id: target.id, title: target.title, url: target.url } }));
    process.exit(0);
  } catch (err) {
    lastError = err;
    await sleep(delayMs);
  }
}

console.error(`[deepcodex-cdp-inject] failed: ${lastError?.stack || lastError}`);
process.exit(1);
