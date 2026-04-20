import OpenAI from "openai";

type ChatCompletionChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type ChatCompletionCreateParamsStreaming = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
type ChatCompletionCreateParamsNonStreaming = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatCompletionMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;

export type LlmMessage = ChatCompletionMessageParam;
export type LlmTool = ChatCompletionTool;

export interface LlmToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
}

type OnDelta = (delta: string) => void;

export class LlmClient {
  private client: OpenAI | null;
  private model: string;
  private providerLabel: string;

  constructor() {
    const apiKey =
      process.env.AGENT_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
    const baseURL =
      process.env.AGENT_BASE_URL || process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL;
    this.model =
      process.env.AGENT_MODEL || process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || "deepseek-chat";

    this.providerLabel = baseURL || "default(OpenAI)";
    this.client = apiKey
      ? new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
      : null;
  }

  isReady(): boolean {
    return Boolean(this.client);
  }

  getProviderInfo(): string {
    return `${this.providerLabel} / ${this.model}`;
  }

  async chat(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
    onDelta?: OnDelta,
  ): Promise<LlmResponse> {
    if (!this.client) {
      throw new Error("LLM API key not configured. Set AGENT_API_KEY in .env");
    }

    let fullText = "";
    const toolCalls: Array<{ id: string; name: string; argStr: string }> = [];

    try {
      const streamParams: ChatCompletionCreateParamsStreaming = {
        model: this.model,
        messages,
        stream: true,
        ...(tools && tools.length > 0 ? { tools } : {}),
      };
      const stream = await this.client.chat.completions.create(streamParams);

      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const textDelta = choice.delta?.content;
        if (typeof textDelta === "string" && textDelta.length > 0) {
          fullText += textDelta;
          onDelta?.(textDelta);
        }

        const tcDeltas = choice.delta?.tool_calls;
        if (Array.isArray(tcDeltas)) {
          for (const tcd of tcDeltas) {
            const idx = tcd.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: tcd.id || "", name: tcd.function?.name || "", argStr: "" };
            }
            if (tcd.id) toolCalls[idx].id = tcd.id;
            if (tcd.function?.name) toolCalls[idx].name = tcd.function.name;
            if (tcd.function?.arguments) toolCalls[idx].argStr += tcd.function.arguments;
          }
        }
      }
    } catch (err) {
      if (this.isRetryableStreamError(err)) {
        return this.chatNonStream(messages, tools);
      }
      throw err;
    }

    const parsedToolCalls: LlmToolCall[] = toolCalls
      .filter((tc) => tc.name)
      .map((tc) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.argStr || "{}"); } catch { /* use empty */ }
        return { id: tc.id, name: tc.name, args };
      });

    return { text: fullText, toolCalls: parsedToolCalls };
  }

  private async chatNonStream(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
  ): Promise<LlmResponse> {
    if (!this.client) throw new Error("client not initialized");

    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages,
      stream: false,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const resp = await this.client.chat.completions.create(params);
    const choice = resp.choices?.[0];
    const text = choice?.message?.content || "";
    const rawToolCalls = choice?.message?.tool_calls || [];

    const toolCalls: LlmToolCall[] = rawToolCalls
      .filter((tc): tc is Extract<typeof tc, { type: "function" }> =>
        (tc as { type?: string }).type === "function",
      )
      .map((tc) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* use empty */ }
        return { id: tc.id || "", name: tc.function.name || "", args };
      });

    return { text, toolCalls };
  }

  private isRetryableStreamError(err: unknown): boolean {
    const status = (err as { status?: number })?.status;
    return status === 404 || status === 405 || status === 400;
  }
}
