import type { AgentEvent, HitlContext } from "@acv/shared";
import type { LlmClient, LlmToolCall } from "./llmClient";
import type { ToolRegistry } from "./tools/registry";
import type { HitlController } from "./hitl";

// Use Record instead of Omit<UnionType> to avoid TS excess property checking issues
type EmitFn = (event: Record<string, unknown> & { type: string }) => void;

interface AgentLoopOptions {
  runId: string;
  prompt: string;
  llm: LlmClient;
  tools: ToolRegistry;
  hitl: HitlController;
  emit: EmitFn;
  maxSteps?: number;
  systemPrompt?: string;
}

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export class AgentLoop {
  private opts: Required<Omit<AgentLoopOptions, "systemPrompt">> & { systemPrompt: string };
  private messages: ChatMessage[] = [];
  private nodeSeq = 0;
  private step = 0;
  private aborted = false;

  constructor(opts: AgentLoopOptions) {
    this.opts = {
      ...opts,
      maxSteps: opts.maxSteps ?? 20,
      systemPrompt: opts.systemPrompt ??
        "You are a helpful agent that can read and write files in a project. " +
        "Use the provided tools to accomplish the user's task. " +
        "Think step by step. When you have completed the task, provide a final answer without tool calls.",
    };
  }

  async run(): Promise<void> {
    const { emit } = this.opts;

    emit({ type: "run_started", provider: "api" });

    this.messages.push({ role: "system", content: this.opts.systemPrompt });
    this.messages.push({ role: "user", content: this.opts.prompt });

    try {
      while (this.step < this.opts.maxSteps && !this.aborted) {
        const interrupts = this.opts.hitl.drainInterrupts();
        for (const intr of interrupts) {
          if (intr.type === "abort") {
            this.aborted = true;
            emit({ type: "run_finished", status: "aborted" });
            return;
          }
          if (intr.type === "inject_message" && intr.content) {
            this.messages.push({ role: "user", content: intr.content });
          }
        }

        this.step++;
        emit({ type: "loop_step", step: this.step, maxSteps: this.opts.maxSteps });

        // 1. Think: call LLM
        const thinkNodeId = this.nextNodeId();
        emit({
          type: "node_created",
          nodeId: thinkNodeId,
          role: "thinking",
          content: "Thinking...",
          status: "streaming",
        });

        let thinkText = "";
        const response = await this.opts.llm.chat(
          this.messages,
          this.opts.tools.toOpenAITools(),
          (delta) => {
            thinkText += delta;
            emit({
              type: "node_updated",
              nodeId: thinkNodeId,
              patch: { content: thinkText, status: "streaming" },
            });
          },
        );

        const finalThinkText = response.text || (response.toolCalls.length > 0 ? "(deciding to use tools)" : "(empty response)");
        emit({
          type: "node_updated",
          nodeId: thinkNodeId,
          patch: { content: finalThinkText, status: "done" },
        });

        // Add assistant message to history
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

        // 2. If no tool calls → final answer
        if (response.toolCalls.length === 0) {
          const answerNodeId = this.nextNodeId();
          emit({
            type: "node_created",
            nodeId: answerNodeId,
            parentId: thinkNodeId,
            role: "answer",
            content: response.text || "(empty)",
            status: "waiting_human",
          });
          emit({ type: "edge_created", from: thinkNodeId, to: answerNodeId, kind: "depends" });

          const ctx: HitlContext = { kind: "answer_review", answer: response.text };
          const { checkpointId, promise } = this.opts.hitl.awaitCheckpoint(ctx);
          emit({
            type: "hitl_required",
            checkpointId,
            nodeId: answerNodeId,
            options: ["accept", "revise", "finish"],
            context: ctx,
          });

          const decision = await promise;
          emit({
            type: "hitl_applied",
            checkpointId,
            decision: decision.decision,
            note: decision.note,
          });

          if (decision.decision === "accept" || decision.decision === "finish") {
            emit({ type: "node_updated", nodeId: answerNodeId, patch: { status: "done" } });
            emit({ type: "run_finished", status: "success" });
            return;
          }

          if (decision.decision === "revise") {
            const feedback = decision.note || "Please revise your answer and improve it.";
            this.messages.push({ role: "user", content: feedback });
            emit({
              type: "node_updated",
              nodeId: answerNodeId,
              patch: { content: `${response.text}\n\n[Revision requested: ${feedback}]`, status: "done" },
            });
            continue;
          }
        }

        // 3. Process tool calls
        for (const toolCall of response.toolCalls) {
          if (this.aborted) break;
          await this.processToolCall(toolCall, thinkNodeId);
        }
      }

      if (!this.aborted) {
        const maxNodeId = this.nextNodeId();
        emit({
          type: "node_created",
          nodeId: maxNodeId,
          role: "error",
          content: `Reached maximum steps (${this.opts.maxSteps}). Stopping.`,
          status: "error",
        });
        emit({ type: "run_finished", status: "failed" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errNodeId = this.nextNodeId();
      emit({
        type: "node_created",
        nodeId: errNodeId,
        role: "error",
        content: `Agent loop error: ${msg}`,
        status: "error",
      });
      emit({ type: "run_finished", status: "failed" });
    }
  }

  private async processToolCall(toolCall: LlmToolCall, parentNodeId: string): Promise<void> {
    const { emit } = this.opts;
    const tool = this.opts.tools.get(toolCall.name);

    const callNodeId = this.nextNodeId();
    emit({
      type: "node_created",
      nodeId: callNodeId,
      parentId: parentNodeId,
      role: "tool_call",
      content: `${toolCall.name}(${JSON.stringify(toolCall.args)})`,
      status: tool?.requiresApproval ? "waiting_human" : "streaming",
      toolName: toolCall.name,
      toolArgs: toolCall.args,
    });
    emit({ type: "edge_created", from: parentNodeId, to: callNodeId, kind: "tool" });

    // HITL: tool approval if required
    if (tool?.requiresApproval) {
      const ctx: HitlContext = { kind: "tool_approval", toolName: toolCall.name, toolArgs: toolCall.args };
      const { checkpointId, promise } = this.opts.hitl.awaitCheckpoint(ctx);
      emit({
        type: "hitl_required",
        checkpointId,
        nodeId: callNodeId,
        options: ["approve", "reject", "modify_args"],
        context: ctx,
      });

      const decision = await promise;
      emit({
        type: "hitl_applied",
        checkpointId,
        decision: decision.decision,
        note: decision.note,
        modifications: decision.modifications,
      });

      if (decision.decision === "reject") {
        emit({
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
        emit({
          type: "node_updated",
          nodeId: callNodeId,
          patch: { content: `${toolCall.name}(${JSON.stringify(toolCall.args)})` },
        });
      }
    }

    emit({ type: "node_updated", nodeId: callNodeId, patch: { status: "streaming" } });

    const resultNodeId = this.nextNodeId();

    if (!tool) {
      const errOutput = `Unknown tool: ${toolCall.name}`;
      emit({
        type: "node_created",
        nodeId: resultNodeId,
        parentId: callNodeId,
        role: "tool_result",
        content: errOutput,
        status: "error",
        toolName: toolCall.name,
      });
      emit({ type: "edge_created", from: callNodeId, to: resultNodeId, kind: "depends" });
      this.messages.push({ role: "tool", content: errOutput, tool_call_id: toolCall.id });
      return;
    }

    try {
      const result = await tool.execute(toolCall.args);

      emit({ type: "node_updated", nodeId: callNodeId, patch: { status: "done" } });
      emit({
        type: "node_created",
        nodeId: resultNodeId,
        parentId: callNodeId,
        role: "tool_result",
        content: result.output,
        status: result.success ? "done" : "error",
        toolName: toolCall.name,
      });
      emit({ type: "edge_created", from: callNodeId, to: resultNodeId, kind: "depends" });
      emit({ type: "tool_executed", nodeId: resultNodeId, toolName: toolCall.name, result });

      this.messages.push({ role: "tool", content: result.output, tool_call_id: toolCall.id });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit({
        type: "node_created",
        nodeId: resultNodeId,
        parentId: callNodeId,
        role: "tool_result",
        content: `Tool execution error: ${errMsg}`,
        status: "error",
        toolName: toolCall.name,
      });
      emit({ type: "edge_created", from: callNodeId, to: resultNodeId, kind: "depends" });
      this.messages.push({ role: "tool", content: `Error: ${errMsg}`, tool_call_id: toolCall.id });
    }
  }

  private nextNodeId(): string {
    this.nodeSeq++;
    return `n${this.nodeSeq}`;
  }
}
