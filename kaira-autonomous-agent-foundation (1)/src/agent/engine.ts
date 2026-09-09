import { and, desc, eq, max, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  messages,
  objectives,
  runs,
  steps,
  type Objective,
  type Run,
  type Step,
} from "@/db/schema";
import {
  getProvider,
  resolveModelConfig,
  type ChatMessage,
  type ModelProvider,
} from "./model";
import { executeTool, toolsPromptSection } from "./tools";
import { recallMemories } from "./tools/memory";
import { ensureWorkspace } from "./workspace";
import { parseAgentResponse, parseCriticResponse } from "./parse";
import {
  PARSE_FEEDBACK,
  criticMessages,
  planningMessages,
  reactMessages,
  renderTranscript,
} from "./prompts";

/**
 * Kaira engine — the control loop that turns an objective into real work.
 *
 *   plan → (think → act → observe)* → verify (critic) → complete/fail
 *
 * Every transition is persisted, so a run can be driven by the background
 * worker OR by the API ("advance"), paused, and resumed after a crash.
 * The engine never touches a specific model SDK — only the ModelProvider
 * interface — so the underlying model is replaceable.
 */

export class InfraError extends Error {}

const TERMINAL: Array<Run["status"]> = ["completed", "failed", "stopped"];
export const RUNNABLE: Array<Run["status"]> = [
  "queued",
  "planning",
  "running",
  "verifying",
];

const MODEL_TIMEOUT_MS = Number(process.env.KAIRA_MODEL_TIMEOUT_MS ?? 180_000);
const DEFAULT_MAX_STEPS = Number(process.env.KAIRA_MAX_STEPS ?? 20);

/* ------------------------------ small helpers ----------------------------- */

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function slimData(data: unknown): unknown {
  if (data == null) return null;
  try {
    const s = JSON.stringify(data);
    return s.length <= 1500 ? data : null;
  } catch {
    return null;
  }
}

async function getRun(runId: string): Promise<Run> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`Run not found: ${runId}`);
  return run;
}

async function getObjective(id: string): Promise<Objective> {
  const [row] = await db.select().from(objectives).where(eq(objectives.id, id));
  if (!row) throw new Error(`Objective not found: ${id}`);
  return row;
}

async function recordStep(
  runId: string,
  kind: Step["kind"],
  fields: {
    name?: string | null;
    input?: unknown;
    output?: unknown;
    latencyMs?: number | null;
  },
): Promise<Step> {
  const [{ value }] = await db
    .select({ value: max(steps.seq) })
    .from(steps)
    .where(eq(steps.runId, runId));
  const seq = (value ?? 0) + 1;
  const [row] = await db
    .insert(steps)
    .values({
      runId,
      seq,
      kind,
      name: fields.name ?? null,
      input: (fields.input ?? null) as Step["input"],
      output: (fields.output ?? null) as Step["output"],
      latencyMs: fields.latencyMs ?? null,
    })
    .returning();
  return row;
}

async function clearLock(runId: string): Promise<void> {
  await db
    .update(runs)
    .set({ lockedAt: null, lockOwner: null })
    .where(eq(runs.id, runId));
}

/* --------------------------- objective lifecycle -------------------------- */

export async function createObjective(input: {
  title: string;
  description?: string;
  priority?: number;
  createdBy?: string;
  autoDispatch?: boolean;
  maxSteps?: number;
}): Promise<{ objective: Objective; run: Run | null }> {
  const [objective] = await db
    .insert(objectives)
    .values({
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      priority: input.priority ?? 0,
      createdBy: input.createdBy ?? "brandon",
      status: "pending",
    })
    .returning();
  await db.insert(messages).values({
    role: "brandon",
    content: `New objective: ${objective.title}`,
    objectiveId: objective.id,
  });
  let run: Run | null = null;
  if (input.autoDispatch) {
    run = await dispatchObjective(objective.id, { maxSteps: input.maxSteps });
  }
  return { objective, run };
}

export async function dispatchObjective(
  objectiveId: string,
  opts: { maxSteps?: number } = {},
): Promise<Run> {
  const objective = await getObjective(objectiveId);
  if (objective.status === "archived") {
    throw new Error("Cannot dispatch an archived objective");
  }
  const [run] = await db
    .insert(runs)
    .values({ objectiveId, status: "queued", maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS })
    .returning();
  await db
    .update(objectives)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(objectives.id, objectiveId));
  return run;
}

/* ------------------------------- run driving ------------------------------ */

/**
 * Atomically claim the right to drive a run. A driver holds the claim via a
 * lock that expires after 2 minutes (renewed every tick), so a crashed
 * worker's runs are picked up again automatically.
 */
export async function claimRun(runId: string, owner: string): Promise<boolean> {
  const res = await db.execute(sql`
    UPDATE runs
    SET locked_at = now(),
        lock_owner = ${owner},
        status = CASE WHEN status = 'queued' THEN 'planning'::run_status ELSE status END,
        started_at = COALESCE(started_at, now())
    WHERE id = ${runId}
      AND status IN ('queued', 'planning', 'running', 'verifying')
      AND (locked_at IS NULL OR lock_owner = ${owner} OR locked_at < now() - interval '2 minutes')
    RETURNING id
  `);
  return res.rows.length > 0;
}

export interface DriverOptions {
  /** Max ticks to execute in this call (1 = single step). */
  ticks?: number;
  /** Test hook / future model routing: execute with a specific provider. */
  provider?: ModelProvider;
  model?: string;
}

export interface AdvanceResult {
  ok: boolean;
  error?: string;
  run: Run;
}

export async function advanceRun(
  runId: string,
  owner: string,
  opts: DriverOptions = {},
): Promise<AdvanceResult> {
  const ticks = Math.max(1, Math.min(opts.ticks ?? 1, 64));
  for (let i = 0; i < ticks; i++) {
    const run = await getRun(runId);
    if (TERMINAL.includes(run.status)) break;
    const claimed = await claimRun(runId, owner);
    if (!claimed) {
      return { ok: false, error: "Run is locked by another driver.", run };
    }
    try {
      const terminal = await tick(runId, opts);
      if (terminal) break;
    } catch (err) {
      if (err instanceof InfraError) {
        return { ok: false, error: err.message, run: await getRun(runId) };
      }
      throw err;
    }
  }
  return { ok: true, run: await getRun(runId) };
}

/* --------------------------------- the tick ------------------------------- */

interface ModelStack {
  provider: ModelProvider;
  model: string;
}

async function resolveStack(run: Run, opts?: DriverOptions): Promise<ModelStack> {
  if (opts?.provider) {
    return { provider: opts.provider, model: opts.model ?? run.modelId ?? "selftest" };
  }
  const config = await resolveModelConfig();
  const provider = getProvider(config);
  let model = config.model;
  if (!model) {
    const status = await provider.status();
    model = status.models[0] ?? "";
  }
  if (!model) {
    throw new InfraError(
      `No model is configured for provider "${provider.id}". Pull one (e.g. \`ollama pull llama3.1:8b\`) or set a model in Settings.`,
    );
  }
  return { provider, model };
}

/** One atomic unit of work: planning, or a single act/observe cycle. */
export async function tick(runId: string, opts?: DriverOptions): Promise<boolean> {
  let run = await getRun(runId);
  if (TERMINAL.includes(run.status)) return true;
  if (run.stepCount >= run.maxSteps) {
    await failRun(run, `Step budget exhausted (${run.maxSteps} steps). Re-dispatch with a larger budget or a sharper objective.`);
    return true;
  }
  let stack: ModelStack;
  try {
    stack = await resolveStack(run, opts);
  } catch (err) {
    if (err instanceof InfraError) {
      await handleInfraFailure(run, err.message);
      throw err;
    }
    throw err;
  }
  run = await getRun(runId);
  if (!run.plan) return doPlanning(run, stack);
  return doReActStep(run, stack);
}

/** Convert a model transport failure into a visible, resumable state. */
async function handleInfraFailure(run: Run, message: string): Promise<never> {
  await db
    .update(runs)
    .set({ error: message })
    .where(eq(runs.id, run.id));
  const [last] = await db
    .select()
    .from(steps)
    .where(eq(steps.runId, run.id))
    .orderBy(desc(steps.seq))
    .limit(1);
  if (!(last && last.kind === "error" && last.name === "model")) {
    await recordStep(run.id, "error", {
      name: "model",
      output: {
        message,
        feedback:
          "Start the model backend (e.g. `ollama serve` with a pulled model) or switch provider in Settings, then resume this run.",
      },
    });
  }
  await clearLock(run.id);
  throw new InfraError(message);
}

async function generateOrThrow(
  run: Run,
  stack: ModelStack,
  chat: ChatMessage[],
  gen: { temperature?: number; maxTokens?: number },
) {
  try {
    return await stack.provider.generate(chat, {
      temperature: gen.temperature,
      maxTokens: gen.maxTokens,
      timeoutMs: MODEL_TIMEOUT_MS,
      model: stack.model,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await handleInfraFailure(run, `Model call failed — ${message}`);
    throw new InfraError(message); // unreachable; satisfies TS
  }
}

async function doPlanning(run: Run, stack: ModelStack): Promise<boolean> {
  const objective = await getObjective(run.objectiveId);
  const mem = await recallMemories(
    db,
    `${objective.title} ${objective.description}`,
  ).catch(() => []);
  const chat = planningMessages({
    objective,
    toolsSection: toolsPromptSection(),
    memories: mem.map((m) => m.content),
  });
  const r = await generateOrThrow(run, stack, chat, {
    temperature: 0.3,
    maxTokens: 1024,
  });
  let plan = r.content.trim();
  const fenced = plan.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (fenced) plan = fenced[1].trim();
  const jsonPlan = plan.match(/\{[\s\S]*"plan"[\s\S]*\}/);
  if (jsonPlan) {
    try {
      const obj = JSON.parse(jsonPlan[0]);
      if (typeof obj.plan === "string") plan = obj.plan.trim();
      else if (Array.isArray(obj.plan))
        plan = obj.plan.map((s: unknown, i: number) => `${i + 1}. ${String(s)}`).join("\n");
    } catch {
      /* keep raw plan */
    }
  }
  if (!plan) plan = "(model returned an empty plan — proceed directly with the objective)";
  await recordStep(run.id, "plan", {
    output: {
      plan: cap(plan, 6000),
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
    },
    latencyMs: r.latencyMs,
  });
  await db
    .update(runs)
    .set({
      plan: cap(plan, 8000),
      status: "running",
      modelId: r.model,
      tokensIn: run.tokensIn + (r.tokensIn ?? 0),
      tokensOut: run.tokensOut + (r.tokensOut ?? 0),
      lockedAt: new Date(),
      error: null,
    })
    .where(eq(runs.id, run.id));
  return false;
}

async function doReActStep(run: Run, stack: ModelStack): Promise<boolean> {
  const objective = await getObjective(run.objectiveId);
  const recentDesc = await db
    .select()
    .from(steps)
    .where(eq(steps.runId, run.id))
    .orderBy(desc(steps.seq))
    .limit(16);
  const recent = recentDesc.reverse();
  const mem = await recallMemories(
    db,
    `${objective.title} ${objective.description}`,
  ).catch(() => []);
  const chat = reactMessages({
    objective,
    plan: run.plan ?? "",
    toolsSection: toolsPromptSection(),
    memories: mem.map((m) => m.content),
    transcript: renderTranscript(recent),
  });
  const r = await generateOrThrow(run, stack, chat, {
    temperature: 0.2,
    maxTokens: 1400,
  });
  const parsed = parseAgentResponse(r.content);
  const tokenUpdate = {
    tokensIn: run.tokensIn + (r.tokensIn ?? 0),
    tokensOut: run.tokensOut + (r.tokensOut ?? 0),
    lockedAt: new Date(),
    error: null,
    modelId: r.model,
  };

  if (parsed.type === "invalid") {
    await recordStep(run.id, "error", {
      name: "parse",
      output: {
        message: `${parsed.reason}${parsed.raw ? ` — model said: "${cap(parsed.raw, 220)}"` : ""}`,
        feedback: PARSE_FEEDBACK,
      },
      latencyMs: r.latencyMs,
    });
    // Fail fast if the model cannot follow the protocol at all.
    const [s1, s2, s3] = recentDesc;
    const streak =
      s1?.kind === "error" && s2?.kind === "error" && s3?.kind === "error";
    if (streak) {
      await failRun(
        run,
        "Model repeatedly failed to produce a valid action envelope. A more capable or instruction-tuned model may be required.",
      );
      return true;
    }
    await db
      .update(runs)
      .set({ ...tokenUpdate, stepCount: run.stepCount + 1 })
      .where(eq(runs.id, run.id));
    return false;
  }

  if (parsed.type === "action") {
    await recordStep(run.id, "action", {
      name: parsed.tool,
      input: parsed.input as Step["input"],
      output: { thought: cap(parsed.thought, 500), model: r.model },
      latencyMs: r.latencyMs,
    });
    await db
      .update(runs)
      .set({ ...tokenUpdate, stepCount: run.stepCount + 1 })
      .where(eq(runs.id, run.id));
    const result = await executeTool(parsed.tool, parsed.input, {
      db,
      workspaceRoot: ensureWorkspace(),
      runId: run.id,
    });
    await recordStep(run.id, "observation", {
      name: parsed.tool,
      output: {
        ok: result.ok,
        output: cap(result.output, 6000),
        data: slimData(result.data),
      },
    });
    return false;
  }

  /* ------------------------- final → verification ------------------------ */
  await recordStep(run.id, "final", {
    output: { thought: cap(parsed.thought, 500), final: cap(parsed.final, 4000) },
    latencyMs: r.latencyMs,
  });
  await db
    .update(runs)
    .set({ ...tokenUpdate, stepCount: run.stepCount + 1, status: "verifying" })
    .where(eq(runs.id, run.id));

  const afterDesc = await db
    .select()
    .from(steps)
    .where(eq(steps.runId, run.id))
    .orderBy(desc(steps.seq))
    .limit(18);
  const criticChat = criticMessages({
    objective,
    plan: run.plan ?? "",
    transcript: renderTranscript(afterDesc.reverse(), 900),
    proposedFinal: parsed.final,
  });
  const criticResult = await generateOrThrow(run, stack, criticChat, {
    temperature: 0.1,
    maxTokens: 400,
  });
  const verdict = parseCriticResponse(criticResult.content);

  if (!verdict.valid) {
    await recordStep(run.id, "critic", {
      output: {
        complete: null,
        reason: "Critic returned unparseable output — accepting result, flagged as unverified.",
        raw: cap(criticResult.content, 300),
      },
    });
    await completeRun(run, objective, `${parsed.final}\n\n[critic: unavailable — result accepted without verification]`);
    return true;
  }
  await recordStep(run.id, "critic", {
    output: { complete: verdict.complete, reason: cap(verdict.reason, 600) },
    latencyMs: criticResult.latencyMs,
  });
  if (verdict.complete) {
    await completeRun(run, objective, parsed.final);
    return true;
  }
  await recordStep(run.id, "observation", {
    name: "critic",
    output: {
      ok: false,
      output: `Completion rejected by verification critic: ${cap(verdict.reason, 500)}. Continue working — address this before finishing.`,
    },
  });
  await db
    .update(runs)
    .set({ status: "running", lockedAt: new Date() })
    .where(eq(runs.id, run.id));
  return false;
}

/* ------------------------------- transitions ------------------------------ */

async function completeRun(run: Run, objective: Objective, result: string) {
  const now = new Date();
  await db
    .update(runs)
    .set({
      status: "completed",
      result: cap(result, 8000),
      error: null,
      finishedAt: now,
      lockedAt: null,
      lockOwner: null,
    })
    .where(eq(runs.id, run.id));
  await db
    .update(objectives)
    .set({ status: "completed", result: cap(result, 8000), updatedAt: now })
    .where(eq(objectives.id, objective.id));
  await db.insert(messages).values({
    role: "kaira",
    content: `Objective completed — "${objective.title}"\n\n${cap(result, 1200)}`,
    objectiveId: objective.id,
  });
}

async function failRun(run: Run, message: string) {
  const now = new Date();
  await db
    .update(runs)
    .set({
      status: "failed",
      error: cap(message, 2000),
      finishedAt: now,
      lockedAt: null,
      lockOwner: null,
    })
    .where(eq(runs.id, run.id));
  const objective = await getObjective(run.objectiveId);
  await db
    .update(objectives)
    .set({ status: "failed", updatedAt: now })
    .where(eq(objectives.id, objective.id));
  await db.insert(messages).values({
    role: "kaira",
    content: `Objective failed — "${objective.title}"\n\n${cap(message, 1200)}`,
    objectiveId: objective.id,
  });
}

export async function stopRun(runId: string): Promise<Run> {
  const res = await db.execute(sql`
    UPDATE runs SET status = 'stopped', finished_at = now(), locked_at = NULL, lock_owner = NULL
    WHERE id = ${runId} AND status IN ('queued', 'planning', 'running', 'verifying')
    RETURNING objective_id
  `);
  const objectiveId = (res.rows[0] as { objective_id?: string } | undefined)?.objective_id;
  const run = await getRun(runId);
  if (objectiveId) {
    await db
      .update(objectives)
      .set({ status: "paused", updatedAt: new Date() })
      .where(and(eq(objectives.id, objectiveId)));
  }
  return run;
}
