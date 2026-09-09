import { z } from "zod";
import { desc, ilike, or } from "drizzle-orm";
import { memories } from "@/db/schema";
import type { Tool } from "./types";

/**
 * Kaira's long-term memory — durable facts, procedures and notes stored in
 * PostgreSQL. Retrieval is keyword-based today (honest, inspectable);
 * embedding/vector retrieval plugs into the same table later.
 */

export const memorySave = {
  name: "memory_save",
  category: "memory",
  description:
    "Save an important fact, procedure, user preference or lesson to long-term memory. Use when you learn something worth remembering across sessions.",
  schema: z.object({
    content: z.string().min(1).max(4000),
    kind: z.enum(["fact", "procedure", "feedback", "note"]).optional(),
    tags: z.array(z.string().min(1).max(40)).max(8).optional(),
    importance: z.number().int().min(1).max(5).optional(),
  }),
  parameters: {
    type: "object",
    properties: {
      content: { type: "string" },
      kind: { type: "string", enum: ["fact", "procedure", "feedback", "note"] },
      tags: { type: "array", items: { type: "string" } },
      importance: { type: "number", description: "1–5, higher = more important" },
    },
    required: ["content"],
  },
  async execute(
    input: { content: string; kind?: "fact" | "procedure" | "feedback" | "note"; tags?: string[]; importance?: number },
    ctx,
  ) {
    const [row] = await ctx.db
      .insert(memories)
      .values({
        content: input.content,
        kind: input.kind ?? "note",
        tags: input.tags ?? [],
        importance: input.importance ?? 1,
      })
      .returning({ id: memories.id });
    return {
      ok: true,
      output: `Saved to long-term memory (${input.kind ?? "note"}, id ${row.id}).`,
      data: { id: row.id },
    };
  },
} satisfies Tool<{ content: string; kind?: "fact" | "procedure" | "feedback" | "note"; tags?: string[]; importance?: number }>;

export const memorySearch = {
  name: "memory_search",
  category: "memory",
  description:
    "Search long-term memory by keywords. Without a query, returns the most recent memories. Use before starting work to recall relevant context.",
  schema: z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: [],
  },
  async execute(input: { query?: string; limit?: number }, ctx) {
    const limit = input.limit ?? 8;
    const words = (input.query ?? "")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3)
      .slice(0, 6);
    const where =
      words.length > 0
        ? or(...words.map((w) => ilike(memories.content, `%${w}%`)))
        : undefined;
    const rows = await ctx.db
      .select()
      .from(memories)
      .where(where)
      .orderBy(desc(memories.importance), desc(memories.createdAt))
      .limit(limit);
    return {
      ok: true,
      output: rows.length
        ? rows
            .map(
              (m) =>
                `[${m.kind}] ${m.content}${m.tags.length ? ` (tags: ${m.tags.join(", ")})` : ""}`,
            )
            .join("\n---\n")
        : input.query
          ? `No memories matched "${input.query}".`
          : "Long-term memory is empty.",
      data: {
        matches: rows.map((m) => ({
          id: m.id,
          kind: m.kind,
          content: m.content,
          tags: m.tags,
        })),
      },
    };
  },
} satisfies Tool<{ query?: string; limit?: number }>;

/** Keyword retrieval used by the engine to prime prompts. */
export async function recallMemories(
  dbClient: Parameters<typeof memorySearch.execute>[1]["db"],
  hint: string,
  limit = 6,
) {
  const words = hint
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4)
    .slice(0, 5);
  const where =
    words.length > 0
      ? or(...words.map((w) => ilike(memories.content, `%${w}%`)))
      : undefined;
  return dbClient
    .select()
    .from(memories)
    .where(where)
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(limit);
}
