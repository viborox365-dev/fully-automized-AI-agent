import { z } from "zod";
import { advanceRun } from "@/agent/engine";
import { releaseRunApi, tryAcquireRunApi } from "@/agent/apiGuard";

export const dynamic = "force-dynamic";
// Local models are slow; a multi-tick advance may legitimately take minutes.
export const maxDuration = 300;

const schema = z.object({
  ticks: z.number().int().min(1).max(64).optional(),
});

const OWNER = `api-${process.pid}`;

/**
 * Drive the run forward from within the web server — the in-app driver for
 * environments where the background worker isn't running. Real execution,
 * same engine as the worker, state persisted to Postgres.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  if (!tryAcquireRunApi(id)) {
    return Response.json(
      { ok: false, error: "This run is already being advanced." },
      { status: 409 },
    );
  }
  try {
    const result = await advanceRun(id, OWNER, { ticks: parsed.data.ticks ?? 1 });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    releaseRunApi(id);
  }
}
