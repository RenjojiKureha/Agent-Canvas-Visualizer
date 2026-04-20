import type { GraphNode, GraphEdge } from "@acv/shared";

/** Layout constants (kept in a single source of truth for node/edge sizing). */
export const PREVIEW_LINES = 8;
export const MAX_CHARS_PER_LINE = 52;
export const NODE_WIDTH = 420;
export const NODE_GAP_Y = 32;
export const BRANCH_GAP_X = 72;
export const HEADER_H = 42;
export const BOTTOM_PAD = 16;
export const EDGE_GAP = 8;

export type LayoutNode = GraphNode & {
  x: number;
  y: number;
  width: number;
  height: number;
  badgeLabel: string;
  badgeWidth: number;
  statusLabel: string;
  lines: string[];
  truncated: boolean;
  totalLines: number;
  fillColor: string;
  statusColor: string;
  isNew: boolean;
};

export type LayoutEdge = GraphEdge & {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  isNew: boolean;
};

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

export function statusText(status: GraphNode["status"]): string {
  switch (status) {
    case "streaming": return "streaming...";
    case "waiting_human": return "waiting";
    default: return status;
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

export function decisionColor(decision: string): string {
  switch (decision) {
    case "approve": return "#16a34a";
    case "reject": return "#dc2626";
    case "continue": return "#2563eb";
    case "revise": return "#d97706";
    case "finish": return "#374151";
    case "retry": return "#059669";
    case "abort": return "#dc2626";
    default: return "#6b7280";
  }
}

export function decisionBadgeWidth(decision: string): number {
  return decision.length * 6.5 + 16;
}

export function edgeStyle(kind: GraphEdge["kind"]): { color: string; label: string; dash?: string } {
  switch (kind) {
    case "calls": return { color: "#3b82f6", label: "calls" };
    case "tool":  return { color: "#7c3aed", label: "result" };
    case "plan":  return { color: "#059669", label: "plan", dash: "6 3" };
    case "depends": return { color: "#d97706", label: "dep", dash: "4 2" };
    default: return { color: "#94a3b8", label: "" };
  }
}

export function edgePath(e: LayoutEdge): string {
  const dx = Math.abs(e.x2 - e.x1);
  const dy = Math.abs(e.y2 - e.y1);

  if (dx > dy) {
    const cp = Math.max(dx * 0.4, 30);
    return `M ${e.x1} ${e.y1} C ${e.x1 + cp} ${e.y1}, ${e.x2 - cp} ${e.y2}, ${e.x2} ${e.y2}`;
  }
  const cp = Math.max(dy * 0.4, 20);
  return `M ${e.x1} ${e.y1} C ${e.x1} ${e.y1 + cp}, ${e.x2} ${e.y2 - cp}, ${e.x2} ${e.y2}`;
}

export function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars));
  return out;
}

export function nodeHeight(n: GraphNode): number {
  const rawLines = (n.content || "").split(/\r?\n/);
  const allWrapped = rawLines.flatMap((l) => wrapLine(l, MAX_CHARS_PER_LINE));
  const lineCount = Math.min(allWrapped.length, PREVIEW_LINES + 1);
  return HEADER_H + Math.max(lineCount, 1) * 16 + BOTTOM_PAD;
}
