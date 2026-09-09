import type { z } from "zod";
import type { db as dbClient } from "@/db";

/**
 * Tool contract. A tool is a real, executable capability of Kaira.
 * Every tool declares a zod input schema (enforced before execution) and a
 * JSON-schema description (shown to the model so it knows how to call it).
 */
export interface ToolContext {
  db: typeof dbClient;
  /** Absolute path of the sandboxed workspace root. */
  workspaceRoot: string;
  /** Run that triggered the call, if any (null for tool-bench calls). */
  runId: string | null;
}

export interface ToolResult {
  ok: boolean;
  /** Human/model-readable summary of what happened (goes into the run log). */
  output: string;
  /** Optional structured payload (goes into the step record). */
  data?: unknown;
}

export interface Tool<I = unknown> {
  name: string;
  category: "fs" | "exec" | "web" | "memory";
  description: string;
  /** Runtime validation of the model-provided input. */
  schema: z.ZodType<I>;
  /** JSON-schema-ish shape advertised to the model in prompts. */
  parameters: Record<string, unknown>;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolSpec {
  name: string;
  category: Tool["category"];
  description: string;
  parameters: Record<string, unknown>;
}

export function specOf(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    category: tool.category,
    description: tool.description,
    parameters: tool.parameters,
  };
}
