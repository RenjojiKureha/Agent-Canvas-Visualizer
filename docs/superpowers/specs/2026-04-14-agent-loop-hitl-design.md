# Agent Loop & HITL Architecture Design

Date: 2026-04-14
Status: Approved

## Problem

Agent Canvas Visualizer aims to solve the agent black-box problem, but currently:
1. No real agent action process — just a single LLM call returning text
2. HITL is ineffective — only triggers "regenerate text", no real execution to approve
3. Revise feature is broken — `buildRevisionPrompt` produces incomplete context, LLM responds with "message incomplete"

## Goals

- Visualize complete agent step chains: thinking → tool_call → tool_result → thinking → ... → answer
- Implement effective HITL: automatic checkpoints (approval gates) + user real-time intervention
- Priority: Claude Code first, then generalize to universal agent protocol
- Full step chain granularity in DAG visualization

## Architecture: Proxy Agent (Option B)

A Server-side Agent Proxy layer between the user and LLM that:
1. Maintains a complete agent loop (think → decide → tool_call → observe → repeat)
2. Calls LLM via OpenAI-compatible API with `tools` parameter
3. Emits standardized events for each step, pushed to frontend via SSE
4. Pauses before tool execution / plan confirmation for HITL approval
5. Accepts user interrupts at any point

## Section 1: Agent Loop Core

### AgentLoop class

Replaces the current "call LLM once, get text" model with a multi-step loop:

```
User Prompt
    ↓
AgentLoop.start()
    ↓
┌─────────────────────────────┐
│  1. Think: call LLM, get    │
│     next decision (text or  │
│     tool_call)              │
│         ↓                   │
│  2. If tool_call:           │
│     → emit thinking node    │
│     → emit tool_call node   │
│     → HITL checkpoint       │◄── user approve/reject/modify
│     → execute tool          │
│     → emit tool_result node │
│     → back to step 1        │
│         ↓                   │
│  3. If final_answer:        │
│     → emit answer node      │
│     → HITL checkpoint       │◄── user accept/revise/continue
│     → end or continue       │
└─────────────────────────────┘
```

Key design points:
- Maintains `messages: ChatMessage[]` context, appending assistant replies and tool results each round
- LLM calls use OpenAI Chat Completions format with `tools` parameter
- Max step limit (e.g., 20 steps) to prevent infinite loops
- Each step produces standardized events via existing SSE channel

## Section 2: Tool System

### Tool Interface

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;        // OpenAI function calling format
  requiresApproval: boolean;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolResult {
  success: boolean;
  output: string;
  artifacts?: Artifact[];
}
```

### Built-in Tools (Phase 1)

| Tool | Description | Requires Approval |
|------|-------------|-------------------|
| `read_file` | Read project file content | No |
| `list_files` | List directory structure | No |
| `write_file` | Write/create files | **Yes** |

### Safety Boundaries

- All tool operations restricted to user-specified project directory (sandbox root)
- `run_command` (Phase 2) will have command whitelist/blacklist
- `requiresApproval: true` tools must pass HITL checkpoint before execution

### LLM Integration

- All tools converted to OpenAI `tools` parameter format when calling LLM
- When LLM returns `tool_calls`, AgentLoop processes each: check approval → execute → collect results → append to messages

## Section 3: HITL Mechanism

### Automatic Checkpoints

AgentLoop pauses automatically at these points:

| Trigger | Condition | User Options |
|---------|-----------|--------------|
| Tool approval | `requiresApproval: true` tool called | approve / reject / modify_args |
| Plan confirmation | LLM outputs multi-step plan (configurable) | accept / revise |
| Final answer | AgentLoop completes | accept / revise / continue |
| Error recovery | Tool execution fails | retry / skip / abort |

Implementation:
- AgentLoop uses a `Promise` + `resolve` pair to pause the loop
- `hitl_required` event pushed to frontend with `checkpointId` and `context`
- User submits decision via `POST /runs/:id/intervene`, RunManager calls `resolve` to resume

### User Active Intervention (Phase 2)

| Action | Effect |
|--------|--------|
| inject_message | Inject a user message into LLM context, effective on next think |
| pause | Pause the loop, await further instructions |
| abort | Terminate the entire run |
| modify_goal | Modify original prompt, agent perceives change on next think |

Implementation:
- `POST /runs/:id/interrupt` endpoint
- AgentLoop checks `interruptQueue` at the start of each loop iteration

### Frontend HITL Panel

Context-aware panel replacing current button group:
- Tool approval checkpoint: show tool name, parameters (editable), approve/reject buttons
- Final answer checkpoint: show accept/revise/continue
- Persistent input bar at bottom for active intervention
- Abort button always visible during agent run

## Section 4: Event Protocol & DAG Node Model

### Extended Node Roles

| Role | Meaning | Color |
|------|---------|-------|
| `thinking` | LLM reasoning process | teal |
| `tool_call` | Tool call request with args | blue |
| `tool_result` | Tool execution result | purple |
| `answer` | Final or intermediate answer | green |
| `hitl` | Human intervention record | orange |
| `error` | Error node | red |

### New Event Types

```typescript
| { type: "tool_requested"; nodeId: string; toolName: string; args: Record<string, unknown> }
| { type: "tool_executed"; nodeId: string; toolName: string; result: ToolResult }
| { type: "hitl_decision"; checkpointId: string; decision: string; modifications?: unknown }
| { type: "interrupt_received"; interruptType: string; content?: string }
| { type: "loop_step"; step: number; maxSteps: number }
```

### DAG Structure Example

```
[thinking n1] "User wants me to read and modify config.ts..."
    │
    ├──→ [tool_call n2] read_file("src/config.ts")
    │        │
    │        └──→ [tool_result n3] "export const PORT = 3000..."
    │
[thinking n4] "Need to change port to 8080, calling edit_file..."
    │
    ├──→ [tool_call n5] edit_file("src/config.ts", ...) ⏸ awaiting approval
    │        │
    │        ├──→ [hitl n6] "User approved, no parameter changes"
    │        │
    │        └──→ [tool_result n7] "File updated"
    │
[answer n8] "Changed port from 3000 to 8080" ⏸ awaiting confirmation
```

### DAG Layout Changes

- **Vertical main axis**: thinking nodes flow top-to-bottom (timeline)
- **Horizontal branches**: each thinking's tool_call → tool_result as right-side branch
- hitl nodes attach beside their corresponding checkpoint node

### GraphNode Extensions

```typescript
interface GraphNode {
  // ...existing fields
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: ToolResult;
  step?: number;
}
```

## Section 5: Server Module Restructure

### File Structure

```
apps/server/src/
├── index.ts              # HTTP routes (add /interrupt endpoint)
├── runManager.ts         # Run lifecycle (simplified: strip agent logic)
├── agentLoop.ts          # [NEW] Core loop: think → act → observe
├── llmClient.ts          # [RENAME] from openaiAdapter.ts, support tool_calls
├── tools/
│   ├── registry.ts       # [NEW] Tool registration and lookup
│   ├── types.ts          # [NEW] Tool / ToolResult interfaces
│   ├── readFile.ts       # [NEW]
│   ├── listFiles.ts      # [NEW]
│   └── writeFile.ts      # [NEW]
└── hitl.ts               # [NEW] Checkpoint management + interrupt queue
```

### Module Responsibilities

**`agentLoop.ts`** (~200 lines)
- Maintains `messages[]` context
- Loop: call LLM → parse response → dispatch to tool or finish
- Emits events to RunManager at each step
- Checks `hitl.interruptQueue` at loop start
- Before tool execution, checks `tool.requiresApproval` → if yes, calls `hitl.awaitCheckpoint()`

**`llmClient.ts`** (from openaiAdapter.ts)
- Retains multi-provider support (OpenAI/DeepSeek/compatible APIs)
- `generate()` returns structured response (`text` + `tool_calls[]`), not just string
- Remove Claude CLI spawn logic (re-add later as separate adapter)
- Streams thinking content deltas

**`hitl.ts`**
- `awaitCheckpoint(context)`: create checkpoint, return Promise, pause caller
- `resolveCheckpoint(id, decision, modifications)`: resolve on user decision
- `enqueueInterrupt(type, content)`: receive user active intervention
- `drainInterrupts()`: AgentLoop calls each round, drain and clear queue

**`runManager.ts`** (simplified)
- Only manages Run creation/lookup/cleanup, SSE client management, event broadcast
- No longer contains agent execution logic (all moved to agentLoop)
- `startRun()` creates `AgentLoop` instance and starts it

**`index.ts`** (add routes)
- `POST /runs/:id/interrupt` — user active intervention
- Existing routes mostly unchanged

### Shared Package Changes

```
packages/shared/src/
├── events.ts    # Extend NodeRole, AgentEvent types
├── reducer.ts   # Extend applyEvent for new events
└── index.ts     # Unchanged
```

## Section 6: Frontend Changes

### Component Structure

```
apps/web/src/
├── App.vue                    # New layout: three-region
├── components/
│   ├── DagCanvas.vue          # New node types + vertical layout
│   ├── HitlPanel.vue          # [NEW] Context-aware HITL panel
│   ├── ToolCallCard.vue       # [NEW] Tool call detail card
│   └── InterruptBar.vue       # [NEW] (Phase 2) Persistent interrupt input
├── stores/agentRun.ts         # Add interrupt action
├── services/sse.ts            # Add new event types + interrupt API
└── styles.css
```

### Page Layout

```
┌──────────────────────────────────────────────┐
│  Header: title + Start button + Abort button │
├──────────────────────────────┬───────────────┤
│                              │               │
│   DAG Canvas                 │  Detail       │
│   (main view, vertical)      │  Panel        │
│                              │  (click node) │
│                              │               │
├──────────────────────────────┴───────────────┤
│  HITL Panel (appears on checkpoint)          │
│  ┌─────────────────────────────────────────┐ │
│  │ ⚠ write_file("config.ts", ...)         │ │
│  │ [param editor]  [Approve] [Reject]      │ │
│  └─────────────────────────────────────────┘ │
├──────────────────────────────────────────────┤
│  Interrupt Bar: [input...] [Send] [Pause]    │
└──────────────────────────────────────────────┘
```

### DagCanvas Changes

- Main axis: vertical (top-to-bottom thinking timeline)
- tool_call → tool_result as horizontal right-side branches
- hitl nodes with distinct style (dashed border, orange)
- Node cards show different content by role:
  - `thinking`: LLM reasoning text (streaming)
  - `tool_call`: tool name + args summary, pulse animation when awaiting approval
  - `tool_result`: execution result summary
  - `answer`: highlighted final answer

### HitlPanel Context Awareness

| Checkpoint Type | Panel Content |
|-----------------|---------------|
| Tool approval | Tool name, args JSON (editable), Approve/Reject |
| Final answer | Answer content, Accept/Revise/Continue |
| Error recovery | Error info, Retry/Skip/Abort |

### Store Changes

`agentRun.ts` additions:
- `interrupt(type, content)` action — calls `/runs/:id/interrupt`
- `currentCheckpoint` getter — current unresolved checkpoint with context
- `stepCount` getter — current step count

## Section 7: Phasing

### Phase 1 (MVP) — This Implementation

**Includes:**
- `agentLoop.ts` — complete think → act → observe loop
- `llmClient.ts` — LLM client with tool_calls support
- 2 read-only tools: `read_file`, `list_files`
- 1 write tool: `write_file` (requires approval)
- HITL automatic checkpoints: tool approval + final answer confirmation
- Frontend: vertical DAG, new node types, HitlPanel (tool approval + answer confirmation)
- Fix existing revise bug (answer double-accumulation in `executeInitial`)

**Excludes:**
- `edit_file`, `run_command` (Phase 2)
- User active intervention / interrupt (Phase 2)
- StepTimeline sidebar (Phase 2)
- Claude Code CLI read-only adapter (Phase 3)
- Custom tool configuration (Phase 3)

### Phase 2

- Complete tool set (search_code, edit_file, run_command)
- InterruptBar + active intervention (pause/abort/inject_message/modify_goal)
- StepTimeline sidebar
- Plan confirmation checkpoint
- Error recovery checkpoint

### Phase 3

- Claude Code CLI adapter (read-only visualization mode)
- Universal agent protocol abstraction (adapter interface)
- Custom tool configuration files
- Event persistence and replay

## File Change Manifest (Phase 1)

| Action | File |
|--------|------|
| New | `apps/server/src/agentLoop.ts` |
| New | `apps/server/src/hitl.ts` |
| New | `apps/server/src/tools/types.ts` |
| New | `apps/server/src/tools/registry.ts` |
| New | `apps/server/src/tools/readFile.ts` |
| New | `apps/server/src/tools/listFiles.ts` |
| New | `apps/server/src/tools/writeFile.ts` |
| New | `apps/web/src/components/HitlPanel.vue` |
| New | `apps/web/src/components/ToolCallCard.vue` |
| Modify | `apps/server/src/openaiAdapter.ts` → `llmClient.ts` |
| Modify | `apps/server/src/runManager.ts` |
| Modify | `apps/server/src/index.ts` |
| Modify | `packages/shared/src/events.ts` |
| Modify | `packages/shared/src/reducer.ts` |
| Modify | `apps/web/src/App.vue` |
| Modify | `apps/web/src/components/DagCanvas.vue` |
| Modify | `apps/web/src/stores/agentRun.ts` |
| Modify | `apps/web/src/services/sse.ts` |
