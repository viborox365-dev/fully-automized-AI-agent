import { sql } from "drizzle-orm";
import { db } from "@/db";
import { kv } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getModelStack } from "@/agent/model";
import { workspaceRoot } from "@/agent/workspace";

export const dynamic = "force-dynamic";

/**
 * Live system status — the honest picture of what is actually available:
 * database, model backend (real health check against the provider), worker.
 */
export async function GET() {
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }

  let model: Record<string, unknown> = {
    provider: "unknown",
    available: false,
    detail: "unavailable",
    model: "",
    models: [],
  };
  try {
    const stack = await getModelStack();
    model = {
      provider: stack.config.provider,
      label: stack.provider.label,
      model: stack.config.model,
      baseUrl: stack.config.baseUrl,
      hasApiKey: Boolean(stack.config.apiKey),
      available: stack.status.ok,
      detail: stack.status.detail,
      models: stack.status.models,
    };
  } catch (err) {
    model = {
      provider: "unknown",
      available: false,
      detail: err instanceof Error ? err.message : String(err),
      model: "",
      models: [],
    };
  }

  let worker: { online: boolean; lastSeenAt: string | null; owner: string | null } = {
    online: false,
    lastSeenAt: null,
    owner: null,
  };
  try {
    const rows = await db
      .select()
      .from(kv)
      .where(eq(kv.key, "worker:heartbeat"));
    if (rows[0]?.value && typeof rows[0].value === "object") {
      const hb = rows[0].value as { at?: string; owner?: string };
      const at = hb.at ? Date.parse(hb.at) : NaN;
      const fresh = Number.isFinite(at) && Date.now() - at < 20_000;
      worker = {
        online: fresh,
        lastSeenAt: hb.at ?? null,
        owner: hb.owner ?? null,
      };
    }
  } catch {
    /* kv table may not exist pre-migration */
  }

  const counts = {
    objectives: {} as Record<string, number>,
    runs: {} as Record<string, number>,
  };
  try {
    const objRows = await db.execute(
      sql`select status::text as status, count(*)::int as c from objectives group by status`,
    );
    for (const r of objRows.rows as Array<{ status: string; c: number }>) {
      counts.objectives[r.status] = r.c;
    }
    const runRows = await db.execute(
      sql`select status::text as status, count(*)::int as c from runs group by status`,
    );
    for (const r of runRows.rows as Array<{ status: string; c: number }>) {
      counts.runs[r.status] = r.c;
    }
  } catch {
    /* pre-migration */
  }

  return Response.json({
    ok: dbOk,
    agent: { name: "Kaira", version: "0.1.0", role: "autonomous operator" },
    db: { ok: dbOk },
    model,
    worker,
    counts,
    workspace: { root: workspaceRoot() },
  });
}
