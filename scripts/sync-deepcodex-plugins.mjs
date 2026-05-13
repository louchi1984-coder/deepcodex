#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const codexHome = process.argv[2] || path.join(os.homedir(), 'Library/Application Support/deepcodex/codex-home-deepseek-app');
const configPath = process.argv[3] || path.join(codexHome, 'config.toml');
const sharedCodexHome = process.argv[4] || path.join(os.homedir(), '.codex');
const mirrorRoot = path.join(codexHome, '.tmp', 'plugins', 'plugins');
const sharedInstalledRoot = path.join(sharedCodexHome, '.tmp', 'plugins', 'plugins');
const sharedCacheRoot = path.join(sharedCodexHome, 'plugins', 'cache');

function parseConfig(text) {
  const marketplaces = new Map();
  const enabledPlugins = [];
  const lines = text.split(/\r?\n/);
  let currentMarketplace = null;
  let currentPlugin = null;
  for (const line of lines) {
    const marketplaceMatch = line.match(/^\[marketplaces\.([^\]]+)\]$/);
    if (marketplaceMatch) {
      currentMarketplace = marketplaceMatch[1];
      currentPlugin = null;
      continue;
    }
    const pluginMatch = line.match(/^\[plugins\."([^"]+)"\]$/);
    if (pluginMatch) {
      currentPlugin = { key: pluginMatch[1], enabled: false };
      enabledPlugins.push(currentPlugin);
      currentMarketplace = null;
      continue;
    }
    const sourceMatch = line.match(/^source\s*=\s*"([^"]+)"$/);
    if (sourceMatch && currentMarketplace) {
      marketplaces.set(currentMarketplace, sourceMatch[1]);
      continue;
    }
    const enabledMatch = line.match(/^enabled\s*=\s*(true|false)$/);
    if (enabledMatch && currentPlugin) {
      currentPlugin.enabled = enabledMatch[1] === 'true';
    }
  }
  return { marketplaces, enabledPlugins: enabledPlugins.filter((p) => p.enabled) };
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function findCuratedVersionDir(baseDir) {
  if (!exists(baseDir)) return null;
  const entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return entries.length ? path.join(baseDir, entries[entries.length - 1]) : null;
}

function resolveInstalledPlugin(pluginName) {
  const dir = path.join(sharedInstalledRoot, pluginName);
  return exists(path.join(dir, '.codex-plugin', 'plugin.json')) ? dir : null;
}

function resolveSource(pluginName, marketplace, marketplaces) {
  const installed = resolveInstalledPlugin(pluginName);
  if (installed) return installed;

  if (marketplace === 'openai-bundled') {
    const sourceRoot = marketplaces.get(marketplace) || path.join(sharedCodexHome, '.tmp', 'bundled-marketplaces', marketplace);
    if (!sourceRoot) return null;
    const dir = path.join(sourceRoot, 'plugins', pluginName);
    return exists(path.join(dir, '.codex-plugin', 'plugin.json')) ? dir : null;
  }
  if (marketplace === 'openai-curated') {
    return findCuratedVersionDir(path.join(sharedCacheRoot, marketplace, pluginName));
  }
  if (marketplace === 'openai-primary-runtime') {
    const cached = findCuratedVersionDir(path.join(sharedCacheRoot, marketplace, pluginName));
    if (cached) return cached;
    const sourceRoot = marketplaces.get(marketplace);
    if (!sourceRoot) return null;
    const dir = path.join(sourceRoot, 'plugins', pluginName);
    return exists(path.join(dir, '.codex-plugin', 'plugin.json')) ? dir : null;
  }
  return findCuratedVersionDir(path.join(sharedCacheRoot, marketplace, pluginName));
}

function readPluginVersion(dir) {
  const pluginJson = path.join(dir, '.codex-plugin', 'plugin.json');
  try {
    return JSON.parse(fs.readFileSync(pluginJson, 'utf8')).version || '';
  } catch {
    return '';
  }
}

function syncDir(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true, dereference: false });
}

const config = fs.readFileSync(configPath, 'utf8');
const { marketplaces, enabledPlugins } = parseConfig(config);
fs.mkdirSync(mirrorRoot, { recursive: true });

const synced = [];
for (const plugin of enabledPlugins) {
  const splitIndex = plugin.key.lastIndexOf('@');
  if (splitIndex <= 0) continue;
  const pluginName = plugin.key.slice(0, splitIndex);
  const marketplace = plugin.key.slice(splitIndex + 1);
  const source = resolveSource(pluginName, marketplace, marketplaces);
  if (!source) continue;
  const target = path.join(mirrorRoot, pluginName);
  const sourceVersion = readPluginVersion(source);
  const targetVersion = exists(path.join(target, '.codex-plugin', 'plugin.json')) ? readPluginVersion(target) : '';
  if (!exists(target) || sourceVersion !== targetVersion) {
    syncDir(source, target);
    synced.push(`${pluginName}@${marketplace}`);
  }
}

if (synced.length) {
  console.log(`Synced plugins: ${synced.join(', ')}`);
} else {
  console.log('Synced plugins: none');
}
