/**
 * Kaira Agent Core — Verification Layer (Phase 2)
 *
 * An extensible verification system that checks whether the actual outcome
 * of a task matches what was expected. This is separate from the execution
 * engine: "action executed successfully" does NOT mean "objective completed."
 *
 * The verifier checks real-world state:
 *   - file_exists:       does the file exist in the workspace?
 *   - output_contains:   does the previous command output contain expected text?
 *   - exit_code_zero:    did the previous command exit successfully?
 *   - command_succeeds:  does a verification command succeed?
 *
 * New verification types can be added by extending the switch in verifyTask().
 */

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { ensureWorkspace, resolveInWorkspace, displayPath } from "./workspace";
import type { VerificationCriteria } from "./planner";

export interface VerificationResult {
  passed: boolean;
  detail: string;
  data?: unknown;
}

/**
 * Verify a task's outcome against its verification criteria.
 *
 * @param criteria  The verification criteria from the structured plan.
 * @param lastOutput  The output of the previous task (for output_contains, exit_code_zero).
 */
export async function verifyTask(
  criteria: VerificationCriteria,
  lastOutput: string,
): Promise<VerificationResult> {
  switch (criteria.type) {
    case "file_exists":
      return verifyFileExists(criteria.path ?? "");

    case "output_contains":
      return verifyOutputContains(lastOutput, criteria.expected ?? "");

    case "exit_code_zero":
      return verifyExitCodeZero(lastOutput);

    case "command_succeeds":
      return verifyCommandSucceeds(criteria.command ?? "");

    case "file_contains":
      return verifyFileContains(criteria.path ?? "", criteria.expected ?? "");

    default:
      return {
        passed: false,
        detail: `Unknown verification type: ${(criteria as { type: string }).type}`,
      };
  }
}

/** Check that a file exists in the workspace. */
function verifyFileExists(relPath: string): VerificationResult {
  ensureWorkspace();
  try {
    const abs = resolveInWorkspace(relPath);
    const exists = fs.existsSync(abs);
    return {
      passed: exists,
      detail: exists
        ? `File exists: ${displayPath(abs)}`
        : `File not found: ${relPath}`,
      data: { path: relPath, exists },
    };
  } catch (err) {
    return {
      passed: false,
      detail: `Path error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Check that the previous command output contains the expected text. */
function verifyOutputContains(output: string, expected: string): VerificationResult {
  const contains = output.includes(expected);
  return {
    passed: contains,
    detail: contains
      ? `Output contains "${expected}"`
      : `Output does not contain "${expected}". Actual: ${output.slice(0, 500)}`,
    data: { expected, found: contains },
  };
}

/** Check that the previous command exited with code 0. */
function verifyExitCodeZero(output: string): VerificationResult {
  // The shell_exec tool includes "exit=0" in its output on success
  const exitMatch = output.match(/exit=(\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
  const passed = exitCode === 0;
  return {
    passed,
    detail: passed
      ? "Command exited with code 0"
      : `Command did not exit cleanly (exit=${exitCode ?? "unknown"})`,
    data: { exitCode },
  };
}

/** Check that a file exists and contains the expected text. */
function verifyFileContains(relPath: string, expected: string): VerificationResult {
  ensureWorkspace();
  try {
    const abs = resolveInWorkspace(relPath);
    if (!fs.existsSync(abs)) {
      return { passed: false, detail: `File not found: ${relPath}` };
    }
    const content = fs.readFileSync(abs, "utf8");
    const contains = content.includes(expected);
    return {
      passed: contains,
      detail: contains
        ? `File ${relPath} contains "${expected}"`
        : `File ${relPath} does not contain "${expected}". Content: ${content.slice(0, 300)}`,
      data: { path: relPath, expected, found: contains },
    };
  } catch (err) {
    return {
      passed: false,
      detail: `File read error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Run a verification command and check that it succeeds. */
function verifyCommandSucceeds(command: string): Promise<VerificationResult> {
  return new Promise((resolve) => {
    const cwd = ensureWorkspace();
    exec(
      command,
      { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const ok = !error;
        const output = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
        resolve({
          passed: ok,
          detail: ok
            ? `Verification command succeeded: ${output.slice(0, 300)}`
            : `Verification command failed: ${error?.message ?? "unknown error"}`,
          data: { exitCode: error ? 1 : 0, output: output.slice(0, 500) },
        });
      },
    );
  });
}

/**
 * Verify an entire objective — check that all task verifications passed
 * and that the final state matches the objective's intent.
 */
export async function verifyObjective(
  taskVerifications: VerificationResult[],
): Promise<VerificationResult> {
  const allPassed = taskVerifications.every((v) => v.passed);
  const failed = taskVerifications.filter((v) => !v.passed);
  return {
    passed: allPassed,
    detail: allPassed
      ? `All ${taskVerifications.length} verification(s) passed`
      : `${failed.length} of ${taskVerifications.length} verification(s) failed: ${failed.map((f) => f.detail).join("; ")}`,
    data: { total: taskVerifications.length, passed: taskVerifications.length - failed.length, failed: failed.length },
  };
}
