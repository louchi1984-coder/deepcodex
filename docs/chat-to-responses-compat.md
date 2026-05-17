# Chat to Responses Compatibility Notes

Scope: deepcodex translates Codex Desktop's Responses-shaped traffic to an OpenAI Chat Completions-compatible DeepSeek route. Claude Messages, Gemini native formats, and other non-Chat upstream protocols are out of scope for this layer.

The translator must remain a compatibility layer. It should preserve Codex runtime semantics, normalize provider differences, and expose diagnostics, but it should not become a separate local control plane.

## Compatibility Rules

### Response Shell

Chat completions should be wrapped into a full Responses-shaped object, not just `{ output }`.

Preserve or echo when present:

- `instructions`
- `model`
- `parallel_tool_calls`
- `previous_response_id`
- `reasoning`
- `store`
- `temperature`
- `text`
- `tool_choice`
- `tools`
- `top_p`
- `truncation`
- `usage`
- `metadata`

Deepcodex may omit fields only when Codex has been tested to accept the reduced shape.

### Message Output

Chat assistant `message.content` maps to:

```json
{
  "type": "message",
  "role": "assistant",
  "status": "completed",
  "content": [
    { "type": "output_text", "text": "..." }
  ]
}
```

For streaming, emit:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`

### Tool Calls

Chat `tool_calls[]` maps to Responses `function_call` items.

- Allocate stable response item ids separately from Chat call ids.
- Preserve `call_id` from Chat `tool_call.id`.
- Stream `function.arguments` through `response.function_call_arguments.delta`.
- Finish with `response.function_call_arguments.done` and `response.output_item.done`.
- Do not execute unknown calls inside the protocol bridge.

Deepcodex-specific routing still applies after this mapping:

- Internal `web_search` / `web_fetch` may be intercepted before returning to Codex.
- Unknown, MCP, plugin, and custom calls must be preserved for Codex unless explicitly recognized as internal.

### Reasoning

DeepSeek `reasoning_content` is provider-native reasoning text. It should be returned as a Responses `reasoning` item.

Deepcodex must not decode or reinterpret OpenAI private reasoning blobs. If reasoning replay is needed, Deepcodex owns its own opaque replay blob:

```text
deepcodex.reasoning.hex.v1:<hex>
```

- Never treat OpenAI encrypted reasoning as prompt text.
- Never try to decode OpenAI private blobs.
- If reasoning replay is needed, create a deepcodex-owned opaque blob or local cache keyed by session/call id.
- Map `reasoning.effort` to DeepSeek `thinking`; that is separate from encrypted reasoning replay.

DeepSeek-specific handling is different from implementing a new Codex runtime:

- Provider-specific handling means preserving and repairing what DeepSeek actually returns, such as `reasoning_content`, prompt-cache counters, `tool_calls` deltas, and transient 429/502/503 failures.
- Runtime implementation means adding missing API surfaces locally, such as Files, Vector Stores, `file_search`, computer calls, MCP execution, conversation CRUD, and response stores.

Deepcodex should prefer the first category inside the translator. Runtime implementation belongs to a separate project boundary, not to `translator/adaptive-server.mjs`.

Provider-specific rules:

- Reconstruct streamed `tool_calls` by stable `index`, not by arrival order alone.
- Treat missing or mismatched DeepSeek `reasoning_content` as a provider-specific recoverable condition when it affects tool-call continuity.
- Preserve `reasoning_content` across the tool-call round trip when DeepSeek requires it for a follow-up turn.
- Map DeepSeek cache fields (`prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, provider aliases) into Responses `usage.input_tokens_details.cached_tokens`.
- Classify upstream transient failures (`429`, `502`, `503`, connection reset) separately from protocol translation failures. Retries are only safe before any partial tool output has been emitted to Codex.
- Detect prompt explosion / zero completion / abnormal burn rate for diagnostics, but do not let diagnostics rewrite the response contract.

Translator boundaries:

- Do not turn `apply_patch` into `exec_command`; it weakens Codex freeform tool semantics.
- Do not execute MCP/computer/file-search tools inside the protocol bridge unless they are explicitly registered as deepcodex internal tools.
- Do not implement Files or Vector Stores in the translator just to satisfy a surface area checklist.
- Do not hide unsupported hosted OpenAI features behind fake local success.

### Finish Status

Map Chat `finish_reason` into Responses status:

- `stop` / absent successful completion -> `completed`
- length/token limit -> `incomplete` with `incomplete_details`
- tool calls -> completed response containing function_call output items

This needs tests because Codex uses the response status to decide whether to continue the turn.

### Streaming

Prefer real upstream streaming when no internal tool loop is active.

- Track text, reasoning, and tool calls independently.
- Allocate output indices in the order items first appear.
- Handle tool call deltas before arguments are complete.
- Emit final `response.completed` with the same output items that were streamed.
- Keep DeepSeek `reasoning_content` deltas independent from assistant text deltas.
- When upstream sends partial tool-call chunks, merge by `tool_call.index` and only emit a completed Responses tool item when name and arguments are complete enough for Codex.

The current deepcodex synthetic SSE is acceptable only as a fallback.

## Out of Scope

- Claude Messages -> Responses
- Gemini native contents -> Responses
- Anthropic reasoning blocks
- Browser automation protocol translation
- Provider-native multimodal formats other than Chat-compatible `image_url`

These can exist in other projects, but they should not drive deepcodex's Chat -> Responses bridge.

## Current Deepcodex Gaps

- `chatToResponsesFormat` returns a minimal response object; it should preserve more shell fields from the original request.
- Native streaming needs continued hardening around reasoning and tool-call delta reconstruction.
- DeepSeek `reasoning_content` is returned as a Responses reasoning item, but multi-turn replay should remain deepcodex-owned and must not pretend to decode OpenAI encrypted reasoning.
- `context_compaction` as a later input item needs explicit handling in Responses -> Chat; this is adjacent to, but not part of, Chat -> Responses.
- Unknown tool calls should stay unresolved and pass back to Codex, not be executed by the bridge.
