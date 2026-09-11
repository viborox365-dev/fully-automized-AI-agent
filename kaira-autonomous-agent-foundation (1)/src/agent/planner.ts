/**
 * Kaira Agent Core — Structured Planner (Phase 2)
 *
 * Receives a high-level objective and produces a structured execution plan
 * (JSON with tasks, tools, inputs, dependencies, verification criteria)
 * that the execution engine can process directly — not natural-language
 * instructions.
 *
 * Uses the reasoning model (qwen3:8b) through the Phase 1 model abstraction.
 */

import { db } from "@/db";
import type { Objective } from "@/db/schema";
import { getProvider, resolveModelConfig, type ModelProvider } from "./model";
import { modelForRole, type ModelRole } from "./model/router";
import { structuredPlanningMessages } from "./prompts";
import { toolsPromptSection } from "./tools";
import { recallMemories } from "./tools/memory";
import { SAFEGUARD_LIMITS } from "./safeguards";

/* ────────────────────────────── types ────────────────────────────── */

export type VerificationType =
  | "file_exists"
  | "file_contains"
  | "output_contains"
  | "exit_code_zero"
  | "command_succeeds";

export interface VerificationCriteria {
  type: VerificationType;
  path?: string;
  expected?: string;
  command?: string;
}

export interface StructuredTask {
  description: string;
  tool: string;
  input: Record<string, unknown>;
  depends_on: number[];
  verify: VerificationCriteria;
}

export interface StructuredPlan {
  understanding: string;
  tasks: StructuredTask[];
}

/* ─────────────────────────── JSON extraction ─────────────────────── */

/** Extract the first balanced JSON object from text (handles code fences). */
function extractJson(raw: string): Record<string, unknown> | null {
  // Try fenced code blocks first
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

/** Parse a model response into a StructuredPlan. */
export function parseStructuredPlan(raw: string): StructuredPlan {
  const obj = extractJson(raw);
  if (!obj) throw new Error("No valid JSON found in plan response");

  const tasksRaw = obj.tasks;
  if (!Array.isArray(tasksRaw)) throw new Error("Plan must contain a 'tasks' array");

  const tasks: StructuredTask[] = tasksRaw.slice(0, SAFEGUARD_LIMITS.MAX_TASKS_PER_OBJECTIVE).map(
    (t: Record<string, unknown>, i: number) => ({
      description: typeof t.description === "string" ? t.description : `Task ${i + 1}`,
      tool: typeof t.tool === "string" ? t.tool : "",
      input: t.input && typeof t.input === "object" ? (t.input as Record<string, unknown>) : {},
      depends_on: Array.isArray(t.depends_on) ? (t.depends_on as number[]) : [],
      verify: (t.verify as VerificationCriteria) ?? { type: "exit_code_zero" },
    }),
  );

  if (tasks.length === 0) throw new Error("Plan must contain at least one task");

  return {
    understanding: typeof obj.understanding === "string" ? obj.understanding : "",
    tasks,
  };
}

/* ──────────────────────────── the planner ────────────────────────── */

/**
 * Produce a structured execution plan for an objective.
 *
 * @param objective  The objective to plan for.
 * @param provider   Optional injected provider (for testing). If omitted,
 *                   the configured provider is used with the reasoning model.
 */
export async function planObjective(
  objective: Objective,
  provider?: ModelProvider,
): Promise<StructuredPlan> {
  const toolsSection = toolsPromptSection();
  const mem = await recallMemories(
    db,
    `${objective.title} ${objective.description}`,
  ).catch(() => []);

  const chat = structuredPlanningMessages({
    objective,
    toolsSection,
    memories: mem.map((m) => m.content),
  });

  let result;
  if (provider) {
    result = await provider.generate(chat, {
      model: modelForRole("reasoning"),
      temperature: 0.3,
      maxTokens: 2000,
    });
  } else {
    const config = await resolveModelConfig();
    const prov = getProvider(config);
    result = await prov.generate(chat, {
      model: modelForRole("reasoning"),
      temperature: 0.3,
      maxTokens: 2000,
      timeoutMs: Number(process.env.KAIRA_MODEL_TIMEOUT_MS ?? 180_000),
    });
  }

  return parseStructuredPlan(result.content);
}
