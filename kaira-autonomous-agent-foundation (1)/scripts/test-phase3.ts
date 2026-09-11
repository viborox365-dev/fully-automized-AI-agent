import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { eq, ilike } from "drizzle-orm";
import { db, pool } from "@/db";
import { changes, memories, messages, objectives, runs, steps, tasks } from "@/db/schema";
import { createObjective } from "@/agent/engine";
import { runAgentCore } from "@/agent/core";
import { verifyTask } from "@/agent/verifier";
import { resolveInWorkspace, workspaceRoot, ensureWorkspace } from "@/agent/workspace";
import { executeTool } from "@/agent/tools";
import { getGitInfo, recordChange } from "@/agent/changeTracker";
import { ENGINEERING_LIMITS } from "@/agent/safeguards";
import type {
  ChatMessage,
  GenerateResult,
  ModelProvider,
  ProviderStatus,
} from "@/agent/model/types";

/**
 * Kaira Agent Core — Phase 3 Engineering Tests
 *
 * Tests A–F prove the engineering layer works against a real workspace
 * using scripted model providers (no Ollama required).
 *
 * Test A: Create and execute (happy path)
 * Test B: Inspect and modify
 * Test C: Real failure and repair
 * Test D: Test failure and repair
 * Test E: Workspace security
 * Test F: Command failure capture + recovery
 *
 * Plus unit tests for new tools, verification, change tracking, and safety.
 */

const TOKEN = `phase3-${Date.now().toString(36)}`;
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

/** Test A: Create and execute — happy path plan. */
class CreateExecuteProvider implements ModelProvider {
  readonly id = "create-exec";
  readonly label = "Create & execute fixture";

  async status(): Promise<ProviderStatus> {
    return { ok: true, detail: "fixture", models: ["test-0"] };
  }

  async generate(chat: ChatMessage[]): Promise<GenerateResult> {
    const system = chat[0]?.content ?? "";
    if (!system.includes("PLANNING phase")) {
      throw new Error(`CreateExecuteProvider: unexpected prompt — ${system.slice(0, 100)}`);
    }
    return {
      content: JSON.stringify({
        understanding: "Create a Python file that prints 12, execute it, verify output.",
        tasks: [
          {
            description: "Create print_12.py that prints 12",
            tool: "fs_write",
            input: { path: "print_12.py", content: "print(12)\n" },
            depends_on: [],
            verify: { type: "file_exists", path: "print_12.py" },
          },
          {
            description: "Execute print_12.py and verify output contains 12",
            tool: "shell_exec",
            input: { command: "python3 print_12.py" },
            depends_on: [0],
            verify: { type: "output_contains", expected: "12" },
          },
        ],
      }),
      model: "test-0",
      tokensIn: 100,
      tokensOut: 200,
      latencyMs: 5,
    };
  }
}

/** Test B: Inspect and modify — read, modify, execute. */
class InspectModifyProvider implements ModelProvider {
  readonly id = "inspect-modify";
  readonly label = "Inspect & modify fixture";

  async status(): Promise<ProviderStatus> {
    return { ok: true, detail: "fixture", models: ["test-0"] };
  }

  async generate(chat: ChatMessage[]): Promise<GenerateResult> {
    const system = chat[0]?.content ?? "";
    if (!system.includes("PLANNING phase")) {
      throw new Error(`InspectModifyProvider: unexpected prompt — ${system.slice(0, 100)}`);
    }
    return {
      content: JSON.stringify({
        understanding: "Read the existing file, change value from 5 to 12, execute and verify.",
        tasks: [
          {
            description: "Read value_test.py to inspect current content",
            tool: "fs_read",
            input: { path: "value_test.py" },
            depends_on: [],
            verify: { type: "output_contains", expected: "value = 5" },
          },
          {
            description: "Modify value_test.py to change value to 12",
            tool: "fs_write",
            input: { path: "value_test.py", content: "value = 12\nprint(value)\n" },
            depends_on: [0],
            verify: { type: "file_contains", path: "value_test.py", expected: "value = 12" },
          },
          {
            description: "Execute value_test.py and verify output is 12",
            tool: "shell_exec",
            input: { command: "python3 value_test.py" },
            depends_on: [1],
            verify: { type: "output_contains", expected: "12" },
          },
        ],
      }),
      model: "test-0",
      tokensIn: 100,
      tokensOut: 200,
      latencyMs: 5,
    };
  }
}

/** Test C: Real failure and repair — broken Python file. */
class FailureRepairProvider implements ModelProvider {
  readonly id = "failure-repair";
  readonly label = "Failure & repair fixture";
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
        understanding: "Execute the broken Python file, diagnose the error, repair it, rerun, verify.",
        tasks: [
          {
            description: "Execute broken.py to observe the error",
            tool: "shell_exec",
            input: { command: "python3 broken.py" },
            depends_on: [],
            verify: { type: "output_contains", expected: "hello" },
          },
        ],
      });
    } else if (system.includes("DIAGNOSING phase")) {
      content = JSON.stringify({
        diagnosis: "NameError: 'pront' is not defined. The code uses 'pront' instead of 'print'. Replace 'pront' with 'print' to fix the error.",
        recoverable: true,
      });
    } else if (system.includes("REPAIRING phase")) {
      content = JSON.stringify({
        tool: "fs_write",
        input: { path: "broken.py", content: 'print("hello")\n' },
      });
    } else {
      throw new Error(`FailureRepairProvider: unexpected call ${this.calls} — ${system.slice(0, 100)}`);
    }

    return { content, model: "test-0", tokensIn: 100, tokensOut: 200, latencyMs: 5 };
  }
}

/** Test D: Test failure and repair — failing test. */
class TestFailureProvider implements ModelProvider {
  readonly id = "test-failure";
  readonly label = "Test failure fixture";
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
        understanding: "Run the failing test, diagnose the failure, fix the implementation, rerun, verify.",
        tasks: [
          {
            description: "Run test_add.py to observe the failure",
            tool: "shell_exec",
            input: { command: "python3 test_add.py" },
            depends_on: [],
            verify: { type: "output_contains", expected: "All tests passed" },
          },
        ],
      });
    } else if (system.includes("DIAGNOSING phase")) {
      content = JSON.stringify({
        diagnosis: "AssertionError: add(5, 7) returns -2 instead of 12. The function uses subtraction instead of addition. Fix: change 'return a - b' to 'return a + b'.",
        recoverable: true,
      });
    } else if (system.includes("REPAIRING phase")) {
      content = JSON.stringify({
        tool: "fs_write",
        input: {
          path: "test_add.py",
          content: 'def add(a, b):\n    return a + b\n\nassert add(5, 7) == 12, f"Expected 12, got {add(5, 7)}"\nprint("All tests passed")\n',
        },
      });
    } else {
      throw new Error(`TestFailureProvider: unexpected call ${this.calls} — ${system.slice(0, 100)}`);
    }

    return { content, model: "test-0", tokensIn: 100, tokensOut: 200, latencyMs: 5 };
  }
}

/** Test F: Command failure — diagnose and repair a failing command. */
class CommandFailureProvider implements ModelProvider {
  readonly id = "cmd-failure";
  readonly label = "Command failure fixture";
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
        understanding: "Run the failing script, diagnose the error, fix it, rerun, verify success.",
        tasks: [
          {
            description: "Run fail_script.py to observe the failure",
            tool: "shell_exec",
            input: { command: "python3 fail_script.py" },
            depends_on: [],
            verify: { type: "output_contains", expected: "success" },
          },
        ],
      });
    } else if (system.includes("DIAGNOSING phase")) {
      content = JSON.stringify({
        diagnosis: "The script exits with code 1 and prints 'fail'. The script needs to print 'success' and exit 0. Rewrite the script to print 'success'.",
        recoverable: true,
      });
    } else if (system.includes("REPAIRING phase")) {
      content = JSON.stringify({
        tool: "fs_write",
        input: { path: "fail_script.py", content: 'print("success")\n' },
      });
    } else {
      throw new Error(`CommandFailureProvider: unexpected call ${this.calls} — ${system.slice(0, 100)}`);
    }

    return { content, model: "test-0", tokensIn: 100, tokensOut: 200, latencyMs: 5 };
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  HELPERS                                                              */
/* ────────────────────────────────────────────────────── */

async function cleanupObjective(objectiveId: string) {
  await db.delete(tasks).where(eq(tasks.objectiveId, objectiveId));
  await db.delete(messages).where(eq(messages.objectiveId, objectiveId));
  await db.delete(changes).where(eq(changes.objectiveId, objectiveId));
  await db.delete(memories).where(ilike(memories.content, `%${TOKEN}%`));
  await db.delete(objectives).where(eq(objectives.id, objectiveId));
}

function cleanupFile(filename: string) {
  const file = path.join(workspaceRoot(), filename);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function cleanupDir(dirname: string) {
  const dir = path.join(workspaceRoot(), dirname);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

/* ────────────────────────────────────────────────────────────────────── */
/*  UNIT TESTS                                                           */
/* ────────────────────────────────────────────────────── */

async function testEngineeringTools() {
  console.log("\n1. Engineering tools (unit)");
  const ws = ensureWorkspace();

  // fs_exists
  const testFile = path.join(ws, "eng_test_exists.txt");
  fs.writeFileSync(testFile, "test");
  const existsResult = await executeTool("fs_exists", { path: "eng_test_exists.txt" }, { db, workspaceRoot: ws, runId: null });
  check("fs_exists: finds existing file", existsResult.ok && (existsResult.data as { exists: boolean }).exists);
  const missingResult = await executeTool("fs_exists", { path: "nonexistent.xyz" }, { db, workspaceRoot: ws, runId: null });
  check("fs_exists: reports missing file", missingResult.ok && !(missingResult.data as { exists: boolean }).exists);
  fs.unlinkSync(testFile);

  // fs_mkdir
  const mkdirResult = await executeTool("fs_mkdir", { path: "eng_test_dir" }, { db, workspaceRoot: ws, runId: null });
  check("fs_mkdir: creates directory", mkdirResult.ok);
  check("fs_mkdir: directory exists", fs.existsSync(path.join(ws, "eng_test_dir")));
  // Test nested
  const nestedResult = await executeTool("fs_mkdir", { path: "eng_test_dir/nested/deep" }, { db, workspaceRoot: ws, runId: null });
  check("fs_mkdir: creates nested directories", nestedResult.ok && fs.existsSync(path.join(ws, "eng_test_dir/nested/deep")));
  cleanupDir("eng_test_dir");

  // fs_tree
  fs.writeFileSync(path.join(ws, "tree_a.txt"), "a");
  fs.mkdirSync(path.join(ws, "tree_dir"));
  fs.writeFileSync(path.join(ws, "tree_dir/b.txt"), "b");
  const treeResult = await executeTool("fs_tree", { path: ".", maxDepth: 3 }, { db, workspaceRoot: ws, runId: null });
  check("fs_tree: returns tree", treeResult.ok);
  check("fs_tree: output includes tree_a.txt", treeResult.output.includes("tree_a.txt"));
  check("fs_tree: output includes tree_dir/", treeResult.output.includes("tree_dir"));
  cleanupFile("tree_a.txt");
  cleanupDir("tree_dir");

  // fs_delete
  fs.writeFileSync(path.join(ws, "delete_me.txt"), "delete me");
  const deleteResult = await executeTool("fs_delete", { path: "delete_me.txt" }, { db, workspaceRoot: ws, runId: null });
  check("fs_delete: deletes file", deleteResult.ok);
  check("fs_delete: file is gone", !fs.existsSync(path.join(ws, "delete_me.txt")));

  // fs_delete on directory should fail
  fs.mkdirSync(path.join(ws, "no_delete_dir"));
  const deleteDirResult = await executeTool("fs_delete", { path: "no_delete_dir" }, { db, workspaceRoot: ws, runId: null });
  check("fs_delete: rejects directory", !deleteDirResult.ok);
  cleanupDir("no_delete_dir");

  // detect_tooling
  fs.writeFileSync(path.join(ws, "requirements.txt"), "requests\n");
  const toolingResult = await executeTool("detect_tooling", {}, { db, workspaceRoot: ws, runId: null });
  check("detect_tooling: detects Python", toolingResult.ok && toolingResult.output.includes("Python"));
  check("detect_tooling: detects pytest", toolingResult.output.includes("pytest"));
  cleanupFile("requirements.txt");
}

async function testFileContainsVerification() {
  console.log("\n2. Verification: file_contains");
  const ws = ensureWorkspace();
  const testFile = path.join(ws, "contains_test.txt");
  fs.writeFileSync(testFile, "The answer is 42\n");

  const passResult = await verifyTask({ type: "file_contains", path: "contains_test.txt", expected: "42" }, "");
  check("file_contains: pass when found", passResult.passed);

  const failResult = await verifyTask({ type: "file_contains", path: "contains_test.txt", expected: "99" }, "");
  check("file_contains: fail when not found", !failResult.passed);

  const missingResult = await verifyTask({ type: "file_contains", path: "nonexistent.txt", expected: "x" }, "");
  check("file_contains: fail for missing file", !missingResult.passed);

  fs.unlinkSync(testFile);
}

async function testWorkspaceSecurity() {
  console.log("\n3. Workspace security");

  // Path traversal
  let threw = false;
  try { resolveInWorkspace("../escape.txt"); } catch { threw = true; }
  check("reject ../ path traversal", threw);

  threw = false;
  try { resolveInWorkspace("../../etc/passwd"); } catch { threw = true; }
  check("reject ../../ path traversal", threw);

  threw = false;
  try { resolveInWorkspace("/etc/passwd"); } catch { threw = true; }
  check("reject absolute path outside workspace", threw);

  // fs_write with escape path
  const ws = ensureWorkspace();
  const escapeResult = await executeTool("fs_write", { path: "../escape.txt", content: "escape" }, { db, workspaceRoot: ws, runId: null });
  check("fs_write rejects ../ path", !escapeResult.ok);
  check("escape file not created", !fs.existsSync(path.join(path.dirname(ws), "escape.txt")));

  // fs_delete with escape path
  const deleteEscapeResult = await executeTool("fs_delete", { path: "../escape.txt" }, { db, workspaceRoot: ws, runId: null });
  check("fs_delete rejects ../ path", !deleteEscapeResult.ok);
}

async function testShellExecution() {
  console.log("\n4. Shell execution: structured output");
  const ws = ensureWorkspace();

  // Successful command
  const successResult = await executeTool("shell_exec", { command: "python3 -c \"print('hello world')\"" }, { db, workspaceRoot: ws, runId: null });
  check("success: ok=true", successResult.ok);
  check("success: stdout captured", (successResult.data as { stdout: string }).stdout.includes("hello world"));
  check("success: exitCode=0", (successResult.data as { exitCode: number }).exitCode === 0);

  // Failing command
  const failResult = await executeTool("shell_exec", { command: "python3 -c \"import sys; print('out'); sys.stderr.write('err'); sys.exit(1)\"" }, { db, workspaceRoot: ws, runId: null });
  check("failure: ok=false", !failResult.ok);
  check("failure: stdout captured", (failResult.data as { stdout: string }).stdout.includes("out"));
  check("failure: stderr captured", (failResult.data as { stderr: string }).stderr.includes("err"));
  check("failure: exitCode=1", (failResult.data as { exitCode: number }).exitCode === 1);
}

async function testChangeTracking() {
  console.log("\n5. Change tracking");
  const ws = ensureWorkspace();
  const testFile = `change_test_${TOKEN}.py`;

  // Create a file and verify change is recorded
  const createResult = await executeTool("fs_write", {
    path: testFile,
    content: "print('original')\n",
  }, { db, workspaceRoot: ws, runId: null, objectiveId: null, taskId: null });
  check("create: fs_write succeeds", createResult.ok);

  // Check change record (query by path since runId is null)
  const createChanges = await db.select().from(changes).where(eq(changes.path, testFile));
  check("create: change recorded", createChanges.length >= 1);
  const createChange = createChanges.find((c) => c.operation === "create");
  check("create: operation=create", createChange?.operation === "create");
  check("create: beforeContent=null", createChange?.beforeContent === null);
  check("create: afterContent captured", createChange?.afterContent?.includes("print('original')") ?? false);

  // Modify the file
  const modifyResult = await executeTool("fs_write", {
    path: testFile,
    content: "print('modified')\n",
  }, { db, workspaceRoot: ws, runId: null, objectiveId: null, taskId: null });
  check("modify: fs_write succeeds", modifyResult.ok);

  const modifyChanges = await db.select().from(changes).where(eq(changes.path, testFile));
  const modifyChange = modifyChanges.find((c) => c.operation === "modify");
  check("modify: operation=modify", modifyChange?.operation === "modify");
  check("modify: beforeContent captured", modifyChange?.beforeContent?.includes("print('original')") ?? false);
  check("modify: afterContent captured", modifyChange?.afterContent?.includes("print('modified')") ?? false);

  // Delete the file
  const deleteResult = await executeTool("fs_delete", {
    path: testFile,
  }, { db, workspaceRoot: ws, runId: null, objectiveId: null, taskId: null });
  check("delete: fs_delete succeeds", deleteResult.ok);

  const deleteChange = (await db.select().from(changes).where(eq(changes.path, testFile)))
    .find((c) => c.operation === "delete");
  check("delete: operation=delete", deleteChange?.operation === "delete");
  check("delete: beforeContent captured", deleteChange?.beforeContent?.includes("print('modified')") ?? false);

  // Cleanup
  await db.delete(changes).where(eq(changes.path, testFile));
  cleanupFile(testFile);
}

async function testGitInfo() {
  console.log("\n6. Git detection");
  const info = getGitInfo();
  // The workspace may or may not be a git repo — just verify the function doesn't crash
  check("getGitInfo: returns object", typeof info === "object");
  check("getGitInfo: has isRepo field", typeof info.isRepo === "boolean");
}

/* ────────────────────────────────────────────────────────────────────── */
/*  E2E TESTS                                                            */
/* ────────────────────────────────────────────────────── */

async function testA_CreateAndExecute() {
  console.log("\n7. E2E Test A: Create and execute");
  const { objective } = await createObjective({
    title: `PHASE3 TEST A ${TOKEN}`,
    description: "Create a Python program that prints 12 and verify that it prints 12.",
  });

  const provider = new CreateExecuteProvider();
  const result = await runAgentCore(objective.id, { provider, maxRetries: 3 });

  check("A: runAgentCore returns completed", result.status === "completed", result.error ?? result.status);

  // Verify real file exists
  const filePath = path.join(workspaceRoot(), "print_12.py");
  check("A: print_12.py exists", fs.existsSync(filePath));
  check("A: file contains print(12)", fs.readFileSync(filePath, "utf8").includes("print(12)"));

  // Verify run state
  const [run] = await db.select().from(runs).where(eq(runs.objectiveId, objective.id));
  check("A: run status = completed", run?.status === "completed");

  // Verify change tracking
  const objChanges = await db.select().from(changes).where(eq(changes.objectiveId, objective.id));
  check("A: change tracked (create)", objChanges.some((c) => c.operation === "create" && c.path === "print_12.py"));

  await cleanupObjective(objective.id);
  cleanupFile("print_12.py");
}

async function testB_InspectAndModify() {
  console.log("\n8. E2E Test B: Inspect and modify");

  // Pre-create the file
  const ws = ensureWorkspace();
  fs.writeFileSync(path.join(ws, "value_test.py"), "value = 5\nprint(value)\n");

  const { objective } = await createObjective({
    title: `PHASE3 TEST B ${TOKEN}`,
    description: "Change the value in value_test.py from 5 to 12 and verify the program outputs 12.",
  });

  const provider = new InspectModifyProvider();
  const result = await runAgentCore(objective.id, { provider, maxRetries: 3 });

  check("B: runAgentCore returns completed", result.status === "completed", result.error ?? result.status);

  // Verify file was modified
  const filePath = path.join(workspaceRoot(), "value_test.py");
  check("B: value_test.py exists", fs.existsSync(filePath));
  const content = fs.readFileSync(filePath, "utf8");
  check("B: file contains value = 12", content.includes("value = 12"));
  check("B: file does NOT contain value = 5", !content.includes("value = 5"));

  // Verify change tracking (modify operation)
  const objChanges = await db.select().from(changes).where(eq(changes.objectiveId, objective.id));
  check("B: change tracked (modify)", objChanges.some((c) => c.operation === "modify" && c.path === "value_test.py"));
  const modifyChange = objChanges.find((c) => c.operation === "modify" && c.path === "value_test.py");
  check("B: beforeContent has value = 5", modifyChange?.beforeContent?.includes("value = 5") ?? false);
  check("B: afterContent has value = 12", modifyChange?.afterContent?.includes("value = 12") ?? false);

  await cleanupObjective(objective.id);
  cleanupFile("value_test.py");
}

async function testC_RealFailureAndRepair() {
  console.log("\n9. E2E Test C: Real failure and repair");

  // Pre-create the broken file
  const ws = ensureWorkspace();
  fs.writeFileSync(path.join(ws, "broken.py"), 'pront("hello")\n');

  const { objective } = await createObjective({
    title: `PHASE3 TEST C ${TOKEN}`,
    description: "Fix the broken Python file broken.py and verify it prints 'hello' when executed.",
  });

  const provider = new FailureRepairProvider();
  const result = await runAgentCore(objective.id, { provider, maxRetries: 3 });

  check("C: runAgentCore returns completed", result.status === "completed", result.error ?? result.status);

  // Verify file was repaired
  const filePath = path.join(workspaceRoot(), "broken.py");
  check("C: broken.py exists", fs.existsSync(filePath));
  const content = fs.readFileSync(filePath, "utf8");
  check("C: file contains print(", content.includes("print("));
  check("C: file does NOT contain pront", !content.includes("pront"));

  // Verify recovery steps
  const stepRows = await db.select().from(steps).where(eq(steps.runId, result.runId)).orderBy(steps.seq);
  const kinds = stepRows.map((s) => s.kind);
  check("C: has diagnose step", kinds.includes("diagnose"));
  check("C: has repair step", kinds.includes("repair"));

  // Verify change tracking (repair = modify operation)
  const objChanges = await db.select().from(changes).where(eq(changes.objectiveId, objective.id));
  check("C: change tracked (repair)", objChanges.some((c) => c.operation === "modify" && c.path === "broken.py"));

  await cleanupObjective(objective.id);
  cleanupFile("broken.py");
}

async function testD_TestFailureAndRepair() {
  console.log("\n10. E2E Test D: Test failure and repair");

  // Pre-create the failing test
  const ws = ensureWorkspace();
  fs.writeFileSync(
    path.join(ws, "test_add.py"),
    'def add(a, b):\n    return a - b\n\nassert add(5, 7) == 12, f"Expected 12, got {add(5, 7)}"\nprint("All tests passed")\n',
  );

  const { objective } = await createObjective({
    title: `PHASE3 TEST D ${TOKEN}`,
    description: "Fix the failing test in test_add.py and verify all tests pass.",
  });

  const provider = new TestFailureProvider();
  const result = await runAgentCore(objective.id, { provider, maxRetries: 3 });

  check("D: runAgentCore returns completed", result.status === "completed", result.error ?? result.status);

  // Verify test file was fixed
  const filePath = path.join(workspaceRoot(), "test_add.py");
  check("D: test_add.py exists", fs.existsSync(filePath));
  const content = fs.readFileSync(filePath, "utf8");
  check("D: file contains 'return a + b'", content.includes("return a + b"));
  check("D: file does NOT contain 'return a - b'", !content.includes("return a - b"));

  // Verify recovery
  const stepRows = await db.select().from(steps).where(eq(steps.runId, result.runId)).orderBy(steps.seq);
  const kinds = stepRows.map((s) => s.kind);
  check("D: has diagnose step", kinds.includes("diagnose"));
  check("D: has repair step", kinds.includes("repair"));

  await cleanupObjective(objective.id);
  cleanupFile("test_add.py");
}

async function testE_WorkspaceSecurityE2E() {
  console.log("\n11. E2E Test E: Workspace security");

  // These are direct tool tests — no provider needed
  const ws = ensureWorkspace();

  // Attempt path traversal via fs_write
  const escapeWrite = await executeTool("fs_write", {
    path: "../../../etc/escape_test",
    content: "escape",
  }, { db, workspaceRoot: ws, runId: null });
  check("E: fs_write rejects ../../../ path", !escapeWrite.ok);

  // Attempt absolute path via fs_write
  const absWrite = await executeTool("fs_write", {
    path: "/tmp/escape_test",
    content: "escape",
  }, { db, workspaceRoot: ws, runId: null });
  check("E: fs_write rejects absolute path", !absWrite.ok);

  // Attempt path traversal via fs_delete
  const escapeDelete = await executeTool("fs_delete", {
    path: "../../../etc/passwd",
  }, { db, workspaceRoot: ws, runId: null });
  check("E: fs_delete rejects ../../../ path", !escapeDelete.ok);

  // Attempt path traversal via fs_read
  const escapeRead = await executeTool("fs_read", {
    path: "../../../etc/passwd",
  }, { db, workspaceRoot: ws, runId: null });
  check("E: fs_read rejects ../../../ path", !escapeRead.ok);

  // Verify no escape file was created
  check("E: no escape file outside workspace", !fs.existsSync("/etc/escape_test"));
  check("E: no escape file in parent dir", !fs.existsSync(path.join(path.dirname(ws), "escape.txt")));
}

async function testF_CommandFailure() {
  console.log("\n12. E2E Test F: Command failure capture + recovery");

  // Pre-create a failing script
  const ws = ensureWorkspace();
  fs.writeFileSync(path.join(ws, "fail_script.py"), 'print("fail")\nimport sys\nsys.exit(1)\n');

  const { objective } = await createObjective({
    title: `PHASE3 TEST F ${TOKEN}`,
    description: "Fix the failing script fail_script.py and verify it prints 'success' when executed.",
  });

  const provider = new CommandFailureProvider();
  const result = await runAgentCore(objective.id, { provider, maxRetries: 3 });

  check("F: runAgentCore returns completed", result.status === "completed", result.error ?? result.status);

  // Verify the script was fixed
  const filePath = path.join(workspaceRoot(), "fail_script.py");
  check("F: fail_script.py exists", fs.existsSync(filePath));
  const content = fs.readFileSync(filePath, "utf8");
  check("F: file contains 'success'", content.includes("success"));
  check("F: file does NOT contain 'fail'", !content.includes("fail"));

  // Verify recovery path was used
  const stepRows = await db.select().from(steps).where(eq(steps.runId, result.runId)).orderBy(steps.seq);
  const kinds = stepRows.map((s) => s.kind);
  check("F: has diagnose step", kinds.includes("diagnose"));
  check("F: has repair step", kinds.includes("repair"));

  // Verify the initial command failure was captured
  const observations = stepRows.filter((s) => s.kind === "observation");
  const firstObs = observations[0];
  check("F: first observation shows failure", (firstObs?.output as { ok: boolean })?.ok === false);

  await cleanupObjective(objective.id);
  cleanupFile("fail_script.py");
}

/* ────────────────────────────────────────────────────────────────────── */
/*  MAIN                                                                 */
/* ────────────────────────────────────────────────────── */

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  KAIRA AGENT CORE — Phase 3 Engineering Tests             ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // Check Python3
  console.log("\n0. Environment check");
  const { execSync } = await import("node:child_process");
  try {
    const pyVersion = execSync("python3 --version 2>&1", { encoding: "utf8" }).trim();
    check("python3 available", true, pyVersion);
    console.log(`  · ${pyVersion}`);
  } catch {
    check("python3 available", false, "python3 not found");
    console.log("  · Installing python3...");
    try {
      execSync("apt-get update -qq && apt-get install -y -qq python3 2>&1", { stdio: "pipe", timeout: 60000 });
      check("python3 installed", true);
    } catch {
      console.error("  · Failed to install python3 — E2E tests will fail");
    }
  }

  // Unit tests
  await testEngineeringTools();
  await testFileContainsVerification();
  await testWorkspaceSecurity();
  await testShellExecution();
  await testChangeTracking();
  await testGitInfo();

  // E2E tests
  await testA_CreateAndExecute();
  await testB_InspectAndModify();
  await testC_RealFailureAndRepair();
  await testD_TestFailureAndRepair();
  await testE_WorkspaceSecurityE2E();
  await testF_CommandFailure();

  console.log(
    failures === 0
      ? `\nRESULT: PASS — ${tests} checks passed. Phase 3 engineering layer is working.\n`
      : `\nRESULT: FAIL — ${failures} of ${tests} checks failed.\n`,
  );
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nPHASE 3 TEST CRASHED:", err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
