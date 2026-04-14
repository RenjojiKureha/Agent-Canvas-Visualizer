import type { AgentEvent, GraphState } from "./events";

export const createInitialGraphState = (): GraphState => ({
  runStatus: "idle",
  nodes: {},
  edges: [],
  checkpoints: {},
  lastSeq: 0
});

export function applyEvent(state: GraphState, event: AgentEvent): GraphState {
  if (event.seq <= state.lastSeq) return state;

  const next: GraphState = {
    ...state,
    runId: event.runId,
    lastSeq: event.seq,
    nodes: { ...state.nodes },
    edges: [...state.edges],
    checkpoints: { ...state.checkpoints }
  };

  switch (event.type) {
    case "run_started":
      next.runStatus = "streaming";
      return next;

    case "node_created":
      next.nodes[event.nodeId] = {
        id: event.nodeId,
        parentId: event.parentId,
        role: event.role,
        content: event.content,
        status: event.status ?? "streaming"
      };
      return next;

    case "node_updated": {
      const node = next.nodes[event.nodeId];
      if (!node) return next;
      next.nodes[event.nodeId] = { ...node, ...event.patch };
      return next;
    }

    case "edge_created":
      next.edges.push({
        id: `${event.from}->${event.to}:${event.kind}`,
        from: event.from,
        to: event.to,
        kind: event.kind
      });
      return next;

    case "hitl_required":
      next.runStatus = "waiting_human";
      next.checkpoints[event.checkpointId] = { nodeId: event.nodeId, resolved: false };
      if (next.nodes[event.nodeId]) {
        next.nodes[event.nodeId] = { ...next.nodes[event.nodeId], status: "waiting_human" };
      }
      return next;

    case "hitl_applied": {
      const cp = next.checkpoints[event.checkpointId];
      if (cp) {
        next.checkpoints[event.checkpointId] = {
          ...cp,
          resolved: true,
          decision: event.decision
        };
        const node = next.nodes[cp.nodeId];
        if (node) next.nodes[cp.nodeId] = { ...node, status: "streaming" };
      }
      next.runStatus = "resumed";
      return next;
    }

    case "run_finished":
      next.runStatus = event.status === "success" ? "finished" : "error";
      return next;

    default:
      return next;
  }
}
