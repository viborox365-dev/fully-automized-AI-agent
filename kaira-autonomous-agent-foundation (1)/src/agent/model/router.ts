/**
 * Kaira Agent Core — Model Router (Phase 2)
 *
 * Routes model calls to specific models based on their role in the agent
 * pipeline. The router uses the Phase 1 model abstraction (ModelProvider)
 * and only changes which model name is passed to generate().
 *
 * Configuration (env vars or defaults):
 *   qwen3:8b          → reasoning / planning / diagnosis
 *   qwen2.5-coder:7b  → coding / technical implementation / repair
 *   llama3.2:3b      → lightweight tasks
 *
 * Not all models need to be loaded simultaneously — the provider (Ollama)
 * loads models on demand. If a model is unavailable, the provider returns
 * an error that the engine surfaces as an infrastructure failure.
 */

export type ModelRole = "reasoning" | "coding" | "lightweight";

export const MODEL_ROUTING: Record<ModelRole, string> = {
  reasoning: process.env.KAIRA_MODEL_REASONING ?? "qwen3:8b",
  coding: process.env.KAIRA_MODEL_CODING ?? "qwen2.5-coder:7b",
  lightweight: process.env.KAIRA_MODEL_LIGHTWEIGHT ?? "llama3.2:3b",
};

/** Human-readable label for each role. */
export const ROLE_LABELS: Record<ModelRole, string> = {
  reasoning: "Reasoning / Planning",
  coding: "Coding / Technical",
  lightweight: "Lightweight",
};

/** Get the model name for a given role. */
export function modelForRole(role: ModelRole): string {
  return MODEL_ROUTING[role];
}

/** Get all configured model roles and their models. */
export function getModelRouting(): Record<ModelRole, string> {
  return { ...MODEL_ROUTING };
}
