#!/usr/bin/env node
import fs from "node:fs";

const [, , sourcePath, targetPath] = process.argv;

if (!sourcePath || !targetPath) {
  console.error("Usage: sync-shared-codex-config.mjs <source-config> <target-config>");
  process.exit(2);
}

const sharedSectionRe = /^\[(marketplaces|plugins|mcp_servers)\./;
const windowsShimCommands = new Set(["npx", "npm", "pnpm", "yarn"]);
const shouldNormalizeWindowsShims = process.platform === "win32" || process.env.DEEPCODEX_FORCE_WINDOWS_SHIM === "1";

function splitTomlBlocks(text) {
  const blocks = [];
  let current = { header: null, lines: [] };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, "");
    if (/^\[[^\]]+\]\s*$/.test(line)) {
      blocks.push(current);
      current = { header: line.trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }

  blocks.push(current);
  return blocks;
}

function isShared(block) {
  return Boolean(block.header && sharedSectionRe.test(block.header));
}

function parseTomlStringArray(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("[") || !raw.endsWith("]")) return null;
  try {
    return JSON.parse(raw.replace(/'/g, '"'));
  } catch {
    return null;
  }
}

function renderTomlStringArray(values) {
  return `[${values.map((value) => JSON.stringify(String(value))).join(", ")}]`;
}

function normalizeWindowsMcpShim(block) {
  if (!shouldNormalizeWindowsShims || !block.header?.startsWith("[mcp_servers.")) return block;

  let commandLineIndex = -1;
  let argsLineIndex = -1;
  let command = "";

  for (let i = 0; i < block.lines.length; i += 1) {
    const commandMatch = block.lines[i].match(/^command\s*=\s*"([^"]+)"\s*$/);
    if (commandMatch) {
      commandLineIndex = i;
      command = commandMatch[1].trim().toLowerCase();
      continue;
    }
    if (/^args\s*=/.test(block.lines[i])) argsLineIndex = i;
  }

  if (!windowsShimCommands.has(command)) return block;

  let args = [];
  if (argsLineIndex >= 0) {
    const rawArgs = block.lines[argsLineIndex].replace(/^args\s*=\s*/, "");
    const parsed = parseTomlStringArray(rawArgs);
    if (Array.isArray(parsed)) args = parsed;
  }

  const shim = `${command}.cmd`;
  const next = { ...block, lines: [...block.lines] };
  next.lines[commandLineIndex] = `command = "cmd.exe"`;
  const argsLine = `args = ${renderTomlStringArray(["/d", "/s", "/c", shim, ...args])}`;
  if (argsLineIndex >= 0) next.lines[argsLineIndex] = argsLine;
  else next.lines.splice(commandLineIndex + 1, 0, argsLine);
  return next;
}

function render(blocks) {
  return blocks
    .map((block) => block.lines.join("\n").replace(/\n+$/g, ""))
    .filter((part) => part.length > 0)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

if (!fs.existsSync(sourcePath)) {
  process.exit(0);
}

if (!fs.existsSync(targetPath)) {
  fs.writeFileSync(targetPath, "");
}

const source = fs.readFileSync(sourcePath, "utf8");
const target = fs.readFileSync(targetPath, "utf8");
const sourceBlocks = splitTomlBlocks(source);
const targetBlocks = splitTomlBlocks(target);
const sharedBlocks = sourceBlocks.filter(isShared).map(normalizeWindowsMcpShim);
const keptTargetBlocks = targetBlocks.filter((block) => !isShared(block));

fs.writeFileSync(targetPath, render([...keptTargetBlocks, ...sharedBlocks]));
