export const DEFAULT_MAX_STEPS = 20;
export const MAX_PROMPT_LENGTH = 10000;
export const RUN_TTL_MS = 30 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const SSE_HEARTBEAT_MS = 15000;

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful agent that can read and write files in a project. " +
  "Use the provided tools to accomplish the user's task. " +
  "Think step by step. When you have completed the task, provide a final answer without tool calls.";

export const DEFAULT_CONTINUE_NOTE =
  "I agree with your reasoning and support your recommendation. Please proceed and execute everything as proposed.";

export const DEFAULT_REVISE_NOTE = "Please revise your answer and improve it.";
