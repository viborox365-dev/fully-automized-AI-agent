import { eq } from "drizzle-orm";
import { db } from "@/db";
import { memories } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const [row] = await db
    .delete(memories)
    .where(eq(memories.id, id))
    .returning({ id: memories.id });
  if (!row) {
    return Response.json({ ok: false, error: "Memory not found" }, { status: 404 });
  }
  return Response.json({ ok: true, deleted: row.id });
}
