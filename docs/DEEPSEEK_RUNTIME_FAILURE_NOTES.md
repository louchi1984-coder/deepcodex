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
- connector/app-tool availability
- permission and local preview ambiguity
- Markdown/rendering hygiene

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

### 9. Hosted tool absence can be misread as local tool absence

Observed:

When provider-hosted tools such as OpenAI `web_search_preview` are unavailable, DeepSeek may generalize too far and say `web_search` is unavailable even though the translator has injected local `web_search` / `web_fetch`.

Risk:

- search-capable requests are prematurely refused
- model asks the user to take over even though local tools exist
- logs look like search script failure while the real issue is route/tool wording

Current translator guard:

- provider-hosted tool limitations are described separately from translator-owned internal tools
- internal `web_search` / `web_fetch` are injected only when the provider lacks hosted tools
- local tool failures are returned as tool messages instead of user-visible hosted-tool errors

Runtime lesson:

Capability descriptions need separate lanes:

- provider capabilities
- translator-owned internal tools
- host/Codex tools
- connector/app tools

Do not collapse them into a single "tools unavailable" state.

### 10. Search/fetch strategy is fragile without explicit evidence flow

Observed:

DeepSeek sometimes searches, receives snippets, and then either repeats the same search or emits a fetch request as visible DSML markup. It can also rely too heavily on search snippets without fetching primary pages.

Risk:

- weak evidence
- repeated tool loops
- user sees raw tool markup
- final answer overstates uncertain search results

Current translator guard:

- local `web_search` is discovery
- `web_fetch` is available for known URLs
- repeated internal calls are stopped
- finalization prompt asks the model to answer from collected tool results

Runtime lesson:

For research workflows, the runtime should represent search as a mini pipeline:

1. search
2. select sources
3. fetch sources
4. synthesize with citations or state missing evidence

Leaving this entirely to the model causes inconsistent behavior.

### 11. Connector/app plugins can look installed but not active

Observed:

Google Drive/Gmail-style connector plugins can have local plugin metadata and skill files present, while actual app tools are absent from the current thread. DeepSeek may then inspect local caches, infer connector state from files, or tell the user to reconnect without a host-level connector prompt.

Risk:

- installed plugin is mistaken for active connector
- user expects a connector auth flow but gets file-cache analysis
- DeepCodex appears to support a connector that the current route cannot actually invoke

Current boundary:

- DeepCodex reuses Codex plugin/skill directories where possible
- hosted/app connector tools still depend on the Codex/OpenAI host activation path
- translator should not fake connector activation

Runtime lesson:

Connector state should be a first-class runtime capability:

- installed
- connected/authenticated
- tools available in this thread
- unavailable on this route

The model should see this state directly instead of inferring it from files.

### 12. Computer Use / hosted desktop tools can degrade into shell fallback

Observed:

When Computer Use tools are absent on the DeepSeek route, the model may try shell-level fallbacks such as `screencapture`, keyboard shortcuts, or generic app commands. If those are sandboxed or permission-blocked, it asks the user for screenshots.

Risk:

- unclear whether the plugin is missing, permissions are missing, or route does not support hosted tools
- local shell fallbacks do not match Computer Use capability
- user sees inconsistent behavior between OpenAI and DeepSeek routes

Runtime lesson:

Desktop automation capability should be reported as a structured runtime capability, not discovered by trial and error. If Computer Use is absent, the model should say so clearly and avoid pretending that shell screenshots are equivalent.

### 13. Local preview and localhost failures are easy to misattribute

Observed:

Game/web workflows can fail to preview because of local browser isolation, VPN/proxy behavior, missing dev server, sandboxed listener startup, or `file://` asset paths. DeepSeek may treat these as project bugs or keep switching servers/ports.

Risk:

- unnecessary project rewrites
- server churn
- false debugging of app code
- user loses trust because preview behavior changes between routes

Runtime lesson:

Preview state should be explicit:

- server started or failed
- port
- browser surface used
- network/proxy constraints
- whether `file://` or HTTP preview is expected

The model should not infer all preview failures from app code alone.

### 14. macOS permission prompts can be missed

Observed:

Some actions trigger short-lived macOS permission prompts. If the command exits quickly, the prompt may disappear before the user can click Allow.

Risk:

- model assumes the command failed
- user never had time to grant permission
- repeated attempts create confusing state

Current translator guard:

- the system block asks the model to keep permission-sensitive processes alive long enough for prompts

Runtime lesson:

Permission prompts should be surfaced by the host when possible. Prompt-sensitive operations should not rely only on model instructions.

### 15. Markdown hygiene affects UI perception

Observed:

DeepSeek can leave Markdown decorations unclosed or wrap local URLs with trailing `**`, producing UI artifacts such as:

```text
http://localhost:3001/**
```

Risk:

- user thinks the tool produced an incorrect URL
- preview links look broken
- harmless formatting dirt becomes a debugging distraction

Current translator guard:

- known local URL bolding artifacts are sanitized

Runtime lesson:

Rendering cleanup is acceptable only for narrow, well-known artifacts. Do not build a broad Markdown repair engine in the translator.

### 16. DeepSeek may over-explain process after command/tool failure

Observed:

After failed commands, DeepSeek often narrates what it will do next, explains tool limitations, or analyzes why something failed, but does not always perform the next concrete action.

Risk:

- apparent progress without state mutation
- task appears "handled" in the UI but no artifact/check changed

Runtime lesson:

The runtime should distinguish:

- analysis text
- planned action
- actual tool call
- artifact mutation
- verification result

Task completion should depend on state change or explicit user-facing stop condition, not narrative confidence.

### 17. DeepSeek may narrate fake tool execution

Observed:

For search-style requests such as "找一找 remotion 的案例", DeepSeek may say things like:

```text
先搜 Remotion 相关的 showcase 和示例库
搜到一堆好东西
刚才在看 Remotion 官方 showcase 和 GitHub 示例仓库
看着后台跑搜索但界面没反应
```

But the rollout/session JSONL contains no corresponding `function_call` and no `function_call_output` for `web_search`, `web_fetch`, browser, shell, git, or MCP resource tools. The assistant message is followed directly by `task_complete`.

Risk:

- user sees a confident progress narrative but no real search happened
- URLs, examples, and source claims can be invented from model memory
- debugging is misleading because the UI appears to have hidden background work

Current translator guard:

- the system block now includes a tool evidence honesty rule
- the model is told not to claim it searched, fetched, opened, read, inspected, or ran anything unless a matching tool result exists in the current turn or provided history
- for explicit search/discovery requests, the model is told to use available search/fetch/browser/shell tools before giving concrete external examples

Runtime lesson:

The translator should not synthesize tool calls from prose or decide task completion. The runtime should add a completion guard: if the final assistant message contains completed-action claims like "搜到", "我看了", "后台跑", or "刚才在看" but the current turn has no matching tool call/output, it should continue tool execution when possible or force an honest "no actual search result was obtained" response.

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
7. Expose route capabilities as structured state so the model does not infer connector, Computer Use, preview, or search availability from failures.
8. Separate "assistant promised an action" from "runtime observed an action" in rollout/session records.
