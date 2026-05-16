#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [, , configPath, previousPath, globalPath] = process.argv;

if (!configPath || !previousPath) {
  console.error("Usage: sync-deepcodex-plugin-registrations.mjs <current-config> <previous-config> [global-config]");
  process.exit(2);
}

const sharedSectionRe = /^\[(marketplaces|plugins|mcp_servers)\./;

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

function render(blocks) {
  return blocks
    .map((block) => block.lines.join("\n").replace(/\n+$/g, ""))
    .filter((part) => part.length > 0)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

function isShared(block) {
  return Boolean(block.header && sharedSectionRe.test(block.header));
}

function sharedHeaders(blocks) {
  return new Set(blocks.filter(isShared).map((block) => block.header));
}

function appendMissingBlocks(targetPath, targetBlocks, blocksToAppend) {
  if (blocksToAppend.length === 0) return false;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, render([...targetBlocks, ...blocksToAppend]));
  return true;
}

if (!fs.existsSync(configPath) || !fs.existsSync(previousPath)) {
  process.exit(0);
}

const currentBlocks = splitTomlBlocks(fs.readFileSync(configPath, "utf8"));
const previousBlocks = splitTomlBlocks(fs.readFileSync(previousPath, "utf8"));
const globalBlocks = globalPath && fs.existsSync(globalPath)
  ? splitTomlBlocks(fs.readFileSync(globalPath, "utf8"))
  : [];

const currentHeaders = sharedHeaders(currentBlocks);
const globalHeaders = sharedHeaders(globalBlocks);

const deepCodexOnly = previousBlocks.filter(
  (block) => isShared(block) && !currentHeaders.has(block.header) && !globalHeaders.has(block.header)
);

const wroteCurrent = appendMissingBlocks(configPath, currentBlocks, deepCodexOnly);
let wroteGlobal = false;
if (globalPath) {
  wroteGlobal = appendMissingBlocks(globalPath, globalBlocks, deepCodexOnly);
}

console.log(JSON.stringify({
  ok: true,
  restored: deepCodexOnly.map((block) => block.header),
  wroteCurrent,
  wroteGlobal,
}, null, 2));
