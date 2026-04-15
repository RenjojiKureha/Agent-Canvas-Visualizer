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
