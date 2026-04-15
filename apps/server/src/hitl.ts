import { randomUUID } from "node:crypto";
import type { HitlContext } from "@acv/shared";

export interface CheckpointResult {
  decision: string;
  note?: string;
  modifications?: Record<string, unknown>;
}

export interface InterruptMessage {
  type: "inject_message" | "pause" | "abort";
  content?: string;
}

interface PendingCheckpoint {
  id: string;
  context: HitlContext;
  resolve: (result: CheckpointResult) => void;
}

export class HitlController {
  private pending: PendingCheckpoint | null = null;
  private interruptQueue: InterruptMessage[] = [];

  awaitCheckpoint(context: HitlContext): { checkpointId: string; promise: Promise<CheckpointResult> } {
    const checkpointId = `cp_${randomUUID().slice(0, 8)}`;
    let resolveFunc!: (result: CheckpointResult) => void;
    const promise = new Promise<CheckpointResult>((resolve) => {
      resolveFunc = resolve;
    });

    this.pending = { id: checkpointId, context, resolve: resolveFunc };
    return { checkpointId, promise };
  }

  resolveCheckpoint(checkpointId: string, decision: string, note?: string, modifications?: Record<string, unknown>): boolean {
    if (!this.pending || this.pending.id !== checkpointId) return false;
    const cp = this.pending;
    this.pending = null;
    cp.resolve({ decision, note, modifications });
    return true;
  }

  getPendingCheckpointId(): string | null {
    return this.pending?.id ?? null;
  }

  enqueueInterrupt(msg: InterruptMessage) {
    this.interruptQueue.push(msg);
  }

  drainInterrupts(): InterruptMessage[] {
    return this.interruptQueue.splice(0);
  }

  hasAbort(): boolean {
    return this.interruptQueue.some((m) => m.type === "abort");
  }
}
