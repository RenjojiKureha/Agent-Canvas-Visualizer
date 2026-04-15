import OpenAI from "openai";

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
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; tool_calls?: unknown[] }>,
    tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
    onDelta?: OnDelta,
  ): Promise<LlmResponse> {
    if (!this.client) {
      throw new Error("LLM API key not configured. Set AGENT_API_KEY in .env");
    }

    const params: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    let fullText = "";
    const toolCalls: Array<{ id: string; name: string; argStr: string }> = [];

    try {
      const stream = await this.client.chat.completions.create(params as any) as unknown;

      for await (const chunk of stream as AsyncIterable<any>) {
        const choice = chunk?.choices?.[0];
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
    messages: Array<{ role: string; content: string; tool_call_id?: string }>,
    tools?: unknown[],
  ): Promise<LlmResponse> {
    if (!this.client) throw new Error("client not initialized");

    const params: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };
    if (tools && (tools as unknown[]).length > 0) params.tools = tools;

    const resp: any = await this.client.chat.completions.create(params as any);
    const choice = resp?.choices?.[0];
    const text = choice?.message?.content || "";
    const rawToolCalls = choice?.message?.tool_calls || [];

    const toolCalls: LlmToolCall[] = rawToolCalls.map((tc: any) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* use empty */ }
      return { id: tc.id || "", name: tc.function?.name || "", args };
    });

    return { text, toolCalls };
  }

  private isRetryableStreamError(err: unknown): boolean {
    const status = (err as { status?: number })?.status;
    return status === 404 || status === 405 || status === 400;
  }
}
