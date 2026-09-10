import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { eq, ilike } from "drizzle-orm";
import { db, pool } from "@/db";
import { memories, messages, objectives, runs, steps, tasks } from "@/db/schema";
import { createObjective } from "@/agent/engine";
import { runAgentCore } from "@/agent/core";
import { parseStructuredPlan, type StructuredPlan } from "@/agent/planner";
import { verifyTask } from "@/agent/verifier";
import { parseDiagnosisResponse, parseRepairResponse } from "@/agent/recovery";
import {
  canTransition,
  isTerminalState,
  AgentStates,
  type AgentState,
} from "@/agent/states";
import { workspaceRoot } from "@/agent/workspace";
import type {
  ChatMessage,
  GenerateResult,
  ModelProvider,
  ProviderStatus,
} from "@/agent/model/types";

/**
 * Kaira Agent Core — Phase 2 Tests
 *
 * Test 1: End-to-end happy path
 *   Objective: Create calculator_test.py, execute it, verify output is 12.
 *   Flow: PLAN → EXECUTE → OBSERVE → VERIFY → COMPLETE
 *
 * Test 2: Failure recovery
 *   Objective: Same, but the generated code has a bug.
 *   Flow: PLAN → EXECUTE → OBSERVE → DIAGNOSE → REPAIR → RETRY → VERIFY → COMPLETE
 *
 * Unit tests: state machine, planner parsing, verifier, recovery parsing.
 */

const TOKEN = `phase2-${Date.now().toString(36)}`;
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

/** Provider for the happy path test — produces a correct plan. */
class HappyPathProvider implements ModelProvider {
  readonly id = "happy-path";
  readonly label = "Happy path fixture";
  private calls = 0;

  async status(): Promise<ProviderStatus> {
    return { ok: true, detail: "fixture", models: ["test-0"] };
  }

  async generate(chat: ChatMessage[]): Promise<GenerateResult> {
    this.calls++;
    const system = chat[0]?.content ?? "";
    let content: string;

    if (system.includes("PLANNING phase")) {
      content = JSON.stringify({
        understanding: "I need to create a Python file that adds 5 and 7, execute it, and verify the output is 12.",
        tasks: [
          {
            description: "Create calculator_test.py with a program that adds 5 and 7 and prints the result",
            tool: "fs_write",
            input: { path: "calculator_test.py", content: "print(5 + 7)\n" },
            depends_on: [],
            verify: { type: "file_exists", path: "calculator_test.py" },
          },
          {
            description: "Execute calculator_test.py and verify the output is 12",
            tool: "shell_exec",
            input: { command: "python3 calculator_test.py" },
            depends_on: [0],
            verify: { type: "output_contains", expected: "12" },
          },
        ],
      });
    } else {
      throw new Error(`HappyPathProvider: unexpected call ${this.calls} — system: ${system.slice(0, 100)}`);
    }

    await new Promise((r) => setTimeout(r, 5));
    return {
      content,
      model: "test-0",
      tokensIn: 100,
      tokensOut: 200,
      latencyMs: 5,
    };
  }
}

/** Provider for the failure recovery test — produces a buggy plan, then diagnoses and repairs. */
class RecoveryProvider implements ModelProvider {
  readonly id = "recovery";
  readonly label = "Recovery fixture";
  private calls = 0;

  async status(): Promise<ProviderStatus> {
    return { ok: true, detail: "fixture", models: ["test-0"] };
  }

  async generate(chat: ChatMessage[]): Promise<GenerateResult> {
    this.calls++;
    const system = chat[0]?.content ?? "";
    let content: string;

    if (system.includes("PLANNING phase")) {
      // Plan with a bug: "pront" instead of "print"
      content = JSON.stringify({
        understanding: "I need to create a Python file that adds 5 and 7, execute it, and verify the output is 12.",
        tasks: [
          {
            description: "Create calculator_test.py with a program that adds 5 and 7 and prints the result",
            tool: "fs_write",
            input: { path: "calculator_test.py", content: "pront(5 + 7)\n" },
            depends_on: [],
            verify: { type: "file_exists", path: "calculator_test.py" },
          },
          {
            description: "Execute calculator_test.py and verify the output is 12",
            tool: "shell_exec",
            input: { command: "python3 calculator_test.py" },
            depends_on: [0],
            verify: { type: "output_contains", expected: "12" },
          },
        ],
      });
    } else if (system.includes("DIAGNOSING phase")) {
      content = JSON.stringify({
        diagnosis: "The error is a NameError: 'pront' is not defined. This is a typo of the built-in 'print' function. The fix is to replace 'pront' with 'print' in the file.",
        recoverable: true,
      });
    } else if (system.includes("REPAIRING phase")) {
      content = JSON.stringify({
        tool: "fs_write",
        input: { path: "calculator_test.py", content: "print(5 + 7)\n" },
      });
    } else {
      throw new Error(`RecoveryProvider: unexpected call ${this.calls} — system: ${system.slice(0, 100)}`);
    }

    await new Promise((r) => setTimeout(r, 5));
    return {
      content,
      model: "test-0",
      tokensIn: 100,
      tokensOut: 200,
      latencyMs: 5,
    };
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  CLEANUP                                                              */
/* ────────────────────────────────────────────────────── */

async function cleanup(objectiveId: string) {
  await db.delete(tasks).where(eq(tasks.objectiveId, objectiveId));
  await db.delete(messages).where(eq(messages.objectiveId, objectiveId));
  await db.delete(memories).where(ilike(memories.content, `%${TOKEN}%`));
  await db.delete(objectives).where(eq(objectives.id, objectiveId));
}

function cleanupWorkspace() {
  const file = path.join(workspaceRoot(), "calculator_test.py");
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/* ────────────────────────────────────────────────────────────────────── */
/*  UNIT TESTS                                                           */
/* ────────────────────────────────────────────────────── */

async function testStateMachine() {
  console.log("\n1. State machine (Phase 2 states)");
  check("12 states defined", AgentStates.length === 12, `got ${AgentStates.length}`);

  const newStates: AgentState[] = ["diagnosing", "repairing"];
  for (const s of newStates) {
    check(`state ${s} exists`, AgentStates.includes(s));
    check(`${s} is non-terminal`, !isTerminalState(s));
  }

  // New transitions
  check("observing→diagnosing", canTransition("observing", "diagnosing"));
  check("diagnosing→repairing", canTransition("diagnosing", "repairing"));
  check("diagnosing→retrying", canTransition("diagnosing", "retrying"));
  check("diagnosing→failed", canTransition("diagnosing", "failed"));
  check("repairing→retrying", canTransition("repairing", "retrying"));
  check("repairing→executing", canTransition("repairing", "executing"));
  check("retrying→executing", canTransition("retrying", "executing"));
  check("verifying→diagnosing", canTransition("verifying", "diagnosing"));

  // Invalid transitions
  check("reject idle→diagnosing", !canTransition("idle", "diagnosing"));
  check("reject completed→repairing", !canTransition("completed", "repairing"));
}

async function testPlannerParsing() {
  console.log("\n2. Structured plan parsing");

  const validPlan = `{"understanding":"test","tasks":[{"description":"Write file","tool":"fs_write","input":{"path":"a.py","content":"print(1)"},"depends_on":[],"verify":{"type":"file_exists","path":"a.py"}}]}`;
  const plan = parseStructuredPlan(validPlan);
  check("parses valid plan", plan.tasks.length === 1);
  check("parses task description", plan.tasks[0].description === "Write file");
  check("parses tool name", plan.tasks[0].tool === "fs_write");
  check("parses verify type", plan.tasks[0].verify.type === "file_exists");

  const fencedPlan = '```json\n{"understanding":"test","tasks":[{"description":"t","tool":"shell_exec","input":{"command":"ls"},"depends_on":[],"verify":{"type":"exit_code_zero"}}]}\n```';
  const plan2 = parseStructuredPlan(fencedPlan);
  check("parses fenced JSON", plan2.tasks.length === 1);

  const prosePlan = 'Here is the plan:\n{"understanding":"test","tasks":[{"description":"t","tool":"fs_read","input":{"path":"a"},"depends_on":[],"verify":{"type":"file_exists","path":"a"}}]}\nDone.';
  const plan3 = parseStructuredPlan(prosePlan);
  check("parses prose-wrapped JSON", plan3.tasks.length === 1);

  let threw = false;
  try {
    parseStructuredPlan("no json here");
  } catch {
    threw = true;
  }
  check("rejects non-JSON", threw);
}

async function testVerifier() {
  console.log("\n3. Verification layer");

  // file_exists (positive)
  const testFile = path.join(workspaceRoot(), "verify_test.txt");
  fs.writeFileSync(testFile, "test content");
  const fileResult = await verifyTask({ type: "file_exists", path: "verify_test.txt" }, "");
  check("file_exists: pass for existing file", fileResult.passed);

  // file_exists (negative)
  const missingResult = await verifyTask({ type: "file_exists", path: "nonexistent.xyz" }, "");
  check("file_exists: fail for missing file", !missingResult.passed);

  // output_contains (positive)
  const containsResult = await verifyTask({ type: "output_contains", expected: "12" }, "The answer is 12\n");
  check("output_contains: pass when found", containsResult.passed);

  // output_contains (negative)
  const notContainsResult = await verifyTask({ type: "output_contains", expected: "42" }, "The answer is 12\n");
  check("output_contains: fail when not found", !notContainsResult.passed);

  // exit_code_zero (positive)
  const exitOkResult = await verifyTask({ type: "exit_code_zero" }, "$ echo hello\nexit=0 · 5ms\nhello");
  check("exit_code_zero: pass for exit=0", exitOkResult.passed);

  // exit_code_zero (negative)
  const exitFailResult = await verifyTask({ type: "exit_code_zero" }, "$ badcmd\nexit=1 · 5ms\nerror");
  check("exit_code_zero: fail for exit=1", !exitFailResult.passed);

  // command_succeeds
  const cmdResult = await verifyTask({ type: "command_succeeds", command: "echo verify" }, "");
  check("command_succeeds: pass for echo", cmdResult.passed);

  // Cleanup
  fs.unlinkSync(testFile);
}

async function testRecoveryParsing() {
  console.log("\n4. Recovery parsing");

  const diagnosis = parseDiagnosisResponse('{"diagnosis":"typo error","recoverable":true}');
  check("parses diagnosis", diagnosis.diagnosis === "typo error");
  check("parses recoverable=true", diagnosis.recoverable === true);

  const notRecoverable = parseDiagnosisResponse('{"diagnosis":"fatal","recoverable":false}');
  check("parses recoverable=false", !notRecoverable.recoverable);

  const repair = parseRepairResponse('{"tool":"fs_write","input":{"path":"a.py","content":"print(1)"}}');
  check("parses repair tool", repair?.tool === "fs_write");
  check("parses repair input", repair?.input.path === "a.py");

  const noRepair = parseRepairResponse("no json here");
  check("returns null for invalid repair", noRepair === null);
}

/* ────────────────────────────────────────────────────────────────────── */
/*  END-TO-END TEST 1: HAPPY PATH                                        */
/* ────────────────────────────────────────────────────── */

async function testHappyPath() {
  console.log("\n5. E2E: Calculator (happy path)");
  const objTitle = `PHASE2 TEST calculator ${TOKEN}`;

  const { objective } = await createObjective({
    title: objTitle,
    description: "Create a Python file called calculator_test.py containing a program that adds 5 and 7 and prints the result. Execute the program and verify that the output is 12.",
  });

  const provider = new HappyPathProvider();
  const result = await runAgentCore(objective.id, { provider, maxRetries: 3 });

  check("runAgentCore returns completed", result.status === "completed", result.error ?? result.status);
  check("no error", !result.error, result.error ?? "");

  // Check run state
  const [run] = await db.select().from(runs).where(eq(runs.objectiveId, objective.id));
  check("run status = completed", run?.status === "completed", run?.status);
  check("agentState = completed", run?.agentState === "completed", run?.agentState);

  // Check steps
  const stepRows = await db.select().from(steps).where(eq(steps.runId, result.runId)).orderBy(steps.seq);
  const kinds = stepRows.map((s) => s.kind);
  check("has plan step", kinds.includes("plan"));
  check("has action steps", kinds.filter((k) => k === "action").length >= 2);
  check("has observation steps", kinds.filter((k) => k === "observation").length >= 2);
  check("has verify steps", kinds.includes("verify"));
  check("has transition steps", kinds.filter((k) => k === "transition").length >= 5);

  // Check transition sequence
  const transitions = stepRows.filter((s) => s.kind === "transition");
  const transitionSequence = transitions.map((s) => {
    const out = s.output as { from: string; to: string };
    return `${out.from}→${out.to}`;
  });
  check("starts with idle→planning", transitionSequence[0] === "idle→planning", transitionSequence[0]);
  check("has planning→executing", transitionSequence.some((t) => t === "planning→executing"));
  check("has executing→observing", transitionSequence.some((t) => t === "executing→observing"));
  check("has observing→verifying", transitionSequence.some((t) => t === "observing→verifying"));
  check("ends with verifying→completed", transitionSequence[transitionSequence.length - 1] === "verifying→completed", transitionSequence[transitionSequence.length - 1]);

  // Check no diagnose/repair steps (happy path)
  check("no diagnose steps (happy path)", !kinds.includes("diagnose"));
  check("no repair steps (happy path)", !kinds.includes("repair"));

  // Check tasks
  const taskRows = await db.select().from(tasks).where(eq(tasks.objectiveId, objective.id)).orderBy(tasks.order);
  check("2 tasks created", taskRows.length === 2, `count=${taskRows.length}`);
  check("all tasks completed", taskRows.every((t) => t.state === "completed"), taskRows.map((t) => t.state).join(","));
  check("all tasks verified", taskRows.every((t) => t.verificationStatus === "passed"));
  check("task 1 has toolName", taskRows[0].toolName === "fs_write");
  check("task 2 has toolName", taskRows[1].toolName === "shell_exec");
  check("task 2 has dependencies", Array.isArray(taskRows[1].dependencies) && taskRows[1].dependencies.length === 1);

  // Check real file
  const filePath = path.join(workspaceRoot(), "calculator_test.py");
  check("calculator_test.py exists", fs.existsSync(filePath));
  const fileContent = fs.readFileSync(filePath, "utf8");
  check("file contains print(5 + 7)", fileContent.includes("print(5 + 7)"), fileContent);

  // Check objective
  const [objRow] = await db.select().from(objectives).where(eq(objectives.id, objective.id));
  check("objective status = completed", objRow.status === "completed", objRow.status);
  check("objective has verification result", objRow.verificationResult !== null);

  await cleanup(objective.id);
  cleanupWorkspace();
}

/* ────────────────────────────────────────────────────────────────────── */
/*  END-TO-END TEST 2: FAILURE RECOVERY                                  */
/* ────────────────────────────────────────────────────── */

async function testFailureRecovery() {
  console.log("\n6. E2E: Failure recovery (buggy calculator)");
  const objTitle = `PHASE2 TEST recovery ${TOKEN}`;

  const { objective } = await createObjective({
    title: objTitle,
    description: "Create a Python file called calculator_test.py containing a program that adds 5 and 7 and prints the result. Execute the program and verify that the output is 12.",
  });

  const provider = new RecoveryProvider();
  const result = await runAgentCore(objective.id, { provider, maxRetries: 3 });

  check("runAgentCore returns completed", result.status === "completed", result.error ?? result.status);

  // Check run state
  const [run] = await db.select().from(runs).where(eq(runs.objectiveId, objective.id));
  check("run status = completed", run?.status === "completed", run?.status);
  check("agentState = completed", run?.agentState === "completed", run?.agentState);

  // Check steps
  const stepRows = await db.select().from(steps).where(eq(steps.runId, result.runId)).orderBy(steps.seq);
  const kinds = stepRows.map((s) => s.kind);
  check("has plan step", kinds.includes("plan"));
  check("has diagnose step", kinds.includes("diagnose"), kinds.join(","));
  check("has repair step", kinds.includes("repair"), kinds.join(","));
  check("has verify steps", kinds.includes("verify"));

  // Check transition sequence includes recovery states
  const transitions = stepRows.filter((s) => s.kind === "transition");
  const transitionSequence = transitions.map((s) => {
    const out = s.output as { from: string; to: string };
    return `${out.from}→${out.to}`;
  });
  check("has observing→diagnosing", transitionSequence.some((t) => t === "observing→diagnosing"), transitionSequence.join(", "));
  check("has diagnosing→repairing", transitionSequence.some((t) => t === "diagnosing→repairing"), transitionSequence.join(", "));
  check("has repairing→retrying", transitionSequence.some((t) => t === "repairing→retrying"), transitionSequence.join(", "));
  check("has retrying→observing",
    transitionSequence.some((t) => t === "retrying→observing"),
    transitionSequence.join(", "));
  check("ends with verifying→completed", transitionSequence[transitionSequence.length - 1] === "verifying→completed");

  // Check diagnose step content
  const diagnoseStep = stepRows.find((s) => s.kind === "diagnose");
  check("diagnose step has recoverable=true",
    (diagnoseStep?.output as { recoverable?: boolean })?.recoverable === true);
  check("diagnose step has diagnosis text",
    Boolean((diagnoseStep?.output as { diagnosis?: string })?.diagnosis));

  // Check repair step content
  const repairStep = stepRows.find((s) => s.kind === "repair");
  check("repair step has tool", Boolean((repairStep?.output as { status?: string })?.status));
  check("repair step has input", Boolean(repairStep?.input));

  // Check tasks
  const taskRows = await db.select().from(tasks).where(eq(tasks.objectiveId, objective.id)).orderBy(tasks.order);
  check("all tasks completed after recovery", taskRows.every((t) => t.state === "completed"), taskRows.map((t) => t.state).join(","));
  check("task 2 has retryCount > 0", (taskRows[1]?.retryCount ?? 0) > 0, `retryCount=${taskRows[1]?.retryCount}`);

  // Check the file was repaired
  const filePath = path.join(workspaceRoot(), "calculator_test.py");
  check("calculator_test.py exists", fs.existsSync(filePath));
  const fileContent = fs.readFileSync(filePath, "utf8");
  check("file contains corrected print(5 + 7)", fileContent.includes("print(5 + 7)"), fileContent);
  check("file does NOT contain pront", !fileContent.includes("pront"), fileContent);

  // Check objective
  const [objRow] = await db.select().from(objectives).where(eq(objectives.id, objective.id));
  check("objective status = completed", objRow.status === "completed", objRow.status);

  await cleanup(objective.id);
  cleanupWorkspace();
}

/* ────────────────────────────────────────────────────────────────────── */
/*  MAIN                                                                 */
/* ────────────────────────────────────────────────────── */

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  KAIRA AGENT CORE — Phase 2 Tests                        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // Check Python3 availability
  console.log("\n0. Environment check");
  const { execSync } = await import("node:child_process");
  try {
    const pyVersion = execSync("python3 --version 2>&1", { encoding: "utf8" }).trim();
    check("python3 available", true, pyVersion);
    console.log(`  · ${pyVersion}`);
  } catch {
    check("python3 available", false, "python3 not found — tests will fail");
    console.log("  · python3 is not available in this container");
    console.log("  · Installing python3...");
    try {
      execSync("apt-get update -qq && apt-get install -y -qq python3 2>&1", { stdio: "pipe", timeout: 60000 });
      check("python3 installed", true);
    } catch {
      console.error("  · Failed to install python3");
    }
  }

  await testStateMachine();
  await testPlannerParsing();
  await testVerifier();
  await testRecoveryParsing();
  await testHappyPath();
  await testFailureRecovery();

  console.log(
    failures === 0
      ? `\nRESULT: PASS — ${tests} checks passed. Agent Core is working.\n`
      : `\nRESULT: FAIL — ${failures} of ${tests} checks failed.\n`,
  );
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nPHASE 2 TEST CRASHED:", err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
