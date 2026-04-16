# Codebase Quality Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply 12 targeted improvements to type safety, code deduplication, security, DX, and robustness across the monorepo.

**Architecture:** Incremental changes — each task is self-contained, commits independently, and doesn't break existing functionality. Tasks are ordered so earlier changes don't conflict with later ones.

**Tech Stack:** TypeScript, Node.js, Vue 3, Pinia, Vitest

---

### Task 1: Fix emit type safety — remove `as any` from `emitEvent`

**Files:**
- Modify: `packages/shared/src/events.ts:16-64` (add `EmitPayload` type)
- Modify: `apps/server/src/agentLoop.ts:7` (use `EmitPayload`)
- Modify: `apps/server/src/claudeLoop.ts:5` (use `EmitPayload`)
- Modify: `apps/server/src/runManager.ts:71-73,143` (use `EmitPayload`, remove `as any`)

- [ ] **Step 1: Define `EmitPayload` union type in shared events**

In `packages/shared/src/events.ts`, add after the `AgentEvent` type (before `HitlContext`):

```ts
/** Payload for emitting events — BaseEvent fields are added by RunManager */
export type EmitPayload =
  | { type: "run_started"; provider?: "api" | "claude" }
  | {
      type: "node_created";
      nodeId: string;
      parentId?: string;
      role: NodeRole;
      content: string;
      status?: NodeStatus;
      toolName?: string;
      toolArgs?: Record<string, unknown>;
    }
  | {
      type: "node_updated";
      nodeId: string;
      patch: Partial<Pick<GraphNode, "content" | "status">>;
    }
  | {
      type: "edge_created";
      from: string;
      to: string;
      kind: "plan" | "depends" | "calls" | "tool";
    }
  | {
      type: "hitl_required";
      checkpointId: string;
      nodeId: string;
      options: string[];
      context?: HitlContext;
    }
  | {
      type: "hitl_applied";
      checkpointId: string;
      decision: string;
      note?: string;
      modifications?: Record<string, unknown>;
    }
  | {
      type: "tool_executed";
      nodeId: string;
      toolName: string;
      result: ToolResultData;
    }
  | { type: "loop_step"; step: number; maxSteps: number }
  | { type: "run_finished"; status: "success" | "failed" | "aborted" };
```

- [ ] **Step 2: Export `EmitPayload` from shared index**

In `packages/shared/src/index.ts`, add `EmitPayload` to the exports.

- [ ] **Step 3: Update `EmitFn` in agentLoop.ts**

Replace line 7 in `apps/server/src/agentLoop.ts`:

```ts
// Old:
type EmitFn = (event: Record<string, unknown> & { type: string }) => void;

// New:
import type { EmitPayload } from "@acv/shared";
type EmitFn = (event: EmitPayload) => void;
```

Also update the import on line 1 to add `EmitPayload`:

```ts
import type { AgentEvent, HitlContext, EmitPayload } from "@acv/shared";
```

Wait — `EmitPayload` is imported separately via the `type EmitFn` line. Just replace line 7:

```ts
type EmitFn = (event: import("@acv/shared").EmitPayload) => void;
```

Or cleaner — add to the existing import and define inline:

```ts
import type { HitlContext, EmitPayload } from "@acv/shared";
type EmitFn = (event: EmitPayload) => void;
```

(Remove `AgentEvent` from import since it's not used in agentLoop.ts.)

- [ ] **Step 4: Update `EmitFn` in claudeLoop.ts**

Replace line 5 in `apps/server/src/claudeLoop.ts`:

```ts
// Old:
type EmitFn = (event: Record<string, unknown> & { type: string }) => void;

// New:
import type { EmitPayload } from "@acv/shared";
type EmitFn = (event: EmitPayload) => void;
```

Update line 3 import: keep `HitlContext` from `@acv/shared`, add `EmitPayload`.

- [ ] **Step 5: Update RunManager to use EmitPayload — remove `as any`**

In `apps/server/src/runManager.ts`:

Line 2 import — add `EmitPayload`:
```ts
import type { AgentEvent, EmitPayload } from "@acv/shared";
```

Lines 71-73 — fix the emit wrapper:
```ts
// Old:
const emit = (event: Record<string, unknown> & { type: string }) => {
  this.emitEvent(runId, event as any);
};

// New:
const emit = (event: EmitPayload) => {
  this.emitEvent(runId, event);
};
```

Line 143 — update `emitEvent` signature:
```ts
// Old:
private emitEvent(runId: string, event: Record<string, unknown> & { type: string }) {

// New:
private emitEvent(runId: string, event: EmitPayload) {
```

Line 83 — fix the direct `emitEvent` call:
```ts
// Old:
this.emitEvent(runId, { type: "run_finished", status: "failed" });
// This already matches EmitPayload, so no change needed.
```

- [ ] **Step 6: Run TypeScript check**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/src/index.ts apps/server/src/agentLoop.ts apps/server/src/claudeLoop.ts apps/server/src/runManager.ts
git commit -m "refactor: add EmitPayload type to replace as-any emit casts"
```

---

### Task 2: Extract shared HITL answer decision handler

**Files:**
- Create: `apps/server/src/hitlDecision.ts`
- Modify: `apps/server/src/agentLoop.ts:117-196`
- Modify: `apps/server/src/claudeLoop.ts:115-226`

- [ ] **Step 1: Create `hitlDecision.ts` with shared handler**

Create `apps/server/src/hitlDecision.ts`:

```ts
import type { HitlContext, EmitPayload } from "@acv/shared";
import type { HitlController, CheckpointResult } from "./hitl";

type EmitFn = (event: EmitPayload) => void;
type NextNodeIdFn = () => string;

export interface AnswerDecisionResult {
  action: "finish" | "continue" | "revise" | "unknown";
  userMessage?: string;
}

/**
 * Shared logic for handling answer_review HITL checkpoint:
 * emits checkpoint, waits for decision, emits decision nodes.
 * Returns the action and optional user message for the loop to act on.
 */
export async function handleAnswerDecision(opts: {
  answerNodeId: string;
  hitl: HitlController;
  emit: EmitFn;
  nextNodeId: NextNodeIdFn;
  answer: string;
}): Promise<{ decision: CheckpointResult; hitlNodeId: string }> {
  const { answerNodeId, hitl, emit, nextNodeId, answer } = opts;

  const ctx: HitlContext = { kind: "answer_review", answer };
  const { checkpointId, promise } = hitl.awaitCheckpoint(ctx);
  emit({
    type: "hitl_required",
    checkpointId,
    nodeId: answerNodeId,
    options: ["continue", "revise", "finish"],
    context: ctx,
  });

  const decision = await promise;
  emit({
    type: "hitl_applied",
    checkpointId,
    decision: decision.decision,
    note: decision.note,
  });

  emit({ type: "node_updated", nodeId: answerNodeId, patch: { status: "done" } });

  const hitlNodeId = nextNodeId();
  const label =
    decision.decision === "finish" ? "Finish"
    : decision.decision === "continue" ? "Continue"
    : decision.decision === "revise" ? "Revise"
    : decision.decision;

  const noteText = decision.decision === "finish"
    ? (decision.note ? `\n${decision.note}` : "")
    : decision.decision === "continue"
    ? `\n${decision.note || "I agree with your reasoning and support your recommendation. Please proceed and execute everything as proposed."}`
    : decision.decision === "revise"
    ? `\n${decision.note || "Please revise your answer and improve it."}`
    : (decision.note ? `\n${decision.note}` : "");

  emit({
    type: "node_created",
    nodeId: hitlNodeId,
    parentId: answerNodeId,
    role: "hitl",
    content: `User: ${label}${noteText}`,
    status: "done",
  });
  emit({ type: "edge_created", from: answerNodeId, to: hitlNodeId, kind: "depends" });

  return { decision, hitlNodeId };
}
```

- [ ] **Step 2: Refactor `agentLoop.ts` to use shared handler**

In `apps/server/src/agentLoop.ts`, add import:

```ts
import { handleAnswerDecision } from "./hitlDecision";
```

Replace lines 117-196 (the answer + HITL block inside the `if (response.toolCalls.length === 0)` block) with:

```ts
        // 2. If no tool calls → final answer
        if (response.toolCalls.length === 0) {
          const answerNodeId = this.nextNodeId();
          emit({
            type: "node_created",
            nodeId: answerNodeId,
            parentId: thinkNodeId,
            role: "answer",
            content: response.text || "(empty)",
            status: "waiting_human",
          });
          emit({ type: "edge_created", from: thinkNodeId, to: answerNodeId, kind: "depends" });

          const { decision, hitlNodeId } = await handleAnswerDecision({
            answerNodeId,
            hitl: this.opts.hitl,
            emit,
            nextNodeId: () => this.nextNodeId(),
            answer: response.text || "",
          });

          if (decision.decision === "finish") {
            emit({ type: "run_finished", status: "success" });
            return;
          }

          if (decision.decision === "continue") {
            const followUp = decision.note || "I agree with your reasoning and support your recommendation. Please proceed and execute everything as proposed.";
            this.messages.push({ role: "user", content: followUp });
            continue;
          }

          if (decision.decision === "revise") {
            const feedback = decision.note || "Please revise your answer and improve it.";
            this.messages.push({ role: "user", content: feedback });
            continue;
          }
        }
```

- [ ] **Step 3: Refactor `claudeLoop.ts` to use shared handler**

In `apps/server/src/claudeLoop.ts`, add import:

```ts
import { handleAnswerDecision } from "./hitlDecision";
```

Replace the body of `answerCheckpointLoop` (lines 83-226) with:

```ts
  private async answerCheckpointLoop(answerText: string): Promise<void> {
    const { emit, hitl } = this.opts;
    let currentAnswer = answerText;

    while (true) {
      const answerNodeId = this.nextNodeId();
      emit({
        type: "node_created",
        nodeId: answerNodeId,
        parentId: this.lastParentNodeId ?? undefined,
        role: "answer",
        content: currentAnswer,
        status: "waiting_human",
      });
      if (this.lastParentNodeId) {
        emit({ type: "edge_created", from: this.lastParentNodeId, to: answerNodeId, kind: "depends" });
      }

      const { decision, hitlNodeId } = await handleAnswerDecision({
        answerNodeId,
        hitl,
        emit,
        nextNodeId: () => this.nextNodeId(),
        answer: currentAnswer,
      });

      if (decision.decision === "finish") {
        emit({ type: "run_finished", status: "success" });
        return;
      }

      this.lastParentNodeId = hitlNodeId;
      this.currentThinkNodeId = null;
      this.currentThinkText = "";
      this.finalText = "";

      const userMsg = decision.decision === "continue"
        ? (decision.note || "I agree with your reasoning and support your recommendation. Please proceed and execute everything as proposed.")
        : (decision.note || "Please improve your answer.");

      const prompt = decision.decision === "continue"
        ? `Previous result:\n${currentAnswer}\n\nUser instruction:\n${userMsg}\n\nPlease continue based on the instruction above.`
        : `Previous answer:\n${currentAnswer}\n\nUser feedback:\n${userMsg}\n\nPlease revise your answer based on the feedback above.`;

      try {
        await this.spawnClaude(prompt);
        this.finalizeThinkingNode();
        currentAnswer = this.finalText || "(empty response)";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: "node_created",
          nodeId: this.nextNodeId(),
          role: "error",
          content: `${decision.decision === "continue" ? "Continue" : "Revision"} failed: ${msg}`,
          status: "error",
        });
        emit({ type: "run_finished", status: "failed" });
        return;
      }
    }
  }
```

- [ ] **Step 4: Run TypeScript check**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: No type errors.

- [ ] **Step 5: Run tests**

Run: `cd E:/Agent-Canvas-Visualizer && npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/hitlDecision.ts apps/server/src/agentLoop.ts apps/server/src/claudeLoop.ts
git commit -m "refactor: extract shared HITL answer decision handler"
```

---

### Task 3: Fix Windows dev script with concurrently

**Files:**
- Modify: `package.json:10` (root)

- [ ] **Step 1: Install concurrently**

Run: `cd E:/Agent-Canvas-Visualizer && npm install -D concurrently`

- [ ] **Step 2: Update root dev script**

In `package.json`, replace the dev script:

```json
"dev": "concurrently \"npm:dev:server\" \"npm:dev:web\""
```

- [ ] **Step 3: Verify dev starts both processes**

Run: `cd E:/Agent-Canvas-Visualizer && npm run dev` (then Ctrl+C after both start)
Expected: Both server and web dev processes start and their output is interleaved.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "fix: use concurrently for Windows-compatible dev script"
```

---

### Task 4: Fix SSE error handling — report connection status

**Files:**
- Modify: `apps/web/src/services/sse.ts:77-79`
- Modify: `apps/web/src/stores/agentRun.ts` (add connection state)

- [ ] **Step 1: Add connection error callback to `connectRunStream`**

In `apps/web/src/services/sse.ts`, change the `connectRunStream` signature and error handler:

```ts
export function connectRunStream(
  runId: string,
  onEvent: (e: AgentEvent) => void,
  onError?: () => void,
) {
  const source = new EventSource(`${API_BASE}/runs/${runId}/stream`);
  // ... existing event listeners ...

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      onError?.();
    }
  };

  return source;
}
```

- [ ] **Step 2: Handle connection errors in store**

In `apps/web/src/stores/agentRun.ts`, update the `startRun` function:

```ts
  const connectionError = ref(false);

  async function startRun(prompt: string, projectPath?: string) {
    closeStream();
    graph.value = createInitialGraphState();
    connectionError.value = false;
    const runId = await startRunRequest(prompt, projectPath);
    activeRunId = runId;
    currentSource = connectRunStream(runId, enqueue, () => {
      connectionError.value = true;
    });
  }
```

Add `connectionError` to the return object.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/sse.ts apps/web/src/stores/agentRun.ts
git commit -m "fix: report SSE connection errors to store instead of swallowing"
```

---

### Task 5: Add graceful shutdown to server

**Files:**
- Modify: `apps/server/src/index.ts` (add signal handlers)

- [ ] **Step 1: Add shutdown handlers after `server.listen`**

Append to `apps/server/src/index.ts`, after `server.listen(...)`:

```ts
function shutdown() {
  console.log("[acv-server] shutting down...");
  manager.destroy();
  server.close(() => process.exit(0));
  // Force exit after 5s if server.close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat: add graceful shutdown on SIGTERM/SIGINT"
```

---

### Task 6: Add concurrent run limit

**Files:**
- Modify: `apps/server/src/runManager.ts` (add limit check)

- [ ] **Step 1: Add MAX_CONCURRENT_RUNS and check in startRun**

In `apps/server/src/runManager.ts`, add constant after `CLEANUP_INTERVAL_MS`:

```ts
const MAX_CONCURRENT_RUNS = 5;
```

Add check at the start of `startRun`:

```ts
  startRun(runId: string, prompt: string, projectPath?: string) {
    const activeCount = [...this.runs.values()].filter(r => !r.finishedAt).length;
    if (activeCount >= MAX_CONCURRENT_RUNS) {
      throw new Error(`Max concurrent runs (${MAX_CONCURRENT_RUNS}) reached`);
    }
    // ... existing code
  }
```

- [ ] **Step 2: Handle the error in index.ts POST /runs handler**

In `apps/server/src/index.ts`, wrap `manager.startRun(...)` in try/catch:

```ts
    try {
      manager.startRun(runId, prompt, projectPath);
    } catch (err) {
      res.writeHead(429, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    res.writeHead(201, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ runId }));
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/runManager.ts apps/server/src/index.ts
git commit -m "feat: limit concurrent runs to prevent resource exhaustion"
```

---

### Task 7: Improve path traversal check with realpath

**Files:**
- Modify: `apps/server/src/tools/readFile.ts:18-22`
- Modify: `apps/server/src/tools/writeFile.ts:18-22`

- [ ] **Step 1: Update readFile.ts path check**

In `apps/server/src/tools/readFile.ts`, add `realpath` to import and update the check:

```ts
import { readFile, realpath } from "node:fs/promises";
```

Replace the sandbox check (lines 18-22):

```ts
    async execute(args) {
      const filePath = resolve(sandboxRoot, String(args.path));
      const rel = relative(sandboxRoot, filePath);
      if (rel.startsWith("..") || resolve(sandboxRoot, rel) !== filePath) {
        return { success: false, output: "Path escapes sandbox root" };
      }
      try {
        const realSandbox = await realpath(sandboxRoot);
        const realFile = await realpath(filePath);
        if (!realFile.startsWith(realSandbox)) {
          return { success: false, output: "Path escapes sandbox root (symlink)" };
        }
        const content = await readFile(filePath, "utf-8");
        const truncated = content.length > 10000 ? content.slice(0, 10000) + "\n...(truncated)" : content;
        return { success: true, output: truncated };
      } catch (err) {
        return { success: false, output: `Failed to read file: ${(err as Error).message}` };
      }
    },
```

- [ ] **Step 2: Update writeFile.ts path check**

In `apps/server/src/tools/writeFile.ts`, add `realpath` to import:

```ts
import { writeFile, mkdir, realpath } from "node:fs/promises";
```

Replace the sandbox check:

```ts
    async execute(args) {
      const filePath = resolve(sandboxRoot, String(args.path));
      const rel = relative(sandboxRoot, filePath);
      if (rel.startsWith("..") || resolve(sandboxRoot, rel) !== filePath) {
        return { success: false, output: "Path escapes sandbox root" };
      }
      try {
        await mkdir(dirname(filePath), { recursive: true });
        // Check realpath after mkdir to resolve any symlinks
        const realSandbox = await realpath(sandboxRoot);
        const realDir = await realpath(dirname(filePath));
        if (!realDir.startsWith(realSandbox)) {
          return { success: false, output: "Path escapes sandbox root (symlink)" };
        }
        await writeFile(filePath, String(args.content), "utf-8");
        return { success: true, output: `Written ${rel} (${String(args.content).length} chars)` };
      } catch (err) {
        return { success: false, output: `Failed to write file: ${(err as Error).message}` };
      }
    },
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/tools/readFile.ts apps/server/src/tools/writeFile.ts
git commit -m "security: add realpath check to prevent symlink-based path traversal"
```

---

### Task 8: Remove `shell: true` from Claude CLI spawn

**Files:**
- Modify: `apps/server/src/claudeLoop.ts:247-252`

- [ ] **Step 1: Change spawn to shell: false**

In `apps/server/src/claudeLoop.ts`, line 247-252, change:

```ts
      // Old:
      this.child = spawn(this.claudeCommand, args, {
        shell: true,
        env: process.env,
        windowsHide: true,
        cwd: this.opts.cwd || undefined,
      });

      // New:
      this.child = spawn(this.claudeCommand, args, {
        shell: false,
        env: process.env,
        windowsHide: true,
        cwd: this.opts.cwd || undefined,
      });
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/claudeLoop.ts
git commit -m "security: remove shell: true from Claude CLI spawn"
```

---

### Task 9: Move App.vue inline styles to scoped CSS

**Files:**
- Modify: `apps/web/src/App.vue:85-103`

- [ ] **Step 1: Replace inline styles with CSS classes**

In `apps/web/src/App.vue`, replace the template sections with inline styles:

Replace `style="margin-bottom: 12px"` on sections with class `panel-gap`.
Replace inline styles on `<input>` and `<textarea>` with classes.

Template changes:
```html
    <section class="panel panel-gap">
      <div class="field-label">Project Path</div>
      <input
        v-model="projectPath"
        type="text"
        :disabled="isRunning"
        placeholder="Leave empty for server's working directory"
        class="field-input mono"
      />
    </section>

    <section class="panel panel-gap">
      <div class="field-label">Prompt</div>
      <textarea
        v-model="prompt"
        rows="3"
        :disabled="isRunning"
        class="field-input field-textarea"
      />
    </section>

    <section class="panel panel-gap">
      <!-- ... meta content unchanged ... -->
    </section>

    <section v-if="checkpoint" class="panel-gap">
      <!-- ... HitlPanel unchanged ... -->
    </section>
```

Add a `<style scoped>` block to `App.vue` (the file currently has no style block):

```css
<style scoped>
.panel-gap { margin-bottom: 12px; }
.field-label { font-size: 13px; color: var(--muted); margin-bottom: 6px; }
.field-input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
  font-size: 14px;
  background: var(--panel);
  color: var(--text);
}
.field-input.mono { font-family: monospace; }
.field-textarea { resize: vertical; }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/App.vue
git commit -m "refactor: move App.vue inline styles to scoped CSS"
```

---

### Task 10: CORS from environment variable

**Files:**
- Modify: `apps/server/src/index.ts:46`

- [ ] **Step 1: Read CORS origin from env**

In `apps/server/src/index.ts`, replace line 46:

```ts
// Old:
const cors = { "Access-Control-Allow-Origin": "*" };

// New:
const corsOrigin = process.env.CORS_ORIGIN || "*";
const cors = { "Access-Control-Allow-Origin": corsOrigin };
```

Also update the OPTIONS handler (line 53):

```ts
      "Access-Control-Allow-Origin": corsOrigin,
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat: make CORS origin configurable via CORS_ORIGIN env var"
```

---

### Task 11: Reduce LlmClient `any` usage

**Files:**
- Modify: `apps/server/src/llmClient.ts:65-67`

- [ ] **Step 1: Use OpenAI SDK stream type**

In `apps/server/src/llmClient.ts`, add import:

```ts
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";
```

Replace lines 64-67:

```ts
    try {
      const stream = await this.client.chat.completions.create(params as any) as unknown;

      for await (const chunk of stream as AsyncIterable<any>) {

// With:
    try {
      const stream = await this.client.chat.completions.create({
        ...params,
        stream: true,
      } as Parameters<typeof this.client.chat.completions.create>[0]) as Stream<ChatCompletionChunk>;

      for await (const chunk of stream) {
```

Also update `chatNonStream` line 121:

```ts
      const resp = await this.client.chat.completions.create({
        ...params,
        stream: false,
      } as Parameters<typeof this.client.chat.completions.create>[0]);
      const choice = resp.choices?.[0];
```

And for the non-stream tool_calls, update line 126:

```ts
      const rawToolCalls: Array<{ id: string; function: { name: string; arguments: string } }> =
        (choice?.message as any)?.tool_calls || [];

      const toolCalls: LlmToolCall[] = rawToolCalls.map((tc) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* use empty */ }
        return { id: tc.id || "", name: tc.function?.name || "", args };
      });
```

- [ ] **Step 2: Run TypeScript check**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/llmClient.ts
git commit -m "refactor: reduce any usage in LlmClient with proper OpenAI SDK types"
```

---

### Task 12: Extract DagCanvas layout into composable

**Files:**
- Create: `apps/web/src/composables/useLayout.ts`
- Modify: `apps/web/src/components/DagCanvas.vue`

- [ ] **Step 1: Create `useLayout.ts` composable**

Create `apps/web/src/composables/useLayout.ts`:

```ts
import { computed, type Ref } from "vue";
import type { GraphEdge, GraphNode } from "@acv/shared";

export type LayoutNode = GraphNode & {
  x: number;
  y: number;
  width: number;
  height: number;
  header: string;
  lines: string[];
  truncated: boolean;
  totalLines: number;
  fillColor: string;
  statusColor: string;
};

export type LayoutEdge = GraphEdge & {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

const PREVIEW_LINES = 6;
const MAX_CHARS_PER_LINE = 44;
const NODE_WIDTH = 360;
const NODE_GAP_Y = 24;
const BRANCH_GAP_X = 56;

export function roleColor(role: GraphNode["role"]): string {
  switch (role) {
    case "thinking": return "#0f766e";
    case "tool_call": return "#1d4ed8";
    case "tool_result": return "#7c3aed";
    case "answer": return "#16a34a";
    case "hitl": return "#ea580c";
    case "error": return "#dc2626";
    default: return "#6b7280";
  }
}

export function roleLabel(role: GraphNode["role"]): string {
  switch (role) {
    case "thinking": return "Thinking";
    case "tool_call": return "Tool Call";
    case "tool_result": return "Result";
    case "answer": return "Answer";
    case "hitl": return "HITL";
    case "error": return "Error";
    default: return String(role);
  }
}

export function statusIndicator(status: GraphNode["status"]): string {
  switch (status) {
    case "streaming": return "#facc15";
    case "done": return "#22c55e";
    case "error": return "#ef4444";
    case "waiting_human": return "#f97316";
    default: return "#94a3b8";
  }
}

function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars));
  return out;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function nodeHeight(n: GraphNode): number {
  const rawLines = (n.content || "").split(/\r?\n/);
  const allWrapped = rawLines.flatMap((l) => wrapLine(l, MAX_CHARS_PER_LINE));
  const lineCount = Math.min(allWrapped.length, PREVIEW_LINES + 1);
  return 40 + Math.max(lineCount, 1) * 16 + 14;
}

export function useLayout(nodes: Ref<GraphNode[]>, edges: Ref<GraphEdge[]>) {
  const layout = computed(() => {
    const mainRoles = new Set(["thinking", "answer", "error"]);
    const mainCol: GraphNode[] = [];
    const branches = new Map<string, GraphNode[]>();

    for (const n of nodes.value) {
      if (mainRoles.has(n.role)) {
        mainCol.push(n);
      } else if (n.parentId) {
        const list = branches.get(n.parentId) || [];
        list.push(n);
        branches.set(n.parentId, list);
      } else {
        mainCol.push(n);
      }
    }

    const posMap = new Map<string, { x: number; y: number }>();
    let cursorY = 24;
    const mainX = 32;

    for (const n of mainCol) {
      posMap.set(n.id, { x: mainX, y: cursorY });
      const h = nodeHeight(n);

      const branchNodes = branches.get(n.id) || [];
      let branchY = cursorY;
      for (const bn of branchNodes) {
        const bx = mainX + NODE_WIDTH + BRANCH_GAP_X;
        posMap.set(bn.id, { x: bx, y: branchY });

        const subBranch = branches.get(bn.id) || [];
        let subY = branchY;
        for (const sbn of subBranch) {
          const sx = bx + NODE_WIDTH + BRANCH_GAP_X;
          posMap.set(sbn.id, { x: sx, y: subY });
          subY += nodeHeight(sbn) + NODE_GAP_Y;
        }
        branchY += Math.max(nodeHeight(bn), subY - branchY) + NODE_GAP_Y;
      }

      cursorY += Math.max(h, branchY - cursorY) + NODE_GAP_Y;
    }

    const layoutNodes: LayoutNode[] = nodes.value.map((n) => {
      const pos = posMap.get(n.id) || { x: mainX, y: 24 };
      const statusLabel = n.status === "streaming" ? "streaming..."
        : n.status === "waiting_human" ? "waiting"
        : n.status;
      const header = `${roleLabel(n.role)} · ${statusLabel}`;
      const rawLines = (n.content || "").split(/\r?\n/);
      const allWrapped = rawLines.flatMap((l) => wrapLine(l, MAX_CHARS_PER_LINE));
      const totalLines = allWrapped.length;
      const truncated = allWrapped.length > PREVIEW_LINES;
      const lines = truncated
        ? [...allWrapped.slice(0, PREVIEW_LINES), `... ${totalLines} lines total`]
        : allWrapped;

      const longest = Math.max(header.length, ...lines.map((l) => l.length), 12);
      const width = clamp(26 + longest * 7.2, 200, NODE_WIDTH);
      const height = 40 + Math.max(lines.length, 1) * 16 + 14;

      return {
        ...n,
        x: pos.x,
        y: pos.y,
        width,
        height,
        header,
        lines,
        truncated,
        totalLines,
        fillColor: roleColor(n.role),
        statusColor: statusIndicator(n.status),
      };
    });

    const nodePos = new Map(layoutNodes.map((nd) => [nd.id, nd]));
    const layoutEdges: LayoutEdge[] = edges.value
      .map((e) => {
        const from = nodePos.get(e.from);
        const to = nodePos.get(e.to);
        if (!from || !to) return null;
        const isHorizontal = Math.abs(from.x - to.x) > NODE_WIDTH / 2;
        return {
          ...e,
          x1: isHorizontal ? from.x + from.width : from.x + from.width / 2,
          y1: isHorizontal ? from.y + from.height / 2 : from.y + from.height,
          x2: isHorizontal ? to.x : to.x + to.width / 2,
          y2: isHorizontal ? to.y + to.height / 2 : to.y,
        };
      })
      .filter((e): e is LayoutEdge => Boolean(e));

    const svgWidth = Math.max(980, ...layoutNodes.map((nd) => nd.x + nd.width + 40));
    const svgHeight = Math.max(620, ...layoutNodes.map((nd) => nd.y + nd.height + 40));

    return { nodes: layoutNodes, edges: layoutEdges, svgWidth, svgHeight };
  });

  return layout;
}

export function edgePath(e: LayoutEdge): string {
  const dx = Math.abs(e.x2 - e.x1);
  const dy = Math.abs(e.y2 - e.y1);

  if (dx > dy) {
    const cp = Math.max(dx * 0.4, 30);
    return `M ${e.x1} ${e.y1} C ${e.x1 + cp} ${e.y1}, ${e.x2 - cp} ${e.y2}, ${e.x2} ${e.y2}`;
  } else {
    const cp = Math.max(dy * 0.4, 20);
    return `M ${e.x1} ${e.y1} C ${e.x1} ${e.y1 + cp}, ${e.x2} ${e.y2 - cp}, ${e.x2} ${e.y2}`;
  }
}
```

- [ ] **Step 2: Simplify DagCanvas.vue to use composable**

Replace the entire `<script setup>` in `apps/web/src/components/DagCanvas.vue` with:

```ts
<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick, toRef } from "vue";
import type { GraphEdge, GraphNode } from "@acv/shared";
import {
  useLayout, edgePath, roleColor, roleLabel, statusIndicator,
  type LayoutNode, type LayoutEdge,
} from "../composables/useLayout";

const props = defineProps<{
  nodes: GraphNode[];
  edges: GraphEdge[];
}>();

const selectedNodeId = ref<string | null>(null);
const dagContainerRef = ref<HTMLElement | null>(null);

const selectedNode = computed(() => {
  if (!selectedNodeId.value) return null;
  return props.nodes.find((n) => n.id === selectedNodeId.value) ?? null;
});

function selectNode(id: string) {
  selectedNodeId.value = selectedNodeId.value === id ? null : id;
}

function closeDetail() {
  selectedNodeId.value = null;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && selectedNodeId.value) closeDetail();
}

onMounted(() => document.addEventListener("keydown", onKeyDown));
onUnmounted(() => document.removeEventListener("keydown", onKeyDown));

const prevNodeCount = ref(0);
watch(
  () => props.nodes.length,
  (count) => {
    if (count > prevNodeCount.value && dagContainerRef.value) {
      nextTick(() => {
        const el = dagContainerRef.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
    prevNodeCount.value = count;
  },
);

const layout = useLayout(
  toRef(props, "nodes"),
  toRef(props, "edges"),
);
</script>
```

The template and styles remain unchanged.

- [ ] **Step 3: Run dev to verify**

Run: `cd E:/Agent-Canvas-Visualizer && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/composables/useLayout.ts apps/web/src/components/DagCanvas.vue
git commit -m "refactor: extract DagCanvas layout logic into useLayout composable"
```
