import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const syncSharedConfig = path.join(repoRoot, "scripts", "sync-shared-codex-config.mjs");
const syncRegistrations = path.join(repoRoot, "scripts", "sync-deepcodex-plugin-registrations.mjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deepcodex-config-sync-"));
}

test("shared config sync preserves DeepCodex-only plugin registrations", () => {
  const dir = tempDir();
  const source = path.join(dir, "global.toml");
  const target = path.join(dir, "deepcodex.toml");

  fs.writeFileSync(source, [
    'model = "gpt"',
    "",
    '[plugins."remotion@openai-curated"]',
    "enabled = false",
    "",
    '[plugins."hyperframes@openai-curated"]',
    "enabled = true",
    "",
  ].join("\n"));

  fs.writeFileSync(target, [
    'model = "deepseek"',
    "",
    '[plugins."remotion@openai-curated"]',
    "enabled = true",
    "",
    '[plugins."game-studio@openai-curated"]',
    "enabled = true",
    "",
    "[projects.foo]",
    'trust_level = "trusted"',
    "",
  ].join("\n"));

  execFileSync(process.execPath, [syncSharedConfig, source, target]);
  const next = fs.readFileSync(target, "utf8");

  assert.match(next, /\[plugins\."remotion@openai-curated"\]\nenabled = false/);
  assert.match(next, /\[plugins\."hyperframes@openai-curated"\]\nenabled = true/);
  assert.match(next, /\[plugins\."game-studio@openai-curated"\]\nenabled = true/);
  assert.match(next, /\[projects\.foo\]\ntrust_level = "trusted"/);
});

test("DeepCodex-only plugin registrations are written back to current and global config", () => {
  const dir = tempDir();
  const current = path.join(dir, "current.toml");
  const previous = path.join(dir, "previous.toml");
  const global = path.join(dir, "global.toml");

  fs.writeFileSync(current, [
    'model = "deepseek"',
    "",
    '[plugins."hyperframes@openai-curated"]',
    "enabled = true",
    "",
  ].join("\n"));

  fs.writeFileSync(previous, [
    'model = "deepseek"',
    "",
    '[plugins."remotion@openai-curated"]',
    "enabled = true",
    "",
    '[plugins."hyperframes@openai-curated"]',
    "enabled = true",
    "",
  ].join("\n"));

  fs.writeFileSync(global, [
    'model = "gpt"',
    "",
    '[plugins."github@openai-curated"]',
    "enabled = true",
    "",
  ].join("\n"));

  const output = execFileSync(process.execPath, [syncRegistrations, current, previous, global], { encoding: "utf8" });
  const result = JSON.parse(output);
  const currentNext = fs.readFileSync(current, "utf8");
  const globalNext = fs.readFileSync(global, "utf8");

  assert.deepEqual(result.restored, ['[plugins."remotion@openai-curated"]']);
  assert.match(currentNext, /\[plugins\."remotion@openai-curated"\]\nenabled = true/);
  assert.match(globalNext, /\[plugins\."remotion@openai-curated"\]\nenabled = true/);
  assert.doesNotMatch(globalNext, /\[plugins\."hyperframes@openai-curated"\]\nenabled = true/);
});
