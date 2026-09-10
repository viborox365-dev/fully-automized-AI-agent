/**
 * Kaira Agent Kernel — State Machine (Phase 2)
 *
 * Explicit state tracking for the agent execution loop. Every transition
 * is validated against the allowed transition table, so the agent can never
 * reach an invalid state.
 *
 * States:
 *   IDLE        — waiting for an objective
 *   PLANNING    — analyzing objective and producing a structured plan
 *   EXECUTING   — selecting and running a tool action
 *   OBSERVING   — recording and interpreting tool results
 *   DIAGNOSING  — analyzing a failure to determine recovery options
 *   REPAIRING   — generating and applying a repair action
 *   RETRYING    — re-executing a failed task after repair
 *   VERIFYING   — verifying that the actual outcome matches the objective
 *   WAITING     — paused for external resource (model, network)
 *   COMPLETED   — objective accomplished and verified
 *   FAILED      — unrecoverable error
 *   ESCALATED   — retries exhausted, needs human intervention
 */

export const AgentStates = [
  "idle",
  "planning",
  "executing",
  "observing",
  "diagnosing",
  "repairing",
  "retrying",
  "verifying",
  "waiting",
  "completed",
  "failed",
  "escalated",
] as const;

export type AgentState = (typeof AgentStates)[number];

export const TERMINAL_AGENT_STATES: AgentState[] = [
  "completed",
  "failed",
  "escalated",
];

/** Allowed transitions from each state. */
export const STATE_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["planning"],
  planning: ["executing", "waiting", "failed", "escalated"],
  executing: ["observing", "verifying", "waiting", "failed", "escalated"],
  observing: ["executing", "retrying", "diagnosing", "verifying", "failed", "escalated"],
  diagnosing: ["repairing", "retrying", "failed", "escalated"],
  repairing: ["retrying", "executing", "failed", "escalated"],
  retrying: ["executing", "observing", "escalated", "failed"],
  verifying: ["completed", "executing", "diagnosing", "failed", "escalated"],
  waiting: ["executing", "planning", "failed", "escalated"],
  completed: [],
  failed: [],
  escalated: [],
};

/** Check whether a transition is allowed. */
export function canTransition(from: AgentState, to: AgentState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

/** Check whether a state is terminal (no further transitions). */
export function isTerminalState(state: AgentState): boolean {
  return TERMINAL_AGENT_STATES.includes(state);
}

/** Human-readable label for each state (for logs and UI). */
export const STATE_LABELS: Record<AgentState, string> = {
  idle: "Idle",
  planning: "Planning",
  executing: "Executing",
  observing: "Observing",
  diagnosing: "Diagnosing",
  repairing: "Repairing",
  retrying: "Retrying",
  verifying: "Verifying",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  escalated: "Escalated",
};
