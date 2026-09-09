/**
 * Model provider abstraction.
 *
 * The engine only ever speaks to this interface, so the underlying model
 * (Ollama model, LM Studio server, llama.cpp, an OpenAI-compatible API,
 * or anything added later) is fully replaceable without touching agent code.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerateOptions {
  /** Override the provider's configured model for a single call. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Hard timeout for the whole call (local models can be slow). */
  timeoutMs?: number;
}

export interface GenerateResult {
  content: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
}

export interface ProviderStatus {
  ok: boolean;
  detail: string;
  models: string[];
}

export interface ModelProvider {
  readonly id: string;
  readonly label: string;
  /** Live health check + model listing. Must not throw. */
  status(): Promise<ProviderStatus>;
  /** Single chat completion. Throws on transport/protocol errors. */
  generate(
    messages: ChatMessage[],
    opts?: GenerateOptions,
  ): Promise<GenerateResult>;
}

export type ProviderKind = "ollama" | "openai_compatible";

export interface ModelConfig {
  provider: ProviderKind;
  /** Model identifier passed to the provider, e.g. "llama3.1:8b". */
  model: string;
  /** Base URL of the provider server. */
  baseUrl: string;
  /** Optional API key (never logged; masked by the settings API). */
  apiKey?: string;
}
