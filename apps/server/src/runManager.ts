import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { AgentEvent } from "@acv/shared";
import { OpenAIAgentAdapter } from "./openaiAdapter";

type EmitEvent = {
  [K in AgentEvent["type"]]: Omit<Extract<AgentEvent, { type: K }>, "runId" | "eventId" | "seq" | "ts">;
}[AgentEvent["type"]];

type RunData = {
  seq: number;
  events: AgentEvent[];
  clients: Set<ServerResponse>;
  waitingCheckpointId?: string;
  waitingNodeId?: string;
  prompt?: string;
  answer?: string;
};

export class RunManager {
  private runs = new Map<string, RunData>();
  private agent = new OpenAIAgentAdapter();

  startRun(runId: string, prompt: string) {
    const run = this.ensureRun(runId);
    run.prompt = prompt;

    this.emit(runId, { type: "run_started" });
    this.emit(runId, {
      type: "node_created",
      nodeId: "n1",
      role: "thought",
      content: `正在请求 Agent (${this.agent.getProviderInfo()})...`,
      status: "streaming"
    });

    void this.executeAgent(runId, prompt);
  }

  intervene(runId: string, checkpointId: string, decision: string, note?: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.waitingCheckpointId !== checkpointId || !run.waitingNodeId) return false;

    this.emit(runId, {
      type: "hitl_applied",
      checkpointId,
      decision,
      note
    });

    this.emit(runId, {
      type: "node_updated",
      nodeId: run.waitingNodeId,
      patch: { content: `人工决策: ${decision}${note ? ` (${note})` : ""}`, status: "done" }
    });

    this.emit(runId, {
      type: "node_created",
      nodeId: "n3",
      parentId: run.waitingNodeId,
      role: "observation",
      content: `Run 完成，人工选择: ${decision}`,
      status: "done"
    });
    this.emit(runId, { type: "edge_created", from: run.waitingNodeId, to: "n3", kind: "depends" });
    this.emit(runId, { type: "run_finished", status: "success" });

    run.waitingCheckpointId = undefined;
    run.waitingNodeId = undefined;
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

  private async executeAgent(runId: string, prompt: string) {
    if (!this.agent.isReady()) {
      this.emit(runId, {
        type: "node_updated",
        nodeId: "n1",
        patch: {
          content: "AGENT_API_KEY 未设置，无法调用模型。",
          status: "error"
        }
      });
      this.emit(runId, { type: "run_finished", status: "failed" });
      return;
    }

    let answer = "";

    try {
      answer = await this.agent.generate({
        prompt,
        onDelta: (delta) => {
          answer += delta;
          this.emit(runId, {
            type: "node_updated",
            nodeId: "n1",
            patch: {
              content: answer,
              status: "streaming"
            }
          });
        }
      });

      this.emit(runId, {
        type: "node_updated",
        nodeId: "n1",
        patch: {
          content: answer || "(空响应)",
          status: "done"
        }
      });

      this.emit(runId, {
        type: "node_created",
        nodeId: "n2",
        parentId: "n1",
        role: "action",
        content: "模型回答已生成，请人工确认是否采纳。",
        status: "waiting_human"
      });
      this.emit(runId, { type: "edge_created", from: "n1", to: "n2", kind: "plan" });

      const checkpointId = `cp_${randomUUID().slice(0, 8)}`;
      const run = this.ensureRun(runId);
      run.waitingCheckpointId = checkpointId;
      run.waitingNodeId = "n2";
      run.answer = answer;

      this.emit(runId, {
        type: "hitl_required",
        checkpointId,
        nodeId: "n2",
        options: ["accept", "revise", "retry"]
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit(runId, {
        type: "node_updated",
        nodeId: "n1",
        patch: {
          content: `模型调用失败: ${message}`,
          status: "error"
        }
      });
      this.emit(runId, { type: "run_finished", status: "failed" });
    }
  }

  private ensureRun(runId: string): RunData {
    let run = this.runs.get(runId);
    if (!run) {
      run = { seq: 0, events: [], clients: new Set() };
      this.runs.set(runId, run);
    }
    return run;
  }

  private emit(runId: string, event: EmitEvent) {
    const run = this.ensureRun(runId);
    run.seq += 1;
    const fullEvent = {
      ...event,
      runId,
      eventId: `${runId}:${run.seq}`,
      seq: run.seq,
      ts: Date.now()
    } as AgentEvent;

    run.events.push(fullEvent);
    for (const client of run.clients) this.writeSse(client, fullEvent);
  }

  private writeSse(res: ServerResponse, event: AgentEvent) {
    res.write(`id: ${event.seq}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
