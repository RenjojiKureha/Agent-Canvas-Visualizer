import type { HitlContext } from "@acv/shared";
import { BaseLoop, type BaseLoopOptions } from "./baseLoop";
import type { LlmClient, LlmMessage, LlmToolCall } from "./llmClient";
import type { ToolRegistry } from "./tools/registry";
import { handleAnswerDecision } from "./hitlDecision";
import { DEFAULT_MAX_STEPS, DEFAULT_SYSTEM_PROMPT, DEFAULT_CONTINUE_NOTE, DEFAULT_REVISE_NOTE } from "./config";

interface AgentLoopOptions extends BaseLoopOptions {
  llm: LlmClient;
  tools: ToolRegistry;
  maxSteps?: number;
  systemPrompt?: string;
}

export class AgentLoop extends BaseLoop {
  private readonly llm: LlmClient;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly systemPrompt: string;
  private messages: LlmMessage[] = [];
  private step = 0;

  constructor(opts: AgentLoopOptions) {
    super(opts);
    this.llm = opts.llm;
    this.tools = opts.tools;
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async run(): Promise<void> {
    this.emit({ type: "run_started", provider: "api" });

    this.messages.push({ role: "system", content: this.systemPrompt });
    this.messages.push({ role: "user", content: this.base.prompt });

    try {
      while (this.step < this.maxSteps && !this.aborted) {
        if (!this.drainInterrupts()) return;

        this.step++;
        this.emit({ type: "loop_step", step: this.step, maxSteps: this.maxSteps });

        const done = await this.thinkStep();
        if (done) return;
      }

      if (!this.aborted) {
        this.emitFailure(`Reached maximum steps (${this.maxSteps}). Stopping.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitFailure(`Agent loop error: ${msg}`);
    }
  }

  /** Returns true if loop should exit (abort). */
  private drainInterrupts(): boolean {
    const interrupts = this.base.hitl.drainInterrupts();
    for (const intr of interrupts) {
      if (intr.type === "abort") {
        this.aborted = true;
        this.emitFinished("aborted");
        return false;
      }
      if (intr.type === "inject_message" && intr.content) {
        this.messages.push({ role: "user", content: intr.content });
      }
    }
    return true;
  }

  /** Returns true if loop should terminate (final answer + finish). */
  private async thinkStep(): Promise<boolean> {
    const thinkNodeId = this.nextNodeId();
    this.emit({
      type: "node_created",
      nodeId: thinkNodeId,
      role: "thinking",
      content: "Thinking...",
      status: "streaming",
    });

    let thinkText = "";
    const response = await this.llm.chat(
      this.messages,
      this.tools.toOpenAITools(),
      (delta) => {
        thinkText += delta;
        this.emit({
          type: "node_updated",
          nodeId: thinkNodeId,
          patch: { content: thinkText, status: "streaming" },
        });
      },
    );

    const finalThinkText = response.text || (response.toolCalls.length > 0 ? "(deciding to use tools)" : "(empty response)");
    this.emit({
      type: "node_updated",
      nodeId: thinkNodeId,
      patch: { content: finalThinkText, status: "done" },
    });

    if (response.toolCalls.length > 0) {
      this.messages.push({
        role: "assistant",
        content: response.text || "",
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });
    } else {
      this.messages.push({ role: "assistant", content: response.text });
    }

    if (response.toolCalls.length === 0) {
      return this.finalAnswerStep(thinkNodeId, response.text);
    }

    for (const toolCall of response.toolCalls) {
      if (this.aborted) break;
      await this.processToolCall(toolCall, thinkNodeId);
    }
    return false;
  }

  /** Returns true if run should finish. */
  private async finalAnswerStep(thinkNodeId: string, answerText: string): Promise<boolean> {
    const answerNodeId = this.nextNodeId();
    this.emit({
      type: "node_created",
      nodeId: answerNodeId,
      parentId: thinkNodeId,
      role: "answer",
      content: answerText || "(empty)",
      status: "waiting_human",
    });
    this.emit({ type: "edge_created", from: thinkNodeId, to: answerNodeId, kind: "depends" });

    const { decision } = await handleAnswerDecision({
      answerNodeId,
      hitl: this.base.hitl,
      emit: (e) => this.emit(e),
      nextNodeId: () => this.nextNodeId(),
      answer: answerText || "",
    });

    if (decision.decision === "finish") {
      this.emitFinished("success");
      return true;
    }
    if (decision.decision === "abort") {
      this.aborted = true;
      this.emitFinished("aborted");
      return true;
    }
    if (decision.decision === "continue") {
      this.messages.push({ role: "user", content: decision.note || DEFAULT_CONTINUE_NOTE });
      return false;
    }
    if (decision.decision === "revise") {
      this.messages.push({ role: "user", content: decision.note || DEFAULT_REVISE_NOTE });
      return false;
    }
    return false;
  }

  private async processToolCall(toolCall: LlmToolCall, parentNodeId: string): Promise<void> {
    const tool = this.tools.get(toolCall.name);

    const callNodeId = this.nextNodeId();
    this.emit({
      type: "node_created",
      nodeId: callNodeId,
      parentId: parentNodeId,
      role: "tool_call",
      content: `${toolCall.name}(${JSON.stringify(toolCall.args)})`,
      status: tool?.requiresApproval ? "waiting_human" : "streaming",
      toolName: toolCall.name,
      toolArgs: toolCall.args,
    });
    this.emit({ type: "edge_created", from: parentNodeId, to: callNodeId, kind: "tool" });

    if (tool?.requiresApproval) {
      const ctx: HitlContext = { kind: "tool_approval", toolName: toolCall.name, toolArgs: toolCall.args };
      const { checkpointId, promise } = this.base.hitl.awaitCheckpoint(ctx);
      this.emit({
        type: "hitl_required",
        checkpointId,
        nodeId: callNodeId,
        options: ["approve", "reject", "modify_args"],
        context: ctx,
      });

      const decision = await promise;
      this.emit({
        type: "hitl_applied",
        checkpointId,
        decision: decision.decision,
        note: decision.note,
        modifications: decision.modifications,
      });

      if (decision.decision === "abort") {
        this.aborted = true;
        this.emit({
          type: "node_updated",
          nodeId: callNodeId,
          patch: { content: `${toolCall.name} — run aborted`, status: "error" },
        });
        return;
      }

      if (decision.decision === "reject") {
        this.emit({
          type: "node_updated",
          nodeId: callNodeId,
          patch: { content: `${toolCall.name} — rejected by user`, status: "error" },
        });
        this.messages.push({
          role: "tool",
          content: `Tool call rejected by user. Reason: ${decision.note || "No reason given."}`,
          tool_call_id: toolCall.id,
        });
        return;
      }

      if (decision.decision === "modify_args" && decision.modifications) {
        Object.assign(toolCall.args, decision.modifications);
        this.emit({
          type: "node_updated",
          nodeId: callNodeId,
          patch: { content: `${toolCall.name}(${JSON.stringify(toolCall.args)})` },
        });
      }
    }

    this.emit({ type: "node_updated", nodeId: callNodeId, patch: { status: "streaming" } });

    const resultNodeId = this.nextNodeId();

    if (!tool) {
      const errOutput = `Unknown tool: ${toolCall.name}`;
      this.emit({
        type: "node_created",
        nodeId: resultNodeId,
        parentId: callNodeId,
        role: "tool_result",
        content: errOutput,
        status: "error",
        toolName: toolCall.name,
      });
      this.emit({ type: "edge_created", from: callNodeId, to: resultNodeId, kind: "depends" });
      this.messages.push({ role: "tool", content: errOutput, tool_call_id: toolCall.id });
      return;
    }

    try {
      const result = await tool.execute(toolCall.args);

      this.emit({ type: "node_updated", nodeId: callNodeId, patch: { status: "done" } });
      this.emit({
        type: "node_created",
        nodeId: resultNodeId,
        parentId: callNodeId,
        role: "tool_result",
        content: result.output,
        status: result.success ? "done" : "error",
        toolName: toolCall.name,
      });
      this.emit({ type: "edge_created", from: callNodeId, to: resultNodeId, kind: "depends" });
      this.emit({ type: "tool_executed", nodeId: resultNodeId, toolName: toolCall.name, result });

      this.messages.push({ role: "tool", content: result.output, tool_call_id: toolCall.id });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "node_created",
        nodeId: resultNodeId,
        parentId: callNodeId,
        role: "tool_result",
        content: `Tool execution error: ${errMsg}`,
        status: "error",
        toolName: toolCall.name,
      });
      this.emit({ type: "edge_created", from: callNodeId, to: resultNodeId, kind: "depends" });
      this.messages.push({ role: "tool", content: `Error: ${errMsg}`, tool_call_id: toolCall.id });
    }
  }
}
