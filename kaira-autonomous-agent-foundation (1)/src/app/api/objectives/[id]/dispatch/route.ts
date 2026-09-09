import { z } from "zod";
import { dispatchObjective } from "@/agent/engine";

export const dynamic = "force-dynamic";

const schema = z.object({
  maxSteps: z.number().int().min(1).max(100).optional(),
});

/** Queue a fresh run for this objective. Any driver (worker / API) may then execute it. */
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
  try {
    const run = await dispatchObjective(id, parsed.data);
    return Response.json({ ok: true, run });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
