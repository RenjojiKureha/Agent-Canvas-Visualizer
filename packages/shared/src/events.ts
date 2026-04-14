export type NodeRole = "thought" | "action" | "observation";
export type NodeStatus = "pending" | "streaming" | "done" | "error" | "waiting_human";

export interface BaseEvent {
  runId: string;
  eventId: string;
  seq: number;
  ts: number;
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
      kind: "plan" | "depends" | "calls";
    })
  | (BaseEvent & {
      type: "hitl_required";
      checkpointId: string;
      nodeId: string;
      options: string[];
    })
  | (BaseEvent & {
      type: "hitl_applied";
      checkpointId: string;
      decision: string;
      note?: string;
    })
  | (BaseEvent & { type: "run_finished"; status: "success" | "failed" | "aborted" });

export interface GraphNode {
  id: string;
  parentId?: string;
  role: NodeRole;
  content: string;
  status: NodeStatus;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "plan" | "depends" | "calls";
}

export type RunStatus = "idle" | "streaming" | "waiting_human" | "resumed" | "finished" | "error";

export interface GraphState {
  runId?: string;
  runStatus: RunStatus;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  checkpoints: Record<string, { nodeId: string; resolved: boolean; decision?: string }>;
  lastSeq: number;
}
