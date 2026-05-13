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
  hasPseudoToolMarkup,
  normalizeCompactSummary,
  parsePseudoToolCalls,
  prepareCompactChatBody,
  responsesToChatBody,
  stripPseudoToolMarkup,
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
  assert.match(prepared.messages[0].content, /Do not answer the user's original task/);
});

test("compact summary normalizer rejects acknowledgements", () => {
  const summary = normalizeCompactSummary("已理解，我会保存这些上下文用于后续工程。");
  assert.match(summary, /Compact summary unavailable/);
});

test("compact summary normalizer unwraps json and fences", () => {
  assert.equal(normalizeCompactSummary('```json\n{"summary":"具体进展：已完成 translator compact 包装测试。"}\n```'), "具体进展：已完成 translator compact 包装测试。");
});

test("chat completions are wrapped with a VibeAround-style Responses shell", () => {
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

test("chat tool calls become completed Responses function_call items", () => {
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
  assert.equal(formatted.output[0].type, "function_call");
  assert.equal(formatted.output[0].status, "completed");
  assert.equal(formatted.output[0].call_id, "call_123");
  assert.equal(formatted.output[0].name, "apply_patch");
  assert.equal(formatted.output[0].arguments, "*** Begin Patch\n*** End Patch\n");
  assert.notEqual(formatted.output[0].id, "call_123");
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

test("readable context_compaction input is preserved as system context", () => {
  const body = responsesToChatBody({
    model: "gpt-5.5",
    input: [
      { type: "context_compaction", summary: "项目名 deepcodex，translator 已补 compact。" },
      { type: "message", role: "user", content: [{ type: "text", text: "继续" }] },
    ],
  }, { allowTools: false, injectInternalTools: false });

  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /Previous Codex context compaction/);
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
