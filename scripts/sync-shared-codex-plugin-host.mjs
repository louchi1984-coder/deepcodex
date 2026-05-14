#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const codexHome = process.argv[2] || path.join(os.homedir(), 'Library/Application Support', 'deepcodex', 'codex-home-deepseek-app');
const sharedCodexHome = process.argv[3] || path.join(os.homedir(), '.codex');
const backupRoot = path.join(codexHome, '.patch-backups', 'shared-plugin-host');

const mappings = [
  ['skills', path.join(sharedCodexHome, 'skills')],
  ['plugins', path.join(sharedCodexHome, 'plugins')],
  [path.join('.tmp', 'plugins'), path.join(sharedCodexHome, '.tmp', 'plugins')],
  [path.join('cache', 'codex_apps_tools'), path.join(sharedCodexHome, 'cache', 'codex_apps_tools')],
  ['computer-use', path.join(sharedCodexHome, 'computer-use')],
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function existsOrSymlink(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function targetMatches(linkPath, expectedTarget) {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return false;
    const actual = fs.readlinkSync(linkPath);
    const resolvedActual = path.resolve(path.dirname(linkPath), actual);
    return resolvedActual === expectedTarget;
  } catch {
    return false;
  }
}

function backupPathFor(relPath) {
  return path.join(backupRoot, relPath);
}

function moveAside(currentPath, relPath) {
  if (!existsOrSymlink(currentPath)) return;
  const backupPath = backupPathFor(relPath);
  ensureDir(path.dirname(backupPath));
  if (existsOrSymlink(backupPath)) {
    fs.rmSync(backupPath, { recursive: true, force: true });
  }
  fs.renameSync(currentPath, backupPath);
}

ensureDir(codexHome);
ensureDir(backupRoot);

const summary = [];
for (const [relPath, sharedPath] of mappings) {
  const targetPath = path.join(codexHome, relPath);
  ensureDir(path.dirname(targetPath));
  if (targetMatches(targetPath, sharedPath)) {
    summary.push({ relPath, mode: 'already-linked', target: sharedPath });
    continue;
  }
  if (!fs.existsSync(sharedPath)) {
    summary.push({ relPath, mode: 'missing-shared-target', target: sharedPath });
    continue;
  }
  moveAside(targetPath, relPath);
  fs.symlinkSync(sharedPath, targetPath);
  summary.push({ relPath, mode: 'linked', target: sharedPath });
}

console.log(JSON.stringify({ ok: true, codexHome, sharedCodexHome, summary }, null, 2));
