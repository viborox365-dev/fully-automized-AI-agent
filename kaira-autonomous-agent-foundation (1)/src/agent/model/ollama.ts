import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  ModelProvider,
  ProviderStatus,
} from "./types";

/**
 * Ollama provider — the default local-first backend.
 * Talks to a local Ollama server (default http://localhost:11434) running
 * models like llama3.1, qwen2.5, mistral, etc. No paid APIs involved.
 */
export class OllamaProvider implements ModelProvider {
  readonly id = "ollama" as const;
  readonly label = "Ollama (local)";

  constructor(
    private baseUrl: string,
    private model: string,
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const res = await fetch(this.url("/api/tags"), {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        return {
          ok: false,
          detail: `Ollama responded with HTTP ${res.status}`,
          models: [],
        };
      }
      const data = (await res.json()) as {
        models?: Array<{ name?: string; model?: string }>;
      };
      const models = (data.models ?? [])
        .map((m) => m.name ?? m.model ?? "")
        .filter(Boolean);
      return models.length
        ? { ok: true, detail: `${models.length} model(s) available`, models }
        : {
            ok: false,
            detail:
              "Ollama is running but no models are installed (run: ollama pull llama3.1:8b)",
            models,
          };
    } catch (err) {
      return {
        ok: false,
        detail: `Cannot reach Ollama at ${this.baseUrl} — is it running? (${errMessage(err)})`,
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
        "No model configured for Ollama. Set one in Settings or KAIRA_MODEL.",
      );
    }
    const started = Date.now();
    const res = await fetch(this.url("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.2,
          num_predict: opts.maxTokens ?? 2048,
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Ollama generate failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      error?: string;
    };
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    return {
      content: data.message?.content ?? "",
      model,
      tokensIn: data.prompt_eval_count ?? null,
      tokensOut: data.eval_count ?? null,
      latencyMs: Date.now() - started,
    };
  }
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
