import type { ServerResponse } from "node:http";
import type { AgentEvent } from "@acv/shared";
import { LlmClient } from "./llmClient";
import { ToolRegistry } from "./tools/registry";
import { HitlController } from "./hitl";
import { AgentLoop } from "./agentLoop";
import { createReadFileTool } from "./tools/readFile";
import { createListFilesTool } from "./tools/listFiles";
import { createWriteFileTool } from "./tools/writeFile";

const RUN_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

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
  private llm = new LlmClient();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
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
      }
    }
  }

  startRun(runId: string, prompt: string) {
    const run = this.ensureRun(runId);
    const hitl = run.hitl;

    const sandboxRoot = process.env.SANDBOX_ROOT || process.cwd();
    const tools = new ToolRegistry();
    tools.register(createReadFileTool(sandboxRoot));
    tools.register(createListFilesTool(sandboxRoot));
    tools.register(createWriteFileTool(sandboxRoot));

    const emit = (event: Record<string, unknown> & { type: string }) => {
      this.emitEvent(runId, event as any);
    };

    const loop = new AgentLoop({ runId, prompt, llm: this.llm, tools, hitl, emit });

    void loop.run().then(() => {
      run.finishedAt = Date.now();
    }).catch((err) => {
      console.error(`[run ${runId}] loop crashed:`, err);
      this.emitEvent(runId, { type: "run_finished", status: "failed" });
      run.finishedAt = Date.now();
    });
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
      res.write(`:heartbeat ${Date.now()}\n\n`);
    }, 15000);
    res.on("close", () => clearInterval(hb));
  }

  removeClient(runId: string, res: ServerResponse) {
    const run = this.runs.get(runId);
    if (!run) return;
    run.clients.delete(res);
  }

  getEvents(runId: string): AgentEvent[] {
    return this.runs.get(runId)?.events ?? [];
  }

  private emitEvent(runId: string, event: Record<string, unknown> & { type: string }) {
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
    res.write(`id: ${event.seq}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
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
