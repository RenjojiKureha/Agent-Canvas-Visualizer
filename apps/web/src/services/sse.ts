import type { AgentEvent } from "@acv/shared";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8787";

/** Seconds without any SSE activity before we consider the connection stale */
const STALE_TIMEOUT_S = 30;

async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body.error === "string") return body.error;
  } catch { /* ignore */ }
  return `${fallback} (${res.status})`;
}

export async function startRunRequest(prompt: string, projectPath?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, projectPath: projectPath || undefined }),
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

export interface RunStreamHandle {
  source: EventSource;
  /** Call to stop the staleness timer (called automatically on source.close) */
  cleanup: () => void;
}

export function connectRunStream(
  runId: string,
  onEvent: (e: AgentEvent) => void,
  onError?: () => void,
  onStale?: () => void,
): RunStreamHandle {
  const source = new EventSource(`${API_BASE}/runs/${runId}/stream`);
  let errorCount = 0;
  const MAX_RETRIES = 5;

  // --- Staleness detection ---
  let lastActivityTs = Date.now();
  const staleTimer = setInterval(() => {
    // Only flag stale if the connection is OPEN (not reconnecting/closed)
    if (source.readyState === EventSource.OPEN) {
      const elapsed = (Date.now() - lastActivityTs) / 1000;
      if (elapsed >= STALE_TIMEOUT_S) {
        console.warn(`[sse] No activity for ${Math.round(elapsed)}s — flagging stale`);
        onStale?.();
      }
    }
  }, 5000);

  function touchActivity() {
    lastActivityTs = Date.now();
  }

  const cleanup = () => clearInterval(staleTimer);

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
      errorCount = 0; // reset on successful event
      touchActivity();
      try {
        const parsed = JSON.parse((message as MessageEvent).data) as AgentEvent;
        onEvent(parsed);
      } catch {
        console.warn(`[sse] Failed to parse event "${name}":`, (message as MessageEvent).data);
      }
    });
  });

  // Listen for server heartbeat events (keeps staleness timer fresh)
  source.addEventListener("heartbeat", () => {
    errorCount = 0; // A heartbeat proves the connection is alive
    touchActivity();
  });

  source.onerror = () => {
    errorCount++;
    if (errorCount >= MAX_RETRIES) {
      cleanup();
      source.close();
      console.error(`[sse] Gave up reconnecting after ${MAX_RETRIES} errors`);
      onError?.();
    }
  };

  return { source, cleanup };
}
