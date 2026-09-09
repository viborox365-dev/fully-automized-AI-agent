import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { eq, ilike, and } from "drizzle-orm";
import { db, pool } from "@/db";
import { memories, messages, objectives, runs, steps, tasks } from "@/db/schema";
import { advanceRun, createObjective } from "@/agent/engine";
import {
  canTransition,
  isTerminalState,
  STATE_TRANSITIONS,
  AgentStates,
  type AgentState,
} from "@/agent/states";
import {
  detectInfiniteLoop,
  detectRepeatedFailures,
  isWithinTaskDepth,
  isWithinTaskCount,
  checkSafeguards,
  SAFEGUARD_LIMITS,
} from "@/agent/safeguards";
import { workspaceRoot } from "@/agent/workspace";
import type {
  ChatMessage,
  GenerateResult,
  ModelProvider,
  ProviderStatus,
} from "@/agent/model/types";
import type { Step } from "@/db/schema";

/**
 * Kaira Agent Kernel — Automated Tests
 *
 * Covers:
 *   1. State machine: valid/invalid transitions, terminal states
 *   2. Safeguards: infinite loop, repeated failures, task depth/count
 *   3. End-to-end happy path: understand → plan → execute → observe → verify → complete
 *   4. Retry: tool fails, agent retries, succeeds
 *   5. Escalation: repeated failures exhaust retry budget
 *   6. Safeguard trigger: infinite loop detected
 *   7. No chain-of-thought: step outputs never contain "thought"
 */

const TOKEN = `kernel-test-${Date.now().toString(36)}`;
let failures = 0;
let tests = 0;

function check(label: string, cond: boolean, detail = "") {
  tests++;
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  SCRIPTED MODEL PROVIDERS                                             */
/* ────────────────────────────────────────────────────── */

function makeStep(
  kind: Step["kind"],
  name: string | null,
  input: unknown,
  output: unknown,
): Step {
  return {
    id: "fake",
    runId: "fake",
    seq: 0,
    kind,
    name,
    input: input as Step["input"],
    output: output as Step["output"],
    latencyMs: null,
    createdAt: new Date(),
  };
}

class HappyPathProvider implements ModelProvider {
  readonly id = "happy-path-fixture";
  readonly label = "Happy path fixture";
  private calls = 0;

  async status(): Promise<ProviderStatus> {
    return { ok: true, detail: "fixture", models: ["test-0"] };
  }

  async generate(messages: ChatMessage[]): Promise<GenerateResult> {
    this.calls++;
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";
    let content: string;

    if (system.includes("UNDERSTANDING phase")) {
      content = `This objective requires creating a file in the workspace and verifying its contents by reading it back. I'll use fs_write to create the file and fs_read to verify it.`;
    } else if (system.includes("verification critic")) {
      content = JSON.stringify({
        complete: true,
        reason: "The transcript shows the file was written and read back with the expected content.",
      });
    } else if (user.includes("Write a concrete, numbered execution plan")) {
      content = [
        `1. Write a marker file to kernel-test/hello.txt with fs_write.`,
        "2. Read it back with fs_read to verify its contents.",
        "3. Report completion with the verified evidence.",
      ].join("\n");
    } else {
      const envelopes = [
        {
          thought: "Step 1: create the marker file.",
          action: {
            tool: "fs_write",
            input: { path: "kernel-test/hello.txt", content: `Kernel test\nmarker: ${TOKEN}\n` },
          },
        },
        {
          thought: "Step 2: read the file back to verify.",
          action: {
            tool: "fs_read",
            input: { path: "kernel-test/hello.txt" },
          },
        },
        {
          thought: "All steps verified. Reporting completion.",
          final: `Verified: created kernel-test/hello.txt and read it back successfully (marker ${TOKEN} confirmed). Objective complete.`,
        },
      ];
      const next = envelopes[this.calls - 3];
      if (!next) throw new Error(`HappyPath exhausted at call ${this.calls}`);
      content = JSON.stringify(next);
    }
    await new Promise((r) => setTimeout(r, 5));
    return {
      content,
      model: "test-0",
      tokensIn: Math.ceil(user.length / 4),
      tokensOut: Math.ceil(content.length / 4),
      latencyMs: 5,
    };
  }
}

class RetryProvider implements ModelProvider {
  readonly id = "retry-fixture";
  readonly label = "Retry fixture";
  private calls = 0;

  async status(): Promise<ProviderStatus> {
    return { ok: true, detail: "fixture", models: ["test-0"] };
  }

  async generate(messages: ChatMessage[]): Promise<GenerateResult> {
    this.calls++;
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";
    let content: string;

    if (system.includes("UNDERSTANDING phase")) {
      content = `I need to create a file in the workspace. The first attempt may fail if the path is invalid, so I'll adjust and retry.`;
    } else if (system.includes("verification critic")) {
      content = JSON.stringify({
        complete: true,
        reason: "The file was successfully written and read back after a retry.",
      });
    } else if (user.includes("Write a concrete, numbered execution plan")) {
      content = [
        "1. Write a marker file to kernel-test/hello.txt with fs_write.",
        "2. Read it back with fs_read to verify.",
        "3. Report completion.",
      ].join("\n");
    } else {
      const envelopes = [
        {
          thought: "Step 1: try to write the file (this path will fail).",
          action: {
            tool: "fs_write",
            input: { path: "../../../etc/invalid", content: "test" },
          },
        },
        {
          thought: "The path was invalid. Retry with a valid workspace path.",
          action: {
            tool: "fs_write",
            input: { path: "kernel-test/hello.txt", content: `Kernel retry test\nmarker: ${TOKEN}\n` },
          },
        },
        {
          thought: "Step 2: read the file back to verify.",
          action: {
            tool: "fs_read",
            input: { path: "kernel-test/hello.txt" },
          },
        },
        {
          thought: "All verified. Reporting completion.",
          final: `Verified: after a retry, created kernel-test/hello.txt and read it back (marker ${TOKEN} confirmed). Objective complete.`,
        },
      ];
      const next = envelopes[this.calls - 3];
      if (!next) throw new Error(`RetryProvider exhausted at call ${this.calls}`);
      content = JSON.stringify(next);
    }
    await new Promise((r) => setTimeout(r, 5));
    return {
      content,
      model: "test-0",
      tokensIn: Math.ceil(user.length / 4),
      tokensOut: Math.ceil(content.length / 4),
      latencyMs: 5,
    };
  }
}

class EscalationProvider implements ModelProvider {
  readonly id = "escalation-fixture";
  readonly label = "Escalation fixture";
  private calls = 0;

  async status(): Promise<ProviderStatus> {
    return { ok: true, detail: "fixture", models: ["test-0"] };
  }

  async generate(messages: ChatMessage[]): Promise<GenerateResult> {
    this.calls++;
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";
    let content: string;

    if (system.includes("UNDERSTANDING phase")) {
      content = `I need to write a file, but I'll keep trying invalid paths that escape the workspace.`;
    } else if (user.includes("Write a concrete, numbered execution plan")) {
      content = "1. Write a file with fs_write.\n2. Report completion.";
    } else {
      const invalidPaths = ["../../../etc/invalid1", "../../../etc/invalid2", "../../../etc/invalid3"];
      const idx = this.calls - 3;
      if (idx >= invalidPaths.length) throw new Error(`EscalationProvider exhausted at call ${this.calls}`);
      content = JSON.stringify({
        thought: `Attempt ${idx + 1}: try writing to a path.`,
        action: {
          tool: "fs_write",
          input: { path: invalidPaths[idx], content: "test" },
        },
      });
    }
    await new Promise((r) => setTimeout(r, 5));
    return {
      content,
      model: "test-0",
      tokensIn: Math.ceil(user.length / 4),
      tokensOut: Math.ceil(content.length / 4),
      latencyMs: 5,
    };
  }
}

class InfiniteLoopProvider implements ModelProvider {
  readonly id = "loop-fixture";
  readonly label = "Infinite loop fixture";
  private calls = 0;

  async status(): Promise<ProviderStatus> {
    return { ok: true, detail: "fixture", models: ["test-0"] };
  }

  async generate(messages: ChatMessage[]): Promise<GenerateResult> {
    this.calls++;
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";
    let content: string;

    if (system.includes("UNDERSTANDING phase")) {
      content = `I need to list files in the workspace repeatedly.`;
    } else if (user.includes("Write a concrete, numbered execution plan")) {
      content = "1. List files in the workspace with fs_list.\n2. Report completion.";
    } else {
      // Always return the same action — triggers infinite loop safeguard
      content = JSON.stringify({
        thought: "Listing files.",
        action: { tool: "fs_list", input: { path: "." } },
      });
    }
    await new Promise((r) => setTimeout(r, 5));
    return {
      content,
      model: "test-0",
      tokensIn: Math.ceil(user.length / 4),
      tokensOut: Math.ceil(content.length / 4),
      latencyMs: 5,
    };
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  CLEANUP HELPER                                                       */
/* ────────────────────────────────────────────────────── */

async function cleanupObjective(objectiveId: string) {
  await db.delete(tasks).where(eq(tasks.objectiveId, objectiveId));
  await db.delete(messages).where(eq(messages.objectiveId, objectiveId));
  await db.delete(memories).where(ilike(memories.content, `%${TOKEN}%`));
  // steps and runs cascade from objectives
  await db.delete(objectives).where(eq(objectives.id, objectiveId));
}

/* ────────────────────────────────────────────────────────────────────── */
/*  TEST SUITES                                                          */
/* ────────────────────────────────────────────────────── */

async function testStateMachine() {
  console.log("\n1. State machine");
  const valid: Array<[AgentState, AgentState]> = [
    ["idle", "planning"],
    ["planning", "executing"],
    ["executing", "observing"],
    ["observing", "executing"],
    ["observing", "retrying"],
    ["retrying", "executing"],
    ["retrying", "escalated"],
    ["executing", "verifying"],
    ["verifying", "completed"],
    ["verifying", "executing"],
  ];
  for (const [from, to] of valid) {
    check(`transition ${from}→${to}`, canTransition(from, to));
  }

  const invalid: Array<[AgentState, AgentState]> = [
    ["idle", "executing"],
    ["completed", "executing"],
    ["failed", "planning"],
    ["escalated", "executing"],
    ["idle", "completed"],
  ];
  for (const [from, to] of invalid) {
    check(`reject ${from}→${to}`, !canTransition(from, to));
  }

  for (const s of ["completed", "failed", "escalated"] as AgentState[]) {
    check(`terminal: ${s}`, isTerminalState(s));
    check(`no transitions from ${s}`, STATE_TRANSITIONS[s].length === 0);
  }
  for (const s of ["idle", "planning", "executing"] as AgentState[]) {
    check(`non-terminal: ${s}`, !isTerminalState(s));
  }
  check("all 10 states defined", AgentStates.length === 10);
}

async function testSafeguards() {
  console.log("\n2. Safeguards");

  // Infinite loop: 3 identical actions
  const loopSteps: Step[] = [
    makeStep("action", "fs_list", { path: "." }, { status: "Executing fs_list" }),
    makeStep("observation", "fs_list", null, { ok: true, output: "files" }),
    makeStep("action", "fs_list", { path: "." }, { status: "Executing fs_list" }),
    makeStep("observation", "fs_list", null, { ok: true, output: "files" }),
    makeStep("action", "fs_list", { path: "." }, { status: "Executing fs_list" }),
  ];
  check("detect infinite loop (3 identical)", detectInfiniteLoop(loopSteps));

  // No infinite loop: different actions
  const variedSteps: Step[] = [
    makeStep("action", "fs_write", { path: "a.txt" }, {}),
    makeStep("action", "fs_read", { path: "a.txt" }, {}),
    makeStep("action", "fs_list", { path: "." }, {}),
  ];
  check("no false positive (varied actions)", !detectInfiniteLoop(variedSteps));

  // Only 2 identical — not enough
  const twoIdentical: Step[] = [
    makeStep("action", "fs_list", { path: "." }, {}),
    makeStep("action", "fs_list", { path: "." }, {}),
  ];
  check("no false positive (only 2 identical)", !detectInfiniteLoop(twoIdentical));

  // Repeated identical failures
  const failSteps: Step[] = [
    makeStep("observation", "fs_write", null, { ok: false, output: "Path escapes workspace: ../../../etc/a" }),
    makeStep("observation", "fs_write", null, { ok: false, output: "Path escapes workspace: ../../../etc/a" }),
    makeStep("observation", "fs_write", null, { ok: false, output: "Path escapes workspace: ../../../etc/a" }),
  ];
  check("detect repeated identical failures", detectRepeatedFailures(failSteps));

  // Different failures — not repeated identical
  const diffFailSteps: Step[] = [
    makeStep("observation", "fs_write", null, { ok: false, output: "Error A" }),
    makeStep("observation", "fs_write", null, { ok: false, output: "Error B" }),
    makeStep("observation", "fs_write", null, { ok: false, output: "Error C" }),
  ];
  check("no false positive (different failures)", !detectRepeatedFailures(diffFailSteps));

  // checkSafeguards escalation decision
  const loopResult = checkSafeguards(loopSteps);
  check("infinite loop → fail (not escalate)", loopResult.triggered && !loopResult.escalate);

  const repeatResult = checkSafeguards(failSteps);
  check("repeated failures → escalate", repeatResult.triggered && repeatResult.escalate);

  const okResult = checkSafeguards([]);
  check("no issues → OK", !okResult.triggered);

  // Task depth/count
  check("task depth 3 within limit", isWithinTaskDepth(3));
  check("task depth 4 exceeds limit", !isWithinTaskDepth(4));
  check("task count 12 within limit", isWithinTaskCount(12));
  check("task count 13 exceeds limit", !isWithinTaskCount(13));
}

async function testHappyPath() {
  console.log("\n3. End-to-end happy path (understand → plan → execute → verify → complete)");
  const { objective, run } = await createObjective({
    title: `KERNEL TEST happy path ${TOKEN}`,
    description: "Create a file and verify it.",
    autoDispatch: true,
    maxSteps: 12,
  });
  check("objective + run created", Boolean(objective.id && run?.id));

  const provider = new HappyPathProvider();
  const result = await advanceRun(run!.id, "kernel-test", {
    ticks: 10,
    provider,
    model: "test-0",
  });
  check("advanceRun ok", result.ok, result.error);
  check("run completed", result.run.status === "completed", result.run.status);
  check("agent state = completed", result.run.agentState === "completed", result.run.agentState);

  const stepRows = await db.select().from(steps).where(eq(steps.runId, run!.id)).orderBy(steps.seq);
  const kinds = stepRows.map((s) => s.kind);
  check("has understand step", kinds.includes("understand"), kinds.join(","));
  check("has plan step", kinds.includes("plan"));
  check("has action steps", kinds.filter((k) => k === "action").length >= 2);
  check("has observation steps", kinds.filter((k) => k === "observation").length >= 2);
  check("has final step", kinds.includes("final"));
  check("has critic step", kinds.includes("critic"));

  // No chain-of-thought exposed
  const hasThought = stepRows.some(
    (s) => s.output && typeof s.output === "object" && "thought" in (s.output as object),
  );
  check("no 'thought' in step outputs", !hasThought);

  // Tasks created and completed
  const taskRows = await db.select().from(tasks).where(eq(tasks.objectiveId, objective.id));
  check("tasks created from plan", taskRows.length >= 2, `count=${taskRows.length}`);
  check("all tasks completed", taskRows.every((t) => t.state === "completed"));

  // Objective completed
  const [objRow] = await db.select().from(objectives).where(eq(objectives.id, objective.id));
  check("objective status = completed", objRow.status === "completed");

  await cleanupObjective(objective.id);
  fs.rmSync(path.join(workspaceRoot(), "kernel-test"), { recursive: true, force: true });
}

async function testRetry() {
  console.log("\n4. Retry handling (fail → retry → succeed → complete)");
  const { objective, run } = await createObjective({
    title: `KERNEL TEST retry ${TOKEN}`,
    description: "Write a file, fail first, then succeed.",
    autoDispatch: true,
    maxSteps: 12,
  });

  const provider = new RetryProvider();
  const result = await advanceRun(run!.id, "kernel-test", {
    ticks: 10,
    provider,
    model: "test-0",
  });
  check("advanceRun ok", result.ok, result.error);
  check("run completed after retry", result.run.status === "completed", result.run.status);

  const stepRows = await db.select().from(steps).where(eq(steps.runId, run!.id)).orderBy(steps.seq);
  const kinds = stepRows.map((s) => s.kind);
  check("has retry step", kinds.includes("retry"), kinds.join(","));

  // Verify the first action failed and second succeeded
  const obsSteps = stepRows.filter((s) => s.kind === "observation");
  check("first observation failed", (obsSteps[0]?.output as { ok?: boolean })?.ok === false);
  check("second observation succeeded", (obsSteps[1]?.output as { ok?: boolean })?.ok === true);

  // Retry count should be reset to 0 after success
  check("retryCount reset to 0", result.run.retryCount === 0, `retryCount=${result.run.retryCount}`);

  await cleanupObjective(objective.id);
  fs.rmSync(path.join(workspaceRoot(), "kernel-test"), { recursive: true, force: true });
}

async function testEscalation() {
  console.log("\n5. Escalation (repeated failures exhaust retry budget)");
  const { objective, run } = await createObjective({
    title: `KERNEL TEST escalation ${TOKEN}`,
    description: "Keep failing until escalation.",
    autoDispatch: true,
    maxSteps: 12,
  });

  const provider = new EscalationProvider();
  const result = await advanceRun(run!.id, "kernel-test", {
    ticks: 10,
    provider,
    model: "test-0",
  });
  check("run escalated", result.run.status === "escalated", result.run.status);
  check("agent state = escalated", result.run.agentState === "escalated", result.run.agentState);

  const stepRows = await db.select().from(steps).where(eq(steps.runId, run!.id)).orderBy(steps.seq);
  const retrySteps = stepRows.filter((s) => s.kind === "retry");
  check("has retry steps", retrySteps.length >= 2, `count=${retrySteps.length}`);

  const [objRow] = await db.select().from(objectives).where(eq(objectives.id, objective.id));
  check("objective status = escalated", objRow.status === "escalated", objRow.status);

  // Tasks should be escalated
  const taskRows = await db.select().from(tasks).where(eq(tasks.objectiveId, objective.id));
  check("tasks escalated", taskRows.every((t) => t.state === "escalated"), taskRows.map((t) => t.state).join(","));

  await cleanupObjective(objective.id);
}

async function testInfiniteLoopSafeguard() {
  console.log("\n6. Safeguard: infinite loop detection");
  const { objective, run } = await createObjective({
    title: `KERNEL TEST loop ${TOKEN}`,
    description: "Repeat the same action until safeguard triggers.",
    autoDispatch: true,
    maxSteps: 12,
  });

  const provider = new InfiniteLoopProvider();
  const result = await advanceRun(run!.id, "kernel-test", {
    ticks: 10,
    provider,
    model: "test-0",
  });
  check("run failed (safeguard)", result.run.status === "failed", result.run.status);
  check("error mentions infinite loop", (result.run.error ?? "").includes("Infinite loop"), result.run.error ?? "");

  const stepRows = await db.select().from(steps).where(eq(steps.runId, run!.id)).orderBy(steps.seq);
  const actionSteps = stepRows.filter((s) => s.kind === "action");
  check("3 identical actions recorded", actionSteps.length >= 3, `count=${actionSteps.length}`);

  await cleanupObjective(objective.id);
}

/* ────────────────────────────────────────────────────────────────────── */
/*  MAIN                                                                 */
/* ────────────────────────────────────────────────────── */

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  KAIRA AGENT KERNEL — Automated Tests                     ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  await testStateMachine();
  await testSafeguards();
  await testHappyPath();
  await testRetry();
  await testEscalation();
  await testInfiniteLoopSafeguard();

  console.log(
    failures === 0
      ? `\nRESULT: PASS — ${tests} checks passed. Agent kernel is working.\n`
      : `\nRESULT: FAIL — ${failures} of ${tests} checks failed.\n`,
  );
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nTEST CRASHED:", err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
