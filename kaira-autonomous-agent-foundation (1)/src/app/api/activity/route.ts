import { desc } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema";

export const dynamic = "force-dynamic";

/** The Brandon ⇄ Kaira activity feed, newest first. */
export async function GET() {
  const rows = await db
    .select()
    .from(messages)
    .orderBy(desc(messages.createdAt))
    .limit(40);
  return Response.json({ ok: true, messages: rows });
}
