import test from "node:test";
import assert from "node:assert/strict";

import {
  INTERNAL_TOOLS,
  executeInternalTool,
  getToolChoiceForRole,
  isInternalTool,
  toolsToInject,
} from "../tools/registry.mjs";

const noHostedProfile = { capabilities: { hostedTools: false } };
const hostedProfile = { capabilities: { hostedTools: true } };
const disabledInternalWebProfile = {
  capabilities: { hostedTools: false, internalWebTools: false },
  toolStrategy: { web_search: "manual_handoff", web_fetch: "manual_handoff" },
};

test("urllib web_search is the injected search tool", () => {
  const choice = getToolChoiceForRole("web_search", noHostedProfile);
  assert.equal(choice, INTERNAL_TOOLS.web_search_urllib);
  assert.equal(choice.definition.function.name, "web_search");
  assert.match(choice.definition.function.description, /urllib/i);
  assert.match(choice.definition.function.description, /DuckDuckGo/i);
});

test("urllib web_fetch is the injected fetch tool", () => {
  assert.equal(getToolChoiceForRole("web_fetch", noHostedProfile), INTERNAL_TOOLS.web_fetch_urllib);
  assert.equal(INTERNAL_TOOLS.web_fetch_urllib.definition.function.name, "web_fetch");
});

test("toolsToInject exposes one tool per role when hosted tools are missing", () => {
  const names = toolsToInject(noHostedProfile).map((t) => t.function.name).sort();
  assert.deepEqual(names, ["web_fetch", "web_search"]);
});

test("toolsToInject injects nothing when upstream supports hosted tools", () => {
  assert.deepEqual(toolsToInject(hostedProfile), []);
});

test("toolsToInject honors internal web tool capability switch", () => {
  assert.deepEqual(toolsToInject(disabledInternalWebProfile), []);
  assert.equal(getToolChoiceForRole("web_search", disabledInternalWebProfile), null);
});

test("isInternalTool recognizes translator-provided web tools", () => {
  assert.equal(isInternalTool("web_search"), true);
  assert.equal(isInternalTool("web_fetch"), true);
  assert.equal(isInternalTool("exec_command"), false);
});

test("internal web tools execute through local scripts", () => {
  assert.equal(typeof INTERNAL_TOOLS.web_search_urllib.execute, "function");
  assert.equal(typeof INTERNAL_TOOLS.web_fetch_urllib.execute, "function");
  assert.match(INTERNAL_TOOLS.web_search_urllib.definition.function.description, /structured ranked results/i);
  assert.match(INTERNAL_TOOLS.web_search_urllib.definition.function.description, /top 2 results/i);
});

test("unknown internal tool errors are explicit", async () => {
  const parsed = JSON.parse(await executeInternalTool("not_a_tool", {}));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "internal tool unavailable: not_a_tool");
});
