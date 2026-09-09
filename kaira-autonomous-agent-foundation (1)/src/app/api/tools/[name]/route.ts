import { db } from "@/db";
import { executeTool, getTool } from "@/agent/tools";
import { ensureWorkspace } from "@/agent/workspace";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * Manually execute a tool — the tool bench. Same validation and execution
 * path the engine uses, so results here match what the agent would see.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!getTool(name)) {
    return Response.json({ ok: false, error: `Unknown tool: ${name}` }, { status: 404 });
  }
  const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
  const result = await executeTool(name, body?.input ?? {}, {
    db,
    workspaceRoot: ensureWorkspace(),
    runId: null,
  });
  return Response.json({ ok: true, name, result });
}
