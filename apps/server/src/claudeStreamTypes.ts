/**
 * Claude Code CLI stream-json event types (verified format).
 *
 * Stream lines:
 *   {"type":"system","subtype":"init",...}
 *   {"type":"assistant","message":{"content":[{"type":"thinking",...}|{"type":"tool_use",...}|{"type":"text",...}]}}
 *   {"type":"result","subtype":"success","result":"..."}
 */

export interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ClaudeToolUseBlock {
  type: "tool_use";
  name?: string;
  input?: Record<string, unknown>;
}

export interface ClaudeTextBlock {
  type: "text";
  text: string;
}

export type ClaudeContentBlock =
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeTextBlock
  | { type: string; [key: string]: unknown };

export interface ClaudeSystemEvent {
  type: "system";
  subtype?: string;
  [key: string]: unknown;
}

export interface ClaudeAssistantEvent {
  type: "assistant";
  message?: { content?: ClaudeContentBlock[] };
}

export interface ClaudeResultEvent {
  type: "result";
  subtype?: string;
  result?: string;
}

export type ClaudeStreamEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeResultEvent
  | { type: string; [key: string]: unknown };

export function isAssistantEvent(e: ClaudeStreamEvent): e is ClaudeAssistantEvent {
  return e.type === "assistant";
}

export function isResultEvent(e: ClaudeStreamEvent): e is ClaudeResultEvent {
  return e.type === "result";
}

export function isThinkingBlock(b: ClaudeContentBlock): b is ClaudeThinkingBlock {
  return b.type === "thinking" && typeof (b as ClaudeThinkingBlock).thinking === "string";
}

export function isToolUseBlock(b: ClaudeContentBlock): b is ClaudeToolUseBlock {
  return b.type === "tool_use";
}

export function isTextBlock(b: ClaudeContentBlock): b is ClaudeTextBlock {
  return b.type === "text" && typeof (b as ClaudeTextBlock).text === "string";
}
