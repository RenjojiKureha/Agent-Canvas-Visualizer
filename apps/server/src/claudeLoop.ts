import { spawn, type ChildProcess } from "node:child_process";
import type { HitlController } from "./hitl";
import type { EmitPayload, HitlContext } from "@acv/shared";
import { handleAnswerDecision } from "./hitlDecision";

type EmitFn = (event: EmitPayload) => void;

interface ClaudeLoopOptions {
  runId: string;
  prompt: string;
  hitl: HitlController;
  emit: EmitFn;
  claudeCommand?: string;
  cwd?: string;
}

/**
 * Runs Claude Code CLI and maps its stream-json output to DAG nodes.
 *
 * Real CLI output format (verified):
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."}]}}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{...}}]}}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"answer"}]}}
 *   {"type":"result","subtype":"success","result":"..."}
 */
export class ClaudeLoop {
  private claudeCommand: string;
  private child: ChildProcess | null = null;
  private aborted = false;
  private nodeSeq = 0;

  // Mutable state for building the DAG
  private currentThinkNodeId: string | null = null;
  private currentThinkText = "";
  private lastParentNodeId: string | null = null;
  private finalText = "";

  constructor(private opts: ClaudeLoopOptions) {
    this.claudeCommand = opts.claudeCommand || process.env.AGENT_COMMAND || "claude";
  }

  async run(): Promise<void> {
    const { emit, prompt } = this.opts;

    emit({ type: "run_started", provider: "claude" });

    try {
      await this.spawnClaude(prompt);

      if (this.aborted) {
        emit({ type: "run_finished", status: "aborted" });
        return;
      }

      // Finalize last thinking node if still open
      this.finalizeThinkingNode();

      // Create answer node and HITL checkpoint
      const answerText = this.finalText || "(empty response)";
      await this.answerCheckpointLoop(answerText);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errNodeId = this.nextNodeId();
      emit({
        type: "node_created",
        nodeId: errNodeId,
        role: "error",
        content: `Claude CLI error: ${msg}`,
        status: "error",
      });
      emit({ type: "run_finished", status: "failed" });
    }
  }

  /**
   * HITL loop: show answer, wait for user decision, revise if needed.
   */
  private async answerCheckpointLoop(answerText: string): Promise<void> {
    const { emit, hitl } = this.opts;
    let currentAnswer = answerText;

    while (true) {
      const answerNodeId = this.nextNodeId();
      emit({
        type: "node_created",
        nodeId: answerNodeId,
        parentId: this.lastParentNodeId ?? undefined,
        role: "answer",
        content: currentAnswer,
        status: "waiting_human",
      });
      if (this.lastParentNodeId) {
        emit({ type: "edge_created", from: this.lastParentNodeId, to: answerNodeId, kind: "depends" });
      }

      const { decision, hitlNodeId } = await handleAnswerDecision({
        answerNodeId,
        hitl,
        emit,
        nextNodeId: () => this.nextNodeId(),
        answer: currentAnswer,
      });

      if (decision.decision === "finish") {
        emit({ type: "run_finished", status: "success" });
        return;
      }

      this.lastParentNodeId = hitlNodeId;
      this.currentThinkNodeId = null;
      this.currentThinkText = "";
      this.finalText = "";

      const userMsg = decision.decision === "continue"
        ? (decision.note || "I agree with your reasoning and support your recommendation. Please proceed and execute everything as proposed.")
        : (decision.note || "Please improve your answer.");

      const prompt = decision.decision === "continue"
        ? `Previous result:\n${currentAnswer}\n\nUser instruction:\n${userMsg}\n\nPlease continue based on the instruction above.`
        : `Previous answer:\n${currentAnswer}\n\nUser feedback:\n${userMsg}\n\nPlease revise your answer based on the feedback above.`;

      try {
        await this.spawnClaude(prompt);
        this.finalizeThinkingNode();
        currentAnswer = this.finalText || "(empty response)";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: "node_created",
          nodeId: this.nextNodeId(),
          role: "error",
          content: `${decision.decision === "continue" ? "Continue" : "Revision"} failed: ${msg}`,
          status: "error",
        });
        emit({ type: "run_finished", status: "failed" });
        return;
      }
    }
  }

  abort() {
    this.aborted = true;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  private spawnClaude(prompt: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const { emit } = this.opts;

      const args = [
        "-p",
        "--verbose",
        "--output-format", "stream-json",
        "--include-partial-messages",
      ];

      this.child = spawn(this.claudeCommand, args, {
        shell: true,
        env: process.env,
        windowsHide: true,
        cwd: this.opts.cwd || undefined,
      });

      // Pass prompt via stdin to avoid shell argument splitting
      this.child.stdin!.write(prompt);
      this.child.stdin!.end();

      let stdoutBuf = "";
      let stderrBuf = "";

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          return;
        }

        // Skip system events (hooks, init)
        if (obj?.type === "system") return;

        // Handle assistant messages
        if (obj?.type === "assistant") {
          const content = obj.message?.content;
          if (!Array.isArray(content)) return;

          for (const block of content) {
            this.handleContentBlock(block);
          }
          return;
        }

        // Handle final result — capture text for answer node
        if (obj?.type === "result") {
          if (typeof obj.result === "string" && obj.result.length > 0) {
            this.finalText = obj.result;
          }
          return;
        }
      };

      this.child.stdout!.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        let idx = stdoutBuf.indexOf("\n");
        while (idx >= 0) {
          handleLine(stdoutBuf.slice(0, idx));
          stdoutBuf = stdoutBuf.slice(idx + 1);
          idx = stdoutBuf.indexOf("\n");
        }
      });

      this.child.stderr!.on("data", (chunk) => {
        stderrBuf += chunk.toString();
      });

      this.child.on("error", (err) => {
        reject(new Error(`Failed to start '${this.claudeCommand}': ${err.message}`));
      });

      this.child.on("close", (code) => {
        if (stdoutBuf.trim()) handleLine(stdoutBuf);
        this.child = null;

        if (this.aborted) {
          resolve();
          return;
        }

        if (code === 0) {
          resolve();
        } else {
          const errMsg = stderrBuf.trim() || `Claude exited with code ${code}`;
          reject(new Error(errMsg));
        }
      });

      // Poll for abort interrupts
      const checkAbort = setInterval(() => {
        const interrupts = this.opts.hitl.drainInterrupts();
        for (const intr of interrupts) {
          if (intr.type === "abort") {
            this.abort();
          }
        }
      }, 500);
      this.child.on("close", () => clearInterval(checkAbort));
    });
  }

  private handleContentBlock(block: any): void {
    const { emit } = this.opts;

    // Thinking block
    if (block.type === "thinking" && typeof block.thinking === "string") {
      this.ensureThinkingNode();
      this.currentThinkText += block.thinking;
      emit({
        type: "node_updated",
        nodeId: this.currentThinkNodeId!,
        patch: { content: this.currentThinkText, status: "streaming" },
      });
      return;
    }

    // Tool use block — CLI has already executed this tool
    if (block.type === "tool_use") {
      this.finalizeThinkingNode();

      const toolNodeId = this.nextNodeId();
      const toolName = block.name || "unknown_tool";
      const toolArgs = block.input || {};

      emit({
        type: "node_created",
        nodeId: toolNodeId,
        parentId: this.lastParentNodeId ?? undefined,
        role: "tool_call",
        content: `${toolName}(${JSON.stringify(toolArgs)})`,
        status: "done",
        toolName,
        toolArgs,
      });
      if (this.lastParentNodeId) {
        emit({ type: "edge_created", from: this.lastParentNodeId, to: toolNodeId, kind: "tool" });
      }

      this.lastParentNodeId = toolNodeId;
      return;
    }

    // Text block — update current thinking node
    if (block.type === "text" && typeof block.text === "string") {
      this.ensureThinkingNode();
      this.currentThinkText += block.text;
      this.finalText = this.currentThinkText; // Keep as candidate for final answer
      emit({
        type: "node_updated",
        nodeId: this.currentThinkNodeId!,
        patch: { content: this.currentThinkText, status: "streaming" },
      });
      return;
    }
  }

  private ensureThinkingNode(): void {
    if (this.currentThinkNodeId) return;

    const nodeId = this.nextNodeId();
    this.currentThinkNodeId = nodeId;
    this.currentThinkText = "";

    this.opts.emit({
      type: "node_created",
      nodeId,
      parentId: this.lastParentNodeId ?? undefined,
      role: "thinking",
      content: "Thinking...",
      status: "streaming",
    });
    if (this.lastParentNodeId) {
      this.opts.emit({ type: "edge_created", from: this.lastParentNodeId, to: nodeId, kind: "depends" });
    }

    this.lastParentNodeId = nodeId;
  }

  private finalizeThinkingNode(): void {
    if (!this.currentThinkNodeId) return;

    this.opts.emit({
      type: "node_updated",
      nodeId: this.currentThinkNodeId,
      patch: {
        content: this.currentThinkText || "(empty)",
        status: "done",
      },
    });

    this.currentThinkNodeId = null;
  }

  private nextNodeId(): string {
    this.nodeSeq++;
    return `n${this.nodeSeq}`;
  }
}
