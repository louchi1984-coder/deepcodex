import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  buildSystemBlock,
  callUpstreamWithInternalTools,
  canUseNativeStreaming,
  ChatToResponsesStreamMapper,
  chatToCompactResponseFormat,
  chatToResponsesFormat,
  classifyUpstreamFailure,
  hasPseudoToolMarkup,
  inputTokensResponse,
  normalizeCompactSummary,
  parsePseudoToolCalls,
  prepareCompactChatBody,
  responsesToChatBody,
  sanitizeMarkdownUrlFormatting,
  stripPseudoToolMarkup,
  unknownInputItemText,
  usageDiagnostics,
} = await import("../adaptive-server.mjs");

const dsmlFetch = `最后抓一下 163 那篇比较全面的伤亡统计文章，确认乌克兰方面的完整数据：

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="web_fetch">
<｜｜DSML｜｜parameter name="url" string="true">https://m.163.com/news/article/KLMPU1SA0523C0OR.html</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;

const dsmlExec = `我需要查看文件列表：

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="exec_command">
<｜｜DSML｜｜parameter name="cmd" string="true">ls</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`;

test("pseudo DSML tool calls are detected and stripped from text", () => {
  assert.equal(hasPseudoToolMarkup(dsmlFetch), true);
  const stripped = stripPseudoToolMarkup(dsmlFetch);
  assert.equal(stripped.includes("DSML"), false);
  assert.equal(stripped.includes("web_fetch"), false);
  assert.match(stripped, /最后抓一下 163/);
});

test("pseudo DSML web_fetch is parsed as an internal tool call", () => {
  const calls = parsePseudoToolCalls(dsmlFetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "web_fetch");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    url: "https://m.163.com/news/article/KLMPU1SA0523C0OR.html",
  });
});

test("compact responses are returned as context_compaction items", () => {
  const formatted = chatToCompactResponseFormat({
    id: "chatcmpl_compact",
    created: 123,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    choices: [{
      message: { role: "assistant", content: "  当前进展：translator compact 已包装 context_compaction。下一步：继续验证 Codex 接受该结构。  " },
    }],
  }, "gpt-5.5");

  assert.equal(formatted.object, "response");
  assert.equal(formatted.status, "completed");
  assert.equal(formatted.output.length, 1);
  assert.deepEqual(formatted.output[0], {
    type: "context_compaction",
    summary: "当前进展：translator compact 已包装 context_compaction。下一步：继续验证 Codex 接受该结构。",
  });
  assert.equal(formatted.usage.total_tokens, 15);
});

test("compact chat body disables tools and adds strict compact instruction", () => {
  const prepared = prepareCompactChatBody({
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "history" }],
    tools: [{ type: "function", function: { name: "web_search" } }],
  });

  assert.equal(prepared.stream, false);
  assert.equal(prepared.tool_choice, "none");
  assert.equal(prepared.tools, undefined);
  assert.equal(prepared.messages[0].role, "system");
  assert.match(prepared.messages[0].content, /CONTEXT CHECKPOINT COMPACTION/);
  assert.match(prepared.messages[0].content, /handoff summary/);
  assert.match(prepared.messages[0].content, /latest user request/);
  assert.match(prepared.messages[0].content, /active in-flight task/);
  assert.match(prepared.messages[0].content, /exact files, commands, parameters/);
  assert.match(prepared.messages[0].content, /one-line continuation instruction/);
  assert.match(prepared.messages[0].content, /What remains to be done/);
});

test("compact summary normalizer rejects acknowledgements", () => {
  const summary = normalizeCompactSummary("已理解，我会保存这些上下文用于后续工程。");
  assert.match(summary, /Compact summary unavailable/);
});

test("compact fallback preserves active task when upstream summary is weak", () => {
  const formatted = chatToCompactResponseFormat({
    id: "chatcmpl_compact_weak",
    choices: [{ message: { role: "assistant", content: "好的" } }],
  }, "gpt-5.5", {
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "text", text: "当前任务：把 Editorial.tsx 的 padding 从 280 改成 400，并继续检查 node news-pipeline/pipeline.js demo-001 的结果。" }],
    }],
  });

  const summary = formatted.output[0].summary;
  assert.match(summary, /上游模型没有返回可用的压缩摘要/);
  assert.match(summary, /Editorial\.tsx/);
  assert.match(summary, /280/);
  assert.match(summary, /400/);
  assert.match(summary, /news-pipeline\/pipeline\.js demo-001/);
});

test("compact summary normalizer unwraps json and fences", () => {
  assert.equal(normalizeCompactSummary('```json\n{"summary":"具体进展：已完成 translator compact 包装测试。"}\n```'), "具体进展：已完成 translator compact 包装测试。");
});

test("input token probe returns a stable Responses-compatible shape", () => {
  const result = inputTokensResponse({ input: "hello" });
  assert.equal(result.object, "response.input_tokens");
  assert.equal(typeof result.input_tokens, "number");
  assert.ok(result.input_tokens > 0);
  assert.deepEqual(result.input_tokens_details, { cached_tokens: 0 });
});

test("unknown input items are preserved as bounded system text", () => {
  const text = unknownInputItemText({
    type: "computer_call_output",
    call_id: "call_123",
    screenshot: "x".repeat(5000),
    output: "visible result",
  });
  assert.match(text, /computer_call_output/);
  assert.match(text, /visible result/);
  assert.match(text, /screenshot omitted/);
  assert.ok(text.length < 2400);
});

test("markdown sanitizer unwraps bold local URLs without touching normal text", () => {
  assert.equal(
    sanitizeMarkdownUrlFormatting("服务已启动，运行在 **🌐 http://localhost:3000/**，返回 200。"),
    "服务已启动，运行在 🌐 http://localhost:3000/，返回 200。",
  );
  assert.equal(
    sanitizeMarkdownUrlFormatting("打开 `http://127.0.0.1:8080/**` 测试。"),
    "打开 `http://127.0.0.1:8080/` 测试。",
  );
});

test("chat completions are wrapped with a full Responses shell", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_123",
    created: 123,
    model: "deepseek-chat",
    choices: [{
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "Hi",
        reasoning_content: "Need to answer briefly.",
      },
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  }, {
    model: "gpt-5.5",
    instructions: "Be brief.",
    max_output_tokens: 128,
    parallel_tool_calls: true,
    reasoning: { effort: "xhigh" },
    store: false,
    tool_choice: "auto",
    tools: [{ type: "function", name: "exec_command" }],
    text: { verbosity: "low" },
  });

  assert.equal(formatted.object, "response");
  assert.equal(formatted.status, "completed");
  assert.equal(formatted.instructions, "Be brief.");
  assert.equal(formatted.max_output_tokens, 128);
  assert.deepEqual(formatted.reasoning, { effort: "xhigh" });
  assert.equal(formatted.output[0].type, "reasoning");
  assert.equal(formatted.output[0].summary.length, 0);
  assert.match(formatted.output[0].encrypted_content, /^deepcodex\.reasoning\.hex\.v1:/);
  assert.equal(formatted.output[1].type, "message");
  assert.equal(formatted.output[1].content[0].text, "Hi");
  assert.equal(formatted.usage.input_tokens, 10);
  assert.equal(formatted.usage.input_tokens_details.cached_tokens, 3);
  assert.equal(formatted.usage.output_tokens_details.reasoning_tokens, 1);
});

test("chat finish_reason maps to Responses incomplete status", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "length",
      message: { role: "assistant", content: "partial" },
    }],
  }, { model: "gpt-5.5", input: "hello" });

  assert.equal(formatted.status, "incomplete");
  assert.deepEqual(formatted.incomplete_details, { reason: "max_output_tokens" });
});

test("DeepSeek prompt cache usage fields map to Responses cached tokens", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_cache",
    model: "deepseek-v4-pro",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "ok" },
    }],
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 750,
      prompt_cache_miss_tokens: 250,
      completion_tokens: 10,
      total_tokens: 1010,
    },
  }, { model: "gpt-5.5", input: "hello" });

  assert.equal(formatted.usage.input_tokens, 1000);
  assert.equal(formatted.usage.input_tokens_details.cached_tokens, 750);
  assert.equal(formatted.usage.output_tokens, 10);
});

test("usage diagnostics classify cache misses and prompt explosion", () => {
  assert.deepEqual(usageDiagnostics({
    prompt_tokens: 60000,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 60000,
    completion_tokens: 0,
    total_tokens: 60000,
  }), {
    input: 60000,
    output: 0,
    total: 60000,
    cache_hit: 0,
    cache_miss: 60000,
    flags: ["zero_completion", "cache_miss_large_prompt"],
  });

  const huge = usageDiagnostics({
    prompt_tokens: 250000,
    prompt_tokens_details: { cached_tokens: 100000 },
    completion_tokens: 20,
    total_tokens: 250020,
  });
  assert.equal(huge.cache_hit, 100000);
  assert.equal(huge.cache_miss, 150000);
  assert.deepEqual(huge.flags, ["prompt_explosion"]);
});

test("upstream failure classifier separates transient, protocol, auth, and quota failures", () => {
  assert.deepEqual(classifyUpstreamFailure(502, "Bad Gateway").type, "transient_upstream_error");
  assert.equal(classifyUpstreamFailure(502, "Bad Gateway").retryable, true);

  const protocol = classifyUpstreamFailure(400, "", {
    error: {
      message: "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
      type: "invalid_request_error",
      code: "invalid_request_error",
    },
  });
  assert.equal(protocol.type, "protocol_or_translation_error");
  assert.equal(protocol.retryable, false);
  assert.match(protocol.hint, /message\/tool ordering/);
  assert.equal(protocol.raw_type, "invalid_request_error");

  assert.equal(classifyUpstreamFailure(401, "Invalid API key").type, "auth_error");
  assert.equal(classifyUpstreamFailure(402, "insufficient quota").type, "quota_or_billing_error");
});

test("chat response blocks fake tool execution claims without tool calls", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "我已经运行 npm install，启动 Remotion Studio，并生成音频文件。" },
    }],
  }, { model: "gpt-5.5", input: "帮我做视频" });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
  assert.match(formatted.output[0].content[0].text, /没有实际 tool call/);
});

test("chat response blocks direct command promises without tool calls", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "`npm run dev` / `npm start` 都崩。我直接在项目目录用 `npx remotion studio --port=3001`。" },
    }],
  }, { model: "gpt-5.5", input: "赶紧的" });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response allows completion summary when prior tool evidence exists", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "已经读取 projections.mjs，并把对应改动写入完成。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "function_call_output", call_id: "call_read", output: "file content" }],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.doesNotMatch(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response still blocks future action promise even when prior tool evidence exists", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "读完了。现在我直接用 npx remotion studio 启动。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [{ type: "function_call_output", call_id: "call_read", output: "file content" }],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks dangling skeleton promise after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "webbridge daemon 活了，extension_connected: false。现在先不管扩展连通——直接做 gemini-cli 的 skeleton：" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_status", name: "exec_command", arguments: "{\"cmd\":\"curl http://127.0.0.1:10086/status\"}" },
      { type: "function_call_output", call_id: "call_status", output: "{\"extension_connected\":false,\"running\":true}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks dangling colon action after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "看到 new-chat-3 了，这很可能就是 qwen 相关项目。看看它的内容：" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_ls", name: "exec_command", arguments: "{\"cmd\":\"ssh win-codex ls\"}" },
      { type: "function_call_output", call_id: "call_ls", output: "new-chat-3" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks English dangling patch retry promise after failed patch", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "Patch body got clipped. Let me use the full content directly:" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "apply_patch verification failed: invalid patch: The last line of the patch must be '*** End Patch'" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
  assert.match(formatted.output[0].content[0].text, /没有实际 tool call/);
});

test("chat response blocks English direct write promise after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "I found the target files. Let me now write the implementation directly:" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_read", name: "exec_command", arguments: "{\"cmd\":\"sed -n '1,120p' src/App.jsx\"}" },
      { type: "function_call_output", call_id: "call_read", output: "export default function App() {}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks English dangling verification promise after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "Now I have the full picture. Let me check that the computeResultConsumption function is actually in the file:" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "{\"output\":\"Success. Updated the following files:\\nM runtime/codex/projections.mjs\\n\"}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks English dangling update promise with numbered lead-in", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "I need to add consumption-first rendering. Let me update: 1" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_read", name: "exec_command", arguments: "{\"cmd\":\"sed -n '1,220p' SidePanel.jsx\"}" },
      { type: "function_call_output", call_id: "call_read", output: "function TurnResultBlock() {}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
});

test("chat response blocks status-probe detour after results are ready", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "搜索已经跑完了，结果就在上面。让我确认一下 daemon 还在跑、工具链完整，然后给你最终总结。",
        tool_calls: [{
          id: "call_status",
          type: "function",
          function: {
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "powershell -Command \"netstat -ano | findstr ':10086'\"" }),
          },
        }],
      },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_search", name: "exec_command", arguments: "{\"cmd\":\"google-cli search AI\"}" },
      { type: "function_call_output", call_id: "call_search", output: "{\"data\":[{\"title\":\"AI news\"}]}" },
    ],
  }, { exec_command: { type: "function", codexName: "exec_command" } });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /已拦截这轮回复/);
  assert.match(formatted.output[0].content[0].text, /最终回答/);
  assert.ok(!formatted.output.some(item => item.type === "function_call"), "status probe should not be forwarded");
});

test("chat response allows factual blocker after tool evidence", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "webbridge daemon 活了，但 extension_connected 还是 false。需要先安装 Chrome 扩展，否则不能控制网页。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_status", name: "exec_command", arguments: "{\"cmd\":\"curl http://127.0.0.1:10086/status\"}" },
      { type: "function_call_output", call_id: "call_status", output: "{\"extension_connected\":false,\"running\":true}" },
    ],
  });

  assert.doesNotMatch(formatted.output[0].content[0].text, /已拦截这轮回复/);
  assert.match(formatted.output[0].content[0].text, /需要先安装 Chrome 扩展/);
});

test("chat response blocks web_search unavailable claim when only exec_command failed", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "现在搜了，但 web_search 真的暂时不可用，只能基于已有信息回答。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"curl https://example.com\"}" },
      { type: "function_call_output", call_id: "call_exec", output: "curl: network is unreachable" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /web_search\/web_fetch 不可用/);
  assert.match(formatted.output[0].content[0].text, /exec_command 的网络失败/);
});

test("chat response allows web_search unavailable claim after matching web_search failure output", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "web_search 返回失败，当前没有可靠搜索结果。" },
    }],
  }, {
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_search", name: "web_search", arguments: "{\"query\":\"Remotion examples\"}" },
      { type: "function_call_output", call_id: "call_search", output: "{\"ok\":false,\"error\":\"network blocked\"}" },
    ],
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.equal(formatted.output[0].content[0].text, "web_search 返回失败，当前没有可靠搜索结果。");
});

test("chat custom tool calls become completed Responses custom_tool_call items", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_123",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: "{\"content\":\"*** Begin Patch\\n*** End Patch\\n\"}",
          },
        }],
      },
    }],
  }, { model: "gpt-5.5", input: "patch" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "custom_tool_call");
  assert.equal(formatted.output[0].status, "completed");
  assert.equal(formatted.output[0].call_id, "call_123");
  assert.equal(formatted.output[0].name, "apply_patch");
  assert.equal(formatted.output[0].input, "*** Begin Patch\n*** End Patch\n");
  assert.notEqual(formatted.output[0].id, "call_123");
});

test("malformed custom apply_patch call is not forwarded to Codex", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_bad_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: "{}",
          },
        }],
      },
    }],
  }, { model: "gpt-5.5", input: "patch" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /requires a complete freeform patch/);
  assert.match(formatted.output[0].content[0].text, /Add File/);
  assert.match(formatted.output[0].content[0].text, /End Patch/);
  assert.match(formatted.output[0].content[0].text, /Do not bypass/);
});

test("empty custom apply_patch content is not forwarded to Codex", () => {
  const formatted = chatToResponsesFormat({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_empty_patch",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: "{\"content\":\"  \"}",
          },
        }],
      },
    }],
  }, { model: "gpt-5.5", input: "patch" }, {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.match(formatted.output[0].content[0].text, /Regenerate a valid patch body/);
});

test("stream mapper converts Chat text deltas to Responses events", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "hello" }, "gpt-5.5");
  const first = mapper.pushChunk({
    choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
  });
  assert.ok(first.some(([event]) => event === "response.created"));
  assert.ok(first.some(([event]) => event === "response.output_text.delta"));

  const done = mapper.pushChunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].content[0].text, "Hi");
  assert.equal(completed.response.usage.total_tokens, 4);
});

test("stream mapper blocks future-action-only text at completion", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "继续" }, "gpt-5.5");
  mapper.pushChunk({
    choices: [{ index: 0, delta: { content: "好的，先完整读当前 projections.mjs，然后一次性把补丁打上。" }, finish_reason: null }],
  });
  const done = mapper.pushChunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.match(completed.response.output[0].content[0].text, /已拦截这轮回复/);
});

test("stream mapper blocks direct command promises at completion", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "继续" }, "gpt-5.5");
  mapper.pushChunk({
    choices: [{ index: 0, delta: { content: "Server 挂了。让我确认文件状态然后启动：我直接用 npx remotion studio。" }, finish_reason: null }],
  });
  const done = mapper.pushChunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.match(completed.response.output[0].content[0].text, /已拦截这轮回复/);
});

test("stream mapper blocks web_search unavailable claims without web tool evidence", () => {
  const mapper = new ChatToResponsesStreamMapper({
    model: "gpt-5.5",
    input: [
      { type: "function_call", id: "fc_exec", call_id: "call_exec", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_exec", output: "curl: failed to connect" },
    ],
  }, "gpt-5.5");

  mapper.pushChunk({
    choices: [{ index: 0, delta: { content: "我试了，web_search 目前不可用，只能靠 shell。" }, finish_reason: null }],
  });
  const done = mapper.pushChunk({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.match(completed.response.output[0].content[0].text, /不能等同于 web_search\/web_fetch 不可用/);
});

test("native streaming is disabled when translator internal web tools may be needed", () => {
  assert.equal(canUseNativeStreaming({ stream: true }, { model: "deepseek-v4-pro" }, false), false);
});

test("native streaming is opt-in even when no tools are present", () => {
  const previous = process.env.TRANSLATOR_NATIVE_STREAMING;
  delete process.env.TRANSLATOR_NATIVE_STREAMING;
  try {
    assert.equal(canUseNativeStreaming({ stream: true }, { model: "plain-chat" }, false), false);
  } finally {
    if (previous === undefined) delete process.env.TRANSLATOR_NATIVE_STREAMING;
    else process.env.TRANSLATOR_NATIVE_STREAMING = previous;
  }
});

test("system block includes global macOS permission-sensitive action guidance", () => {
  const block = buildSystemBlock();
  assert.match(block, /macOS permission-sensitive action rule:/);
  assert.match(block, /keep the triggering process alive for at least 15 seconds/i);
  assert.match(block, /do not immediately replace a just-started local server/i);
});

test("system block tells Windows agents to use Node .cmd shims", () => {
  const block = buildSystemBlock();
  assert.match(block, /Windows Node command rule:/);
  assert.match(block, /npx\.cmd/);
  assert.match(block, /Start-Process -FilePath "npx"/);
  assert.match(block, /Do not prepend C:\\Program Files\\nodejs to PATH/);
});

test("system block distinguishes hosted tool limits from internal web tools", () => {
  const block = buildSystemBlock();
  assert.match(block, /does NOT support provider-hosted tools/i);
  assert.match(block, /use the translator-provided internal web_search and web_fetch tools/i);
  assert.match(block, /Do not say web_search or web_fetch is unavailable/i);
  assert.doesNotMatch(block, /This route does NOT support: hosted tools/i);
});

test("system block forbids fake tool execution narration", () => {
  const block = buildSystemBlock();
  assert.match(block, /Tool evidence honesty rule:/);
  assert.match(block, /Never claim that you searched/);
  assert.match(block, /corresponding tool call\/result exists/);
  assert.match(block, /Do not say a search is running in the background/);
  assert.match(block, /找一找, 搜索, 查案例, 看看 GitHub/);
  assert.match(block, /do not have actual search results/i);
  assert.match(block, /Do not invent URLs, repositories, examples, or source claims/i);
  assert.match(block, /Do not end a turn with a future-action promise/);
  assert.match(block, /call the appropriate tool now/);
  assert.match(block, /After a tool failure/);
});

test("stream mapper converts Chat tool_call deltas to Responses function_call events", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "pwd" }, "gpt-5.5");
  const first = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_exec",
          type: "function",
          function: { name: "exec_command", arguments: "{\"cmd\"" },
        }],
      },
      finish_reason: null,
    }],
  });
  assert.ok(first.some(([event, data]) => event === "response.output_item.added" && data.item.type === "function_call"));
  assert.ok(first.some(([event]) => event === "response.function_call_arguments.delta"));

  const done = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: ":\"pwd\"}" } }] },
      finish_reason: "tool_calls",
    }],
  });
  const argsDone = done.find(([event]) => event === "response.function_call_arguments.done")?.[1];
  assert.equal(argsDone.arguments, "{\"cmd\":\"pwd\"}");
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].type, "function_call");
  assert.equal(completed.response.output[0].call_id, "call_exec");
  assert.equal(completed.response.output[0].arguments, "{\"cmd\":\"pwd\"}");
});

test("stream mapper converts Chat custom tool calls to custom_tool_call items", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "patch" }, "gpt-5.5", {
    apply_patch: { codexName: "apply_patch", type: "custom" },
  });
  const patch = "*** Begin Patch\n*** End Patch\n";
  const first = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_patch",
          type: "function",
          function: { name: "apply_patch", arguments: JSON.stringify({ content: patch }).slice(0, 20) },
        }],
      },
      finish_reason: null,
    }],
  });
  assert.ok(first.some(([event, data]) => event === "response.output_item.added" && data.item.type === "custom_tool_call"));
  assert.ok(!first.some(([event]) => event === "response.function_call_arguments.delta"));

  const done = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ content: patch }).slice(20) } }] },
      finish_reason: "tool_calls",
    }],
  });
  assert.ok(!done.some(([event]) => event === "response.function_call_arguments.done"));
  const itemDone = done.find(([event, data]) => event === "response.output_item.done" && data.item.type === "custom_tool_call")?.[1];
  assert.equal(itemDone.item.call_id, "call_patch");
  assert.equal(itemDone.item.name, "apply_patch");
  assert.equal(itemDone.item.input, patch);
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].type, "custom_tool_call");
  assert.equal(completed.response.output[0].input, patch);
});

test("stream mapper converts reasoning_content to replayable reasoning item", () => {
  const mapper = new ChatToResponsesStreamMapper({ model: "gpt-5.5", input: "pwd" }, "gpt-5.5");
  const first = mapper.pushChunk({
    choices: [{ index: 0, delta: { reasoning_content: "Need to inspect cwd." }, finish_reason: null }],
  });
  assert.ok(first.some(([event, data]) => event === "response.output_item.added" && data.item.type === "reasoning"));

  const done = mapper.pushChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_exec",
          type: "function",
          function: { name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });
  const reasoningDone = done.find(([event, data]) => event === "response.output_item.done" && data.item.type === "reasoning")?.[1];
  assert.match(reasoningDone.item.encrypted_content, /^deepcodex\.reasoning\.hex\.v1:/);
  const completed = done.find(([event]) => event === "response.completed")?.[1];
  assert.equal(completed.response.output[0].type, "reasoning");
  assert.equal(completed.response.output[1].type, "function_call");
});

test("polluted history is cleaned before forwarding to Chat Completions", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: dsmlFetch }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "继续" }],
      },
    ],
  }, { allowTools: false, injectInternalTools: false });
  assert.equal(body.messages[0].content.includes("DSML"), false);
  assert.equal(body.messages[0].content.includes("web_fetch"), false);
  assert.match(body.messages[0].content, /最后抓一下 163/);
});

test("pure leaked pseudo DSML assistant history is dropped after cleanup", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: `< | | DSML | | tool_calls>
< | | DSML | | invoke name="web_fetch">
< | | DSML | | parameter name="url" string="true">https://example.com</| | DSML | | parameter>
</| | DSML | | invoke>
</| | DSML | | tool_calls>` }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: "继续" }],
      },
    ],
  }, { allowTools: false, injectInternalTools: false });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[0].content, "继续");
});

test("user-supplied pseudo DSML is preserved as text and never becomes null content", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "text", text: `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="read_file">
<｜｜DSML｜｜parameter name="file_path" string="true">/tmp/example.tsx</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>` }],
      },
    ],
  }, { allowTools: true, injectInternalTools: false });

  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.equal(typeof body.messages[0].content, "string");
  assert.match(body.messages[0].content, /read_file/);
  assert.notEqual(body.messages[0].content, null);
});

test("non-assistant empty content is removed before forwarding to Chat", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [] },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content, "继续");
});

test("unsupported message roles are preserved as valid system messages", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "critic", content: [{ type: "text", text: "role should not break upstream" }] },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /unsupported role "critic"/);
  assert.match(body.messages[0].content, /role should not break upstream/);
  assert.equal(body.messages[1].role, "user");
});

test("readable context_compaction input is preserved with Codex summary prefix", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "context_compaction", summary: "项目名 deepcodex，translator 已补 compact。" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "user");
  assert.match(body.messages[0].content, /Another language model started to solve this problem/);
  assert.match(body.messages[0].content, /avoid duplicating work/);
  assert.match(body.messages[0].content, /deepcodex/);
  assert.equal(body.messages[1].role, "user");
});

test("opaque context_compaction input is not injected into prompt", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "context_compaction", encrypted_content: "opaque" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
});

test("damaged context_compaction repairs restore and drops noisy tool history", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "context_compaction" },
      { type: "function_call", call_id: "call_old", name: "exec_command", arguments: "{\"cmd\":\"render\"}" },
      { type: "function_call_output", call_id: "call_old", output: "ANSI render log ".repeat(2000) },
      { type: "message", role: "developer", content: [{ type: "text", text: "stale developer instruction" }] },
      { type: "message", role: "assistant", content: [{ type: "text", text: "上一轮已经做到一半。" }] },
      { type: "message", role: "user", content: [{ type: "text", text: "继续修复 compact restore。" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "user");
  assert.match(body.messages[0].content, /damaged previous context_compaction/);
  assert.match(body.messages[0].content, /omitted/);
  assert.ok(!body.messages.some((message) => message.role === "tool"), "old tool outputs are dropped");
  assert.ok(!body.messages.some((message) => String(message.content).includes("stale developer instruction")), "stale developer message is dropped");
  assert.equal(body.messages.at(-1).role, "user");
  assert.match(body.messages.at(-1).content, /继续修复 compact restore/);
});

test("healthy long restored history is capped by translator item count", () => {
  const input = Array.from({ length: 230 }, (_, index) => ({
    type: "message",
    role: index % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `healthy-history-${index}` }],
  }));

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages.length, 220);
  assert.match(body.messages[0].content, /healthy-history-10/);
  assert.match(body.messages.at(-1).content, /healthy-history-229/);
});

test("healthy long restored history keeps the latest compaction summary before capped tail", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "text", text: "old noisy setup" }] },
    { type: "context_compaction", summary: "压缩摘要：用户正在修复缓存命中，必须保留这个记忆。" },
    ...Array.from({ length: 230 }, (_, index) => ({
      type: "message",
      role: index % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `tail-history-${index}` }],
    })),
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  assert.match(body.messages[0].content, /压缩摘要/);
  assert.match(body.messages[0].content, /缓存命中/);
  assert.match(body.messages[1].content, /tail-history-10/);
  assert.match(body.messages.at(-1).content, /tail-history-229/);
});

test("restored history prunes older tool transcripts while keeping recent tool pairs", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前任务。" },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `call_${index}`, name: "exec_command", arguments: `{"cmd":"echo ${index}"}` },
      { type: "function_call_output", call_id: `call_${index}`, output: `output-${index} ` + "x".repeat(7000) },
    ])).flat(),
    { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  assert.match(body.messages[0].content, /omitted older restored tool transcripts/);
  assert.ok(!body.messages.some((message) => String(message.content).includes("output-0")), "old tool output is omitted");
  assert.ok(body.messages.some((message) => String(message.content).includes("output-19")), "recent tool output is preserved");
  assert.ok(body.messages.some((message) => String(message.content).includes("clipped by DeepCodex translator")), "large tool output is clipped");
  assert.equal(body.messages.at(-1).role, "user");
});

test("restored history keeps active-turn tool transcripts stable for prompt cache", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前任务。" },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `old_${index}`, name: "exec_command", arguments: `{"cmd":"echo old-${index}"}` },
      { type: "function_call_output", call_id: `old_${index}`, output: `old-output-${index}` },
    ])).flat(),
    { type: "message", role: "user", content: [{ type: "text", text: "继续修复缓存命中" }] },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `active_${index}`, name: "exec_command", arguments: `{"cmd":"echo active-${index}"}` },
      { type: "function_call_output", call_id: `active_${index}`, output: `active-output-${index}` },
    ])).flat(),
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(body.messages[0].content, /omitted older restored tool transcripts/);
  assert.doesNotMatch(joined, /old-output-0/);
  assert.match(joined, /old-output-19/);
  assert.match(joined, /active-output-0/);
  assert.match(joined, /active-output-19/);
});

test("restored history prunes active-turn tool transcripts already summarized by assistant", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "text", text: "继续修复" }] },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `summarized_${index}`, name: "exec_command", arguments: `{"cmd":"echo summarized-${index}"}` },
      { type: "function_call_output", call_id: `summarized_${index}`, output: `summarized-output-${index}` },
    ])).flat(),
    { type: "message", role: "assistant", content: [{ type: "text", text: "前面失败原因已经确认，继续下一步。" }] },
    { type: "function_call", call_id: "current_0", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
    { type: "function_call_output", call_id: "current_0", output: "/tmp/project" },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(body.messages[0].content, /omitted older restored tool transcripts/);
  assert.doesNotMatch(joined, /summarized-output-0/);
  assert.doesNotMatch(joined, /summarized-output-19/);
  assert.match(joined, /前面失败原因已经确认/);
  assert.ok(joined.includes("/tmp/project"));
});

test("restored history drops volatile polling transcripts that change every turn", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前发布任务。" },
    { type: "message", role: "assistant", content: [{ type: "text", text: "可能还在跑。等等再查。" }] },
    { type: "function_call", call_id: "call_poll", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex \"powershell -NoProfile -Command \\\"Get-Process python\\\"\"" }) },
    { type: "function_call_output", call_id: "call_poll", output: "Chunk ID: abc\nWall time: 10.0009 seconds\nProcess running with session ID 96679\nOriginal token count: 56\nOutput:\n" },
    { type: "function_call", call_id: "call_result", name: "exec_command", arguments: JSON.stringify({ cmd: "cat release-notes.txt" }) },
    { type: "function_call_output", call_id: "call_result", output: "Chunk ID: stable\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 20\nOutput:\nrelease notes are ready" },
    { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });
  const joined = JSON.stringify(body.messages);

  assert.match(joined, /omitted volatile restored polling/);
  assert.doesNotMatch(joined, /Get-Process/);
  assert.doesNotMatch(joined, /session ID 96679/);
  assert.doesNotMatch(joined, /等等再查/);
  assert.doesNotMatch(joined, /Chunk ID/);
  assert.doesNotMatch(joined, /Wall time/);
  assert.match(joined, /release notes are ready/);
  assert.equal(body.messages.at(-1).role, "user");
});

test("restored history drops update_plan transcripts that churn prompt cache", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "assistant", content: [{ type: "text", text: "更新计划后继续。" }] },
      { type: "function_call", call_id: "call_plan", name: "update_plan", arguments: JSON.stringify({ plan: [{ status: "in_progress", step: "A" }] }) },
      { type: "function_call_output", call_id: "call_plan", output: "Plan updated" },
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }) },
      { type: "function_call_output", call_id: "call_exec", output: "/tmp/project" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /omitted volatile restored polling/);
  assert.doesNotMatch(joined, /update_plan/);
  assert.doesNotMatch(joined, /Plan updated/);
  assert.match(joined, /exec_command/);
  assert.ok(joined.includes("/tmp/project"));
});

test("restored history preserves durable tool facts before pruning noisy probes", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前跨工具任务。" },
    { type: "function_call", call_id: "list", name: "exec_command", arguments: JSON.stringify({ cmd: "docker exec app ls /workspace" }) },
    { type: "function_call_output", call_id: "list", output: "Chunk ID: ls\nWall time: 0s\nProcess exited with code 0\nOutput:\nnew-chat-3\nqwen-cli\nsrc\n" },
    { type: "function_call", call_id: "read", name: "exec_command", arguments: JSON.stringify({ cmd: "docker exec app cat /workspace/qwen-cli/package.json" }) },
    { type: "function_call_output", call_id: "read", output: "Chunk ID: read\nWall time: 0s\nProcess exited with code 0\nOutput:\n{\"name\":\"qwen-cli\"}\n" },
    { type: "function_call", call_id: "build", name: "exec_command", arguments: JSON.stringify({ cmd: "docker exec app npm run build" }) },
    { type: "function_call_output", call_id: "build", output: "Chunk ID: build\nWall time: 1s\nProcess exited with code 1\nOutput:\nError: missing script build\n" },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `old_${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: `echo old-${index}` }) },
      { type: "function_call_output", call_id: `old_${index}`, output: `old-output-${index}` },
    ])).flat(),
    { type: "message", role: "user", content: [{ type: "text", text: "继续看 qwen-cli" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /DeepCodex durable environment facts/);
  assert.match(joined, /workspace: Listing result from docker exec app ls \/workspace: new-chat-3, qwen-cli, src/);
  assert.match(joined, /tool-state: Read command succeeded: docker exec app cat \/workspace\/qwen-cli\/package\.json/);
  assert.match(joined, /tool-state: Command failed, do not assume success: docker exec app npm run build -> Error: missing script build/);
  assert.match(joined, /继续看 qwen-cli/);
});

test("restored history task ledger preserves explicit task target and pending action", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续当前任务。" },
    { type: "message", role: "user", content: [{ type: "text", text: "帮我在 Windows 上找到 qwen-cli 项目，看看 new-chat-3 是不是相关。" }] },
    { type: "function_call", call_id: "ls", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex 'dir C:\\\\Users\\\\jz\\\\Documents\\\\Codex\\\\2026-05-14'" }) },
    { type: "function_call_output", call_id: "ls", output: "new-chat-3\nremotion-demo\n" },
    { type: "message", role: "assistant", content: [{ type: "text", text: "看到 new-chat-3 了，这很可能就是 qwen 相关项目。看看它的内容：" }] },
    { type: "message", role: "user", content: [{ type: "text", text: "你倒是看啊" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /DeepCodex task ledger/);
  assert.match(joined, /current-user-task: 帮我在 Windows 上找到 qwen-cli 项目/);
  assert.match(joined, /pending-next-action: 看到 new-chat-3/);
  assert.match(joined, /target-hint: qwen-cli/);
  assert.match(joined, /target-hint: new-chat-3/);
});

test("restored history keeps successful non-shell tool calls as durable facts", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续处理浏览器标签页。" },
    { type: "function_call", call_id: "close_1", name: "closeTab", arguments: JSON.stringify({ targetId: "tab-123", url: "https://example.com/search" }) },
    { type: "function_call_output", call_id: "close_1", output: JSON.stringify({ ok: true, closed: true, targetId: "tab-123" }) },
    { type: "message", role: "assistant", content: [{ type: "text", text: "抱歉，刚才的回复没有实际行动。让我现在验证一下。" }] },
    { type: "message", role: "user", content: [{ type: "text", text: "刚才你已经成功关闭了" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /DeepCodex durable environment facts/);
  assert.match(joined, /tool-state: Tool closeTab succeeded/);
  assert.match(joined, /targetId=tab-123/);
  assert.match(joined, /刚才你已经成功关闭了/);
});

test("restored history does not turn failed non-shell tool calls into success facts", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续处理浏览器标签页。" },
    { type: "function_call", call_id: "close_1", name: "closeTab", arguments: JSON.stringify({ targetId: "tab-123" }) },
    { type: "function_call_output", call_id: "close_1", output: JSON.stringify({ ok: false, error: "tab not found" }) },
    { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /Tool closeTab failed, do not assume success/);
  assert.doesNotMatch(joined, /Tool closeTab succeeded/);
});

test("restored history drops stale completion detours and paired status probes", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：用户要基于搜索结果总结 2026 年 AI 发展。" },
    { type: "function_call", call_id: "search", name: "exec_command", arguments: JSON.stringify({ cmd: "google-cli search 2026 AI" }) },
    { type: "function_call_output", call_id: "search", output: "Chunk ID: s\nWall time: 1s\nProcess exited with code 0\nOutput:\n{\"data\":[{\"title\":\"AI 2026\"}]}\n" },
    { type: "message", role: "assistant", content: [{ type: "text", text: "搜索已经跑完了，结果就在上面。让我确认一下 daemon 还在跑、工具链完整，然后给你最终总结。" }] },
    { type: "function_call", call_id: "status", name: "exec_command", arguments: JSON.stringify({ cmd: "netstat -ano | findstr ':10086'" }) },
    { type: "function_call_output", call_id: "status", output: "Chunk ID: st\nWall time: 1s\nProcess exited with code 0\nOutput:\nTCP 127.0.0.1:10086 LISTENING\n" },
    { type: "message", role: "user", content: [{ type: "text", text: "直接总结" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /omitted volatile restored polling/);
  assert.doesNotMatch(joined, /让我确认一下 daemon/);
  assert.doesNotMatch(joined, /findstr ':10086'/);
  assert.match(joined, /2026 年 AI/);
  assert.match(joined, /直接总结/);
});

test("restored history ledger preserves workspace and tool-state facts", () => {
  const input = [
    { type: "context_compaction", summary: "压缩摘要：继续找 qwen 项目。" },
    { type: "function_call", call_id: "ls_day", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex 'powershell -NoProfile -Command \"Get-ChildItem C:\\\\Users\\\\jz\\\\Documents\\\\Codex\\\\2026-05-14 -Name\"'" }) },
    { type: "function_call_output", call_id: "ls_day", output: "Chunk ID: ls\nWall time: 1s\nProcess exited with code 0\nOutput:\nnew-chat-3\nqwen-cli\nremotion-demo\n" },
    { type: "function_call", call_id: "read_pkg", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex 'type C:\\\\Users\\\\jz\\\\Documents\\\\Codex\\\\2026-05-14\\\\new-chat-3\\\\package.json'" }) },
    { type: "function_call_output", call_id: "read_pkg", output: "Chunk ID: read\nWall time: 1s\nProcess exited with code 0\nOutput:\n{\"name\":\"new-chat-3\"}\n" },
    { type: "function_call", call_id: "build_fail", name: "exec_command", arguments: JSON.stringify({ cmd: "ssh win-codex 'npm run build'" }) },
    { type: "function_call_output", call_id: "build_fail", output: "Chunk ID: build\nWall time: 1s\nProcess exited with code 1\nOutput:\nError: missing script build\n" },
    ...Array.from({ length: 20 }, (_, index) => ([
      { type: "function_call", call_id: `old_${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: `echo old-${index}` }) },
      { type: "function_call_output", call_id: `old_${index}`, output: `old-output-${index}` },
    ])).flat(),
    { type: "message", role: "user", content: [{ type: "text", text: "继续看 qwen" }] },
  ];

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input,
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /workspace: Listing result/);
  assert.match(joined, /new-chat-3/);
  assert.match(joined, /qwen-cli/);
  assert.match(joined, /tool-state: Read command succeeded/);
  assert.match(joined, /tool-state: Command failed, do not assume success/);
  assert.match(joined, /missing script build/);
});

test("restored custom tool calls replay as Chat tool calls", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "patch failed" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].tool_calls[0].id, "call_patch");
  assert.equal(body.messages[0].tool_calls[0].function.name, "apply_patch");
  assert.deepEqual(JSON.parse(body.messages[0].tool_calls[0].function.arguments), {
    content: "*** Begin Patch\n*** End Patch",
  });
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "call_patch");
  assert.equal(body.messages[1].content, "patch failed");
  assert.equal(body.messages[2].role, "user");
});

test("restored custom tool bodies are clipped to avoid prompt-cache churn", () => {
  const largePatch = `*** Begin Patch\n${"x".repeat(5000)}\n*** End Patch`;
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: largePatch },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "apply_patch verification failed: expected lines not found" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const args = JSON.parse(body.messages[0].tool_calls[0].function.arguments);
  assert.ok(args.content.length < largePatch.length);
  assert.match(args.content, /older custom tool body clipped/);
  assert.equal(body.messages[1].content, "apply_patch verification failed: expected lines not found");
});

test("restored long source outputs are folded but important errors are preserved", () => {
  const longSource = Array.from({ length: 160 }, (_, i) => `${i + 1}\tconst value${i} = computeThing(${i});`).join("\n");
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_source", name: "exec_command", arguments: JSON.stringify({ cmd: "sed -n '1,160p' src/file.js" }) },
      { type: "function_call_output", call_id: "call_source", output: longSource },
      { type: "function_call", call_id: "call_error", name: "exec_command", arguments: JSON.stringify({ cmd: "npm run check" }) },
      { type: "function_call_output", call_id: "call_error", output: "SyntaxError: Unexpected token at src/file.js:42\n    at compile" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /DeepCodex folded/);
  assert.match(joined, /const value0/);
  assert.match(joined, /const value159/);
  assert.doesNotMatch(joined, /const value80/);
  assert.match(joined, /SyntaxError: Unexpected token/);
});

test("restored documentation dumps are folded earlier than source dumps", () => {
  const doc = [
    "# x-cli",
    "",
    "你想在网页上反复做的事，一句话告诉 AI agent，它就能帮你做成 CLI。",
    "",
    "## Usage",
    "- install",
    "- login",
    "- run",
    "",
    "## Site Exploration Protocol",
    ...Array.from({ length: 120 }, (_, i) => `- step ${i}: read the page and record the result`),
    "",
    "## Reference",
    "Keep this tail marker.",
  ].join("\n");

  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_doc", name: "exec_command", arguments: JSON.stringify({ cmd: "cat README.md" }) },
      { type: "function_call_output", call_id: "call_doc", output: doc },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  const joined = JSON.stringify(body.messages);
  assert.match(joined, /DeepCodex folded/);
  assert.match(joined, /# x-cli/);
  assert.match(joined, /Keep this tail marker/);
  assert.doesNotMatch(joined, /step 60/);
});

test("successful patch outputs are summarized for restored cache stability", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: "Success. Updated the following files:\nM /tmp/project/src/a.ts\nM /tmp/project/src/b.ts\n" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.match(body.messages[1].content, /patch applied successfully/);
  assert.match(body.messages[1].content, /M \/tmp\/project\/src\/a\.ts/);
  assert.doesNotMatch(body.messages[1].content, /Success\. Updated/);
});

test("deepcodex reasoning blob is replayed onto following Chat tool calls", () => {
  const reasoningText = "Need to inspect cwd before answering.";
  const blob = `deepcodex.reasoning.hex.v1:${Buffer.from(reasoningText, "utf8").toString("hex")}`;
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "reasoning", encrypted_content: blob, summary: [] },
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_exec", output: "/tmp" },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].reasoning_content, reasoningText);
  assert.equal(body.messages[0].tool_calls[0].id, "call_exec");
  assert.equal(body.messages[1].role, "tool");
});

test("missing tool results in prior history are synthesized before forwarding upstream", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].tool_calls[0].id, "call_exec");
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "call_exec");
  assert.match(body.messages[1].content, /tool_call_interrupted/);
  assert.equal(body.messages[2].role, "user");
});

test("orphan restored tool outputs are dropped before forwarding upstream", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
      { type: "function_call_output", call_id: "call_old", output: "stale output" },
      { type: "message", role: "assistant", content: [{ type: "text", text: "继续处理。" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.ok(!body.messages.some((message) => message.role === "tool"));
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.messages[1].role, "assistant");
});

test("mismatched restored tool outputs do not break Chat tool ordering", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_other", output: "wrong tool result" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].tool_calls[0].id, "call_exec");
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "call_exec");
  assert.match(body.messages[1].content, /tool_call_interrupted/);
  assert.equal(body.messages[2].role, "user");
  assert.ok(!body.messages.some((message) => message.tool_call_id === "call_other"));
});

test("developer approval messages are deferred until after tool output", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "message", role: "developer", content: [{ type: "text", text: "Approved command prefix saved" }] },
      { type: "function_call_output", call_id: "call_exec", output: "ok" },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "assistant");
  assert.equal(body.messages[0].tool_calls[0].id, "call_exec");
  assert.equal(body.messages[1].role, "tool");
  assert.equal(body.messages[1].tool_call_id, "call_exec");
  assert.equal(body.messages[2].role, "system");
  assert.match(body.messages[2].content, /Approved command prefix saved/);
});

test("pseudo DSML external tools are passed through to Codex as tool_calls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 1,
    model: "deepseek-v4-pro",
    choices: [{
      index: 0,
      message: { role: "assistant", content: dsmlExec },
      finish_reason: "stop",
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await callUpstreamWithInternalTools({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "list files" }],
      tools: [],
    });
    const msg = result.json.choices[0].message;
    assert.equal(msg.content, null);
    assert.equal(msg.tool_calls.length, 1);
    assert.equal(msg.tool_calls[0].function.name, "exec_command");
    assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { cmd: "ls" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("internal tool execution exceptions are converted into tool failure messages", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async (_url, options) => {
    upstreamCalls += 1;
    const body = JSON.parse(options.body);
    if (upstreamCalls === 1) {
      return new Response(JSON.stringify({
        id: "chatcmpl_internal_fail_1",
        object: "chat.completion",
        created: 1,
        model: "deepseek-v4-pro",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_bad_fetch",
              type: "function",
              function: { name: "web_fetch", arguments: "{\"url\":\"https://example.com\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    const toolMessage = body.messages.find((msg) => msg.role === "tool" && msg.tool_call_id === "call_bad_fetch");
    assert.ok(toolMessage);
    assert.match(toolMessage.content, /internal tool failed/i);

    return new Response(JSON.stringify({
      id: "chatcmpl_internal_fail_2",
      object: "chat.completion",
      created: 2,
      model: "deepseek-v4-pro",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "fallback answer" },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async () => { throw new Error("internal tool failed: listen EPERM"); };
  try {
    const result = await callUpstreamWithInternalTools({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "fetch page" }],
      tools: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.json.choices[0].message.content, "fallback answer");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("repeated internal tool calls finalize without leaking internal English prompt", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async (_url, options) => {
    upstreamCalls += 1;
    const body = JSON.parse(options.body);
    if (upstreamCalls <= 2) {
      return new Response(JSON.stringify({
        id: `chatcmpl_repeat_${upstreamCalls}`,
        object: "chat.completion",
        created: upstreamCalls,
        model: "deepseek-v4-pro",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `call_search_${upstreamCalls}`,
              type: "function",
              function: { name: "web_search", arguments: "{\"query\":\"Steam 2026\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    assert.equal(body.tool_choice, "none");
    assert.equal(body.tools, undefined);
    assert.match(body.messages.at(-1).content, /不要再次请求 web_search\/web_fetch/);
    return new Response(JSON.stringify({
      id: "chatcmpl_repeat_finalize",
      object: "chat.completion",
      created: 3,
      model: "deepseek-v4-pro",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const originalTool = globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
  globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = async () => JSON.stringify({
    ok: true,
    results: [{ title: "Steam 2026", url: "https://example.com/steam", snippet: "Valve news" }],
  });
  try {
    const result = await callUpstreamWithInternalTools({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "搜 Steam 2026" }],
      tools: [{ type: "function", function: { name: "web_search" } }],
    });
    const content = result.json.choices[0].message.content;
    assert.match(content, /模型重复请求了同一个内部工具/);
    assert.match(content, /Steam 2026/);
    assert.doesNotMatch(content, /Tool use stopped because/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTool === undefined) delete globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__;
    else globalThis.__DEEPCODEX_TEST_EXEC_INTERNAL_TOOL__ = originalTool;
  }
});

test("final Responses formatting never emits internal pseudo DSML as text", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_final_dsml",
    created: 1,
    model: "deepseek-v4-pro",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: `<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="web_fetch">
<｜｜DSML｜｜parameter name="url" string="true">https://example.com</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>`,
      },
      finish_reason: "stop",
    }],
  }, { model: "gpt-5.5", input: "fetch" });

  assert.equal(formatted.output.length, 1);
  assert.equal(formatted.output[0].type, "message");
  assert.equal(formatted.output[0].content[0].text.includes("DSML"), false);
  assert.match(formatted.output[0].content[0].text, /Internal tool request was intercepted/);
});

test("final Responses formatting passes unknown pseudo DSML tools to Codex", () => {
  const formatted = chatToResponsesFormat({
    id: "chatcmpl_final_external",
    created: 1,
    model: "deepseek-v4-pro",
    choices: [{
      index: 0,
      message: { role: "assistant", content: dsmlExec },
      finish_reason: "stop",
    }],
  }, { model: "gpt-5.5", input: "list files" });

  assert.equal(formatted.output.length, 2);
  assert.equal(formatted.output[0].type, "message");
  assert.equal(formatted.output[0].content[0].text.includes("DSML"), false);
  assert.equal(formatted.output[1].type, "function_call");
  assert.equal(formatted.output[1].name, "exec_command");
  assert.deepEqual(JSON.parse(formatted.output[1].arguments), { cmd: "ls" });
});
