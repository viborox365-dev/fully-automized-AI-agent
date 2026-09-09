import "dotenv/config";
import os from "node:os";
import { sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { kv } from "@/db/schema";
import { advanceRun } from "@/agent/engine";
import { ensureWorkspace } from "@/agent/workspace";

/**
 * Kaira worker — the long-running driver that makes Kaira autonomous.
 *
 * Brandon drops an objective via the UI/API; Postgres is the queue; this
 * process claims runs (FOR UPDATE SKIP LOCKED — safe for multiple workers)
 * and drives them to completion. Crash-safe: locks expire and work resumes.
 *
 *   npx tsx src/worker/runner.ts     (or: npm run worker)
 */

const OWNER = `worker-${os.hostname()}-${process.pid}`;
const IDLE_SLEEP_MS = 4_000;
const INFRA_BACKOFF_MS = 30_000;
const TICKS_PER_RUN = 64;

let stopping = false;
let backoffUntil = 0;

function log(...args: unknown[]) {
  console.log(`[kaira-worker ${new Date().toISOString()}]`, ...args);
}

async function heartbeat(): Promise<void> {
  const value = { owner: OWNER, at: new Date().toISOString() };
  await db
    .insert(kv)
    .values({ key: "worker:heartbeat", value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: kv.key,
      set: { value, updatedAt: new Date() },
    });
}

async function claimNextRunId(): Promise<string | null> {
  const res = await db.execute(sql`
    UPDATE runs
    SET locked_at = now(),
        lock_owner = ${OWNER},
        status = CASE WHEN status = 'queued' THEN 'planning'::run_status ELSE status END,
        started_at = COALESCE(started_at, now())
    WHERE id = (
      SELECT id FROM runs
      WHERE status IN ('queued', 'planning', 'running', 'verifying')
        AND (locked_at IS NULL OR locked_at < now() - interval '2 minutes')
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  return (res.rows[0] as { id?: string } | undefined)?.id ?? null;
}

async function main() {
  ensureWorkspace();
  await heartbeat();
  log(`online as ${OWNER} — waiting for objectives (Ctrl+C to stop)`);

  while (!stopping) {
    try {
      await heartbeat();
    } catch (err) {
      log("heartbeat failed (DB unreachable?):", err instanceof Error ? err.message : err);
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    if (Date.now() < backoffUntil) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    let runId: string | null = null;
    try {
      runId = await claimNextRunId();
    } catch (err) {
      log("claim failed:", err instanceof Error ? err.message : err);
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    if (!runId) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    log(`driving run ${runId}`);
    try {
      const result = await advanceRun(runId, OWNER, { ticks: TICKS_PER_RUN });
      if (!result.ok) {
        // Infra failure (model offline, etc.): run stays runnable; back off.
        log(`run paused — ${result.error}`);
        backoffUntil = Date.now() + INFRA_BACKOFF_MS;
        log(`backing off ${INFRA_BACKOFF_MS / 1000}s before retrying`);
      } else {
        log(`run ${result.run.id.slice(0, 8)} → ${result.run.status} (steps: ${result.run.stepCount})`);
      }
    } catch (err) {
      log("unexpected driver error:", err instanceof Error ? err.message : err);
      await sleep(IDLE_SLEEP_MS);
    }
  }

  log("shutting down — held locks expire within 2 minutes and run work resumes elsewhere");
  await pool.end().catch(() => undefined);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

process.on("SIGINT", () => {
  stopping = true;
  log("SIGINT received — finishing current unit of work…");
  setTimeout(() => process.exit(0), 8_000).unref();
});
process.on("SIGTERM", () => {
  stopping = true;
  setTimeout(() => process.exit(0), 8_000).unref();
});

main().catch((err) => {
  console.error("[kaira-worker] fatal:", err);
  process.exit(1);
});
