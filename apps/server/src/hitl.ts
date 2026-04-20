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

type InterruptListener = (msg: InterruptMessage) => void;

export class HitlController {
  private pending: PendingCheckpoint | null = null;
  private interruptQueue: InterruptMessage[] = [];
  private interruptListeners = new Set<InterruptListener>();

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

  /**
   * Cancel any pending checkpoint with an abort signal.
   * Used by the run lifecycle — clients should call this when a run is being
   * torn down (e.g., orphaned). The waiting loop will see `decision === "abort"`.
   */
  cancelCheckpoint(reason = "run aborted"): boolean {
    if (!this.pending) return false;
    const cp = this.pending;
    this.pending = null;
    cp.resolve({ decision: "abort", note: reason });
    return true;
  }

  getPendingCheckpointId(): string | null {
    return this.pending?.id ?? null;
  }

  enqueueInterrupt(msg: InterruptMessage) {
    this.interruptQueue.push(msg);
    for (const listener of this.interruptListeners) {
      try {
        listener(msg);
      } catch (err) {
        console.error("[hitl] interrupt listener threw:", err);
      }
    }
  }

  drainInterrupts(): InterruptMessage[] {
    return this.interruptQueue.splice(0);
  }

  hasAbort(): boolean {
    return this.interruptQueue.some((m) => m.type === "abort");
  }

  /**
   * Subscribe to interrupts as they arrive. Returns an unsubscribe function.
   * Listeners receive every new interrupt, but the queue is shared — callers
   * still decide whether to `drainInterrupts` in their own loop.
   */
  onInterrupt(listener: InterruptListener): () => void {
    this.interruptListeners.add(listener);
    return () => this.interruptListeners.delete(listener);
  }
}
