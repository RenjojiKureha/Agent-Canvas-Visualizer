import { describe, it, expect } from "vitest";
import { createInitialGraphState, applyEvent } from "./reducer";
import type { AgentEvent, GraphState } from "./events";

function makeEvent(seq: number, partial: Omit<AgentEvent, "runId" | "eventId" | "seq" | "ts">): AgentEvent {
  return { runId: "r1", eventId: `e${seq}`, seq, ts: Date.now(), ...partial } as AgentEvent;
}

function applyAll(events: AgentEvent[]): GraphState {
  return events.reduce(applyEvent, createInitialGraphState());
}

describe("createInitialGraphState", () => {
  it("returns idle state with empty collections", () => {
    const state = createInitialGraphState();
    expect(state.runStatus).toBe("idle");
    expect(state.nodes).toEqual({});
    expect(state.edges).toEqual([]);
    expect(state.checkpoints).toEqual({});
    expect(state.lastSeq).toBe(0);
    expect(state.currentStep).toBe(0);
    expect(state.maxSteps).toBe(0);
  });
});

describe("applyEvent", () => {
  describe("seq dedup", () => {
    it("ignores events with seq <= lastSeq", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
      ]);
      const dup = applyEvent(state, makeEvent(1, { type: "run_finished", status: "success" }));
      expect(dup).toBe(state); // same reference, no change
    });

    it("ignores events with seq < lastSeq", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(5, { type: "loop_step", step: 1, maxSteps: 10 }),
      ]);
      const dup = applyEvent(state, makeEvent(3, { type: "run_finished", status: "success" }));
      expect(dup).toBe(state);
    });
  });

  describe("run_started", () => {
    it("sets runStatus to streaming and records provider", () => {
      const state = applyAll([makeEvent(1, { type: "run_started", provider: "api" })]);
      expect(state.runStatus).toBe("streaming");
      expect(state.provider).toBe("api");
      expect(state.runId).toBe("r1");
      expect(state.lastSeq).toBe(1);
    });

    it("works without provider", () => {
      const state = applyAll([makeEvent(1, { type: "run_started" })]);
      expect(state.runStatus).toBe("streaming");
      expect(state.provider).toBeUndefined();
    });
  });

  describe("node_created", () => {
    it("adds a node to state", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, {
          type: "node_created",
          nodeId: "n1",
          role: "thinking",
          content: "Let me think...",
          status: "streaming",
        }),
      ]);
      expect(state.nodes["n1"]).toEqual({
        id: "n1",
        parentId: undefined,
        role: "thinking",
        content: "Let me think...",
        status: "streaming",
        toolName: undefined,
        toolArgs: undefined,
      });
    });

    it("defaults status to streaming when omitted", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, {
          type: "node_created",
          nodeId: "n1",
          role: "answer",
          content: "Hello",
        }),
      ]);
      expect(state.nodes["n1"].status).toBe("streaming");
    });

    it("records parentId and tool metadata", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, {
          type: "node_created",
          nodeId: "n1",
          parentId: "n0",
          role: "tool_call",
          content: "",
          toolName: "read_file",
          toolArgs: { path: "/tmp/x" },
        }),
      ]);
      expect(state.nodes["n1"].parentId).toBe("n0");
      expect(state.nodes["n1"].toolName).toBe("read_file");
      expect(state.nodes["n1"].toolArgs).toEqual({ path: "/tmp/x" });
    });
  });

  describe("node_updated", () => {
    it("patches existing node", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "node_created", nodeId: "n1", role: "thinking", content: "..." }),
        makeEvent(3, { type: "node_updated", nodeId: "n1", patch: { content: "Done thinking", status: "done" } }),
      ]);
      expect(state.nodes["n1"].content).toBe("Done thinking");
      expect(state.nodes["n1"].status).toBe("done");
      expect(state.nodes["n1"].role).toBe("thinking"); // unchanged
    });

    it("ignores update for nonexistent node", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "node_updated", nodeId: "ghost", patch: { content: "boo" } }),
      ]);
      expect(state.nodes["ghost"]).toBeUndefined();
    });
  });

  describe("edge_created", () => {
    it("adds an edge with composite id", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "edge_created", from: "n1", to: "n2", kind: "calls" }),
      ]);
      expect(state.edges).toHaveLength(1);
      expect(state.edges[0]).toEqual({
        id: "n1->n2:calls",
        from: "n1",
        to: "n2",
        kind: "calls",
      });
    });

    it("allows duplicate edges (append-only)", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "edge_created", from: "n1", to: "n2", kind: "calls" }),
        makeEvent(3, { type: "edge_created", from: "n1", to: "n2", kind: "calls" }),
      ]);
      expect(state.edges).toHaveLength(2);
    });
  });

  describe("hitl_required", () => {
    it("creates checkpoint and sets node + run to waiting_human", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "node_created", nodeId: "n1", role: "tool_call", content: "write_file" }),
        makeEvent(3, {
          type: "hitl_required",
          checkpointId: "cp1",
          nodeId: "n1",
          options: ["approve", "reject"],
          context: { kind: "tool_approval", toolName: "write_file" },
        }),
      ]);
      expect(state.runStatus).toBe("waiting_human");
      expect(state.nodes["n1"].status).toBe("waiting_human");
      expect(state.checkpoints["cp1"]).toEqual({
        nodeId: "n1",
        resolved: false,
        context: { kind: "tool_approval", toolName: "write_file" },
      });
    });

    it("handles hitl_required with nonexistent nodeId gracefully", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, {
          type: "hitl_required",
          checkpointId: "cp1",
          nodeId: "ghost",
          options: ["approve"],
        }),
      ]);
      expect(state.runStatus).toBe("waiting_human");
      expect(state.checkpoints["cp1"].nodeId).toBe("ghost");
      expect(state.nodes["ghost"]).toBeUndefined();
    });
  });

  describe("hitl_applied", () => {
    it("resolves checkpoint and resumes run", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "node_created", nodeId: "n1", role: "tool_call", content: "write_file" }),
        makeEvent(3, {
          type: "hitl_required",
          checkpointId: "cp1",
          nodeId: "n1",
          options: ["approve", "reject"],
          context: { kind: "tool_approval" },
        }),
        makeEvent(4, { type: "hitl_applied", checkpointId: "cp1", decision: "approve" }),
      ]);
      expect(state.runStatus).toBe("resumed");
      expect(state.checkpoints["cp1"].resolved).toBe(true);
      expect(state.checkpoints["cp1"].decision).toBe("approve");
      expect(state.nodes["n1"].status).toBe("streaming");
    });

    it("handles unknown checkpointId gracefully", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "hitl_applied", checkpointId: "unknown", decision: "approve" }),
      ]);
      expect(state.runStatus).toBe("resumed");
    });
  });

  describe("tool_executed", () => {
    it("updates node with success result", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "node_created", nodeId: "n1", role: "tool_result", content: "" }),
        makeEvent(3, {
          type: "tool_executed",
          nodeId: "n1",
          toolName: "read_file",
          result: { success: true, output: "file contents here" },
        }),
      ]);
      expect(state.nodes["n1"].content).toBe("file contents here");
      expect(state.nodes["n1"].status).toBe("done");
    });

    it("sets error status on failed result", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "node_created", nodeId: "n1", role: "tool_result", content: "" }),
        makeEvent(3, {
          type: "tool_executed",
          nodeId: "n1",
          toolName: "write_file",
          result: { success: false, output: "Permission denied" },
        }),
      ]);
      expect(state.nodes["n1"].status).toBe("error");
      expect(state.nodes["n1"].content).toBe("Permission denied");
    });

    it("ignores tool_executed for nonexistent node", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, {
          type: "tool_executed",
          nodeId: "ghost",
          toolName: "read_file",
          result: { success: true, output: "data" },
        }),
      ]);
      expect(state.nodes["ghost"]).toBeUndefined();
    });
  });

  describe("loop_step", () => {
    it("updates currentStep and maxSteps", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "loop_step", step: 3, maxSteps: 10 }),
      ]);
      expect(state.currentStep).toBe(3);
      expect(state.maxSteps).toBe(10);
    });
  });

  describe("run_finished", () => {
    it("maps success to finished", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "run_finished", status: "success" }),
      ]);
      expect(state.runStatus).toBe("finished");
    });

    it("maps failed to error", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "run_finished", status: "failed" }),
      ]);
      expect(state.runStatus).toBe("error");
    });

    it("maps aborted to error", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
        makeEvent(2, { type: "run_finished", status: "aborted" }),
      ]);
      expect(state.runStatus).toBe("error");
    });
  });

  describe("unknown event type", () => {
    it("returns base state with updated seq", () => {
      const state = applyAll([
        makeEvent(1, { type: "run_started" }),
      ]);
      const next = applyEvent(state, makeEvent(2, { type: "some_future_event" } as any));
      expect(next.lastSeq).toBe(2);
      expect(next.runStatus).toBe("streaming"); // unchanged from run_started
    });
  });

  describe("immutability", () => {
    it("does not mutate previous state", () => {
      const s0 = createInitialGraphState();
      const s1 = applyEvent(s0, makeEvent(1, { type: "run_started" }));
      const s2 = applyEvent(s1, makeEvent(2, { type: "node_created", nodeId: "n1", role: "thinking", content: "hi" }));

      expect(s0.runStatus).toBe("idle");
      expect(s0.nodes).toEqual({});
      expect(s1.nodes).toEqual({});
      expect(Object.keys(s2.nodes)).toEqual(["n1"]);
    });
  });
});
