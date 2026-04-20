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
      return { ...base, runStatus: "streaming", provider: event.provider };

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
        options: event.options,
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
