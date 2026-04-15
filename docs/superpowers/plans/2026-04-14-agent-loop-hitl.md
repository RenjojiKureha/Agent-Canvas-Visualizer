# Agent Loop & HITL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-shot LLM call with a real agent loop (think → tool_call → tool_result → repeat) and effective HITL checkpoints.

**Architecture:** Server-side AgentLoop class maintains a message history and iterates: call LLM with tools → parse response → if tool_call, pause for HITL approval on write tools, execute, append result → repeat until final answer. Frontend renders each step as a DAG node with vertical timeline layout.

**Tech Stack:** TypeScript, Node.js HTTP server, OpenAI Chat Completions API (with tools), Vue 3 + Pinia, SSE

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/shared/src/events.ts` | Extended NodeRole, AgentEvent types (modify) |
| `packages/shared/src/reducer.ts` | Extended applyEvent for new events (modify) |
| `apps/server/src/tools/types.ts` | Tool and ToolResult interfaces |
| `apps/server/src/tools/registry.ts` | Tool registration, lookup, OpenAI schema conversion |
| `apps/server/src/tools/readFile.ts` | read_file tool implementation |
| `apps/server/src/tools/listFiles.ts` | list_files tool implementation |
| `apps/server/src/tools/writeFile.ts` | write_file tool implementation (requiresApproval) |
| `apps/server/src/hitl.ts` | Checkpoint create/resolve, interrupt queue |
| `apps/server/src/agentLoop.ts` | Core loop: think → act → observe, emits events |
| `apps/server/src/llmClient.ts` | Renamed openaiAdapter, returns structured response with tool_calls |
| `apps/web/src/components/HitlPanel.vue` | Context-aware HITL approval panel |
| `apps/web/src/components/ToolCallCard.vue` | Tool call detail card (name, args, editable) |

### Modified Files

| File | Changes |
|------|---------|
| `apps/server/src/runManager.ts` | Strip agent logic, delegate to AgentLoop |
| `apps/server/src/index.ts` | Add POST /runs/:id/interrupt route |
| `apps/web/src/services/sse.ts` | Add new event type listeners + interrupt API |
| `apps/web/src/stores/agentRun.ts` | Add interrupt action, currentCheckpoint getter |
| `apps/web/src/components/DagCanvas.vue` | New node types, vertical layout |
| `apps/web/src/App.vue` | New page layout with HitlPanel |
| `apps/web/src/styles.css` | New CSS variables and component styles |

### Deleted Files

| File | Reason |
|------|--------|
| `apps/server/src/openaiAdapter.ts` | Renamed to llmClient.ts |

---

## Task 1: Extend Shared Event Types

**Files:**
- Modify: `packages/shared/src/events.ts`

- [ ] **Step 1: Replace events.ts with extended types**

Replace the entire content of `packages/shared/src/events.ts`:

```typescript
export type NodeRole = "thinking" | "tool_call" | "tool_result" | "answer" | "hitl" | "error";
export type NodeStatus = "pending" | "streaming" | "done" | "error" | "waiting_human";

export interface BaseEvent {
  runId: string;
  eventId: string;
  seq: number;
  ts: number;
}

export interface ToolResultData {
  success: boolean;
  output: string;
}

export type AgentEvent =
  | (BaseEvent & { type: "run_started" })
  | (BaseEvent & {
      type: "node_created";
      nodeId: string;
      parentId?: string;
      role: NodeRole;
      content: string;
      status?: NodeStatus;
      toolName?: string;
      toolArgs?: Record<string, unknown>;
    })
  | (BaseEvent & {
      type: "node_updated";
      nodeId: string;
      patch: Partial<Pick<GraphNode, "content" | "status">>;
    })
  | (BaseEvent & {
      type: "edge_created";
      from: string;
      to: string;
      kind: "plan" | "depends" | "calls" | "tool";
    })
  | (BaseEvent & {
      type: "hitl_required";
      checkpointId: string;
      nodeId: string;
      options: string[];
      context?: HitlContext;
    })
  | (BaseEvent & {
      type: "hitl_applied";
      checkpointId: string;
      decision: string;
      note?: string;
      modifications?: Record<string, unknown>;
    })
  | (BaseEvent & {
      type: "tool_executed";
      nodeId: string;
      toolName: string;
      result: ToolResultData;
    })
  | (BaseEvent & {
      type: "loop_step";
      step: number;
      maxSteps: number;
    })
  | (BaseEvent & { type: "run_finished"; status: "success" | "failed" | "aborted" });

export interface HitlContext {
  kind: "tool_approval" | "answer_review" | "error_recovery";
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  answer?: string;
  errorMessage?: string;
}

export interface GraphNode {
  id: string;
  parentId?: string;
  role: NodeRole;
  content: string;
  status: NodeStatus;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  step?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "plan" | "depends" | "calls" | "tool";
}

export type RunStatus = "idle" | "streaming" | "waiting_human" | "resumed" | "finished" | "error";

export interface GraphState {
  runId?: string;
  runStatus: RunStatus;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  checkpoints: Record<string, {
    nodeId: string;
    resolved: boolean;
    decision?: string;
    context?: HitlContext;
  }>;
  lastSeq: number;
  currentStep: number;
  maxSteps: number;
}
```

- [ ] **Step 2: Verify shared package builds**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: No errors (or only errors from downstream consumers not yet updated)

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/events.ts
git commit -m "feat(shared): extend event types for agent loop and HITL"
```

---

## Task 2: Extend Shared Reducer

**Files:**
- Modify: `packages/shared/src/reducer.ts`

- [ ] **Step 1: Replace reducer.ts with extended version**

Replace the entire content of `packages/shared/src/reducer.ts`:

```typescript
import type { AgentEvent, GraphState } from "./events";

export const createInitialGraphState = (): GraphState => ({
  runStatus: "idle",
  nodes: {},
  edges: [],
  checkpoints: {},
  lastSeq: 0,
  currentStep: 0,
  maxSteps: 0,
});

export function applyEvent(state: GraphState, event: AgentEvent): GraphState {
  if (event.seq <= state.lastSeq) return state;

  const base = { ...state, runId: event.runId, lastSeq: event.seq };

  switch (event.type) {
    case "run_started":
      return { ...base, runStatus: "streaming" };

    case "node_created": {
      const newNodes = { ...base.nodes };
      newNodes[event.nodeId] = {
        id: event.nodeId,
        parentId: event.parentId,
        role: event.role,
        content: event.content,
        status: event.status ?? "streaming",
        toolName: event.toolName,
        toolArgs: event.toolArgs,
      };
      return { ...base, nodes: newNodes };
    }

    case "node_updated": {
      const existing = base.nodes[event.nodeId];
      if (!existing) return base;
      const updatedNodes = { ...base.nodes };
      updatedNodes[event.nodeId] = { ...existing, ...event.patch };
      return { ...base, nodes: updatedNodes };
    }

    case "edge_created":
      return {
        ...base,
        edges: [
          ...base.edges,
          {
            id: `${event.from}->${event.to}:${event.kind}`,
            from: event.from,
            to: event.to,
            kind: event.kind,
          },
        ],
      };

    case "hitl_required": {
      const newCheckpoints = { ...base.checkpoints };
      newCheckpoints[event.checkpointId] = {
        nodeId: event.nodeId,
        resolved: false,
        context: event.context,
      };
      const hitlNodes = { ...base.nodes };
      if (hitlNodes[event.nodeId]) {
        hitlNodes[event.nodeId] = { ...hitlNodes[event.nodeId], status: "waiting_human" };
      }
      return {
        ...base,
        runStatus: "waiting_human",
        nodes: hitlNodes,
        checkpoints: newCheckpoints,
      };
    }

    case "hitl_applied": {
      const cp = base.checkpoints[event.checkpointId];
      if (!cp) return { ...base, runStatus: "resumed" };
      const appliedCheckpoints = { ...base.checkpoints };
      appliedCheckpoints[event.checkpointId] = { ...cp, resolved: true, decision: event.decision };
      const appliedNodes = { ...base.nodes };
      const node = appliedNodes[cp.nodeId];
      if (node) appliedNodes[cp.nodeId] = { ...node, status: "streaming" };
      return {
        ...base,
        runStatus: "resumed",
        nodes: appliedNodes,
        checkpoints: appliedCheckpoints,
      };
    }

    case "tool_executed": {
      const teNodes = { ...base.nodes };
      const teNode = teNodes[event.nodeId];
      if (teNode) {
        teNodes[event.nodeId] = {
          ...teNode,
          content: event.result.output,
          status: event.result.success ? "done" : "error",
        };
      }
      return { ...base, nodes: teNodes };
    }

    case "loop_step":
      return { ...base, currentStep: event.step, maxSteps: event.maxSteps };

    case "run_finished":
      return {
        ...base,
        runStatus: event.status === "success" ? "finished" : "error",
      };

    default:
      return base;
  }
}
```

- [ ] **Step 2: Verify shared package builds**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/reducer.ts
git commit -m "feat(shared): extend reducer for new agent loop events"
```

---

## Task 3: Create Tool Types and Registry

**Files:**
- Create: `apps/server/src/tools/types.ts`
- Create: `apps/server/src/tools/registry.ts`

- [ ] **Step 1: Create tools/types.ts**

```typescript
export interface ToolResult {
  success: boolean;
  output: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  requiresApproval: boolean;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
```

- [ ] **Step 2: Create tools/registry.ts**

```typescript
import type { Tool } from "./types";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Convert all tools to OpenAI function calling format */
  toOpenAITools(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> {
    return this.all().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}
```

- [ ] **Step 3: Verify build**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: No errors from these new files

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/tools/types.ts apps/server/src/tools/registry.ts
git commit -m "feat(server): add tool types and registry"
```

---

## Task 4: Implement Built-in Tools

**Files:**
- Create: `apps/server/src/tools/readFile.ts`
- Create: `apps/server/src/tools/listFiles.ts`
- Create: `apps/server/src/tools/writeFile.ts`

- [ ] **Step 1: Create readFile.ts**

```typescript
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { Tool } from "./types";

export function createReadFileTool(sandboxRoot: string): Tool {
  return {
    name: "read_file",
    description: "Read the content of a file within the project directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file from project root" },
      },
      required: ["path"],
    },
    requiresApproval: false,
    async execute(args) {
      const filePath = resolve(sandboxRoot, String(args.path));
      const rel = relative(sandboxRoot, filePath);
      if (rel.startsWith("..") || resolve(sandboxRoot, rel) !== filePath) {
        return { success: false, output: "Path escapes sandbox root" };
      }
      try {
        const content = await readFile(filePath, "utf-8");
        const truncated = content.length > 10000 ? content.slice(0, 10000) + "\n...(truncated)" : content;
        return { success: true, output: truncated };
      } catch (err) {
        return { success: false, output: `Failed to read file: ${(err as Error).message}` };
      }
    },
  };
}
```

- [ ] **Step 2: Create listFiles.ts**

```typescript
import { readdir, stat } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import type { Tool } from "./types";

export function createListFilesTool(sandboxRoot: string): Tool {
  return {
    name: "list_files",
    description: "List files and directories within a path in the project. Returns a tree up to 2 levels deep.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory path from project root. Defaults to '.'." },
      },
      required: [],
    },
    requiresApproval: false,
    async execute(args) {
      const dirPath = resolve(sandboxRoot, String(args.path || "."));
      const rel = relative(sandboxRoot, dirPath);
      if (rel.startsWith("..") && rel !== "") {
        return { success: false, output: "Path escapes sandbox root" };
      }
      try {
        const lines = await listDir(dirPath, sandboxRoot, 0, 2);
        return { success: true, output: lines.join("\n") || "(empty directory)" };
      } catch (err) {
        return { success: false, output: `Failed to list: ${(err as Error).message}` };
      }
    },
  };
}

async function listDir(dir: string, root: string, depth: number, maxDepth: number): Promise<string[]> {
  if (depth >= maxDepth) return [];
  const entries = await readdir(dir);
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  // Filter out node_modules, .git, dist
  const filtered = entries.filter((e) => !["node_modules", ".git", "dist", ".cache"].includes(e));
  filtered.sort();

  for (const entry of filtered) {
    const fullPath = join(dir, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        lines.push(`${indent}${entry}/`);
        const sub = await listDir(fullPath, root, depth + 1, maxDepth);
        lines.push(...sub);
      } else {
        lines.push(`${indent}${entry}`);
      }
    } catch {
      lines.push(`${indent}${entry} (unreadable)`);
    }
  }
  return lines;
}
```

- [ ] **Step 3: Create writeFile.ts**

```typescript
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import type { Tool } from "./types";

export function createWriteFileTool(sandboxRoot: string): Tool {
  return {
    name: "write_file",
    description: "Write content to a file within the project directory. Creates parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file from project root" },
        content: { type: "string", description: "The content to write to the file" },
      },
      required: ["path", "content"],
    },
    requiresApproval: true,
    async execute(args) {
      const filePath = resolve(sandboxRoot, String(args.path));
      const rel = relative(sandboxRoot, filePath);
      if (rel.startsWith("..") || resolve(sandboxRoot, rel) !== filePath) {
        return { success: false, output: "Path escapes sandbox root" };
      }
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, String(args.content), "utf-8");
        return { success: true, output: `Written ${rel} (${String(args.content).length} chars)` };
      } catch (err) {
        return { success: false, output: `Failed to write file: ${(err as Error).message}` };
      }
    },
  };
}
```

- [ ] **Step 4: Verify build**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/tools/readFile.ts apps/server/src/tools/listFiles.ts apps/server/src/tools/writeFile.ts
git commit -m "feat(server): implement read_file, list_files, write_file tools"
```

---

## Task 5: Create HITL Controller

**Files:**
- Create: `apps/server/src/hitl.ts`

- [ ] **Step 1: Create hitl.ts**

```typescript
import { randomUUID } from "node:crypto";
import type { HitlContext } from "@acv/shared";

export interface CheckpointResult {
  decision: string;
  note?: string;
  modifications?: Record<string, unknown>;
}

interface PendingCheckpoint {
  id: string;
  context: HitlContext;
  resolve: (result: CheckpointResult) => void;
}

export interface InterruptMessage {
  type: "inject_message" | "pause" | "abort";
  content?: string;
}

export class HitlController {
  private pending: PendingCheckpoint | null = null;
  private interruptQueue: InterruptMessage[] = [];

  /**
   * Create a checkpoint and pause execution until user decides.
   * Returns a promise that resolves when the user submits a decision.
   */
  awaitCheckpoint(context: HitlContext): { checkpointId: string; promise: Promise<CheckpointResult> } {
    const checkpointId = `cp_${randomUUID().slice(0, 8)}`;
    let resolveFunc!: (result: CheckpointResult) => void;
    const promise = new Promise<CheckpointResult>((resolve) => {
      resolveFunc = resolve;
    });

    this.pending = { id: checkpointId, context, resolve: resolveFunc };
    return { checkpointId, promise };
  }

  /**
   * Resolve a pending checkpoint with user's decision.
   * Returns false if no matching checkpoint is pending.
   */
  resolveCheckpoint(checkpointId: string, decision: string, note?: string, modifications?: Record<string, unknown>): boolean {
    if (!this.pending || this.pending.id !== checkpointId) return false;
    const cp = this.pending;
    this.pending = null;
    cp.resolve({ decision, note, modifications });
    return true;
  }

  /** Get the current pending checkpoint id, or null */
  getPendingCheckpointId(): string | null {
    return this.pending?.id ?? null;
  }

  /** Enqueue an interrupt message from the user */
  enqueueInterrupt(msg: InterruptMessage) {
    this.interruptQueue.push(msg);
  }

  /** Drain all queued interrupts (called by AgentLoop each iteration) */
  drainInterrupts(): InterruptMessage[] {
    const msgs = this.interruptQueue.splice(0);
    return msgs;
  }

  /** Check if an abort has been requested */
  hasAbort(): boolean {
    return this.interruptQueue.some((m) => m.type === "abort");
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/hitl.ts
git commit -m "feat(server): add HITL controller with checkpoint and interrupt support"
```

---

## Task 6: Refactor LLM Client

**Files:**
- Delete: `apps/server/src/openaiAdapter.ts`
- Create: `apps/server/src/llmClient.ts`

- [ ] **Step 1: Create llmClient.ts**

This replaces openaiAdapter.ts. Key changes: returns structured response with tool_calls, accepts tools parameter, removes Claude CLI logic.

```typescript
import OpenAI from "openai";

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
}

type OnDelta = (delta: string) => void;

export class LlmClient {
  private client: OpenAI | null;
  private model: string;
  private providerLabel: string;

  constructor() {
    const apiKey =
      process.env.AGENT_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    const baseURL =
      process.env.AGENT_BASE_URL || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL;
    this.model =
      process.env.AGENT_MODEL || process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || "deepseek-chat";

    this.providerLabel = baseURL || "default(OpenAI)";
    this.client = apiKey
      ? new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
      : null;
  }

  isReady(): boolean {
    return Boolean(this.client);
  }

  getProviderInfo(): string {
    return `${this.providerLabel} / ${this.model}`;
  }

  async chat(
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string }>,
    tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
    onDelta?: OnDelta,
  ): Promise<LlmResponse> {
    if (!this.client) {
      throw new Error("LLM API key not configured. Set AGENT_API_KEY in .env");
    }

    const params: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    let fullText = "";
    const toolCalls: Array<{ id: string; name: string; argStr: string }> = [];

    try {
      const stream = await this.client.chat.completions.create(params as any);

      for await (const chunk of stream as AsyncIterable<any>) {
        const choice = chunk?.choices?.[0];
        if (!choice) continue;

        // Text delta
        const textDelta = choice.delta?.content;
        if (typeof textDelta === "string" && textDelta.length > 0) {
          fullText += textDelta;
          onDelta?.(textDelta);
        }

        // Tool call deltas
        const tcDeltas = choice.delta?.tool_calls;
        if (Array.isArray(tcDeltas)) {
          for (const tcd of tcDeltas) {
            const idx = tcd.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: tcd.id || "", name: tcd.function?.name || "", argStr: "" };
            }
            if (tcd.id) toolCalls[idx].id = tcd.id;
            if (tcd.function?.name) toolCalls[idx].name = tcd.function.name;
            if (tcd.function?.arguments) toolCalls[idx].argStr += tcd.function.arguments;
          }
        }
      }
    } catch (err) {
      // If streaming fails, try non-streaming
      if (this.isRetryableStreamError(err)) {
        return this.chatNonStream(messages, tools);
      }
      throw err;
    }

    const parsedToolCalls: LlmToolCall[] = toolCalls
      .filter((tc) => tc.name)
      .map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.argStr || "{}");
        } catch { /* use empty */ }
        return { id: tc.id, name: tc.name, args };
      });

    return { text: fullText, toolCalls: parsedToolCalls };
  }

  private async chatNonStream(
    messages: Array<{ role: string; content: string; tool_call_id?: string }>,
    tools?: unknown[],
  ): Promise<LlmResponse> {
    if (!this.client) throw new Error("client not initialized");

    const params: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };
    if (tools && (tools as unknown[]).length > 0) params.tools = tools;

    const resp: any = await this.client.chat.completions.create(params as any);
    const choice = resp?.choices?.[0];
    const text = choice?.message?.content || "";
    const rawToolCalls = choice?.message?.tool_calls || [];

    const toolCalls: LlmToolCall[] = rawToolCalls.map((tc: any) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch { /* use empty */ }
      return { id: tc.id || "", name: tc.function?.name || "", args };
    });

    return { text, toolCalls };
  }

  private isRetryableStreamError(err: unknown): boolean {
    const status = (err as { status?: number })?.status;
    return status === 404 || status === 405 || status === 400;
  }
}
```

- [ ] **Step 2: Delete openaiAdapter.ts**

Run: `rm E:/Agent-Canvas-Visualizer/apps/server/src/openaiAdapter.ts`

- [ ] **Step 3: Verify build** (will have errors in runManager.ts — expected, fixed in Task 8)

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/llmClient.ts
git rm apps/server/src/openaiAdapter.ts
git commit -m "feat(server): replace openaiAdapter with llmClient supporting tool_calls"
```

---

## Task 7: Create Agent Loop

**Files:**
- Create: `apps/server/src/agentLoop.ts`

- [ ] **Step 1: Create agentLoop.ts**

```typescript
import type { AgentEvent, HitlContext } from "@acv/shared";
import type { LlmClient, LlmToolCall } from "./llmClient";
import type { ToolRegistry } from "./tools/registry";
import type { HitlController } from "./hitl";

type EmitFn = (event: Omit<AgentEvent, "runId" | "eventId" | "seq" | "ts">) => void;

interface AgentLoopOptions {
  runId: string;
  prompt: string;
  llm: LlmClient;
  tools: ToolRegistry;
  hitl: HitlController;
  emit: EmitFn;
  maxSteps?: number;
  systemPrompt?: string;
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export class AgentLoop {
  private opts: Required<Omit<AgentLoopOptions, "systemPrompt">> & { systemPrompt: string };
  private messages: ChatMessage[] = [];
  private nodeSeq = 0;
  private step = 0;
  private aborted = false;

  constructor(opts: AgentLoopOptions) {
    this.opts = {
      ...opts,
      maxSteps: opts.maxSteps ?? 20,
      systemPrompt: opts.systemPrompt ??
        "You are a helpful agent that can read and write files in a project. " +
        "Use the provided tools to accomplish the user's task. " +
        "Think step by step. When you have completed the task, provide a final answer without tool calls.",
    };
  }

  async run(): Promise<void> {
    const { runId, prompt, emit } = this.opts;

    emit({ type: "run_started" });

    this.messages.push({ role: "system", content: this.opts.systemPrompt });
    this.messages.push({ role: "user", content: prompt });

    try {
      while (this.step < this.opts.maxSteps && !this.aborted) {
        // Check for interrupts
        const interrupts = this.opts.hitl.drainInterrupts();
        for (const intr of interrupts) {
          if (intr.type === "abort") {
            this.aborted = true;
            emit({ type: "run_finished", status: "aborted" });
            return;
          }
          if (intr.type === "inject_message" && intr.content) {
            this.messages.push({ role: "user", content: intr.content });
          }
        }

        this.step++;
        emit({ type: "loop_step", step: this.step, maxSteps: this.opts.maxSteps });

        // 1. Think: call LLM
        const thinkNodeId = this.nextNodeId();
        emit({
          type: "node_created",
          nodeId: thinkNodeId,
          role: "thinking",
          content: "Thinking...",
          status: "streaming",
        });

        let thinkText = "";
        const response = await this.opts.llm.chat(
          this.messages,
          this.opts.tools.toOpenAITools(),
          (delta) => {
            thinkText += delta;
            emit({
              type: "node_updated",
              nodeId: thinkNodeId,
              patch: { content: thinkText, status: "streaming" },
            });
          },
        );

        // Update thinking node with final text
        const finalThinkText = response.text || (response.toolCalls.length > 0 ? "(deciding to use tools)" : "(empty response)");
        emit({
          type: "node_updated",
          nodeId: thinkNodeId,
          patch: { content: finalThinkText, status: "done" },
        });

        // Add assistant message to history
        if (response.toolCalls.length > 0) {
          this.messages.push({
            role: "assistant",
            content: response.text || "",
            tool_calls: response.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          });
        } else {
          this.messages.push({ role: "assistant", content: response.text });
        }

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

          // HITL: answer review
          const ctx: HitlContext = { kind: "answer_review", answer: response.text };
          const { checkpointId, promise } = this.opts.hitl.awaitCheckpoint(ctx);
          emit({
            type: "hitl_required",
            checkpointId,
            nodeId: answerNodeId,
            options: ["accept", "revise", "finish"],
            context: ctx,
          });

          const decision = await promise;
          emit({
            type: "hitl_applied",
            checkpointId,
            decision: decision.decision,
            note: decision.note,
          });

          if (decision.decision === "accept" || decision.decision === "finish") {
            emit({
              type: "node_updated",
              nodeId: answerNodeId,
              patch: { status: "done" },
            });
            emit({ type: "run_finished", status: "success" });
            return;
          }

          // revise: inject feedback and continue loop
          if (decision.decision === "revise") {
            const feedback = decision.note || "Please revise your answer and improve it.";
            this.messages.push({ role: "user", content: feedback });
            emit({
              type: "node_updated",
              nodeId: answerNodeId,
              patch: { content: `${response.text}\n\n[Revision requested: ${feedback}]`, status: "done" },
            });
            continue;
          }
        }

        // 3. Process tool calls
        for (const toolCall of response.toolCalls) {
          if (this.aborted) break;
          await this.processToolCall(toolCall, thinkNodeId);
        }
      }

      // Max steps reached
      if (!this.aborted) {
        const maxNodeId = this.nextNodeId();
        emit({
          type: "node_created",
          nodeId: maxNodeId,
          role: "error",
          content: `Reached maximum steps (${this.opts.maxSteps}). Stopping.`,
          status: "error",
        });
        emit({ type: "run_finished", status: "failed" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errNodeId = this.nextNodeId();
      emit({
        type: "node_created",
        nodeId: errNodeId,
        role: "error",
        content: `Agent loop error: ${msg}`,
        status: "error",
      });
      emit({ type: "run_finished", status: "failed" });
    }
  }

  private async processToolCall(toolCall: LlmToolCall, parentNodeId: string): Promise<void> {
    const { emit } = this.opts;
    const tool = this.opts.tools.get(toolCall.name);

    // Create tool_call node
    const callNodeId = this.nextNodeId();
    emit({
      type: "node_created",
      nodeId: callNodeId,
      parentId: parentNodeId,
      role: "tool_call",
      content: `${toolCall.name}(${JSON.stringify(toolCall.args)})`,
      status: tool?.requiresApproval ? "waiting_human" : "streaming",
      toolName: toolCall.name,
      toolArgs: toolCall.args,
    });
    emit({ type: "edge_created", from: parentNodeId, to: callNodeId, kind: "tool" });

    // HITL: tool approval if required
    if (tool?.requiresApproval) {
      const ctx: HitlContext = { kind: "tool_approval", toolName: toolCall.name, toolArgs: toolCall.args };
      const { checkpointId, promise } = this.opts.hitl.awaitCheckpoint(ctx);
      emit({
        type: "hitl_required",
        checkpointId,
        nodeId: callNodeId,
        options: ["approve", "reject", "modify_args"],
        context: ctx,
      });

      const decision = await promise;
      emit({
        type: "hitl_applied",
        checkpointId,
        decision: decision.decision,
        note: decision.note,
        modifications: decision.modifications,
      });

      if (decision.decision === "reject") {
        emit({
          type: "node_updated",
          nodeId: callNodeId,
          patch: { content: `${toolCall.name} — rejected by user`, status: "error" },
        });
        this.messages.push({
          role: "tool",
          content: `Tool call rejected by user. Reason: ${decision.note || "No reason given."}`,
          tool_call_id: toolCall.id,
        });
        return;
      }

      // Apply modified args if provided
      if (decision.decision === "modify_args" && decision.modifications) {
        Object.assign(toolCall.args, decision.modifications);
        emit({
          type: "node_updated",
          nodeId: callNodeId,
          patch: { content: `${toolCall.name}(${JSON.stringify(toolCall.args)})` },
        });
      }
    }

    // Execute tool
    emit({
      type: "node_updated",
      nodeId: callNodeId,
      patch: { status: "streaming" },
    });

    const resultNodeId = this.nextNodeId();

    if (!tool) {
      const errOutput = `Unknown tool: ${toolCall.name}`;
      emit({
        type: "node_created",
        nodeId: resultNodeId,
        parentId: callNodeId,
        role: "tool_result",
        content: errOutput,
        status: "error",
        toolName: toolCall.name,
      });
      emit({ type: "edge_created", from: callNodeId, to: resultNodeId, kind: "depends" });
      this.messages.push({ role: "tool", content: errOutput, tool_call_id: toolCall.id });
      return;
    }

    try {
      const result = await tool.execute(toolCall.args);

      emit({ type: "node_updated", nodeId: callNodeId, patch: { status: "done" } });
      emit({
        type: "node_created",
        nodeId: resultNodeId,
        parentId: callNodeId,
        role: "tool_result",
        content: result.output,
        status: result.success ? "done" : "error",
        toolName: toolCall.name,
      });
      emit({ type: "edge_created", from: callNodeId, to: resultNodeId, kind: "depends" });
      emit({ type: "tool_executed", nodeId: resultNodeId, toolName: toolCall.name, result });

      this.messages.push({ role: "tool", content: result.output, tool_call_id: toolCall.id });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit({
        type: "node_created",
        nodeId: resultNodeId,
        parentId: callNodeId,
        role: "tool_result",
        content: `Tool execution error: ${errMsg}`,
        status: "error",
        toolName: toolCall.name,
      });
      emit({ type: "edge_created", from: callNodeId, to: resultNodeId, kind: "depends" });
      this.messages.push({ role: "tool", content: `Error: ${errMsg}`, tool_call_id: toolCall.id });
    }
  }

  private nextNodeId(): string {
    this.nodeSeq++;
    return `n${this.nodeSeq}`;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: Errors only from runManager.ts (still references old openaiAdapter — fixed next task)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/agentLoop.ts
git commit -m "feat(server): implement AgentLoop with think-act-observe cycle and HITL"
```

---

## Task 8: Refactor RunManager

**Files:**
- Modify: `apps/server/src/runManager.ts`

- [ ] **Step 1: Replace runManager.ts**

Replace the entire file. RunManager is now thin — it creates AgentLoop instances and manages SSE/events:

```typescript
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { AgentEvent } from "@acv/shared";
import { LlmClient } from "./llmClient";
import { ToolRegistry } from "./tools/registry";
import { HitlController } from "./hitl";
import { AgentLoop } from "./agentLoop";
import { createReadFileTool } from "./tools/readFile";
import { createListFilesTool } from "./tools/listFiles";
import { createWriteFileTool } from "./tools/writeFile";

const RUN_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

type RunData = {
  seq: number;
  events: AgentEvent[];
  clients: Set<ServerResponse>;
  hitl: HitlController;
  createdAt: number;
  finishedAt?: number;
};

export class RunManager {
  private runs = new Map<string, RunData>();
  private llm = new LlmClient();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  destroy() {
    clearInterval(this.cleanupTimer);
  }

  private cleanup() {
    const now = Date.now();
    for (const [runId, run] of this.runs) {
      if (run.finishedAt && now - run.finishedAt > RUN_TTL_MS) {
        this.runs.delete(runId);
      }
    }
  }

  startRun(runId: string, prompt: string) {
    const run = this.ensureRun(runId);
    const hitl = run.hitl;

    // Set up tools with sandbox root = current working directory
    const sandboxRoot = process.env.SANDBOX_ROOT || process.cwd();
    const tools = new ToolRegistry();
    tools.register(createReadFileTool(sandboxRoot));
    tools.register(createListFilesTool(sandboxRoot));
    tools.register(createWriteFileTool(sandboxRoot));

    const emit = (event: Omit<AgentEvent, "runId" | "eventId" | "seq" | "ts">) => {
      this.emitEvent(runId, event);
    };

    const loop = new AgentLoop({
      runId,
      prompt,
      llm: this.llm,
      tools,
      hitl,
      emit,
    });

    // Run the loop (fire and forget — events are emitted via SSE)
    void loop.run().then(() => {
      run.finishedAt = Date.now();
    }).catch((err) => {
      console.error(`[run ${runId}] loop crashed:`, err);
      this.emitEvent(runId, { type: "run_finished", status: "failed" });
      run.finishedAt = Date.now();
    });
  }

  intervene(runId: string, checkpointId: string, decision: string, note?: string, modifications?: Record<string, unknown>): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    return run.hitl.resolveCheckpoint(checkpointId, decision, note, modifications);
  }

  interrupt(runId: string, type: string, content?: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    const validTypes = ["inject_message", "pause", "abort"];
    if (!validTypes.includes(type)) return false;
    run.hitl.enqueueInterrupt({ type: type as "inject_message" | "pause" | "abort", content });
    return true;
  }

  addClient(runId: string, res: ServerResponse, lastSeq = 0) {
    const run = this.ensureRun(runId);
    run.clients.add(res);

    const history = run.events.filter((e) => e.seq > lastSeq);
    for (const event of history) this.writeSse(res, event);

    const hb = setInterval(() => {
      res.write(`:heartbeat ${Date.now()}\n\n`);
    }, 15000);
    res.on("close", () => clearInterval(hb));
  }

  removeClient(runId: string, res: ServerResponse) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.clients.delete(res);
  }

  getEvents(runId: string): AgentEvent[] {
    return this.runs.get(runId)?.events ?? [];
  }

  private emitEvent(runId: string, event: Omit<AgentEvent, "runId" | "eventId" | "seq" | "ts">) {
    const run = this.ensureRun(runId);
    run.seq += 1;
    const fullEvent = {
      ...event,
      runId,
      eventId: `${runId}:${run.seq}`,
      seq: run.seq,
      ts: Date.now(),
    } as AgentEvent;

    run.events.push(fullEvent);
    for (const client of run.clients) this.writeSse(client, fullEvent);
  }

  private writeSse(res: ServerResponse, event: AgentEvent) {
    res.write(`id: ${event.seq}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private ensureRun(runId: string): RunData {
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        seq: 0,
        events: [],
        clients: new Set(),
        hitl: new HitlController(),
        createdAt: Date.now(),
      };
      this.runs.set(runId, run);
    }
    return run;
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: No errors (or only index.ts needing update)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/runManager.ts
git commit -m "refactor(server): simplify RunManager, delegate agent logic to AgentLoop"
```

---

## Task 9: Update Server Routes

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Add interrupt route and update intervene route**

Add `modifications` to intervene handler, add new `/runs/:id/interrupt` route. Replace the full `index.ts`:

```typescript
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RunManager } from "./runManager";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), ".env"),
  resolve(__dirname, "../../../.env.local"),
  resolve(__dirname, "../../../.env"),
  resolve(__dirname, "../../.env.local"),
  resolve(__dirname, "../../.env"),
];

for (const p of envCandidates) {
  if (existsSync(p)) {
    loadEnv({ path: p, override: false });
  }
}

const port = Number(process.env.PORT || 8787);
const manager = new RunManager();

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

const cors = { "Access-Control-Allow-Origin": "*" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
    });
    res.end();
    return;
  }

  // POST /runs — start a new run
  if (req.method === "POST" && url.pathname === "/runs") {
    const raw = await readBody(req);
    const body = parseJson(raw);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const prompt =
      typeof body.prompt === "string" && body.prompt.trim().length > 0
        ? body.prompt.trim()
        : "Please analyze this project and suggest next steps.";

    if (prompt.length > 10000) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Prompt too long (max 10000 chars)" }));
      return;
    }

    const runId = randomUUID();
    manager.startRun(runId, prompt);
    res.writeHead(201, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ runId }));
    return;
  }

  // GET /runs/:id/stream — SSE stream
  const streamMatch = url.pathname.match(/^\/runs\/([^/]+)\/stream$/);
  if (req.method === "GET" && streamMatch) {
    const runId = streamMatch[1];
    const lastIdHeader = req.headers["last-event-id"];
    const lastSeq = Number(Array.isArray(lastIdHeader) ? lastIdHeader[0] : lastIdHeader || "0");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...cors,
    });

    manager.addClient(runId, res, Number.isNaN(lastSeq) ? 0 : lastSeq);
    req.on("close", () => manager.removeClient(runId, res));
    return;
  }

  // POST /runs/:id/intervene — HITL checkpoint decision
  const interveneMatch = url.pathname.match(/^\/runs\/([^/]+)\/intervene$/);
  if (req.method === "POST" && interveneMatch) {
    const runId = interveneMatch[1];
    const raw = await readBody(req);
    const body = parseJson(raw);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const checkpointId = body.checkpointId;
    const decision = body.decision || "accept";
    const note = typeof body.note === "string" ? body.note : undefined;
    const modifications = typeof body.modifications === "object" && body.modifications !== null
      ? body.modifications as Record<string, unknown>
      : undefined;

    if (typeof checkpointId !== "string" || !checkpointId) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Missing checkpointId" }));
      return;
    }

    const result = manager.intervene(runId, checkpointId, String(decision), note, modifications);
    res.writeHead(result ? 200 : 404, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: result }));
    return;
  }

  // POST /runs/:id/interrupt — user active intervention
  const interruptMatch = url.pathname.match(/^\/runs\/([^/]+)\/interrupt$/);
  if (req.method === "POST" && interruptMatch) {
    const runId = interruptMatch[1];
    const raw = await readBody(req);
    const body = parseJson(raw);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const type = String(body.type || "");
    const content = typeof body.content === "string" ? body.content : undefined;

    if (!type) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: "Missing type (inject_message | pause | abort)" }));
      return;
    }

    const result = manager.interrupt(runId, type, content);
    res.writeHead(result ? 200 : 404, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ ok: result }));
    return;
  }

  // GET /runs/:id/events — get all events
  const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const runId = eventsMatch[1];
    const events = manager.getEvents(runId);
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ runId, count: events.length, events }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json", ...cors });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[acv-server] Port ${port} is already in use. ` +
        `Stop the existing process or run with another port.`,
    );
    process.exit(1);
  }
  console.error("[acv-server] unexpected server error:", err);
  process.exit(1);
});

server.listen(port, () => {
  const addr = server.address() as AddressInfo;
  console.log(`[acv-server] listening on http://localhost:${addr.port}`);
});
```

- [ ] **Step 2: Verify full server build**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): add /interrupt route, update /intervene with modifications"
```

---

## Task 10: Update Frontend SSE Service

**Files:**
- Modify: `apps/web/src/services/sse.ts`

- [ ] **Step 1: Replace sse.ts with extended version**

```typescript
import type { AgentEvent } from "@acv/shared";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body.error === "string") return body.error;
  } catch { /* ignore */ }
  return `${fallback} (${res.status})`;
}

export async function startRunRequest(prompt: string): Promise<string> {
  const res = await fetch(`${API_BASE}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error(await extractError(res, "Failed to start run"));
  const data = await res.json();
  return data.runId as string;
}

export async function interveneRequest(
  runId: string,
  checkpointId: string,
  decision: string,
  note?: string,
  modifications?: Record<string, unknown>,
) {
  const res = await fetch(`${API_BASE}/runs/${runId}/intervene`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkpointId, decision, note, modifications }),
  });
  if (!res.ok) throw new Error(await extractError(res, "Failed to intervene"));
}

export async function interruptRequest(
  runId: string,
  type: string,
  content?: string,
) {
  const res = await fetch(`${API_BASE}/runs/${runId}/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, content }),
  });
  if (!res.ok) throw new Error(await extractError(res, "Failed to interrupt"));
}

export function connectRunStream(runId: string, onEvent: (e: AgentEvent) => void) {
  const source = new EventSource(`${API_BASE}/runs/${runId}/stream`);
  const names: AgentEvent["type"][] = [
    "run_started",
    "node_created",
    "node_updated",
    "edge_created",
    "hitl_required",
    "hitl_applied",
    "tool_executed",
    "loop_step",
    "run_finished",
  ];

  names.forEach((name) => {
    source.addEventListener(name, (message) => {
      try {
        const parsed = JSON.parse((message as MessageEvent).data) as AgentEvent;
        onEvent(parsed);
      } catch {
        console.warn(`[sse] Failed to parse event "${name}":`, (message as MessageEvent).data);
      }
    });
  });

  source.onerror = () => {
    // EventSource auto-reconnects
  };

  return source;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/services/sse.ts
git commit -m "feat(web): extend SSE service with new events and interrupt API"
```

---

## Task 11: Update Pinia Store

**Files:**
- Modify: `apps/web/src/stores/agentRun.ts`

- [ ] **Step 1: Replace agentRun.ts**

```typescript
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { applyEvent, createInitialGraphState, type AgentEvent, type HitlContext } from "@acv/shared";
import { connectRunStream, startRunRequest, interveneRequest, interruptRequest } from "../services/sse";

export const useAgentRunStore = defineStore("agent-run", () => {
  const graph = ref(createInitialGraphState());
  const queue = ref<AgentEvent[]>([]);
  let raf = 0;
  let currentSource: EventSource | null = null;
  let activeRunId: string | null = null;

  const nodes = computed(() => Object.values(graph.value.nodes));

  const currentCheckpoint = computed(() => {
    const entry = Object.entries(graph.value.checkpoints).find(([, c]) => !c.resolved);
    if (!entry) return null;
    return { checkpointId: entry[0], nodeId: entry[1].nodeId, context: entry[1].context };
  });

  const stepInfo = computed(() => ({
    current: graph.value.currentStep,
    max: graph.value.maxSteps,
  }));

  const isRunning = computed(() =>
    graph.value.runStatus === "streaming" || graph.value.runStatus === "resumed",
  );

  function flush() {
    if (queue.value.length === 0) {
      raf = 0;
      return;
    }
    const batch = queue.value.splice(0, queue.value.length);
    for (const event of batch) graph.value = applyEvent(graph.value, event);
    raf = requestAnimationFrame(flush);
  }

  function enqueue(event: AgentEvent) {
    queue.value.push(event);
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function closeStream() {
    if (currentSource) {
      currentSource.close();
      currentSource = null;
    }
  }

  watch(
    () => graph.value.runStatus,
    (status) => {
      if (status === "finished" || status === "error") {
        closeStream();
      }
    },
  );

  async function startRun(prompt: string) {
    closeStream();
    graph.value = createInitialGraphState();
    const runId = await startRunRequest(prompt);
    activeRunId = runId;
    currentSource = connectRunStream(runId, enqueue);
  }

  async function intervene(
    checkpointId: string,
    decision: string,
    note?: string,
    modifications?: Record<string, unknown>,
  ) {
    if (!graph.value.runId) return;
    await interveneRequest(graph.value.runId, checkpointId, decision, note, modifications);
  }

  async function interrupt(type: string, content?: string) {
    const runId = graph.value.runId || activeRunId;
    if (!runId) return;
    await interruptRequest(runId, type, content);
  }

  return {
    graph,
    nodes,
    currentCheckpoint,
    stepInfo,
    isRunning,
    startRun,
    intervene,
    interrupt,
    closeStream,
  };
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/stores/agentRun.ts
git commit -m "feat(web): extend store with checkpoint context, interrupt, and step info"
```

---

## Task 12: Create ToolCallCard Component

**Files:**
- Create: `apps/web/src/components/ToolCallCard.vue`

- [ ] **Step 1: Create ToolCallCard.vue**

```vue
<script setup lang="ts">
import { ref, computed, watch } from "vue";

const props = defineProps<{
  toolName: string;
  toolArgs: Record<string, unknown>;
  editable: boolean;
}>();

const emit = defineEmits<{
  (e: "update:args", args: Record<string, unknown>): void;
}>();

const argsText = ref(JSON.stringify(props.toolArgs, null, 2));
const parseError = ref("");

watch(
  () => props.toolArgs,
  (args) => {
    argsText.value = JSON.stringify(args, null, 2);
    parseError.value = "";
  },
);

function onInput() {
  try {
    const parsed = JSON.parse(argsText.value);
    parseError.value = "";
    emit("update:args", parsed);
  } catch {
    parseError.value = "Invalid JSON";
  }
}
</script>

<template>
  <div class="tool-card">
    <div class="tool-header">
      <span class="tool-icon">&#9881;</span>
      <span class="tool-name">{{ toolName }}</span>
    </div>
    <div class="tool-args">
      <div class="tool-args-label">Arguments:</div>
      <textarea
        v-if="editable"
        v-model="argsText"
        @input="onInput"
        class="tool-args-editor"
        rows="4"
        spellcheck="false"
      />
      <pre v-else class="tool-args-view">{{ argsText }}</pre>
      <div v-if="parseError" class="tool-parse-error">{{ parseError }}</div>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  background: #f9fafb;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 14px;
}

.tool-icon {
  font-size: 16px;
}

.tool-name {
  color: #1d4ed8;
  font-family: monospace;
}

.tool-args-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}

.tool-args-editor {
  width: 100%;
  font-family: "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
  resize: vertical;
  background: #fff;
  color: var(--text);
}

.tool-args-view {
  margin: 0;
  font-family: "Cascadia Code", "Fira Code", monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}

.tool-parse-error {
  color: #dc2626;
  font-size: 11px;
  margin-top: 4px;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/ToolCallCard.vue
git commit -m "feat(web): add ToolCallCard component for tool call detail display"
```

---

## Task 13: Create HitlPanel Component

**Files:**
- Create: `apps/web/src/components/HitlPanel.vue`

- [ ] **Step 1: Create HitlPanel.vue**

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import type { HitlContext } from "@acv/shared";
import ToolCallCard from "./ToolCallCard.vue";

const props = defineProps<{
  checkpointId: string;
  context?: HitlContext;
}>();

const emit = defineEmits<{
  (e: "decide", decision: string, note?: string, modifications?: Record<string, unknown>): void;
}>();

const note = ref("");
const modifiedArgs = ref<Record<string, unknown>>({});

const kind = computed(() => props.context?.kind || "answer_review");

const title = computed(() => {
  if (kind.value === "tool_approval") return `Tool Approval: ${props.context?.toolName}`;
  if (kind.value === "error_recovery") return "Error Recovery";
  return "Review Answer";
});

function decide(decision: string) {
  const mods = decision === "modify_args" ? modifiedArgs.value : undefined;
  emit("decide", decision, note.value.trim() || undefined, mods);
  note.value = "";
}

function onArgsUpdate(args: Record<string, unknown>) {
  modifiedArgs.value = args;
}
</script>

<template>
  <div class="hitl-panel">
    <div class="hitl-header">
      <span class="hitl-badge">{{ kind === "tool_approval" ? "&#9888;" : "&#9998;" }}</span>
      <span class="hitl-title">{{ title }}</span>
    </div>

    <div class="hitl-body">
      <!-- Tool approval -->
      <template v-if="kind === 'tool_approval' && context?.toolName">
        <ToolCallCard
          :tool-name="context.toolName"
          :tool-args="context.toolArgs || {}"
          :editable="true"
          @update:args="onArgsUpdate"
        />
        <div class="hitl-actions">
          <button class="hitl-approve" @click="decide('approve')">Approve</button>
          <button class="hitl-modify" @click="decide('modify_args')">Approve with Changes</button>
          <button class="hitl-reject" @click="decide('reject')">Reject</button>
        </div>
      </template>

      <!-- Answer review -->
      <template v-else-if="kind === 'answer_review'">
        <div v-if="context?.answer" class="hitl-answer-preview">
          <pre>{{ context.answer.slice(0, 500) }}{{ context.answer.length > 500 ? "..." : "" }}</pre>
        </div>
        <div class="hitl-actions">
          <button class="hitl-approve" @click="decide('accept')">Accept</button>
          <button class="hitl-modify" @click="decide('revise')">Revise</button>
          <button class="hitl-finish" @click="decide('finish')">Finish</button>
        </div>
      </template>

      <!-- Error recovery -->
      <template v-else-if="kind === 'error_recovery'">
        <div class="hitl-error-msg">{{ context?.errorMessage || "An error occurred." }}</div>
        <div class="hitl-actions">
          <button class="hitl-approve" @click="decide('retry')">Retry</button>
          <button class="hitl-reject" @click="decide('abort')">Abort</button>
        </div>
      </template>

      <!-- Note input -->
      <textarea
        v-model="note"
        rows="2"
        class="hitl-note"
        placeholder="Optional note or feedback..."
      />
    </div>
  </div>
</template>

<style scoped>
.hitl-panel {
  border: 2px solid #f97316;
  border-radius: 10px;
  background: #fffbeb;
  overflow: hidden;
}

.hitl-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #fef3c7;
  border-bottom: 1px solid #fde68a;
  font-weight: 600;
  font-size: 14px;
}

.hitl-badge {
  font-size: 18px;
}

.hitl-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hitl-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.hitl-approve {
  background: #16a34a;
  color: white;
  border: 0;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.hitl-modify {
  background: #2563eb;
  color: white;
  border: 0;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.hitl-reject {
  background: #dc2626;
  color: white;
  border: 0;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.hitl-finish {
  background: #374151;
  color: white;
  border: 0;
  padding: 8px 16px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.hitl-note {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
  font-family: inherit;
  font-size: 13px;
  resize: vertical;
  background: #fff;
}

.hitl-answer-preview pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  max-height: 120px;
  overflow-y: auto;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
  font-family: "Cascadia Code", "Fira Code", monospace;
}

.hitl-error-msg {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  color: #dc2626;
  padding: 8px;
  border-radius: 6px;
  font-size: 13px;
}

.hitl-approve:hover, .hitl-modify:hover, .hitl-reject:hover, .hitl-finish:hover {
  opacity: 0.85;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/HitlPanel.vue
git commit -m "feat(web): add HitlPanel component with context-aware approval UI"
```

---

## Task 14: Refactor DagCanvas for Vertical Layout and New Node Types

**Files:**
- Modify: `apps/web/src/components/DagCanvas.vue`

- [ ] **Step 1: Replace DagCanvas.vue with vertical layout and new node types**

```vue
<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from "vue";
import type { GraphEdge, GraphNode } from "@acv/shared";

type LayoutNode = GraphNode & {
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

type LayoutEdge = GraphEdge & {
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

const props = defineProps<{
  nodes: GraphNode[];
  edges: GraphEdge[];
}>();

const emit = defineEmits<{
  (e: "selectNode", id: string | null): void;
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

function roleColor(role: GraphNode["role"]): string {
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

function roleLabel(role: GraphNode["role"]): string {
  switch (role) {
    case "thinking": return "Thinking";
    case "tool_call": return "Tool Call";
    case "tool_result": return "Result";
    case "answer": return "Answer";
    case "hitl": return "HITL";
    case "error": return "Error";
    default: return role;
  }
}

function statusIndicator(status: GraphNode["status"]): string {
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

/**
 * Vertical layout:
 * - "thinking" and "answer" nodes go on the main vertical column (x=32)
 * - "tool_call" and "tool_result" branch to the right
 */
const layout = computed(() => {
  const byId = new Map(props.nodes.map((n) => [n.id, n]));

  // Classify: main column vs branch
  const mainRoles = new Set(["thinking", "answer", "error"]);
  const mainCol: GraphNode[] = [];
  const branches = new Map<string, GraphNode[]>(); // parentId → branch nodes

  for (const n of props.nodes) {
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

  // Compute height for a node
  function nodeHeight(n: GraphNode): number {
    const rawLines = (n.content || "").split(/\r?\n/);
    const allWrapped = rawLines.flatMap((l) => wrapLine(l, MAX_CHARS_PER_LINE));
    const lineCount = Math.min(allWrapped.length, PREVIEW_LINES + 1);
    return 40 + Math.max(lineCount, 1) * 16 + 14;
  }

  for (const n of mainCol) {
    posMap.set(n.id, { x: mainX, y: cursorY });
    const h = nodeHeight(n);

    // Place branch nodes to the right
    const branchNodes = branches.get(n.id) || [];
    let branchY = cursorY;
    for (const bn of branchNodes) {
      const bx = mainX + NODE_WIDTH + BRANCH_GAP_X;
      posMap.set(bn.id, { x: bx, y: branchY });

      // Nested branches (tool_result under tool_call)
      const subBranch = branches.get(bn.id) || [];
      let subY = branchY;
      for (const sbn of subBranch) {
        const sx = bx + NODE_WIDTH + BRANCH_GAP_X;
        posMap.set(sbn.id, { x: sx, y: subY });
        subY += nodeHeight(sbn) + NODE_GAP_Y;
      }
      branchY += Math.max(nodeHeight(bn), subY - branchY) + NODE_GAP_Y;
    }

    cursorY += Math.max(h, branchY - cursorY + (branchNodes.length > 0 ? 0 : 0)) + NODE_GAP_Y;
  }

  // Build layout nodes
  const nodes: LayoutNode[] = props.nodes.map((n) => {
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

  const nodePos = new Map(nodes.map((nd) => [nd.id, nd]));
  const edges: LayoutEdge[] = props.edges
    .map((e) => {
      const from = nodePos.get(e.from);
      const to = nodePos.get(e.to);
      if (!from || !to) return null;

      // Vertical edges: bottom of from → top of to
      // Horizontal edges: right of from → left of to
      const isHorizontal = from.y === to.y || Math.abs(from.x - to.x) > NODE_WIDTH / 2;
      return {
        ...e,
        x1: isHorizontal ? from.x + from.width : from.x + from.width / 2,
        y1: isHorizontal ? from.y + from.height / 2 : from.y + from.height,
        x2: isHorizontal ? to.x : to.x + to.width / 2,
        y2: isHorizontal ? to.y + to.height / 2 : to.y,
      };
    })
    .filter((e): e is LayoutEdge => Boolean(e));

  const svgWidth = Math.max(980, ...nodes.map((nd) => nd.x + nd.width + 40));
  const svgHeight = Math.max(620, ...nodes.map((nd) => nd.y + nd.height + 40));

  return { nodes, edges, svgWidth, svgHeight };
});

function edgePath(e: LayoutEdge): string {
  const dx = Math.abs(e.x2 - e.x1);
  const dy = Math.abs(e.y2 - e.y1);

  if (dx > dy) {
    // Horizontal curve
    const cp = Math.max(dx * 0.4, 30);
    return `M ${e.x1} ${e.y1} C ${e.x1 + cp} ${e.y1}, ${e.x2 - cp} ${e.y2}, ${e.x2} ${e.y2}`;
  } else {
    // Vertical curve
    const cp = Math.max(dy * 0.4, 20);
    return `M ${e.x1} ${e.y1} C ${e.x1} ${e.y1 + cp}, ${e.x2} ${e.y2 - cp}, ${e.x2} ${e.y2}`;
  }
}
</script>

<template>
  <div class="dag-wrapper">
    <div ref="dagContainerRef" class="dag-container" :class="{ 'has-detail': selectedNode }">
      <svg :width="layout.svgWidth" :height="layout.svgHeight" class="dag-svg">
        <defs>
          <marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3"
            markerWidth="8" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 3 L 0 6 z" fill="#94a3b8" />
          </marker>
        </defs>

        <g v-for="e in layout.edges" :key="e.id">
          <path :d="edgePath(e)"
            fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#arrow)" />
        </g>

        <g v-for="n in layout.nodes" :key="n.id"
          class="dag-node"
          :class="{ selected: selectedNodeId === n.id, streaming: n.status === 'streaming' }"
          @click="selectNode(n.id)">

          <rect :x="n.x" :y="n.y" rx="10" ry="10"
            :width="n.width" :height="n.height"
            :fill="n.fillColor" class="node-bg" />

          <rect v-if="selectedNodeId === n.id"
            :x="n.x - 2" :y="n.y - 2" rx="12" ry="12"
            :width="n.width + 4" :height="n.height + 4"
            fill="none" stroke="#facc15" stroke-width="2.5" />

          <circle v-if="n.status === 'streaming'"
            :cx="n.x + n.width - 14" :cy="n.y + 16" r="8"
            fill="none" :stroke="n.statusColor" stroke-width="1.5"
            class="pulse-ring" />

          <circle :cx="n.x + n.width - 14" :cy="n.y + 16" r="5" :fill="n.statusColor" />

          <text :x="n.x + 12" :y="n.y + 20" fill="white" font-size="12" font-weight="600">
            {{ n.header }}
          </text>

          <line :x1="n.x + 8" :y1="n.y + 28" :x2="n.x + n.width - 8" :y2="n.y + 28"
            stroke="rgba(255,255,255,0.25)" stroke-width="1" />

          <text
            v-for="(line, idx) in n.lines"
            :key="`${n.id}-${idx}`"
            :x="n.x + 12"
            :y="n.y + 44 + idx * 16"
            :fill="n.truncated && idx === n.lines.length - 1 ? 'rgba(250,204,21,0.9)' : 'rgba(255,255,255,0.92)'"
            :font-size="n.truncated && idx === n.lines.length - 1 ? '10.5' : '11.5'"
            :font-style="n.truncated && idx === n.lines.length - 1 ? 'italic' : 'normal'"
          >
            {{ line }}
          </text>
        </g>
      </svg>
    </div>

    <transition name="slide">
      <div v-if="selectedNode" class="detail-panel">
        <div class="detail-header">
          <div class="detail-title">
            <span class="detail-badge" :style="{ background: roleColor(selectedNode.role) }">
              {{ roleLabel(selectedNode.role) }}
            </span>
            <span class="detail-id">{{ selectedNode.id }}</span>
            <span v-if="selectedNode.toolName" class="detail-tool">{{ selectedNode.toolName }}</span>
            <span class="detail-status" :style="{ color: statusIndicator(selectedNode.status) }">
              {{ selectedNode.status }}
            </span>
          </div>
          <button class="detail-close" @click="closeDetail" title="Esc">&times;</button>
        </div>
        <div class="detail-content">
          <pre>{{ selectedNode.content || "(empty)" }}</pre>
          <div v-if="selectedNode.toolArgs" class="detail-section">
            <div class="detail-section-title">Arguments:</div>
            <pre>{{ JSON.stringify(selectedNode.toolArgs, null, 2) }}</pre>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.dag-wrapper {
  display: flex;
  gap: 12px;
  width: 100%;
}

.dag-container {
  flex: 1;
  overflow: auto;
  max-height: 70vh;
  min-width: 0;
  transition: flex 0.2s;
}

.dag-container.has-detail { flex: 3; }

.dag-svg {
  border: 1px solid #d1d9e6;
  border-radius: 10px;
  background: #fbfdff;
}

.dag-node { cursor: pointer; }
.dag-node .node-bg { opacity: 0.92; transition: opacity 0.15s; }
.dag-node:hover .node-bg { opacity: 1; }

@keyframes pulse {
  0% { opacity: 1; r: 5; }
  100% { opacity: 0; r: 12; }
}
.pulse-ring { animation: pulse 1.2s ease-out infinite; }

.detail-panel {
  flex: 2;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #d1d9e6;
  border-radius: 10px;
  overflow: hidden;
  min-width: 280px;
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.detail-title { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.detail-badge { color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.detail-id { color: #6b7280; font-family: monospace; }
.detail-tool { color: #1d4ed8; font-family: monospace; font-weight: 600; font-size: 12px; }
.detail-status { font-weight: 600; font-size: 12px; }

.detail-close {
  background: none; border: 1px solid #d1d5db; border-radius: 6px;
  font-size: 18px; color: #6b7280; cursor: pointer;
  width: 28px; height: 28px; padding: 0;
  display: flex; align-items: center; justify-content: center;
}
.detail-close:hover { background: #f3f4f6; }

.detail-content { flex: 1; overflow-y: auto; padding: 14px; }
.detail-content pre {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-size: 13px; line-height: 1.6;
  font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
  color: #1f2937;
}

.detail-section { margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb; }
.detail-section-title { font-size: 12px; color: #6b7280; margin-bottom: 4px; font-weight: 600; }

.slide-enter-active, .slide-leave-active { transition: all 0.2s ease; }
.slide-enter-from, .slide-leave-to { opacity: 0; transform: translateX(20px); }
</style>
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/DagCanvas.vue
git commit -m "feat(web): refactor DagCanvas with vertical layout and new node types"
```

---

## Task 15: Update App.vue with New Layout

**Files:**
- Modify: `apps/web/src/App.vue`

- [ ] **Step 1: Replace App.vue**

```vue
<script setup lang="ts">
import { computed, ref } from "vue";
import DagCanvas from "./components/DagCanvas.vue";
import HitlPanel from "./components/HitlPanel.vue";
import { useAgentRunStore } from "./stores/agentRun";

const store = useAgentRunStore();
const prompt = ref("Please analyze this project structure and suggest improvements.");
const loading = ref(false);
const error = ref("");

const isRunning = computed(() => store.isRunning);
const checkpoint = computed(() => store.currentCheckpoint);
const stepInfo = computed(() => store.stepInfo);

async function start() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    await store.startRun(prompt.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function abort() {
  error.value = "";
  try {
    await store.interrupt("abort");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function onHitlDecide(decision: string, note?: string, modifications?: Record<string, unknown>) {
  if (!checkpoint.value) return;
  error.value = "";
  try {
    await store.intervene(checkpoint.value.checkpointId, decision, note, modifications);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <main class="page">
    <section class="header">
      <h1>Agent Canvas Visualizer</h1>
      <div class="btn-group">
        <button @click="start" :disabled="loading || isRunning">
          {{ loading ? "Starting..." : "Start Agent Run" }}
        </button>
        <button class="danger" @click="abort" :disabled="!isRunning">
          Abort
        </button>
      </div>
    </section>

    <div v-if="error" class="error-bar">{{ error }}</div>

    <!-- Prompt input -->
    <section class="panel" style="margin-bottom: 12px">
      <div style="font-size: 13px; color: var(--muted); margin-bottom: 6px">Prompt</div>
      <textarea
        v-model="prompt"
        rows="3"
        :disabled="isRunning"
        style="width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 10px; resize: vertical"
      />
    </section>

    <!-- Meta info -->
    <section class="panel" style="margin-bottom: 12px">
      <div class="meta">
        <span>runId: {{ store.graph.runId || "-" }}</span>
        <span>status: {{ store.graph.runStatus }}{{ isRunning ? " ..." : "" }}</span>
        <span>step: {{ stepInfo.current }}/{{ stepInfo.max || "?" }}</span>
        <span>lastSeq: {{ store.graph.lastSeq }}</span>
      </div>

      <!-- DAG Canvas -->
      <DagCanvas :nodes="store.nodes" :edges="store.graph.edges" />
    </section>

    <!-- HITL Panel -->
    <section v-if="checkpoint" style="margin-bottom: 12px">
      <HitlPanel
        :checkpoint-id="checkpoint.checkpointId"
        :context="checkpoint.context"
        @decide="onHitlDecide"
      />
    </section>
  </main>
</template>
```

- [ ] **Step 2: Add danger button style to styles.css**

Append to `apps/web/src/styles.css`:

```css

button.danger {
  background: #dc2626;
}
```

- [ ] **Step 3: Verify frontend builds**

Run: `cd E:/Agent-Canvas-Visualizer && npx vue-tsc --noEmit -p apps/web/tsconfig.json 2>&1 || npx tsc -p apps/web/tsconfig.json --noEmit 2>&1 || echo "check manually"`

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.vue apps/web/src/styles.css
git commit -m "feat(web): update App.vue with new layout, HitlPanel integration, and abort support"
```

---

## Task 16: Update .env.example and Add SANDBOX_ROOT

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Update .env.example**

Add `SANDBOX_ROOT` and remove Claude CLI provider (moved to Phase 3):

```
# LLM Provider (OpenAI-compatible API)
AGENT_API_KEY=
AGENT_MODEL=deepseek-chat
AGENT_BASE_URL=https://api.deepseek.com

# Sandbox root for tool file operations (defaults to cwd)
SANDBOX_ROOT=

PORT=8787

# Backward compatibility (optional):
# DEEPSEEK_API_KEY=
# DEEPSEEK_MODEL=deepseek-chat
# DEEPSEEK_BASE_URL=https://api.deepseek.com
# OPENAI_API_KEY=
# OPENAI_MODEL=
# OPENAI_BASE_URL=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "chore: update .env.example for agent loop configuration"
```

---

## Task 17: Integration Verification

- [ ] **Step 1: Build shared package**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: No errors

- [ ] **Step 2: Build server**

Run: `cd E:/Agent-Canvas-Visualizer && npx tsc -p apps/server/tsconfig.json --noEmit`
Expected: No errors

- [ ] **Step 3: Start server and verify it launches**

Run: `cd E:/Agent-Canvas-Visualizer && npm run dev:server`
Expected: `[acv-server] listening on http://localhost:8787`

- [ ] **Step 4: Start frontend and verify it loads**

Run: `cd E:/Agent-Canvas-Visualizer && npm run dev:web`
Expected: Vite dev server starts on port 5173

- [ ] **Step 5: Manual smoke test**

1. Open http://localhost:5173
2. Enter a prompt and click "Start Agent Run"
3. Verify: thinking node appears in DAG with streaming animation
4. Verify: if LLM returns tool_calls, tool_call and tool_result nodes appear
5. Verify: write_file calls show HITL panel with Approve/Reject buttons
6. Verify: Approve triggers tool execution and creates tool_result node
7. Verify: final answer shows HITL panel with Accept/Revise/Finish
8. Verify: Abort button terminates the run

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: agent loop with real tool calls and HITL checkpoints (Phase 1 MVP)"
```
