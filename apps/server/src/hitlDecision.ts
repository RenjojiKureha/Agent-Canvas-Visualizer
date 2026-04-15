import type { HitlContext, EmitPayload } from "@acv/shared";
import type { HitlController, CheckpointResult } from "./hitl";

type EmitFn = (event: EmitPayload) => void;
type NextNodeIdFn = () => string;

/**
 * Shared logic for handling answer_review HITL checkpoint:
 * emits checkpoint, waits for decision, emits decision nodes.
 * Returns the action and optional user message for the loop to act on.
 */
export async function handleAnswerDecision(opts: {
  answerNodeId: string;
  hitl: HitlController;
  emit: EmitFn;
  nextNodeId: NextNodeIdFn;
  answer: string;
}): Promise<{ decision: CheckpointResult; hitlNodeId: string }> {
  const { answerNodeId, hitl, emit, nextNodeId, answer } = opts;

  const ctx: HitlContext = { kind: "answer_review", answer };
  const { checkpointId, promise } = hitl.awaitCheckpoint(ctx);
  emit({
    type: "hitl_required",
    checkpointId,
    nodeId: answerNodeId,
    options: ["continue", "revise", "finish"],
    context: ctx,
  });

  const decision = await promise;
  emit({
    type: "hitl_applied",
    checkpointId,
    decision: decision.decision,
    note: decision.note,
  });

  emit({ type: "node_updated", nodeId: answerNodeId, patch: { status: "done" } });

  const hitlNodeId = nextNodeId();
  const label =
    decision.decision === "finish" ? "Finish"
    : decision.decision === "continue" ? "Continue"
    : decision.decision === "revise" ? "Revise"
    : decision.decision;

  const noteText = decision.decision === "finish"
    ? (decision.note ? `\n${decision.note}` : "")
    : decision.decision === "continue"
    ? `\n${decision.note || "I agree with your reasoning and support your recommendation. Please proceed and execute everything as proposed."}`
    : decision.decision === "revise"
    ? `\n${decision.note || "Please revise your answer and improve it."}`
    : (decision.note ? `\n${decision.note}` : "");

  emit({
    type: "node_created",
    nodeId: hitlNodeId,
    parentId: answerNodeId,
    role: "hitl",
    content: `User: ${label}${noteText}`,
    status: "done",
  });
  emit({ type: "edge_created", from: answerNodeId, to: hitlNodeId, kind: "depends" });

  return { decision, hitlNodeId };
}
