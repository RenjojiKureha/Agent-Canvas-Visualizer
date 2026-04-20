import type { EmitPayload, NodeRole } from "@acv/shared";
import type { HitlController } from "./hitl";

export type EmitFn = (event: EmitPayload) => void;

export interface BaseLoopOptions {
  runId: string;
  prompt: string;
  hitl: HitlController;
  emit: EmitFn;
}

/**
 * Shared infrastructure for agent loops: node-id generation, error emission,
 * run finalization. Subclasses implement `run()` with their specific flow.
 */
export abstract class BaseLoop {
  protected nodeSeq = 0;
  protected aborted = false;

  constructor(protected readonly base: BaseLoopOptions) {}

  abstract run(): Promise<void>;

  protected nextNodeId(): string {
    this.nodeSeq++;
    return `n${this.nodeSeq}`;
  }

  protected emit(event: EmitPayload): void {
    this.base.emit(event);
  }

  protected emitError(message: string, role: NodeRole = "error"): string {
    const nodeId = this.nextNodeId();
    this.emit({
      type: "node_created",
      nodeId,
      role,
      content: message,
      status: "error",
    });
    return nodeId;
  }

  protected emitFinished(status: "success" | "failed" | "aborted"): void {
    this.emit({ type: "run_finished", status });
  }

  protected emitFailure(message: string): void {
    this.emitError(message);
    this.emitFinished("failed");
  }
}
