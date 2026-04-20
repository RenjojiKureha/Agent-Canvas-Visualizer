import { describe, it, expect, beforeEach } from "vitest";
import type { EmitPayload, HitlContext } from "@acv/shared";
import { AgentLoop } from "./agentLoop";
import { HitlController } from "./hitl";
import type { LlmClient, LlmResponse, LlmToolCall } from "./llmClient";
import { ToolRegistry } from "./tools/registry";
import type { Tool } from "./tools/types";

/** Deterministic LLM stub: returns scripted responses in order. */
class ScriptedLlm {
  private idx = 0;
  constructor(private readonly script: LlmResponse[]) {}
  async chat(
    _messages: unknown,
    _tools: unknown,
    onDelta?: (d: string) => void,
  ): Promise<LlmResponse> {
    const resp = this.script[this.idx++] ?? { text: "(out of script)", toolCalls: [] };
    if (resp.text && onDelta) onDelta(resp.text);
    return resp;
  }
}

function makeTool(name: string, opts: Partial<Tool> = {}): Tool {
  return {
    name,
    description: opts.description || name,
    parameters: opts.parameters || { type: "object" },
    requiresApproval: opts.requiresApproval ?? false,
    execute: opts.execute || (async () => ({ success: true, output: `${name} ok` })),
  };
}

function newLoop(
  llmScript: LlmResponse[],
  toolsList: Tool[] = [],
): {
  events: EmitPayload[];
  hitl: HitlController;
  run: () => Promise<void>;
} {
  const events: EmitPayload[] = [];
  const hitl = new HitlController();
  const llm = new ScriptedLlm(llmScript) as unknown as LlmClient;
  const tools = new ToolRegistry();
  for (const t of toolsList) tools.register(t);
  const loop = new AgentLoop({
    runId: "r1",
    prompt: "do it",
    llm,
    tools,
    hitl,
    emit: (e) => events.push(e),
    maxSteps: 5,
  });
  return { events, hitl, run: () => loop.run() };
}

function findHitlRequired(events: EmitPayload[]): Extract<EmitPayload, { type: "hitl_required" }> | undefined {
  return events.find((e) => e.type === "hitl_required") as
    | Extract<EmitPayload, { type: "hitl_required" }>
    | undefined;
}

describe("AgentLoop", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });

  describe("answer_review → finish", () => {
    it("ends the run when user chooses finish", async () => {
      const { events, hitl, run } = newLoop([
        { text: "the answer is 42", toolCalls: [] },
      ]);
      const runPromise = run();
      await new Promise((r) => setImmediate(r));
      const req = findHitlRequired(events);
      expect(req).toBeDefined();
      hitl.resolveCheckpoint(req!.checkpointId, "finish");
      await runPromise;

      const finished = events.find((e) => e.type === "run_finished");
      expect(finished).toEqual({ type: "run_finished", status: "success" });
    });
  });

  describe("answer_review → revise", () => {
    it("loops back with user feedback injected as a user message", async () => {
      const { events, hitl, run } = newLoop([
        { text: "first draft", toolCalls: [] },
        { text: "better draft", toolCalls: [] },
      ]);
      const runPromise = run();

      // First checkpoint: revise
      await new Promise((r) => setImmediate(r));
      const req1 = findHitlRequired(events);
      hitl.resolveCheckpoint(req1!.checkpointId, "revise", "tighter pls");

      // Second checkpoint: finish
      await new Promise((r) => setImmediate(r));
      const req2 = events
        .filter((e): e is Extract<EmitPayload, { type: "hitl_required" }> => e.type === "hitl_required")
        .pop();
      hitl.resolveCheckpoint(req2!.checkpointId, "finish");
      await runPromise;

      const applied = events.filter((e) => e.type === "hitl_applied");
      expect(applied).toHaveLength(2);
      expect((applied[0] as Extract<EmitPayload, { type: "hitl_applied" }>).decision).toBe("revise");
    });
  });

  describe("tool_approval → approve", () => {
    it("runs the tool after user approves", async () => {
      const toolCall: LlmToolCall = { id: "tc1", name: "write_file", args: { path: "a.txt" } };
      const executed: Array<Record<string, unknown>> = [];
      const tool = makeTool("write_file", {
        requiresApproval: true,
        execute: async (args) => {
          executed.push(args);
          return { success: true, output: "written" };
        },
      });
      const { events, hitl, run } = newLoop(
        [
          { text: "", toolCalls: [toolCall] },
          { text: "all done", toolCalls: [] },
        ],
        [tool],
      );
      const runPromise = run();
      await new Promise((r) => setImmediate(r));
      const req = findHitlRequired(events);
      expect(req?.context).toMatchObject({ kind: "tool_approval", toolName: "write_file" });
      hitl.resolveCheckpoint(req!.checkpointId, "approve");

      await new Promise((r) => setImmediate(r));
      const finalReq = events
        .filter((e): e is Extract<EmitPayload, { type: "hitl_required" }> => e.type === "hitl_required")
        .pop();
      hitl.resolveCheckpoint(finalReq!.checkpointId, "finish");
      await runPromise;

      expect(executed).toEqual([{ path: "a.txt" }]);
    });
  });

  describe("tool_approval → reject", () => {
    it("skips the tool and injects a tool-message explaining the rejection", async () => {
      const toolCall: LlmToolCall = { id: "tc1", name: "write_file", args: { path: "x.txt" } };
      const executed: unknown[] = [];
      const tool = makeTool("write_file", {
        requiresApproval: true,
        execute: async (args) => { executed.push(args); return { success: true, output: "" }; },
      });
      const { events, hitl, run } = newLoop(
        [
          { text: "", toolCalls: [toolCall] },
          { text: "gave up", toolCalls: [] },
        ],
        [tool],
      );
      const runPromise = run();
      await new Promise((r) => setImmediate(r));
      const req = findHitlRequired(events);
      hitl.resolveCheckpoint(req!.checkpointId, "reject", "unsafe");

      await new Promise((r) => setImmediate(r));
      const finalReq = events
        .filter((e): e is Extract<EmitPayload, { type: "hitl_required" }> => e.type === "hitl_required")
        .pop();
      hitl.resolveCheckpoint(finalReq!.checkpointId, "finish");
      await runPromise;

      expect(executed).toHaveLength(0);
      const rejectedNode = events.find(
        (e) => e.type === "node_updated" && e.patch.content?.includes("rejected by user"),
      );
      expect(rejectedNode).toBeDefined();
    });
  });

  describe("tool_approval → modify_args", () => {
    it("applies modifications before executing", async () => {
      const toolCall: LlmToolCall = { id: "tc1", name: "write_file", args: { path: "orig.txt", content: "x" } };
      const executed: Array<Record<string, unknown>> = [];
      const tool = makeTool("write_file", {
        requiresApproval: true,
        execute: async (args) => { executed.push(args); return { success: true, output: "" }; },
      });
      const { events, hitl, run } = newLoop(
        [
          { text: "", toolCalls: [toolCall] },
          { text: "done", toolCalls: [] },
        ],
        [tool],
      );
      const runPromise = run();
      await new Promise((r) => setImmediate(r));
      const req = findHitlRequired(events);
      hitl.resolveCheckpoint(req!.checkpointId, "modify_args", undefined, { path: "renamed.txt" });

      await new Promise((r) => setImmediate(r));
      const finalReq = events
        .filter((e): e is Extract<EmitPayload, { type: "hitl_required" }> => e.type === "hitl_required")
        .pop();
      hitl.resolveCheckpoint(finalReq!.checkpointId, "finish");
      await runPromise;

      expect(executed[0]).toEqual({ path: "renamed.txt", content: "x" });
    });
  });

  describe("abort interrupt", () => {
    it("stops the loop before the next LLM call", async () => {
      const { events, hitl, run } = newLoop([
        { text: "first answer", toolCalls: [] },
        { text: "second answer", toolCalls: [] },
      ]);

      const runPromise = run();
      await new Promise((r) => setImmediate(r));
      const req = findHitlRequired(events);
      hitl.resolveCheckpoint(req!.checkpointId, "continue");
      // Inject abort before next iteration
      hitl.enqueueInterrupt({ type: "abort" });
      await runPromise;

      const finished = events.find((e) => e.type === "run_finished");
      expect(finished).toEqual({ type: "run_finished", status: "aborted" });
    });
  });

  describe("reached max steps", () => {
    it("emits run_finished=failed after exhausting maxSteps", async () => {
      const script: LlmResponse[] = Array.from({ length: 10 }, () => ({
        text: "",
        toolCalls: [{ id: "t", name: "dummy", args: {} }],
      }));
      const events: EmitPayload[] = [];
      const hitl = new HitlController();
      const llm = new ScriptedLlm(script) as unknown as LlmClient;
      const tools = new ToolRegistry();
      tools.register(makeTool("dummy"));
      const loop = new AgentLoop({
        runId: "r1",
        prompt: "loop forever",
        llm,
        tools,
        hitl,
        emit: (e) => events.push(e),
        maxSteps: 2,
      });

      await loop.run();

      const finished = events.find((e) => e.type === "run_finished");
      expect(finished).toEqual({ type: "run_finished", status: "failed" });
    });
  });
});
