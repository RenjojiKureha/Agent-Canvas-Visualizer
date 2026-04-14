import OpenAI from "openai";

type GenerateOptions = {
  prompt: string;
  onDelta: (delta: string) => void;
};

export class OpenAIAgentAdapter {
  private client: OpenAI | null;
  private model: string;
  private providerLabel: string;

  constructor() {
    const apiKey = process.env.AGENT_API_KEY || process.env.OPENAI_API_KEY;
    const baseURL = process.env.AGENT_BASE_URL || process.env.OPENAI_BASE_URL;

    this.model = process.env.AGENT_MODEL || process.env.OPENAI_MODEL || "deepseek-chat";
    this.providerLabel = baseURL || "default(OpenAI)";

    this.client = apiKey
      ? new OpenAI({
          apiKey,
          ...(baseURL ? { baseURL } : {})
        })
      : null;
  }

  isReady() {
    return Boolean(this.client);
  }

  getProviderInfo() {
    return `${this.providerLabel} / ${this.model}`;
  }

  async generate({ prompt, onDelta }: GenerateOptions): Promise<string> {
    if (!this.client) {
      throw new Error("AGENT_API_KEY (or OPENAI_API_KEY) is not set");
    }

    const instructions =
      "You are an execution agent. Provide concise planning summary and concrete next actions. Do not expose hidden reasoning.";

    let fullText = "";

    try {
      const stream = (await this.client.responses.create({
        model: this.model,
        instructions,
        input: prompt,
        stream: true
      })) as unknown;

      if (stream && Symbol.asyncIterator in Object(stream)) {
        for await (const event of stream as AsyncIterable<any>) {
          const delta = this.extractDelta(event);
          if (delta) {
            fullText += delta;
            onDelta(delta);
          }
        }

        if (fullText.trim().length > 0) return fullText;
      }
    } catch {
      // Continue to fallback path.
    }

    const resp: any = await this.client.responses.create({
      model: this.model,
      instructions,
      input: prompt
    });

    const text = this.extractFinalText(resp);
    if (text) {
      for (const chunk of this.chunkText(text, 32)) {
        onDelta(chunk);
        fullText += chunk;
      }
    }

    return fullText;
  }

  private extractDelta(event: any): string {
    if (!event || typeof event !== "object") return "";

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      return event.delta;
    }

    if (event.type === "response.delta" && typeof event.delta === "string") {
      return event.delta;
    }

    if (typeof event.delta === "string") return event.delta;

    return "";
  }

  private extractFinalText(resp: any): string {
    if (!resp || typeof resp !== "object") return "";
    if (typeof resp.output_text === "string") return resp.output_text;

    const output = Array.isArray(resp.output) ? resp.output : [];
    const chunks: string[] = [];
    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (typeof c?.text === "string") chunks.push(c.text);
      }
    }
    return chunks.join("\n");
  }

  private chunkText(text: string, size: number): string[] {
    if (!text) return [];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      chunks.push(text.slice(i, i + size));
    }
    return chunks;
  }
}
