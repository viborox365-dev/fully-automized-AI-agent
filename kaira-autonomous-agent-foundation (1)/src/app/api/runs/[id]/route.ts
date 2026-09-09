import { asc, eq, gt, and } from "drizzle-orm";
import { db } from "@/db";
import { objectives, runs, steps } from "@/db/schema";

export const dynamic = "force-dynamic";

/** Run detail + its event log. `?after=<seq>` returns only newer steps. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const [run] = await db.select().from(runs).where(eq(runs.id, id));
  if (!run) {
    return Response.json({ ok: false, error: "Run not found" }, { status: 404 });
  }
  const [objective] = await db
    .select()
    .from(objectives)
    .where(eq(objectives.id, run.objectiveId));
  const url = new URL(req.url);
  const after = Number(url.searchParams.get("after") ?? "-1");
  const stepRows = await db
    .select()
    .from(steps)
    .where(and(eq(steps.runId, id), gt(steps.seq, Number.isFinite(after) ? after : -1)))
    .orderBy(asc(steps.seq))
    .limit(600);
  return Response.json({ ok: true, run, objective: objective ?? null, steps: stepRows });
}
