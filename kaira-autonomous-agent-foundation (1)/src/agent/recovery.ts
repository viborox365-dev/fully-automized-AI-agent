/**
 * Kaira Agent Core — Failure Recovery (Phase 2)
 *
 * When a task fails, the recovery system:
 *   1. Captures the real error
 *   2. Sends the error + context to the reasoning model for diagnosis
 *   3. Asks the model to determine if recovery is possible
 *   4. If recoverable, asks the coding model to generate a repair action
 *   5. Returns the repair action for the executor to apply
 *
 * Model routing:
 *   - Diagnosis → reasoning model (qwen3:8b)
 *   - Repair    → coding model (qwen2.5-coder:7b)
 */

import type { Objective } from "@/db/schema";
import { getProvider, resolveModelConfig, type ModelProvider } from "./model";
import { modelForRole } from "./model/router";
import { diagnosisMessages, repairMessages } from "./prompts";
import { toolsPromptSection } from "./tools";

/* ────────────────────────────── types ────────────────────────────── */

export interface DiagnosisResult {
  diagnosis: string;
  recoverable: boolean;
}

export interface RepairAction {
  tool: string;
  input: Record<string, unknown>;
}

/* ─────────────────────────── JSON extraction ─────────────────────── */

function extractJson(raw: string): Record<string, unknown> | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i;
  const m = fence.exec(raw);
  const text = m ? m[1] : raw;

  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function parseDiagnosisResponse(raw: string): DiagnosisResult {
  const obj = extractJson(raw);
  if (!obj) {
    return { diagnosis: raw.slice(0, 500), recoverable: false };
  }
  return {
    diagnosis: typeof obj.diagnosis === "string" ? obj.diagnosis : "",
    recoverable: obj.recoverable === true,
  };
}

export function parseRepairResponse(raw: string): RepairAction | null {
  const obj = extractJson(raw);
  if (!obj) return null;
  if (typeof obj.tool !== "string") return null;
  return {
    tool: obj.tool,
    input: obj.input && typeof obj.input === "object" ? (obj.input as Record<string, unknown>) : {},
  };
}

/* ──────────────────────────── diagnosis ─────────────────────────── */

/**
 * Diagnose a task failure using the reasoning model.
 */
export async function diagnoseFailure(
  params: {
    objective: Objective;
    taskDescription: string;
    tool: string;
    input: unknown;
    error: string;
    transcript: string;
  },
  provider?: ModelProvider,
): Promise<DiagnosisResult> {
  const chat = diagnosisMessages({
    objective: params.objective,
    taskDescription: params.taskDescription,
    tool: params.tool,
    input: params.input,
    error: params.error,
    transcript: params.transcript,
  });

  const result = await callModel(chat, "reasoning", provider);
  return parseDiagnosisResponse(result);
}

/* ───────────────────────────── repair ────────────────────────────── */

/**
 * Generate a repair action using the coding model.
 */
export async function generateRepair(
  params: {
    objective: Objective;
    taskDescription: string;
    tool: string;
    input: unknown;
    diagnosis: string;
    error: string;
  },
  provider?: ModelProvider,
): Promise<RepairAction | null> {
  const toolsSection = toolsPromptSection();
  const chat = repairMessages({
    objective: params.objective,
    taskDescription: params.taskDescription,
    tool: params.tool,
    input: params.input,
    diagnosis: params.diagnosis,
    error: params.error,
    toolsSection,
  });

  const result = await callModel(chat, "coding", provider);
  return parseRepairResponse(result);
}

/* ──────────────────────────── model call ────────────────────────── */

async function callModel(
  chat: { role: string; content: string }[],
  role: "reasoning" | "coding" | "lightweight",
  provider?: ModelProvider,
): Promise<string> {
  if (provider) {
    const result = await provider.generate(
      chat as Parameters<ModelProvider["generate"]>[0],
      { model: modelForRole(role), temperature: 0.2, maxTokens: 2000 },
    );
    return result.content;
  }
  const config = await resolveModelConfig();
  const prov = getProvider(config);
  const result = await prov.generate(
    chat as Parameters<ModelProvider["generate"]>[0],
    {
      model: modelForRole(role),
      temperature: 0.2,
      maxTokens: 2000,
      timeoutMs: Number(process.env.KAIRA_MODEL_TIMEOUT_MS ?? 180_000),
    },
  );
  return result.content;
}
