import { spawn, type ChildProcess } from "node:child_process";
import type { HitlController } from "./hitl";
import type { HitlContext } from "@acv/shared";

type EmitFn = (event: Record<string, unknown> & { type: string }) => void;

interface ClaudeLoopOptions {
  runId: string;
  prompt: string;
  hitl: HitlController;
  emit: EmitFn;
  claudeCommand?: string;
}

/**
 * Runs Claude Code CLI in stream-json mode, parses its output,
 * and maps each event to DAG nodes.
 *
 * Claude CLI outputs JSON lines with types:
 * - { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } } }
 * - { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "...", id: "..." } } }
 * - { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "..." } } }
 * - { type: "stream_event", event: { type: "content_block_stop" } }
 * - { type: "stream_event", event: { type: "message_start" | "message_delta" | "message_stop" } }
 * - { type: "result", result: "..." }
 *
 * Tool use events from Claude CLI (--verbose mode):
 * - { type: "tool_use", tool: "...", input: {...} }
 * - { type: "tool_result", tool: "...", content: "..." }
 */
export class ClaudeLoop {
  private opts: Required<ClaudeLoopOptions>;
  private nodeSeq = 0;
  private child: ChildProcess | null = null;
  private aborted = false;

  constructor(opts: ClaudeLoopOptions) {
    this.opts = {
      ...opts,
      claudeCommand: opts.claudeCommand || process.env.AGENT_COMMAND || "claude",
    };
  }

  async run(): Promise<void> {
    const { emit, prompt } = this.opts;

    emit({ type: "run_started" });

    const thinkNodeId = this.nextNodeId();
    emit({
      type: "node_created",
      nodeId: thinkNodeId,
      role: "thinking",
      content: `Calling Claude Code CLI...`,
      status: "streaming",
    });

    try {
      await this.spawnClaude(prompt, thinkNodeId);

      if (!this.aborted) {
        emit({ type: "run_finished", status: "success" });
      }
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

  abort() {
    this.aborted = true;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  private spawnClaude(prompt: string, thinkNodeId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const { emit, claudeCommand } = this.opts;

      const args = [
        "-p",
        "--verbose",
        "--output-format", "stream-json",
        prompt,
      ];

      this.child = spawn(claudeCommand, args, {
        shell: true,
        env: process.env,
        windowsHide: true,
      });

      let stdoutBuf = "";
      let stderrBuf = "";
      let fullText = "";
      let currentToolNodeId: string | null = null;
      let currentToolName = "";
      let currentToolArgsStr = "";
      let lastParentNodeId = thinkNodeId;

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let obj: any;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          return;
        }

        // Handle stream_event (Claude API streaming events)
        if (obj?.type === "stream_event") {
          const evt = obj.event;
          if (!evt) return;

          // Text delta — append to thinking node
          if (
            evt.type === "content_block_delta" &&
            evt.delta?.type === "text_delta" &&
            typeof evt.delta.text === "string"
          ) {
            fullText += evt.delta.text;
            emit({
              type: "node_updated",
              nodeId: thinkNodeId,
              patch: { content: fullText, status: "streaming" },
            });
            return;
          }

          // Tool use start — create tool_call node
          if (
            evt.type === "content_block_start" &&
            evt.content_block?.type === "tool_use"
          ) {
            // Finalize thinking node if we have text
            if (fullText.length > 0) {
              emit({
                type: "node_updated",
                nodeId: thinkNodeId,
                patch: { content: fullText, status: "done" },
              });
            }

            currentToolName = evt.content_block.name || "unknown_tool";
            currentToolArgsStr = "";
            currentToolNodeId = this.nextNodeId();

            emit({
              type: "node_created",
              nodeId: currentToolNodeId,
              parentId: lastParentNodeId,
              role: "tool_call",
              content: `${currentToolName}(...)`,
              status: "streaming",
              toolName: currentToolName,
            });
            emit({
              type: "edge_created",
              from: lastParentNodeId,
              to: currentToolNodeId,
              kind: "tool",
            });
            return;
          }

          // Tool use input delta — accumulate JSON arguments
          if (
            evt.type === "content_block_delta" &&
            evt.delta?.type === "input_json_delta" &&
            typeof evt.delta.partial_json === "string" &&
            currentToolNodeId
          ) {
            currentToolArgsStr += evt.delta.partial_json;
            emit({
              type: "node_updated",
              nodeId: currentToolNodeId,
              patch: { content: `${currentToolName}(${currentToolArgsStr})` },
            });
            return;
          }

          // Content block stop — finalize tool_call node
          if (evt.type === "content_block_stop" && currentToolNodeId) {
            let toolArgs: Record<string, unknown> = {};
            try {
              toolArgs = JSON.parse(currentToolArgsStr || "{}");
            } catch { /* keep empty */ }

            emit({
              type: "node_updated",
              nodeId: currentToolNodeId,
              patch: {
                content: `${currentToolName}(${JSON.stringify(toolArgs)})`,
                status: "done",
              },
            });

            lastParentNodeId = currentToolNodeId;
            currentToolNodeId = null;
            currentToolName = "";
            currentToolArgsStr = "";
            return;
          }

          return;
        }

        // Handle tool_use events from --verbose mode
        if (obj?.type === "tool_use") {
          const toolNodeId = this.nextNodeId();
          const toolName = obj.tool || "unknown";
          const toolArgs = obj.input || {};

          emit({
            type: "node_created",
            nodeId: toolNodeId,
            parentId: lastParentNodeId,
            role: "tool_call",
            content: `${toolName}(${JSON.stringify(toolArgs)})`,
            status: "done",
            toolName,
            toolArgs,
          });
          emit({
            type: "edge_created",
            from: lastParentNodeId,
            to: toolNodeId,
            kind: "tool",
          });
          lastParentNodeId = toolNodeId;
          return;
        }

        // Handle tool_result events from --verbose mode
        if (obj?.type === "tool_result") {
          const resultNodeId = this.nextNodeId();
          const toolName = obj.tool || "unknown";
          const content = typeof obj.content === "string"
            ? obj.content
            : JSON.stringify(obj.content || "");

          emit({
            type: "node_created",
            nodeId: resultNodeId,
            parentId: lastParentNodeId,
            role: "tool_result",
            content: content.length > 2000 ? content.slice(0, 2000) + "\n...(truncated)" : content,
            status: "done",
            toolName,
          });
          emit({
            type: "edge_created",
            from: lastParentNodeId,
            to: resultNodeId,
            kind: "depends",
          });
          lastParentNodeId = resultNodeId;

          // Start new thinking node for next round
          const newThinkId = this.nextNodeId();
          thinkNodeId = newThinkId;
          fullText = "";
          emit({
            type: "node_created",
            nodeId: newThinkId,
            parentId: resultNodeId,
            role: "thinking",
            content: "Thinking...",
            status: "streaming",
          });
          emit({
            type: "edge_created",
            from: resultNodeId,
            to: newThinkId,
            kind: "depends",
          });
          lastParentNodeId = newThinkId;
          return;
        }

        // Handle final result
        if (obj?.type === "result" && typeof obj.result === "string") {
          if (fullText.length === 0) {
            fullText = obj.result;
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
        reject(new Error(`Failed to start '${claudeCommand}': ${err.message}`));
      });

      this.child.on("close", (code) => {
        // Process remaining buffer
        if (stdoutBuf.trim()) handleLine(stdoutBuf);

        // Finalize the last thinking node
        if (fullText.length > 0) {
          emit({
            type: "node_updated",
            nodeId: thinkNodeId,
            patch: { content: fullText, status: "done" },
          });

          // Create answer node
          const answerNodeId = this.nextNodeId();
          emit({
            type: "node_created",
            nodeId: answerNodeId,
            parentId: thinkNodeId,
            role: "answer",
            content: fullText,
            status: "done",
          });
          emit({
            type: "edge_created",
            from: thinkNodeId,
            to: answerNodeId,
            kind: "depends",
          });
        }

        if (this.aborted) {
          emit({ type: "run_finished", status: "aborted" });
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

      // Wire up abort via hitl interrupt
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

  private nextNodeId(): string {
    this.nodeSeq++;
    return `n${this.nodeSeq}`;
  }
}
