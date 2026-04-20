import type { ServerResponse } from "node:http";
import type { AgentEvent, EmitPayload } from "@acv/shared";
import { LlmClient } from "./llmClient";
import { ToolRegistry } from "./tools/registry";
import { HitlController } from "./hitl";
import { AgentLoop } from "./agentLoop";
import { ClaudeLoop } from "./claudeLoop";
import { createReadFileTool } from "./tools/readFile";
import { createListFilesTool } from "./tools/listFiles";
import { createWriteFileTool } from "./tools/writeFile";
import { RUN_TTL_MS, CLEANUP_INTERVAL_MS, SSE_HEARTBEAT_MS } from "./config";

type AgentProvider = "api" | "claude";

type RunData = {
  seq: number;
  events: AgentEvent[];
  clients: Set<ServerResponse>;
  hitl: HitlController;
  createdAt: number;
  finishedAt?: number;
};

export class RunManager {
  private runs = new Map<string, RunData>();
  private llm: LlmClient | null;
  private provider: AgentProvider;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    const providerRaw = (process.env.AGENT_PROVIDER || "api").toLowerCase();
    this.provider = providerRaw === "claude" ? "claude" : "api";

    this.llm = this.provider === "api" ? new LlmClient() : null;

    console.log(`[acv-server] agent provider: ${this.provider}`);
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  destroy() {
    clearInterval(this.cleanupTimer);
  }

  private cleanup() {
    const now = Date.now();
    for (const [runId, run] of this.runs) {
      if (run.finishedAt && now - run.finishedAt > RUN_TTL_MS) {
        this.runs.delete(runId);
        continue;
      }
      if (!run.finishedAt && run.clients.size === 0 && run.hitl.getPendingCheckpointId()) {
        console.log(`[acv-server] auto-aborting orphaned run ${runId}`);
        run.hitl.enqueueInterrupt({ type: "abort" });
        run.hitl.cancelCheckpoint("orphaned — no SSE clients");
      }
    }
  }

  startRun(runId: string, prompt: string, projectPath?: string) {
    const run = this.ensureRun(runId);
    const hitl = run.hitl;
    const workDir = projectPath || process.env.SANDBOX_ROOT || process.cwd();

    const emit = (event: EmitPayload) => {
      this.emitEvent(runId, event);
    };

    if (this.provider === "claude") {
      const loop = new ClaudeLoop({ runId, prompt, hitl, emit, cwd: workDir });

      void loop.run().then(() => {
        run.finishedAt = Date.now();
      }).catch((err) => {
        console.error(`[run ${runId}] claude loop crashed:`, err);
        this.emitEvent(runId, { type: "run_finished", status: "failed" });
        run.finishedAt = Date.now();
      });
    } else {
      const tools = new ToolRegistry();
      tools.register(createReadFileTool(workDir));
      tools.register(createListFilesTool(workDir));
      tools.register(createWriteFileTool(workDir));

      const loop = new AgentLoop({ runId, prompt, llm: this.llm!, tools, hitl, emit });

      void loop.run().then(() => {
        run.finishedAt = Date.now();
      }).catch((err) => {
        console.error(`[run ${runId}] agent loop crashed:`, err);
        this.emitEvent(runId, { type: "run_finished", status: "failed" });
        run.finishedAt = Date.now();
      });
    }
  }

  intervene(runId: string, checkpointId: string, decision: string, note?: string, modifications?: Record<string, unknown>): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    return run.hitl.resolveCheckpoint(checkpointId, decision, note, modifications);
  }

  interrupt(runId: string, type: string, content?: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    const validTypes = ["inject_message", "pause", "abort"];
    if (!validTypes.includes(type)) return false;
    run.hitl.enqueueInterrupt({ type: type as "inject_message" | "pause" | "abort", content });
    return true;
  }

  addClient(runId: string, res: ServerResponse, lastSeq = 0) {
    const run = this.ensureRun(runId);
    run.clients.add(res);

    const history = run.events.filter((e) => e.seq > lastSeq);
    for (const event of history) this.writeSse(res, event);

    const hb = setInterval(() => {
      this.safeWrite(res, `event: heartbeat\ndata: ${Date.now()}\n\n`);
    }, SSE_HEARTBEAT_MS);
    res.on("close", () => {
      clearInterval(hb);
      this.removeClient(runId, res);
    });
  }

  removeClient(runId: string, res: ServerResponse) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.clients.delete(res);
  }

  getEvents(runId: string): AgentEvent[] {
    return this.runs.get(runId)?.events ?? [];
  }

  private emitEvent(runId: string, event: EmitPayload) {
    const run = this.ensureRun(runId);
    run.seq += 1;
    const fullEvent = {
      ...event,
      runId,
      eventId: `${runId}:${run.seq}`,
      seq: run.seq,
      ts: Date.now(),
    } as AgentEvent;

    run.events.push(fullEvent);
    for (const client of run.clients) this.writeSse(client, fullEvent);
  }

  private writeSse(res: ServerResponse, event: AgentEvent) {
    const payload =
      `id: ${event.seq}\n` +
      `event: ${event.type}\n` +
      `data: ${JSON.stringify(event)}\n\n`;
    this.safeWrite(res, payload);
  }

  private safeWrite(res: ServerResponse, chunk: string) {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch (err) {
      // Client disconnected between close event and next write — swallow.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ERR_STREAM_DESTROYED" && code !== "ERR_STREAM_WRITE_AFTER_END") {
        console.warn("[acv-server] SSE write failed:", (err as Error).message);
      }
    }
  }

  private ensureRun(runId: string): RunData {
    let run = this.runs.get(runId);
    if (!run) {
      run = {
        seq: 0,
        events: [],
        clients: new Set(),
        hitl: new HitlController(),
        createdAt: Date.now(),
      };
      this.runs.set(runId, run);
    }
    return run;
  }
}
