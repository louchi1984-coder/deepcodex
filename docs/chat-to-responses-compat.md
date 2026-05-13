# Chat to Responses Compatibility Notes

Scope: deepcodex should borrow community work for Chat Completions -> OpenAI Responses conversion. Claude Messages, Gemini native formats, and other non-Chat upstream protocols are out of scope for this layer.

## Reference Implementations

- VibeAround
  - `src/server/src/openai_proxy/chat_to_responses.rs`
  - `src/server/src/openai_proxy/reasoning_blob.rs`
  - `src/server/src/openai_proxy/providers/deepseek.rs`
  - Useful because it separates generic Chat -> Responses mapping from provider-specific DeepSeek reasoning replay.
- open-responses-server
  - `src/open_responses_server/responses_service.py`
  - Useful for streaming Chat chunks into Responses events and for local `previous_response_id` style history.
- LiteLLM issue #27276
  - Useful as a warning: unsupported/custom tool types and Codex tool names are easy to corrupt when bridging Responses and Chat.

## Rules to Borrow

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

Important details from VibeAround:

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

VibeAround does not try to decode OpenAI `reasoning.encrypted_content`. Instead, it creates its own opaque replay blob:

```text
vibearound.reasoning.hex.v1:<hex>
```

Deepcodex should follow the same principle:

- Never treat OpenAI encrypted reasoning as prompt text.
- Never try to decode OpenAI private blobs.
- If reasoning replay is needed, create a deepcodex-owned opaque blob or local cache keyed by session/call id.
- Map `reasoning.effort` to DeepSeek `thinking`; that is separate from encrypted reasoning replay.

### Finish Status

Map Chat `finish_reason` into Responses status:

- `stop` / absent successful completion -> `completed`
- length/token limit -> `incomplete` with `incomplete_details`
- tool calls -> completed response containing function_call output items

This needs tests because Codex uses the response status to decide whether to continue the turn.

### Streaming

Prefer real upstream streaming when no internal tool loop is active.

Borrow from VibeAround:

- Track text, reasoning, and tool calls independently.
- Allocate output indices in the order items first appear.
- Handle tool call deltas before arguments are complete.
- Emit final `response.completed` with the same output items that were streamed.

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
- Streaming only handles text in the native path; it needs reasoning and tool call delta support.
- DeepSeek `reasoning_content` is returned as `summary_text`, but not as an opaque replayable reasoning item.
- `context_compaction` as a later input item needs explicit handling in Responses -> Chat; this is adjacent to, but not part of, Chat -> Responses.
- Unknown tool calls should stay unresolved and pass back to Codex, not be executed by the bridge.
