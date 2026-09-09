import { stopRun } from "@/agent/engine";

export const dynamic = "force-dynamic";

/** Request a run to stop. The driver relinquishes it at the next tick boundary. */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const run = await stopRun(id);
    return Response.json({ ok: true, run });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
