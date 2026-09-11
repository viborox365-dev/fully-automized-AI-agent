import type { Step } from "@/db/schema";

/**
 * Kaira Agent Kernel — Safeguards
 *
 * Multiple layers of protection against runaway execution:
 *
 *   1. Step budget          — hard cap on total steps per run (in engine)
 *   2. Retry limit          — max consecutive failures before escalation
 *   3. Infinite loop        — same action+input repeated N times
 *   4. Repeated failures    — same error repeated N times
 *   5. Task depth           — max nesting depth for sub-tasks
 *   6. Task count           — max tasks per objective
 *   7. Execution timeout    — per-model-call timeout (in engine)
 */

export const SAFEGUARD_LIMITS = {
  MAX_STEPS: Number(process.env.KAIRA_MAX_STEPS ?? 20),
  MAX_RETRIES: 3,
  MAX_TASK_DEPTH: 3,
  MAX_TASKS_PER_OBJECTIVE: 12,
  REPEATED_ACTION_THRESHOLD: 3,
  REPEATED_FAILURE_THRESHOLD: 3,
} as const;

/**
 * Phase 3: Engineering-specific safeguards.
 * These protect the workspace from accidental damage.
 */
export const ENGINEERING_LIMITS = {
  /** Max file size for read/write operations (1 MB default). */
  MAX_FILE_SIZE: Number(process.env.KAIRA_MAX_FILE_SIZE ?? 1_048_576),
  /** Max content size for a single write/modify operation (512 KB default). */
  MAX_CHANGE_SIZE: Number(process.env.KAIRA_MAX_CHANGE_SIZE ?? 512_000),
  /** Max command output size (20 KB, already enforced in shell_exec). */
  MAX_OUTPUT_SIZE: 20_000,
  /** Whether file deletion is allowed (set KAIRA_ALLOW_DELETE=false to disable). */
  ALLOW_DELETE: process.env.KAIRA_ALLOW_DELETE !== "false",
  /** Recursive directory deletion is NEVER allowed by default. */
  ALLOW_RECURSIVE_DELETE: false,
  /** Max command execution timeout (ms). */
  MAX_COMMAND_TIMEOUT: 120_000,
} as const;

export interface SafeguardResult {
  triggered: boolean;
  escalate: boolean;
  reason: string;
}

export const SAFEGUARD_OK: SafeguardResult = {
  triggered: false,
  escalate: false,
  reason: "",
};

/** Signature for comparing action steps (tool + input). */
function actionSignature(step: Step): string {
  return JSON.stringify({ tool: step.name, input: step.input });
}

/** Signature for comparing error/failure steps (kind + name + message). */
function failureSignature(step: Step): string {
  const out = (step.output ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    kind: step.kind,
    name: step.name ?? "",
    ok: out.ok,
    message: typeof out.message === "string" ? out.message.slice(0, 200) : "",
    output: typeof out.output === "string" ? out.output.slice(0, 200) : "",
  });
}

/**
 * Detect if the agent is stuck in an infinite loop — the same tool with the
 * same input repeated N consecutive times.
 */
export function detectInfiniteLoop(steps: Step[]): boolean {
  const actions = steps.filter((s) => s.kind === "action");
  const recent = actions.slice(-SAFEGUARD_LIMITS.REPEATED_ACTION_THRESHOLD);
  if (recent.length < SAFEGUARD_LIMITS.REPEATED_ACTION_THRESHOLD) return false;
  const first = actionSignature(recent[0]);
  return recent.every((a) => actionSignature(a) === first);
}

/**
 * Detect if the agent is hitting the same error repeatedly — the same failure
 * signature N consecutive times.
 */
export function detectRepeatedFailures(steps: Step[]): boolean {
  const failures = steps.filter(
    (s) =>
      s.kind === "error" ||
      (s.kind === "observation" &&
        (s.output as Record<string, unknown>)?.ok === false),
  );
  const recent = failures.slice(-SAFEGUARD_LIMITS.REPEATED_FAILURE_THRESHOLD);
  if (recent.length < SAFEGUARD_LIMITS.REPEATED_FAILURE_THRESHOLD) return false;
  const first = failureSignature(recent[0]);
  return recent.every((f) => failureSignature(f) === first);
}

/**
 * Run all safeguard checks against the recent step history.
 * Returns a result indicating whether a safeguard was triggered and whether
 * the run should escalate (vs. fail outright).
 */
export function checkSafeguards(steps: Step[]): SafeguardResult {
  if (detectInfiniteLoop(steps)) {
    return {
      triggered: true,
      escalate: false,
      reason: `Infinite loop detected: the same action was repeated ${SAFEGUARD_LIMITS.REPEATED_ACTION_THRESHOLD} consecutive times. The agent is stuck.`,
    };
  }

  if (detectRepeatedFailures(steps)) {
    return {
      triggered: true,
      escalate: true,
      reason: `Repeated identical failures (${SAFEGUARD_LIMITS.REPEATED_FAILURE_THRESHOLD}x): the agent is hitting the same error and cannot recover.`,
    };
  }

  return SAFEGUARD_OK;
}

/** Check whether a task depth is within the allowed limit. */
export function isWithinTaskDepth(depth: number): boolean {
  return depth <= SAFEGUARD_LIMITS.MAX_TASK_DEPTH;
}

/** Check whether a task count is within the allowed limit. */
export function isWithinTaskCount(count: number): boolean {
  return count <= SAFEGUARD_LIMITS.MAX_TASKS_PER_OBJECTIVE;
}
