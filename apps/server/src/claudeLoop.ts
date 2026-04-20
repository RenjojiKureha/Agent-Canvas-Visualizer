import { spawn, type ChildProcess } from "node:child_process";
import { BaseLoop, type BaseLoopOptions } from "./baseLoop";
import { handleAnswerDecision } from "./hitlDecision";
import {
  type ClaudeContentBlock,
  type ClaudeStreamEvent,
  isAssistantEvent,
  isResultEvent,
  isThinkingBlock,
  isToolUseBlock,
  isTextBlock,
} from "./claudeStreamTypes";

interface ClaudeLoopOptions extends BaseLoopOptions {
  claudeCommand?: string;
  cwd?: string;
}

export class ClaudeLoop extends BaseLoop {
  private claudeCommand: string;
  private cwd?: string;
  private child: ChildProcess | null = null;

  private currentThinkNodeId: string | null = null;
  private currentThinkText = "";
  private lastParentNodeId: string | null = null;
  private finalText = "";

  constructor(opts: ClaudeLoopOptions) {
    super(opts);
    this.claudeCommand = opts.claudeCommand || process.env.AGENT_COMMAND || "claude";
    this.cwd = opts.cwd;
  }

  async run(): Promise<void> {
    this.emit({ type: "run_started", provider: "claude" });

    const unsubscribe = this.base.hitl.onInterrupt((msg) => {
      if (msg.type === "abort") this.abort();
    });

    try {
      await this.spawnClaude(this.base.prompt);

      if (this.aborted) {
        this.emitFinished("aborted");
        return;
      }

      this.finalizeThinkingNode();

      const answerText = this.finalText || "(empty response)";
      await this.answerCheckpointLoop(answerText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitFailure(`Claude CLI error: ${msg}`);
    } finally {
      unsubscribe();
    }
  }

  private async answerCheckpointLoop(answerText: string): Promise<void> {
    let currentAnswer = answerText;

    while (true) {
      const answerNodeId = this.nextNodeId();
      this.emit({
        type: "node_created",
        nodeId: answerNodeId,
        parentId: this.lastParentNodeId ?? undefined,
        role: "answer",
        content: currentAnswer,
        status: "waiting_human",
      });
      if (this.lastParentNodeId) {
        this.emit({ type: "edge_created", from: this.lastParentNodeId, to: answerNodeId, kind: "depends" });
      }

      const { decision, hitlNodeId } = await handleAnswerDecision({
        answerNodeId,
        hitl: this.base.hitl,
        emit: (e) => this.emit(e),
        nextNodeId: () => this.nextNodeId(),
        answer: currentAnswer,
      });

      if (decision.decision === "finish") {
        this.emitFinished("success");
        return;
      }
      if (decision.decision === "abort") {
        this.aborted = true;
        this.emitFinished("aborted");
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
        this.emitFailure(`${decision.decision === "continue" ? "Continue" : "Revision"} failed: ${msg}`);
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
        cwd: this.cwd || undefined,
      });

      this.child.stdin!.write(prompt);
      this.child.stdin!.end();

      let stdoutBuf = "";
      let stderrBuf = "";

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let evt: ClaudeStreamEvent;
        try {
          evt = JSON.parse(trimmed) as ClaudeStreamEvent;
        } catch {
          return;
        }

        if (evt.type === "system") return;

        if (isAssistantEvent(evt)) {
          const content = evt.message?.content;
          if (!Array.isArray(content)) return;
          for (const block of content) {
            this.handleContentBlock(block);
          }
          return;
        }

        if (isResultEvent(evt)) {
          if (typeof evt.result === "string" && evt.result.length > 0) {
            this.finalText = evt.result;
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
    });
  }

  private handleContentBlock(block: ClaudeContentBlock): void {
    if (isThinkingBlock(block)) {
      this.ensureThinkingNode();
      this.currentThinkText += block.thinking;
      this.emit({
        type: "node_updated",
        nodeId: this.currentThinkNodeId!,
        patch: { content: this.currentThinkText, status: "streaming" },
      });
      return;
    }

    if (isToolUseBlock(block)) {
      this.finalizeThinkingNode();

      const toolNodeId = this.nextNodeId();
      const toolName = block.name || "unknown_tool";
      const toolArgs = block.input || {};

      this.emit({
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
        this.emit({ type: "edge_created", from: this.lastParentNodeId, to: toolNodeId, kind: "tool" });
      }

      this.lastParentNodeId = toolNodeId;
      return;
    }

    if (isTextBlock(block)) {
      this.ensureThinkingNode();
      this.currentThinkText += block.text;
      this.finalText = this.currentThinkText;
      this.emit({
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

    this.emit({
      type: "node_created",
      nodeId,
      parentId: this.lastParentNodeId ?? undefined,
      role: "thinking",
      content: "Thinking...",
      status: "streaming",
    });
    if (this.lastParentNodeId) {
      this.emit({ type: "edge_created", from: this.lastParentNodeId, to: nodeId, kind: "depends" });
    }

    this.lastParentNodeId = nodeId;
  }

  private finalizeThinkingNode(): void {
    if (!this.currentThinkNodeId) return;

    this.emit({
      type: "node_updated",
      nodeId: this.currentThinkNodeId,
      patch: {
        content: this.currentThinkText || "(empty)",
        status: "done",
      },
    });

    this.currentThinkNodeId = null;
  }
}
