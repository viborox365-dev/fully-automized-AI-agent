import { desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { objectives, runs } from "@/db/schema";
import { createObjective } from "@/agent/engine";

export const dynamic = "force-dynamic";

/** List objectives with their latest run. */
export async function GET() {
  const rows = await db
    .select()
    .from(objectives)
    .orderBy(desc(objectives.createdAt))
    .limit(100);
  const activeRuns = rows.length
    ? await db
        .select()
        .from(runs)
        .where(inArray(runs.objectiveId, rows.map((r) => r.id)))
        .orderBy(desc(runs.createdAt))
    : [];
  const latestByObjective = new Map<string, (typeof activeRuns)[number]>();
  for (const run of activeRuns) {
    if (!latestByObjective.has(run.objectiveId)) {
      latestByObjective.set(run.objectiveId, run);
    }
  }
  return Response.json({
    ok: true,
    objectives: rows.map((o) => ({
      ...o,
      latestRun: latestByObjective.get(o.id) ?? null,
    })),
  });
}

const createSchema = z.object({
  title: z.string().min(2).max(300),
  description: z.string().max(8000).optional(),
  priority: z.number().int().min(0).max(5).optional(),
  autoDispatch: z.boolean().optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
});

/** Create an objective (Brandon's input channel), optionally dispatching it. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  try {
    const result = await createObjective(parsed.data);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
