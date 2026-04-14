import type { AgentEvent } from "@acv/shared";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

export async function startRunRequest(prompt: string): Promise<string> {
  const res = await fetch(`${API_BASE}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt })
  });
  if (!res.ok) throw new Error("Failed to start run");
  const data = await res.json();
  return data.runId as string;
}

export async function interveneRequest(runId: string, checkpointId: string, decision: string) {
  const res = await fetch(`${API_BASE}/runs/${runId}/intervene`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkpointId, decision })
  });
  if (!res.ok) throw new Error("Failed to intervene");
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
    "run_finished"
  ];

  names.forEach((name) => {
    source.addEventListener(name, (message) => {
      const parsed = JSON.parse((message as MessageEvent).data) as AgentEvent;
      onEvent(parsed);
    });
  });

  source.onerror = () => {
    // EventSource auto-reconnects.
  };

  return source;
}
