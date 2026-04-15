# Bugfix: Claude CLI Parser + HITL + Frontend Polish

Date: 2026-04-15
Status: Approved

## Problem

8 issues identified in the current codebase:

1. **Claude CLI parser entirely wrong** — `claudeLoop.ts` assumes Anthropic API streaming format (`stream_event`, `content_block_delta`) but real CLI outputs `system/assistant/result` JSON lines
2. **Claude mode has no HITL** — `awaitCheckpoint()` never called
3. **`thinkNodeId` variable scope** — function parameter reassigned inside closure
4. **`run_finished` sent twice** — both in `spawnClaude` close handler and `run()` method
5. **Frontend not provider-aware** — shows step counter and tool approval UI in Claude mode where they don't apply
6. **DAG layout bug** — `thinking` nodes created after `tool_result` get placed in branch column instead of main axis
7. **No tests** — all code untested (acknowledged, not in scope for this fix)
8. **SSE reconnection** — analyzed and found to be non-issue (reducer event sourcing handles replay correctly)

## Verified Claude CLI Output Format

Captured from `claude -p --output-format stream-json --verbose`:

```
{"type":"system","subtype":"hook_started",...}        # skip
{"type":"system","subtype":"hook_response",...}       # skip
{"type":"system","subtype":"init","model":"..."}      # extract model info
{"type":"assistant","message":{"content":[
  {"type":"thinking","thinking":"..."}                # → thinking node
]}}
{"type":"assistant","message":{"content":[
  {"type":"tool_use","name":"Read","input":{...}}     # → tool_call node
]}}
{"type":"assistant","message":{"content":[
  {"type":"text","text":"final answer"}               # → answer node
]}}
{"type":"result","subtype":"success","result":"..."}  # → run_finished
```

Key insight: CLI executes tools internally. There is NO `tool_result` event — we only see the next `assistant` message after tool execution completes.

## Fix 1: Rewrite claudeLoop.ts Parser

### JSON Line Handling

| type | subtype/content | DAG mapping |
|------|----------------|-------------|
| `system` (subtype: init) | Session init | Ignore (extract model) |
| `system` (subtype: hook_*) | Hook events | Ignore |
| `assistant` → `thinking` content block | Model reasoning | `thinking` node (streaming update) |
| `assistant` → `tool_use` content block | Tool call request | `tool_call` node (status: done, CLI already executed) |
| `assistant` → `text` content block | Text output | Update current `thinking` node content |
| `result` | Final result | Create `answer` node from `result.result`, then HITL checkpoint |

**Important parsing notes:**
- Each `assistant` JSON line has `message.content` as an **array** of blocks. Parser must iterate all blocks in the array, not assume one block per message.
- `answer` node is ONLY created when `result` event arrives, not from `text` content blocks (since we cannot determine "final turn" at parse time).
- CLI args include `--include-partial-messages` flag for streaming text updates within individual messages.

### Variable Scope Fix

`thinkNodeId` and `fullText` become class member fields instead of local variables / function parameters, eliminating closure reassignment issues.

### run_finished Deduplication

`spawnClaude()` only resolves/rejects the Promise. All `run_finished` emission happens in `run()`:
- Normal completion → HITL checkpoint first, then `run_finished`
- Error → emit error node + `run_finished: failed`
- Abort → `run_finished: aborted`

## Fix 2: Claude Mode HITL

### What We Can Do

| Checkpoint | Trigger | Options |
|-----------|---------|---------|
| Answer review | After CLI finishes, before `run_finished` | accept / revise / finish |

### What We Cannot Do

- Tool approval before execution (CLI controls this)
- Modify tool arguments mid-execution

### Revise Flow

When user chooses "revise" with feedback note:
1. Create new `thinking` node linked to previous `answer` node
2. Spawn a new `claude -p` process with prompt: `"Previous answer:\n{lastAnswer}\n\nUser feedback:\n{note}\n\nPlease revise your answer based on the feedback above."`
3. Parse new output as additional DAG nodes
4. Arrive at new answer → another HITL checkpoint
5. Loop until user accepts or finishes

## Fix 3: Frontend Provider Awareness

### Event Protocol Change

`run_started` event adds optional field:
```typescript
| (BaseEvent & { type: "run_started"; provider?: "api" | "claude" })
```

`GraphState` adds:
```typescript
provider?: "api" | "claude";
```

### UI Behavior by Provider

| UI Element | api mode | claude mode |
|-----------|----------|-------------|
| Step counter | `step: 3/20` | Hidden |
| HITL (tool approval) | approve/reject/modify | Never shown |
| HITL (answer review) | accept/revise/finish | accept/revise/finish |
| Provider label | Shown in meta bar | Shown in meta bar |

## Fix 4: DAG Layout

### Analysis

Reviewed `DagCanvas.vue` layout code: classification checks `mainRoles.has(n.role)` **before** checking `parentId`. This means `thinking` nodes always go to main column regardless of their parentId. The originally reported bug does **not exist** in the current code.

**No changes needed.** DagCanvas.vue is removed from the change list.

## Files Changed

| File | Change |
|------|--------|
| `apps/server/src/claudeLoop.ts` | Full rewrite: real CLI format parser, HITL, scope fix |
| `packages/shared/src/events.ts` | `run_started` add `provider` field |
| `packages/shared/src/reducer.ts` | Store `provider` in GraphState |
| `apps/server/src/runManager.ts` | Emit `provider` in `run_started` |
| `apps/server/src/agentLoop.ts` | Emit `provider` in `run_started` |
| `apps/web/src/App.vue` | Conditional step counter, provider label |
