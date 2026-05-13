#!/usr/bin/env node
import fs from "node:fs";

const [, , sourcePath, targetPath] = process.argv;

if (!sourcePath || !targetPath) {
  console.error("Usage: sync-shared-codex-config.mjs <source-config> <target-config>");
  process.exit(2);
}

const sharedSectionRe = /^\[(marketplaces|plugins|mcp_servers)\./;

function splitTomlBlocks(text) {
  const blocks = [];
  let current = { header: null, lines: [] };

  for (const line of text.split(/\r?\n/)) {
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
const sharedBlocks = sourceBlocks.filter(isShared);
const keptTargetBlocks = targetBlocks.filter((block) => !isShared(block));

fs.writeFileSync(targetPath, render([...keptTargetBlocks, ...sharedBlocks]));
