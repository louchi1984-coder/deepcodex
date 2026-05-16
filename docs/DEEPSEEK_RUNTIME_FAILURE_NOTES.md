# DeepSeek Runtime Failure Notes

This document records failure modes observed when DeepSeek is driven through the Codex Desktop runtime. It is intentionally not a translator design spec. The translator should stay a protocol compatibility layer; planner, task completion, and recovery policy belong in the runtime/harness layer.

## Scope

DeepCodex is a Codex Desktop route/translator patch, not a separate agent runtime. These notes describe places where DeepSeek behaves less reliably than the OpenAI route under the same Codex harness:

- tool-call formatting
- continuation after tool failure
- compaction/restore
- pseudo tool markup leakage
- MCP/skill resource assumptions
- Windows shell command quirks

## Observed Failure Modes

### 1. Freeform tool calls can degrade into empty JSON

Observed:

```json
{ "name": "apply_patch", "arguments": "{}" }
```

Codex `apply_patch` is a freeform patch tool. It requires a complete patch body, not an empty JSON object. When DeepSeek emits `{}`, Codex rejects it with errors such as:

```text
missing field `input`
```

Risk:

- repeated invalid tool calls
- model self-explains the mistake and switches to shell file writes
- source edits happen through unsafe fallback paths

Current translator guard:

- custom/freeform tools are exposed to DeepSeek as a JSON wrapper with `content`
- empty custom calls are blocked before reaching Codex
- the model is told not to bypass malformed `apply_patch` with shell writes

Runtime lesson:

Freeform tools should be treated as a special tool class. Failure recovery should ask for a corrected freeform body, not switch edit mechanisms automatically.

### 2. Tool failure can cause continuation drift

Observed:

After a tool failure or unavailable resource, DeepSeek may answer with a future-action promise:

```text
现在把所有经验补全
```

Then the turn ends without any write/edit tool call. In the UI this reads like work is about to continue, but the runtime has already completed the task.

Risk:

- user believes an edit is in progress
- no file was written
- task state becomes ambiguous

Preferred layer:

This should not be solved in the translator by regexing assistant text. It belongs in the planner/task runtime:

- before `task_complete`, inspect whether the last assistant message is only a future-action commitment
- if there is no following tool call or artifact mutation, keep the run open or produce an explicit "not performed" message
- record pending action state across tool failures

### 3. DeepSeek may invent MCP resource servers

Observed:

The model attempted:

```text
read_mcp_resource(server="codex-skill", ...)
```

where `codex-skill` was not a real MCP server in the session.

Risk:

- false resource lookup failures
- model wastes turns inspecting nonexistent local plugin/resource paths
- connector/skill confusion

Preferred layer:

The runtime should expose a reliable resource registry and validate server/resource pairs before tool execution. The model should only see resource identifiers that are actually available in the thread.

Translator boundary:

Do not invent or repair MCP server names in the translator. Unknown MCP calls should remain visible as tool failures or be rejected by the host with a clear error.

### 4. Context compaction can return weak or empty summaries

Observed:

Old sessions contained compacted events whose `replacement_history` ended with:

```json
{ "type": "context_compaction" }
```

with no `summary`, `text`, or `content`.

Risk:

- restore treats a damaged checkpoint as valid
- old tool outputs, render logs, images, and developer fragments are replayed into `/responses`
- input tokens continue growing after "compaction"
- DeepSeek eventually returns gateway errors or 502

Current translator guard:

- `/responses/compact` normalizes weak compact summaries
- fallback summary is derived from compact input when upstream output is weak
- restore detects damaged empty `context_compaction` and drops noisy post-checkpoint tool history before sending to DeepSeek

Runtime lesson:

The durable thread store should never persist an empty compact item as a successful checkpoint. If a compact result has no summary, it should be marked failed/damaged and retried or surfaced.

### 5. Pseudo DSML tool markup can leak as visible text

Observed:

DeepSeek sometimes outputs pseudo tool markup directly:

```xml
<｜｜DSML｜｜tool_calls>
...
</｜｜DSML｜｜tool_calls>
```

Risk:

- user sees raw tool markup
- requested tool is not executed
- model thinks it has initiated a tool call, while Codex sees only assistant text

Current translator guard:

- parse pseudo DSML for internal `web_search` / `web_fetch`
- execute internal tools and feed results back to DeepSeek
- pass unknown pseudo tool calls through as Codex function calls instead of dropping them
- strip pseudo markup from final visible text

Runtime lesson:

Tool-call parsing must preserve intent, not just clean text. Unknown tool calls should remain inspectable and recoverable.

### 6. Internal web tool loops need hard limits

Observed:

DeepSeek can repeat the same internal `web_search` / `web_fetch` call after receiving tool results.

Risk:

- repeated local search calls
- no final synthesis
- user sees "tool loop limit" style failures

Current translator guard:

- repeated internal calls are detected
- internal tools are disabled for the final synthesis prompt
- collected tool results are summarized back to the model

Runtime lesson:

Loop control is acceptable in the translator for translator-owned internal tools. For host tools, loop control belongs in the runtime.

### 7. Windows command execution is sensitive to shell shims

Observed:

Commands like:

```powershell
Start-Process -FilePath "npx"
```

can open `npx.ps1` in Notepad instead of executing `npx.cmd`.

Risk:

- Remotion/Vite/npm workflows fail oddly
- model interprets this as a project or dependency failure

Current Windows guard:

- startup creates local `.cmd` shims for `npm`, `npx`, `pnpm`, `yarn`
- system prompt tells the model to use `.cmd` explicitly

Runtime lesson:

Windows shell normalization should be an execution-layer concern. Skills/plugins should not each solve it independently.

### 8. Plugin/skills sharing can fail silently on Windows

Observed:

DeepCodex Windows links its `skills`, `plugins`, `.tmp/plugins`, app tool cache, and computer-use state to official Codex `.codex`. Directory linking can fail while DeepCodex is running or if Windows blocks junction/symlink operations.

Risk:

- skills appear missing after restart
- connector/plugin state looks partially installed

Current guard:

- use Windows junctions instead of plain symlinks
- log link failures to `deepcodex-plugin-host-sync.log`
- no robocopy fallback, because DeepCodex should remain a patch and avoid duplicating ecosystem state

Runtime lesson:

Shared plugin/skill state should either be linked before the host starts or fail visibly. Do not silently continue with a half-synced ecosystem.

## What Not To Put In The Translator

Do not make the translator a planner:

- do not decide whether a natural-language promise means task completion
- do not infer pending actions from prose and synthesize tool calls
- do not rewrite arbitrary host tool failures into alternate shell commands
- do not invent MCP server names or connector states
- do not maintain a second task state machine

The translator should only:

- preserve tool-call intent
- repair known protocol shape mismatches
- prevent known invalid tool payloads from reaching Codex
- execute translator-owned internal tools
- normalize compact/restore enough to avoid corrupted context replay

## Runtime Follow-Ups

The DeepSeek Desktop / Codex runtime layer should consider:

1. Add a `pending_action` checkpoint after assistant messages that promise future work.
2. Before task completion, verify the promised write/run/read action actually produced a tool call, artifact, patch, or verification event.
3. Persist compact checkpoints with status: `completed`, `failed`, or `damaged`; never treat an empty compact as completed.
4. Validate MCP resource calls against the actual resource registry before model execution.
5. Add a recovery path after tool failure: retry valid tool call, ask for permission/input, or clearly state no action was performed.
6. Keep Windows shell command normalization in the execution layer.

