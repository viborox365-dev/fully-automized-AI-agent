import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { objectives, runs } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const [objective] = await db
    .select()
    .from(objectives)
    .where(eq(objectives.id, id));
  if (!objective) {
    return Response.json({ ok: false, error: "Objective not found" }, { status: 404 });
  }
  const runRows = await db
    .select()
    .from(runs)
    .where(eq(runs.objectiveId, id))
    .orderBy(desc(runs.createdAt))
    .limit(25);
  return Response.json({ ok: true, objective, runs: runRows });
}

const patchSchema = z.object({
  status: z.enum(["pending", "active", "paused", "completed", "failed", "archived"]),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ ok: false, error: "Invalid status" }, { status: 400 });
  }
  const [updated] = await db
    .update(objectives)
    .set({ status: parsed.data.status, updatedAt: new Date() })
    .where(eq(objectives.id, id))
    .returning();
  if (!updated) {
    return Response.json({ ok: false, error: "Objective not found" }, { status: 404 });
  }
  return Response.json({ ok: true, objective: updated });
}
