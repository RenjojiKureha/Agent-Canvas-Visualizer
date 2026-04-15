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
