/**
 * Kaira Agent Core — Phase 2 Orchestrator
 *
 * The central execution engine that turns an objective into real work:
 *
 *   OBJECTIVE → UNDERSTAND → PLAN → EXECUTE → OBSERVE → DIAGNOSE → REPAIR
 *             → RETRY → VERIFY → COMPLETE / FAILED / ESCALATED
 *
 * Unlike the Phase 1 ReAct loop (engine.ts), the Agent Core uses a structured
 * plan (JSON tasks with tools, inputs, dependencies, verification criteria)
 * and processes tasks sequentially with explicit failure recovery.
 *
 * Every state transition is logged. The AI's generated response is never
 * considered completion — only verified real-world outcomes are.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { objectives, runs, steps, tasks } from "@/db/schema";
import {
  cap,
  completeRun,
  dispatchObjective,
  escalateRun,
  failRun,
  getObjective,
  getRun,
  recordStep,
  setAgentState,
} from "./engine";
import { executeTool } from "./tools";
import { ensureWorkspace } from "./workspace";
import { planObjective, type StructuredPlan, type StructuredTask } from "./planner";
import { verifyTask, verifyObjective, type VerificationResult } from "./verifier";
import { diagnoseFailure, generateRepair, type DiagnosisResult, type RepairAction } from "./recovery";
import { SAFEGUARD_LIMITS } from "./safeguards";
import { renderTranscript } from "./prompts";
import { type AgentState, canTransition } from "./states";
import type { ModelProvider } from "./model";

/* ────────────────────────────── types ────────────────────────────── */

export interface CoreOptions {
  /** Injected provider (for testing). If omitted, the configured provider is used. */
  provider?: ModelProvider;
  /** Max retries per task before escalation. */
  maxRetries?: number;
  /** Execution timeout in ms (0 = no limit). */
  timeoutMs?: number;
  /** Max steps for the run. */
  maxSteps?: number;
}

export interface CoreResult {
  status: "completed" | "failed" | "escalated";
  result?: string;
  error?: string;
  runId: string;
  objectiveId: string;
}

/* ──────────────────────────── helpers ────────────────────────────── */

/** Log a state transition as a step in the run log. */
async function logTransition(
  runId: string,
  from: AgentState,
  to: AgentState,
  reason: string,
): Promise<void> {
  // Validate the transition
  if (!canTransition(from, to)) {
    console.warn(`[kaira-core] Invalid transition: ${from}→${to}`);
  }
  await recordStep(runId, "transition", {
    output: { from, to, reason, timestamp: new Date().toISOString() },
  });
  await setAgentState(runId, to);
  // Also update run status for non-terminal states (terminal states are
  // handled by completeRun / failRun / escalateRun).
  const statusMap: Partial<Record<AgentState, string>> = {
    planning: "planning",
    executing: "running",
    observing: "running",
    diagnosing: "running",
    repairing: "running",
    retrying: "running",
    verifying: "verifying",
  };
  const status = statusMap[to];
  if (status) {
    await db
      .update(runs)
      .set({ status: status as typeof runs.$inferSelect["status"], lockedAt: new Date() })
      .where(eq(runs.id, runId));
  }
}

/** Store a structured plan's tasks in the database. */
async function storeTasks(
  objectiveId: string,
  runId: string,
  plan: StructuredPlan,
): Promise<string[]> {
  const taskIds: string[] = [];
  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i];
    const [row] = await db
      .insert(tasks)
      .values({
        objectiveId,
        runId,
        title: cap(t.description, 500),
        description: t.description,
        state: "idle",
        order: i,
        dependencies: t.depends_on,
        toolName: t.tool,
        toolInput: t.input,
        verificationStatus: "pending",
      })
      .returning({ id: tasks.id });
    taskIds.push(row.id);
  }
  return taskIds;
}

/** Update a task's state and fields in the database. */
async function updateTask(
  taskId: string,
  fields: {
    state?: AgentState;
    actionResult?: unknown;
    errorInfo?: unknown;
    verificationStatus?: string;
    verificationDetail?: unknown;
    result?: string;
    error?: string;
    retryCount?: number;
  },
): Promise<void> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (fields.state !== undefined) update.state = fields.state;
  if (fields.actionResult !== undefined) update.actionResult = fields.actionResult;
  if (fields.errorInfo !== undefined) update.errorInfo = fields.errorInfo;
  if (fields.verificationStatus !== undefined) update.verificationStatus = fields.verificationStatus;
  if (fields.verificationDetail !== undefined) update.verificationDetail = fields.verificationDetail;
  if (fields.result !== undefined) update.result = cap(fields.result, 4000);
  if (fields.error !== undefined) update.error = cap(fields.error, 4000);
  if (fields.retryCount !== undefined) update.retryCount = fields.retryCount;
  await db.update(tasks).set(update).where(eq(tasks.id, taskId));
}

/** Build a compact transcript of recent steps for the diagnosis model. */
async function buildTranscript(runId: string): Promise<string> {
  const recent = await db
    .select()
    .from(steps)
    .where(eq(steps.runId, runId))
    .orderBy(steps.seq)
    .limit(20);
  return renderTranscript(recent);
}

/* ──────────────────────── the agent core loop ────────────────────── */

/**
 * Run an objective through the Agent Core.
 *
 * Creates a run, plans with the reasoning model, executes tasks with real
 * tools, recovers from failures, verifies outcomes, and marks the objective
 * as completed, failed, or escalated.
 *
 * @param objectiveId  The objective to execute.
 * @param opts          Options (provider, max retries, timeout).
 * @returns             The execution result.
 */
export async function runAgentCore(
  objectiveId: string,
  opts: CoreOptions = {},
): Promise<CoreResult> {
  const maxRetries = opts.maxRetries ?? SAFEGUARD_LIMITS.MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? 0;
  const startTime = Date.now();

  const objective = await getObjective(objectiveId);
  const run = await dispatchObjective(objectiveId, { maxSteps: opts.maxSteps ?? 30 });
  const runId = run.id;

  // Helper to check timeout
  const checkTimeout = (): boolean =>
    timeoutMs > 0 && Date.now() - startTime > timeoutMs;

  try {
    /* ── PLANNING ─────────────────────────────────────────────── */
    await logTransition(runId, "idle", "planning", "Starting objective planning");

    let plan: StructuredPlan;
    try {
      plan = await planObjective(objective, opts.provider);
    } catch (err) {
      const msg = `Planning failed: ${err instanceof Error ? err.message : String(err)}`;
      await recordStep(runId, "error", { name: "planner", output: { message: msg } });
      await failRun(run, msg);
      return { status: "failed", error: msg, runId, objectiveId };
    }

    await recordStep(runId, "plan", {
      output: {
        understanding: cap(plan.understanding, 4000),
        taskCount: plan.tasks.length,
        tasks: plan.tasks.map((t, i) => ({
          i,
          description: t.description,
          tool: t.tool,
          verify: t.verify,
        })),
      },
    });

    // Store tasks in the database
    const taskIds = await storeTasks(objectiveId, runId, plan);

    // Update objective tracking
    await db
      .update(objectives)
      .set({ attemptCount: 1, updatedAt: new Date() })
      .where(eq(objectives.id, objectiveId));

    /* ── EXECUTION ────────────────────────────────────────────── */
    await logTransition(runId, "planning", "executing", "Starting task execution");

    let lastOutput = "";
    const taskVerifications: VerificationResult[] = [];

    for (let i = 0; i < plan.tasks.length; i++) {
      if (checkTimeout()) {
        await failRun(run, "Execution timeout exceeded");
        return { status: "failed", error: "Execution timeout exceeded", runId, objectiveId };
      }

      const task = plan.tasks[i];
      const taskId = taskIds[i];

      // Update objective's current task
      await db
        .update(objectives)
        .set({ currentTaskId: taskId, updatedAt: new Date() })
        .where(eq(objectives.id, objectiveId));

      await updateTask(taskId, { state: "executing" });
      await recordStep(runId, "action", {
        name: task.tool,
        input: task.input,
        output: { status: `Task ${i + 1}/${plan.tasks.length}: ${task.description}` },
      });

      /* ── EXECUTE ─────────────────────────────────────────── */
      let result = await executeTool(task.tool, task.input, {
        db,
        workspaceRoot: ensureWorkspace(),
        runId,
        objectiveId,
        taskId,
      });

      /* ── OBSERVE ─────────────────────────────────────────── */
      await logTransition(runId, "executing", "observing", `Task ${i + 1} executed`);
      await recordStep(runId, "observation", {
        name: task.tool,
        output: {
          ok: result.ok,
          output: cap(result.output, 6000),
          data: result.data ?? null,
        },
      });
      lastOutput = result.output;
      await updateTask(taskId, { actionResult: { ok: result.ok, output: cap(result.output, 2000) } });

      /* ── FAILURE RECOVERY ────────────────────────────────── */
      if (!result.ok) {
        let retryCount = 0;
        let recovered = false;

        while (retryCount < maxRetries) {
          if (checkTimeout()) {
            await failRun(run, "Execution timeout exceeded during recovery");
            return { status: "failed", error: "Execution timeout exceeded", runId, objectiveId };
          }

          /* ── DIAGNOSE ─────────────────────────────────────── */
          await logTransition(runId, "observing", "diagnosing", `Task ${i + 1} failed (attempt ${retryCount + 1})`);

          const transcript = await buildTranscript(runId);
          let diagnosis: DiagnosisResult;
          try {
            diagnosis = await diagnoseFailure(
              {
                objective,
                taskDescription: task.description,
                tool: task.tool,
                input: task.input,
                error: result.output,
                transcript,
              },
              opts.provider,
            );
          } catch (err) {
            const msg = `Diagnosis failed: ${err instanceof Error ? err.message : String(err)}`;
            await recordStep(runId, "error", { name: "diagnosis", output: { message: msg } });
            await failRun(run, msg);
            return { status: "failed", error: msg, runId, objectiveId };
          }

          await recordStep(runId, "diagnose", {
            output: {
              diagnosis: cap(diagnosis.diagnosis, 2000),
              recoverable: diagnosis.recoverable,
            },
          });
          await updateTask(taskId, { errorInfo: { diagnosis: diagnosis.diagnosis, recoverable: diagnosis.recoverable } });

          if (!diagnosis.recoverable) {
            await updateTask(taskId, { state: "failed", error: diagnosis.diagnosis });
            await logTransition(runId, "diagnosing", "failed", "Recovery not possible");
            await failRun(run, `Task ${i + 1} ("${task.description}") failed and recovery is not possible: ${diagnosis.diagnosis}`);
            return { status: "failed", error: diagnosis.diagnosis, runId, objectiveId };
          }

          /* ── REPAIR ───────────────────────────────────────── */
          await logTransition(runId, "diagnosing", "repairing", "Generating repair action");

          let repair: RepairAction | null;
          try {
            repair = await generateRepair(
              {
                objective,
                taskDescription: task.description,
                tool: task.tool,
                input: task.input,
                diagnosis: diagnosis.diagnosis,
                error: result.output,
              },
              opts.provider,
            );
          } catch (err) {
            const msg = `Repair generation failed: ${err instanceof Error ? err.message : String(err)}`;
            await recordStep(runId, "error", { name: "repair", output: { message: msg } });
            await failRun(run, msg);
            return { status: "failed", error: msg, runId, objectiveId };
          }

          if (!repair) {
            await updateTask(taskId, { state: "failed", error: "Repair model returned no action" });
            await failRun(run, `Task ${i + 1}: repair model could not generate a repair action`);
            return { status: "failed", error: "No repair action generated", runId, objectiveId };
          }

          await recordStep(runId, "repair", {
            name: repair.tool,
            input: repair.input,
            output: { status: "Applying repair" },
          });

          // Execute the repair
          const repairResult = await executeTool(repair.tool, repair.input, {
            db,
            workspaceRoot: ensureWorkspace(),
            runId,
            objectiveId,
            taskId,
          });
          await recordStep(runId, "observation", {
            name: "repair",
            output: {
              ok: repairResult.ok,
              output: cap(repairResult.output, 4000),
            },
          });

          /* ── RETRY ─────────────────────────────────────────── */
          await logTransition(runId, "repairing", "retrying", `Retrying task ${i + 1} (attempt ${retryCount + 1})`);
          retryCount++;
          await updateTask(taskId, { retryCount });

          result = await executeTool(task.tool, task.input, {
            db,
            workspaceRoot: ensureWorkspace(),
            runId,
            objectiveId,
            taskId,
          });

          // Transition to observing after retry execution
          await logTransition(runId, "retrying", "observing", `Retry ${retryCount} executed, observing result`);

          await recordStep(runId, "observation", {
            name: task.tool,
            output: {
              ok: result.ok,
              output: cap(result.output, 6000),
              retry: retryCount,
            },
          });
          lastOutput = result.output;

          if (result.ok) {
            recovered = true;
            await recordStep(runId, "note", {
              output: { status: `Task ${i + 1} recovered after ${retryCount} retry(s)` },
            });
            break;
          }
        }

        if (!recovered) {
          await updateTask(taskId, {
            state: "escalated",
            error: `Failed after ${maxRetries} retries`,
          });
          await logTransition(runId, "retrying", "escalated", `Max retries (${maxRetries}) exhausted`);
          await escalateRun(run, `Task ${i + 1} ("${task.description}") failed after ${maxRetries} retries. Last error: ${cap(result.output, 500)}`);
          return { status: "escalated", error: `Max retries exhausted for task ${i + 1}`, runId, objectiveId };
        }
      }

      /* ── VERIFY ───────────────────────────────────────────── */
      await logTransition(runId, "observing", "verifying", `Verifying task ${i + 1}`);

      let verification: VerificationResult;
      try {
        verification = await verifyTask(task.verify, lastOutput);
      } catch (err) {
        verification = {
          passed: false,
          detail: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      await recordStep(runId, "verify", {
        name: task.tool,
        output: {
          passed: verification.passed,
          detail: cap(verification.detail, 2000),
          criteria: task.verify,
        },
      });

      taskVerifications.push(verification);

      if (!verification.passed) {
        await updateTask(taskId, {
          state: "failed",
          verificationStatus: "failed",
          verificationDetail: verification,
          error: verification.detail,
        });
        await logTransition(runId, "verifying", "failed", `Task ${i + 1} verification failed`);
        await failRun(run, `Task ${i + 1} ("${task.description}") verification failed: ${verification.detail}`);
        return { status: "failed", error: verification.detail, runId, objectiveId };
      }

      // Task passed verification
      await updateTask(taskId, {
        state: "completed",
        verificationStatus: "passed",
        verificationDetail: verification,
        result: `Verified: ${verification.detail}`,
      });
      await recordStep(runId, "note", {
        output: { status: `Task ${i + 1} completed and verified: ${verification.detail}` },
      });
    }

    /* ── OVERALL VERIFICATION ─────────────────────────────────── */
    await logTransition(runId, "executing", "verifying", "All tasks complete, verifying objective");

    const overallVerification = await verifyObjective(taskVerifications);
    await recordStep(runId, "verify", {
      output: {
        passed: overallVerification.passed,
        detail: overallVerification.detail,
        overall: true,
      },
    });

    // Update objective with verification result
    await db
      .update(objectives)
      .set({ verificationResult: overallVerification, updatedAt: new Date() })
      .where(eq(objectives.id, objectiveId));

    if (!overallVerification.passed) {
      await logTransition(runId, "verifying", "failed", "Overall verification failed");
      await failRun(run, `Objective verification failed: ${overallVerification.detail}`);
      return { status: "failed", error: overallVerification.detail, runId, objectiveId };
    }

    /* ── COMPLETE ────────────────────────────────────────────── */
    await logTransition(runId, "verifying", "completed", "Objective verified and complete");

    const finalResult = `Objective completed. All ${plan.tasks.length} task(s) executed and verified.\n${taskVerifications.map((v, i) => `  Task ${i + 1}: ${v.detail}`).join("\n")}`;
    await completeRun(run, objective, finalResult);

    return { status: "completed", result: finalResult, runId, objectiveId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordStep(runId, "error", { name: "core", output: { message: msg } });
    await failRun(run, `Agent core error: ${msg}`);
    return { status: "failed", error: msg, runId, objectiveId };
  }
}
