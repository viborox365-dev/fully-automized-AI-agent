import type { Tool, ToolContext, ToolResult, ToolSpec } from "./types";
import { specOf } from "./types";
import { fsList, fsRead, fsSearch, fsWrite } from "./fs";
import { shellExec } from "./shell";
import { httpFetch } from "./http";
import { memorySave, memorySearch } from "./memory";

/**
 * Tool registry — the single place capabilities are added to Kaira.
 * New capabilities = new Tool implementation + one line here. The engine,
 * the tool-bench UI and the prompt builder all read from this registry.
 */

const registry = new Map<string, Tool>();

function register(tool: Tool): void {
  registry.set(tool.name, tool as Tool);
}

register(fsWrite);
register(fsRead);
register(fsList);
register(fsSearch);
register(shellExec);
register(httpFetch);
register(memorySave);
register(memorySearch);

export function listTools(): Tool[] {
  return [...registry.values()];
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function toolSpecs(): ToolSpec[] {
  return listTools().map(specOf);
}

/** Compact, readable capability list injected into model prompts. */
export function toolsPromptSection(): string {
  return listTools()
    .map((t) => {
      const props = (t.parameters as { properties?: Record<string, { type?: string; description?: string }> })
        .properties ?? {};
      const required = new Set(
        ((t.parameters as { required?: string[] }).required ?? []) as string[],
      );
      const args = Object.entries(props)
        .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${v.type ?? "any"}`)
        .join(", ");
      return `- ${t.name}({ ${args} }): ${t.description}`;
    })
    .join("\n");
}

/**
 * Validate input against the tool's zod schema and execute it.
 * Never throws — failures become ToolResult{ok:false} so the agent can
 * observe and recover from its own mistakes.
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    return {
      ok: false,
      output: `Unknown tool "${name}". Available tools: ${[...registry.keys()].join(", ")}`,
    };
  }
  const parsed = tool.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      output: `Invalid input for ${name}: ${issues}. Check the tool's parameter schema and retry.`,
    };
  }
  try {
    return await tool.execute(parsed.data, ctx);
  } catch (err) {
    return {
      ok: false,
      output: `${name} threw an error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
