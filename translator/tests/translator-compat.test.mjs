/**
 * translator-compat.test.mjs — Compatibility rules for adaptive translator
 *
 * Optionally uses a local captured Codex request fixture to verify that
 * tool classification & translation-plan generation matches the desired
 * compatibility rules for the DeepSeek V4 backend.
 *
 * The captured fixture is intentionally not published because it can contain
 * local paths, prompts, and conversation context.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  classifyTool,
  classifyTools,
  summarizeClassification,
  generateTranslationPlan,
  buildChatToolsWithRouting,
  HOSTED_ONLY,
} from "../compat-rules.mjs";

// ── load fixture ──────────────────────────────────────────────────────

function loadFixture(name) {
  const path = resolve(__dirname, "fixtures", name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

const fixture = loadFixture("codex-request-174647.json");
const compatTest = fixture ? test : test.skip;

// ── sanity checks ─────────────────────────────────────────────────────

compatTest("fixture is a valid Responses API request", () => {
  assert.equal(typeof fixture, "object");
  assert.equal(fixture.model, "gpt-5.5");
  assert.equal(fixture.tool_choice, "auto");
  assert.ok(Array.isArray(fixture.tools));
  assert.ok(fixture.tools.length >= 15);
  assert.equal(typeof fixture.instructions, "string");
});

// ── tool classification ───────────────────────────────────────────────

compatTest("classifyTool returns correct type for each tool kind", () => {
  const tools = fixture.tools;

  // 1. function tool
  const execCmd = tools.find((t) => t.name === "exec_command");
  assert.ok(execCmd, "exec_command tool found");
  assert.deepEqual(classifyTool(execCmd), {
    type: "function",
    name: "exec_command",
    metadata: {
      description: execCmd.description || "",
      parameters: execCmd.parameters || null,
    },
  });

  // 2. custom tool (apply_patch)
  const applyPatch = tools.find((t) => t.name === "apply_patch");
  assert.ok(applyPatch, "apply_patch tool found");
  const classifiedPatch = classifyTool(applyPatch);
  assert.equal(classifiedPatch.type, "custom");
  assert.equal(classifiedPatch.name, "apply_patch");
  assert.ok(classifiedPatch.format, "apply_patch has a format object");
  assert.equal(classifiedPatch.metadata.formatType, "grammar");
  assert.equal(classifiedPatch.metadata.formatSyntax, "lark");
  assert.ok(typeof classifiedPatch.metadata.description === "string");

  // 3. namespace tool (mcp__node_repl__)
  const nodeRepl = tools.find((t) => t.name === "mcp__node_repl__");
  assert.ok(nodeRepl, "mcp__node_repl__ tool found");
  const classifiedRepl = classifyTool(nodeRepl);
  assert.equal(classifiedRepl.type, "namespace");
  assert.equal(classifiedRepl.name, "mcp__node_repl__");
  assert.ok(Array.isArray(classifiedRepl.nested));
  assert.equal(classifiedRepl.metadata.nestedCount, 3);

  // 4. namespace tool (codex_app)
  const codexApp = tools.find((t) => t.name === "codex_app");
  assert.ok(codexApp, "codex_app tool found");
  const classifiedApp = classifyTool(codexApp);
  assert.equal(classifiedApp.type, "namespace");
  assert.equal(classifiedApp.name, "codex_app");
  assert.equal(classifiedApp.metadata.nestedCount, 1);

  // 5. hosted tool (web_search)
  const webSearch = tools.find((t) => t.type === "web_search");
  assert.ok(webSearch, "web_search tool found");
  assert.deepEqual(classifyTool(webSearch), {
    type: "hosted",
    name: "web_search",
    hostedType: "web_search",
    metadata: { ...webSearch },
  });

  // 6. hosted tool (image_generation)
  const imgGen = tools.find((t) => t.type === "image_generation");
  assert.ok(imgGen, "image_generation tool found");
  assert.deepEqual(classifyTool(imgGen), {
    type: "hosted",
    name: "image_generation",
    hostedType: "image_generation",
    metadata: { ...imgGen },
  });
});

compatTest("classifyTools classifies all 20 tools correctly", () => {
  const classified = classifyTools(fixture.tools);
  assert.equal(classified.length, fixture.tools.length);

  // Verify counts by type
  const summary = summarizeClassification(classified);
  assert.equal(summary.functionCount + summary.customCount + summary.namespaceCount + summary.hostedCount, summary.total);

  // Function tools: exec_command, write_stdin, list_mcp_resources, list_mcp_resource_templates,
  // read_mcp_resource, update_plan, request_user_input, view_image, spawn_agent, send_input,
  // resume_agent, wait_agent, close_agent, read_thread_terminal, load_workspace_dependencies
  assert.equal(summary.functionCount, 15);

  // Custom tools: apply_patch
  assert.equal(summary.customCount, 1);

  // Namespace tools: mcp__node_repl__, codex_app
  assert.equal(summary.namespaceCount, 2);

  // Hosted tools: web_search, image_generation
  assert.equal(summary.hostedCount, 2);
});

// ── Rule 1: function tools are local callable ─────────────────────────

compatTest("Rule 1: function tools are classified as local callable", () => {
  const classified = classifyTools(fixture.tools);
  const fns = classified.filter((t) => t.type === "function");
  const functionNames = fns.map((t) => t.name);

  // Core Codex function tools that must be present
  for (const name of ["exec_command", "update_plan", "spawn_agent", "request_user_input", "view_image", "read_mcp_resource"]) {
    assert.ok(functionNames.includes(name), `function tool "${name}" must be present`);
  }

  // Every function tool has a name
  for (const t of fns) {
    assert.ok(t.name.length > 0, `function tool must have a name, got ${JSON.stringify(t)}`);
  }
});

// ── Rule 2: custom apply_patch is preserved with metadata ─────────────

compatTest("Rule 2: custom apply_patch is preserved with format metadata", () => {
  const classified = classifyTools(fixture.tools);
  const customTools = classified.filter((t) => t.type === "custom");

  assert.equal(customTools.length, 1);
  const patch = customTools[0];
  assert.equal(patch.name, "apply_patch");
  assert.equal(patch.type, "custom");

  // Grammar/freeform format is preserved
  assert.ok(patch.format, "format object must be present");
  assert.equal(patch.format.type, "grammar");
  assert.equal(patch.format.syntax, "lark");
  // The format definition must be a non-empty string
  assert.ok(typeof patch.format.definition === "string" && patch.format.definition.length > 0);

  // Metadata preserved
  assert.ok(patch.metadata.description.length > 0);
  assert.equal(patch.metadata.formatType, "grammar");
  assert.equal(patch.metadata.formatSyntax, "lark");

  // apply_patch should NOT be reclassified as a plain function
  assert.notEqual(patch.metadata.formatType, null);
});

// ── Rule 3: namespace tools have nested tool recognition ──────────────

compatTest("Rule 3: namespace tools expose nested function tools", () => {
  const classified = classifyTools(fixture.tools);
  const namespaces = classified.filter((t) => t.type === "namespace");

  // Namespace mcp__node_repl__ has js / js_add_node_module_dir / js_reset
  const nodeRepl = namespaces.find((ns) => ns.name === "mcp__node_repl__");
  assert.ok(nodeRepl, "mcp__node_repl__ namespace present");
  assert.equal(nodeRepl.metadata.nestedCount, 3);
  const replNames = nodeRepl.nested.map((s) => s.name);
  assert.ok(replNames.includes("js"), "js subtool present");
  assert.ok(replNames.includes("js_add_node_module_dir"), "js_add_node_module_dir subtool present");
  assert.ok(replNames.includes("js_reset"), "js_reset subtool present");
  // Each nested tool is classified as function
  for (const sub of nodeRepl.nested) {
    assert.equal(sub.type, "function");
    assert.ok(sub.name.length > 0);
  }

  // Namespace codex_app has automation_update
  const codexApp = namespaces.find((ns) => ns.name === "codex_app");
  assert.ok(codexApp, "codex_app namespace present");
  assert.equal(codexApp.metadata.nestedCount, 1);
  assert.equal(codexApp.nested[0].name, "automation_update");
  assert.equal(codexApp.nested[0].type, "function");
});

compatTest("Rule 3: namespace tools are not treated as a single callable", () => {
  const classified = classifyTools(fixture.tools);
  const namespaces = classified.filter((t) => t.type === "namespace");

  for (const ns of namespaces) {
    // A namespace tool itself is NOT a callable tool — it has no function name
    assert.equal(ns.type, "namespace", `${ns.name} is namespace type`);
    // The nested tools are the callable ones
    assert.ok(ns.nested.length > 0, `${ns.name} has nested tools`);
    // Each nested tool is callable
    for (const sub of ns.nested) {
      assert.equal(sub.type, "function", `nested tool ${sub.name} is function type`);
    }
  }

  // Verify summary captures nested tool names
  const summary = summarizeClassification(classified);
  const nodeReplSubtools = summary.namespaceSubtools.filter((s) => s.namespace === "mcp__node_repl__");
  assert.equal(nodeReplSubtools.length, 3);
  assert.ok(nodeReplSubtools.some((s) => s.name === "js"));
});

// ── Rule 4: web_search and image_generation are hosted/account-bound ───

compatTest("Rule 4: web_search is classified as hosted/account-bound", () => {
  const classified = classifyTools(fixture.tools);
  const hosted = classified.filter((t) => t.type === "hosted");

  const webSearch = hosted.find((t) => t.hostedType === "web_search");
  assert.ok(webSearch, "web_search classified as hosted");
  assert.equal(webSearch.type, "hosted");
  assert.equal(webSearch.name, "web_search");
  // Not local callable
  assert.notEqual(webSearch.type, "function");
});

compatTest("Rule 4: image_generation is classified as hosted/account-bound", () => {
  const classified = classifyTools(fixture.tools);
  const hosted = classified.filter((t) => t.type === "hosted");

  const imgGen = hosted.find((t) => t.hostedType === "image_generation");
  assert.ok(imgGen, "image_generation classified as hosted");
  assert.equal(imgGen.type, "hosted");
  assert.equal(imgGen.name, "image_generation");
  // Not local callable
  assert.notEqual(imgGen.type, "function");
});

compatTest("Rule 4: hosted tools are not in callable set", () => {
  const classified = classifyTools(fixture.tools);
  const fns = classified.filter((t) => t.type === "function").map((t) => t.name);
  const hosted = classified.filter((t) => t.type === "hosted").map((t) => t.name);

  // No overlap between hosted and function names
  for (const name of hosted) {
    assert.ok(!fns.includes(name), `"${name}" must NOT be in function tools`);
  }

  // HOSTED_ONLY set contains expected types
  assert.ok(HOSTED_ONLY.has("web_search"));
  assert.ok(HOSTED_ONLY.has("image_generation"));
  assert.ok(HOSTED_ONLY.has("code_interpreter"));
});

// ── Rule 5: tool_choice "none" prevents tool forwarding ──────────────

compatTest("Rule 5: tool_choice 'none' prevents tool forwarding/injection", () => {
  // Create a fake request with tool_choice "none"
  const noneRequest = {
    ...fixture,
    tool_choice: "none",
  };

  const planNone = generateTranslationPlan(noneRequest, { compact: false });
  assert.equal(planNone.wouldForwardTools, false, "no tools forwarded when tool_choice=none");
  assert.equal(planNone.allowTools, false);
  assert.equal(planNone.injectInternalTools, false);
  assert.equal(planNone.forwardedTools.length, 0);

  // Same fixture with tool_choice "auto" SHOULD forward tools
  const planAuto = generateTranslationPlan(fixture, { compact: false });
  assert.equal(planAuto.wouldForwardTools, true, "tools forwarded when tool_choice=auto");
  assert.equal(planAuto.allowTools, true);
  assert.equal(planAuto.injectInternalTools, true);
});

compatTest("Rule 5: tool_choice 'none' overrides any tool presence", () => {
  // Even with many tools, tool_choice=none blocks forwarding
  const noneRequest = {
    ...fixture,
    tool_choice: "none",
  };

  const plan = generateTranslationPlan(noneRequest);
  assert.equal(plan.allowTools, false);
  assert.equal(plan.wouldForwardTools, false);
  assert.equal(plan.forwardedTools.length, 0);
  assert.equal(plan.droppedTools.length, 0);

  // Custom tool not forwarded
  const customForwarded = plan.forwardedTools.filter((t) => t.type === "custom");
  assert.equal(customForwarded.length, 0);
});

// ── Rule 6: compact mode does not inject tools ────────────────────────

compatTest("Rule 6: compact mode does not forward or inject tools", () => {
  const plan = generateTranslationPlan(fixture, { compact: true });
  assert.equal(plan.compact, true);
  assert.equal(plan.allowTools, false);
  assert.equal(plan.injectInternalTools, false);
  assert.equal(plan.wouldForwardTools, false);
  assert.equal(plan.forwardedTools.length, 0);
  assert.equal(plan.droppedTools.length, 0);
});

compatTest("Rule 6: compact vs normal mode differ in tool forwarding", () => {
  const compactPlan = generateTranslationPlan(fixture, { compact: true });
  const normalPlan = generateTranslationPlan(fixture, { compact: false });

  // Normal forwards tools, compact doesn't
  assert.equal(normalPlan.wouldForwardTools, true);
  assert.equal(compactPlan.wouldForwardTools, false);

  // Normal injects internal tools, compact doesn't
  assert.equal(normalPlan.injectInternalTools, true);
  assert.equal(compactPlan.injectInternalTools, false);

  // Normal drops hosted tools, compact doesn't process tools at all
  assert.equal(normalPlan.wouldDropHosted, true);
  assert.equal(compactPlan.wouldDropHosted, false);
});

// ── Integration: translation plan uses full fixture ───────────────────

compatTest("translation plan for full fixture drops hosted tools and flattens namespaces", () => {
  const plan = generateTranslationPlan(fixture, { compact: false });

  // Hosted tools are dropped
  assert.ok(plan.wouldDropHosted);
  const droppedNames = plan.droppedTools.map((t) => t.name);
  assert.ok(droppedNames.includes("web_search"), "web_search dropped");
  assert.ok(droppedNames.includes("image_generation"), "image_generation dropped");

  // Namespace tools are flattened into their nested function tools
  const forwardedNames = plan.forwardedTools.map((t) => t.name);
  assert.ok(forwardedNames.includes("js"), "js from mcp__node_repl__ forwarded");
  assert.ok(forwardedNames.includes("js_add_node_module_dir"), "js_add_node_module_dir forwarded");
  assert.ok(forwardedNames.includes("js_reset"), "js_reset forwarded");
  assert.ok(forwardedNames.includes("automation_update"), "automation_update from codex_app forwarded");

  // Source tracking works
  const jsEntry = plan.forwardedTools.find((t) => t.name === "js");
  assert.equal(jsEntry.namespace, "mcp__node_repl__");
  assert.equal(jsEntry.source, "namespace:mcp__node_repl__");

  // Apply_patch is custom and preserved
  assert.ok(plan.customToolPreserved, "custom apply_patch preserved");
  const patchEntry = plan.forwardedTools.find((t) => t.name === "apply_patch");
  assert.ok(patchEntry, "apply_patch in forwarded tools");
  assert.equal(patchEntry.type, "custom");
  assert.equal(patchEntry.formatType, "grammar");

  // Function tools are forwarded as-is
  const execCmd = plan.forwardedTools.find((t) => t.name === "exec_command");
  assert.ok(execCmd, "exec_command forwarded");
  assert.equal(execCmd.type, "function");
});

compatTest("buildChatToolsWithRouting assembles Chat tools with routing metadata", () => {
  const { tools, routing } = buildChatToolsWithRouting(fixture, {
    internalTools: [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "internal search",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
    ],
  });

  const names = tools.map((t) => t.function.name);
  assert.ok(names.includes("exec_command"), "plain function forwarded");
  assert.ok(names.includes("apply_patch"), "custom tool forwarded as callable wrapper");
  assert.ok(names.includes("mcp__node_repl__js"), "namespace subtool flattened");
  assert.ok(names.includes("mcp__node_repl__js_add_node_module_dir"), "second namespace subtool flattened");
  assert.ok(names.includes("codex_app__automation_update"), "codex_app namespace flattened");
  assert.ok(names.includes("web_search"), "internal replacement injected");

  assert.ok(!names.includes("image_generation"), "hosted image_generation not forwarded");

  assert.deepEqual(routing.mcp__node_repl__js, {
    codexName: "js",
    type: "function",
    namespace: "mcp__node_repl__",
  });
  assert.equal(routing.apply_patch.type, "custom");
  assert.equal(routing.apply_patch.formatType, "grammar");
  assert.equal(routing.apply_patch.formatSyntax, "lark");

  const patchTool = tools.find((t) => t.function.name === "apply_patch");
  assert.equal(patchTool.function.parameters.required[0], "content");
});

compatTest("buildChatToolsWithRouting honors tool_choice none and compact mode", () => {
  const internalTools = [
    { type: "function", function: { name: "web_search", parameters: { type: "object", properties: {} } } },
  ];

  const none = buildChatToolsWithRouting({ ...fixture, tool_choice: "none" }, { internalTools });
  assert.deepEqual(none.tools, []);
  assert.deepEqual(none.routing, {});

  const compact = buildChatToolsWithRouting(fixture, { compact: true, internalTools });
  assert.deepEqual(compact.tools, []);
  assert.deepEqual(compact.routing, {});
});

// ── Edge: tool_choice "none" + compact mode coverage ──────────────────

compatTest("compact mode with tool_choice 'none' also yields no tools", () => {
  // Both compact and tool_choice=none independently disable tools
  const plan1 = generateTranslationPlan({ ...fixture, tool_choice: "none" }, { compact: false });
  const plan2 = generateTranslationPlan(fixture, { compact: true });
  const plan3 = generateTranslationPlan({ ...fixture, tool_choice: "none" }, { compact: true });

  for (const plan of [plan1, plan2, plan3]) {
    assert.equal(plan.allowTools, false);
    assert.equal(plan.injectInternalTools, false);
    assert.equal(plan.wouldForwardTools, false);
  }
});

// ── Edge: request with no tools ───────────────────────────────────────

compatTest("request with no tools produces empty summary", () => {
  const empty = { model: "gpt-5.5", tool_choice: "auto", tools: [], input: "hello" };
  const plan = generateTranslationPlan(empty);
  assert.equal(plan.classification.total, 0);
  assert.equal(plan.forwardedTools.length, 0);
  assert.equal(plan.droppedTools.length, 0);
  // wouldForwardTools is false because forwardedTools.length === 0
  // (allowTools=true but no tools to forward)
  assert.equal(plan.wouldForwardTools, false);
});

// ── Edge: null/undefined tools ────────────────────────────────────────

compatTest("null tools does not crash classification", () => {
  const classified = classifyTools(null);
  assert.deepEqual(classified, []);
});

compatTest("undefined tool does not crash classifyTool", () => {
  assert.deepEqual(classifyTool(undefined), { type: "unknown", name: "", metadata: {} });
  assert.deepEqual(classifyTool(null), { type: "unknown", name: "", metadata: {} });
});

// ──────────────────────────────────────────────────────────────────
// buildChatToolsWithRouting integration tests (fixture-based)
// ──────────────────────────────────────────────────────────────────

compatTest("buildChatToolsWithRouting produces Chat-format tools from fixture", () => {
  const { tools, routing } = buildChatToolsWithRouting(fixture);

  assert.ok(Array.isArray(tools), "tools is an array");
  assert.ok(typeof routing === "object", "routing is an object");

  // Hosted tools must NOT appear
  const toolNames = tools.map((t) => t.function.name);
  assert.ok(!toolNames.includes("web_search"), "web_search not forwarded");
  assert.ok(!toolNames.includes("image_generation"), "image_generation not forwarded");

  // Function tools forward normally
  assert.ok(toolNames.includes("exec_command"), "exec_command forwarded");
  assert.ok(toolNames.includes("update_plan"), "update_plan forwarded");

  // Namespace mcp__node_repl__ flattened → collision-safe names
  assert.ok(toolNames.includes("mcp__node_repl__js"), "mcp__node_repl__js forwarded");
  assert.ok(toolNames.includes("mcp__node_repl__js_add_node_module_dir"), "js_add_node_module_dir forwarded");
  assert.ok(toolNames.includes("mcp__node_repl__js_reset"), "js_reset forwarded");

  // Namespace codex_app flattened
  assert.ok(toolNames.includes("codex_app__automation_update"), "codex_app__automation_update forwarded");

  // Custom apply_patch forwarded
  assert.ok(toolNames.includes("apply_patch"), "apply_patch forwarded");
});

compatTest("buildChatToolsWithRouting routing metadata maps chat names back to Codex callable names", () => {
  const { tools, routing } = buildChatToolsWithRouting(fixture);

  // Function tool: identity mapping
  assert.deepEqual(routing["exec_command"], {
    codexName: "exec_command",
    type: "function",
    namespace: null,
  });

  // Namespace-flattened tool: reverse map to original subtool name
  assert.deepEqual(routing["mcp__node_repl__js"], {
    codexName: "js",
    type: "function",
    namespace: "mcp__node_repl__",
  });
  assert.deepEqual(routing["mcp__node_repl__js_reset"], {
    codexName: "js_reset",
    type: "function",
    namespace: "mcp__node_repl__",
  });

  // codex_app flattened tool
  assert.deepEqual(routing["codex_app__automation_update"], {
    codexName: "automation_update",
    type: "function",
    namespace: "codex_app",
  });

  // Custom tool routing
  const patchRoute = routing["apply_patch"];
  assert.ok(patchRoute, "apply_patch has routing");
  assert.equal(patchRoute.codexName, "apply_patch");
  assert.equal(patchRoute.type, "custom");
  assert.equal(patchRoute.namespace, null);
  assert.equal(patchRoute.formatType, "grammar");
  assert.equal(patchRoute.formatSyntax, "lark");
});

compatTest("buildChatToolsWithRouting custom apply_patch has argument handling notes", () => {
  const { tools } = buildChatToolsWithRouting(fixture);
  const patch = tools.find((t) => t.function.name === "apply_patch");
  assert.ok(patch, "apply_patch tool present");

  // Description should mention freeform / grammar
  assert.ok(patch.function.description.includes("freeform"), "description mentions freeform");
  assert.ok(patch.function.description.includes("Never call this tool with {}"), "description rejects empty JSON calls");
  assert.ok(patch.function.description.includes("instead of using shell commands"), "description forbids shell rewrite bypass");
  assert.ok(patch.function.description.includes("lark"), "description mentions lark syntax");

  // Parameters should accept content
  assert.ok(patch.function.parameters.properties.content, "parameters has content property");
  assert.ok(patch.function.parameters.required.includes("content"), "content is required");
});

compatTest("buildChatToolsWithRouting namespace names are collision-safe", () => {
  const { tools, routing } = buildChatToolsWithRouting(fixture);

  // All chat names must be unique
  const names = tools.map((t) => t.function.name);
  const uniqueNames = new Set(names);
  assert.equal(names.length, uniqueNames.size, "all Chat tool names are unique (collision-safe)");

  // Every namespace-flattened name has routing
  for (const name of names) {
    if (name.startsWith("mcp__node_repl__") || name.startsWith("codex_app__")) {
      assert.ok(routing[name], `routing exists for flattened tool: ${name}`);
      assert.ok(routing[name].namespace, `namespace recorded for: ${name}`);
    }
  }
});

compatTest("buildChatToolsWithRouting tool_choice none yields empty tools and empty routing", () => {
  const noneFixture = { ...fixture, tool_choice: "none" };
  const { tools, routing } = buildChatToolsWithRouting(noneFixture);

  assert.equal(tools.length, 0, "no tools forwarded when tool_choice=none");
  assert.equal(Object.keys(routing).length, 0, "empty routing when tool_choice=none");
});

compatTest("buildChatToolsWithRouting compact mode yields empty tools and empty routing", () => {
  const { tools, routing } = buildChatToolsWithRouting(fixture, { compact: true });

  assert.equal(tools.length, 0, "no tools forwarded in compact mode");
  assert.equal(Object.keys(routing).length, 0, "empty routing in compact mode");
});

compatTest("buildChatToolsWithRouting empty tool list with injectInternalTools forwards internal tools", () => {
  const emptyFixture = { model: "gpt-5.5", tool_choice: "auto", tools: [], input: "hello" };
  const internalDefs = [
    { type: "function", function: { name: "web_search", description: "internal search" } },
  ];
  const { tools, routing } = buildChatToolsWithRouting(emptyFixture, {
    injectInternalTools: true,
    internalTools: internalDefs,
  });

  assert.equal(tools.length, 1, "internal tool injected");
  assert.equal(tools[0].function.name, "web_search", "internal web_search injected");
  // Internal tools are not in routing (they are injected, not from Codex request)
  assert.equal(Object.keys(routing).length, 0, "no routing for internal-only tools");
});

compatTest("buildChatToolsWithRouting no request tools + no internal tools yields empty", () => {
  const emptyFixture = { model: "gpt-5.5", tool_choice: "auto", tools: [], input: "hello" };
  const { tools, routing } = buildChatToolsWithRouting(emptyFixture);

  assert.equal(tools.length, 0, "empty tools");
  assert.equal(Object.keys(routing).length, 0, "empty routing");
});

// ── Reverse-mapping simulation (chatToResponsesFormat behavior) ──

compatTest("routing reverse-maps namespace-flattened Chat tool call back to original Codex name", () => {
  const { routing } = buildChatToolsWithRouting(fixture);

  // Simulate upstream returning tool call with chat name mcp__node_repl__js
  const simulatedToolCalls = [
    { id: "call_1", function: { name: "mcp__node_repl__js", arguments: '{"code":"1+1"}' } },
    { id: "call_2", function: { name: "exec_command", arguments: '{"cmd":"ls"}' } },
    { id: "call_3", function: { name: "mcp__node_repl__js_reset", arguments: "{}" } },
  ];

  const mapped = simulatedToolCalls.map((tc) => {
    const upstreamName = tc.function.name;
    const route = routing[upstreamName];
    const codexName = route?.codexName || upstreamName;
    return { ...tc, name: codexName };
  });

  assert.equal(mapped[0].name, "js", "mcp__node_repl__js → js");
  assert.equal(mapped[1].name, "exec_command", "exec_command stays");
  assert.equal(mapped[2].name, "js_reset", "mcp__node_repl__js_reset → js_reset");
});

compatTest("routing records namespace aliases for tool_choice mapping", () => {
  const { tools, routing } = buildChatToolsWithRouting(fixture);
  const toolNames = tools.map((tool) => tool.function.name);

  assert.ok(toolNames.includes("mcp__node_repl__js"), "upstream sees flattened namespace tool name");
  assert.equal(routing.js.chatName, "mcp__node_repl__js", "original subtool name maps to flattened chat name");
  assert.equal(routing.js.codexName, "js", "alias still points back to Codex subtool name");
  assert.equal(routing.js.aliasOnly, true, "alias entry is marked as alias-only");
});

compatTest("routing unwraps custom tool arguments from content wrapper", () => {
  const { routing } = buildChatToolsWithRouting(fixture);

  // Simulate upstream returning a custom tool call with wrapped arguments
  const simulatedCall = {
    id: "call_patch",
    function: {
      name: "apply_patch",
      arguments: '{"content":"--- a/file\\n+++ b/file\\n@@ -1 +1 @@\\n-old\\n+new"}',
    },
  };

  const route = routing[simulatedCall.function.name];
  assert.equal(route.type, "custom", "apply_patch routing is custom type");

  // Simulate unwrap logic (from chatToResponsesFormat)
  const isCustom = route?.type === "custom";
  let args = simulatedCall.function.arguments;
  if (isCustom && args) {
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed.content === "string") args = parsed.content;
    } catch { /* not json */ }
  }

  // After unwrap: arguments should be the raw patch content, not JSON-wrapped
  assert.equal(args, "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new", "custom arguments unwrapped from content wrapper");
  assert.ok(!args.startsWith("{"), "unwrapped content is not JSON");
});

compatTest("routing unknown tool call name passes through unchanged", () => {
  const { routing } = buildChatToolsWithRouting(fixture);

  // A name not in routing passes through as-is
  const unknownName = "some_unknown_tool";
  const route = routing[unknownName];
  assert.equal(route, undefined, "unknown name has no routing entry");
  const codexName = route?.codexName || unknownName;
  assert.equal(codexName, "some_unknown_tool", "passes through unchanged");
});
