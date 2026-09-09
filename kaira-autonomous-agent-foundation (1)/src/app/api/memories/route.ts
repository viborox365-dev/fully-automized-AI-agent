import { desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { memories } from "@/db/schema";
import { recallMemories } from "@/agent/tools/memory";

export const dynamic = "force-dynamic";

/** List memories (optionally keyword-filtered via ?q=). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const rows = q
    ? await recallMemories(db, q, 50)
    : await db
        .select()
        .from(memories)
        .orderBy(desc(memories.createdAt))
        .limit(100);
  return Response.json({ ok: true, memories: rows });
}

const createSchema = z.object({
  content: z.string().min(1).max(4000),
  kind: z.enum(["fact", "procedure", "feedback", "note"]).optional(),
  tags: z.array(z.string().min(1).max(40)).max(8).optional(),
  importance: z.number().int().min(1).max(5).optional(),
});

/** Add a memory (Brandon can teach Kaira directly here). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const [row] = await db
    .insert(memories)
    .values({
      content: parsed.data.content.trim(),
      kind: parsed.data.kind ?? "note",
      tags: parsed.data.tags ?? [],
      importance: parsed.data.importance ?? 1,
    })
    .returning();
  return Response.json({ ok: true, memory: row });
}
