#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sourceHome = process.argv[2] || path.join(os.homedir(), ".codex");
const targetHome = process.argv[3] || path.join(os.homedir(), "Library/Application Support/deepcodex/codex-home-deepseek-app");
const sourceConfigPath = process.argv[4] || path.join(sourceHome, "config.toml");
const targetConfigPath = process.argv[5] || path.join(targetHome, "config.toml");

const pluginSectionRe = /^\[plugins\."([^"]+)"\]$/;
const enabledRe = /^enabled\s*=\s*(true|false)\s*$/;
const notifyRe = /^notify\s*=\s*\[(.*)\]\s*$/;

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function parseEnabledPluginNames(text) {
  const names = new Set();
  let currentPlugin = null;
  for (const line of text.split(/\r?\n/)) {
    const pluginMatch = line.match(pluginSectionRe);
    if (pluginMatch) {
      const key = pluginMatch[1];
      const at = key.lastIndexOf("@");
      currentPlugin = at > 0 ? key.slice(0, at) : null;
      continue;
    }
    const enabledMatch = line.match(enabledRe);
    if (enabledMatch && currentPlugin) {
      if (enabledMatch[1] === "true") {
        names.add(currentPlugin);
      }
      currentPlugin = null;
      continue;
    }
    if (/^\[[^\]]+\]\s*$/.test(line)) {
      currentPlugin = null;
    }
  }
  return names;
}

function ensureSymlink(linkPath, targetPath) {
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetPath, linkPath, "dir");
}

function syncPluginSidecars(enabledNames) {
  const linked = [];
  for (const name of enabledNames) {
    const sourceDir = path.join(sourceHome, name);
    if (!exists(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      continue;
    }
    const targetDir = path.join(targetHome, name);
    ensureSymlink(targetDir, sourceDir);
    linked.push(name);
  }
  return linked;
}

function syncNotifyLine() {
  if (!exists(sourceConfigPath) || !exists(targetConfigPath)) {
    return false;
  }
  const sourceText = fs.readFileSync(sourceConfigPath, "utf8");
  const targetText = fs.readFileSync(targetConfigPath, "utf8");
  const sourceNotifyLine = sourceText.split(/\r?\n/).find((line) => notifyRe.test(line));
  if (!sourceNotifyLine) {
    return false;
  }
  const rewrittenNotify = sourceNotifyLine.replaceAll(sourceHome, targetHome);
  const targetLines = targetText.split(/\r?\n/).filter((line) => !notifyRe.test(line));
  let insertIndex = 0;
  while (insertIndex < targetLines.length && targetLines[insertIndex].trim() !== "") {
    insertIndex += 1;
  }
  targetLines.splice(insertIndex, 0, rewrittenNotify);
  fs.writeFileSync(targetConfigPath, `${targetLines.join("\n").replace(/\n+$/g, "")}\n`);
  return true;
}

if (!exists(targetHome)) {
  fs.mkdirSync(targetHome, { recursive: true });
}

const targetConfigText = exists(targetConfigPath) ? fs.readFileSync(targetConfigPath, "utf8") : "";
const enabledNames = parseEnabledPluginNames(targetConfigText);
const linked = syncPluginSidecars(enabledNames);
const syncedNotify = syncNotifyLine();

if (linked.length || syncedNotify) {
  const parts = [];
  if (linked.length) parts.push(`sidecars=${linked.join(",")}`);
  if (syncedNotify) parts.push("notify=1");
  console.log(`Synced shared Codex sidecars: ${parts.join(" ")}`);
} else {
  console.log("Synced shared Codex sidecars: none");
}
