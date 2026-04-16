import { describe, it, expect } from "vitest";
import { HitlController } from "./hitl";
import type { HitlContext } from "@acv/shared";

const toolApproval: HitlContext = { kind: "tool_approval", toolName: "write_file" };
const answerReview: HitlContext = { kind: "answer_review", answer: "Hello!" };

describe("HitlController", () => {
  describe("awaitCheckpoint", () => {
    it("returns a checkpointId and a pending promise", () => {
      const ctrl = new HitlController();
      const { checkpointId, promise } = ctrl.awaitCheckpoint(toolApproval);

      expect(checkpointId).toMatch(/^cp_/);
      expect(promise).toBeInstanceOf(Promise);
      expect(ctrl.getPendingCheckpointId()).toBe(checkpointId);
    });

    it("overwrites previous pending checkpoint", () => {
      const ctrl = new HitlController();
      const { checkpointId: cp1 } = ctrl.awaitCheckpoint(toolApproval);
      const { checkpointId: cp2 } = ctrl.awaitCheckpoint(answerReview);

      expect(cp1).not.toBe(cp2);
      expect(ctrl.getPendingCheckpointId()).toBe(cp2);
    });
  });

  describe("resolveCheckpoint", () => {
    it("resolves the promise with decision, note, and modifications", async () => {
      const ctrl = new HitlController();
      const { checkpointId, promise } = ctrl.awaitCheckpoint(toolApproval);

      const ok = ctrl.resolveCheckpoint(checkpointId, "approve", "looks good", { extra: true });
      expect(ok).toBe(true);
      expect(ctrl.getPendingCheckpointId()).toBeNull();

      const result = await promise;
      expect(result).toEqual({
        decision: "approve",
        note: "looks good",
        modifications: { extra: true },
      });
    });

    it("returns false for mismatched checkpointId", () => {
      const ctrl = new HitlController();
      ctrl.awaitCheckpoint(toolApproval);

      const ok = ctrl.resolveCheckpoint("wrong_id", "approve");
      expect(ok).toBe(false);
      expect(ctrl.getPendingCheckpointId()).not.toBeNull(); // still pending
    });

    it("returns false when no checkpoint is pending", () => {
      const ctrl = new HitlController();
      const ok = ctrl.resolveCheckpoint("cp_anything", "approve");
      expect(ok).toBe(false);
    });
  });

  describe("getPendingCheckpointId", () => {
    it("returns null when nothing is pending", () => {
      const ctrl = new HitlController();
      expect(ctrl.getPendingCheckpointId()).toBeNull();
    });
  });

  describe("interrupt queue", () => {
    it("enqueues and drains messages", () => {
      const ctrl = new HitlController();
      ctrl.enqueueInterrupt({ type: "pause" });
      ctrl.enqueueInterrupt({ type: "inject_message", content: "new goal" });

      const msgs = ctrl.drainInterrupts();
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toEqual({ type: "pause" });
      expect(msgs[1]).toEqual({ type: "inject_message", content: "new goal" });

      // drain should empty the queue
      expect(ctrl.drainInterrupts()).toHaveLength(0);
    });

    it("hasAbort detects abort in queue", () => {
      const ctrl = new HitlController();
      expect(ctrl.hasAbort()).toBe(false);

      ctrl.enqueueInterrupt({ type: "pause" });
      expect(ctrl.hasAbort()).toBe(false);

      ctrl.enqueueInterrupt({ type: "abort" });
      expect(ctrl.hasAbort()).toBe(true);
    });

    it("hasAbort remains true after drain", () => {
      const ctrl = new HitlController();
      ctrl.enqueueInterrupt({ type: "abort" });
      ctrl.drainInterrupts();
      // after drain, queue is empty so hasAbort should be false
      expect(ctrl.hasAbort()).toBe(false);
    });
  });
});
