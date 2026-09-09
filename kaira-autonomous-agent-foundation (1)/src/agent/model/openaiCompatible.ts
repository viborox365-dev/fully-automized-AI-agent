import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  ModelProvider,
  ProviderStatus,
} from "./types";
import { errMessage } from "./ollama";

/**
 * OpenAI-compatible provider.
 *
 * Works with any server exposing the /v1/chat/completions shape:
 * LM Studio (http://localhost:1234/v1), llama.cpp server, vLLM, Ollama's
 * compat shim, OpenRouter, … Keeps Kaira model-agnostic without new code.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai_compatible" as const;
  readonly label = "OpenAI-compatible endpoint";

  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey?: string,
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const res = await fetch(this.url("/models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        return {
          ok: false,
          detail: `Endpoint responded with HTTP ${res.status} on /models`,
          models: [],
        };
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
      return { ok: true, detail: `${models.length} model(s) listed`, models };
    } catch (err) {
      return {
        ok: false,
        detail: `Cannot reach ${this.baseUrl} (${errMessage(err)})`,
        models: [],
      };
    }
  }

  async generate(
    messages: ChatMessage[],
    opts: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const model = opts.model || this.model;
    if (!model) {
      throw new Error(
        "No model configured for the OpenAI-compatible endpoint. Set one in Settings.",
      );
    }
    const started = Date.now();
    const res = await fetch(this.url("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 2048,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Chat completion failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    if (data.error?.message) throw new Error(data.error.message);
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("Endpoint returned no message content");
    }
    return {
      content,
      model,
      tokensIn: data.usage?.prompt_tokens ?? null,
      tokensOut: data.usage?.completion_tokens ?? null,
      latencyMs: Date.now() - started,
    };
  }
}
