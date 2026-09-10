/** Client-side mirrors of API response shapes. */

export interface ObjectiveRow {
  id: string;
  title: string;
  description: string;
  status:
    | "pending"
    | "active"
    | "paused"
    | "completed"
    | "failed"
    | "archived"
    | "escalated";
  priority: number;
  createdBy: string;
  result: string | null;
  currentTaskId: string | null;
  attemptCount: number;
  verificationResult: unknown;
  createdAt: string;
  updatedAt: string;
  latestRun?: RunRow | null;
}

export interface RunRow {
  id: string;
  objectiveId: string;
  status:
    | "queued"
    | "planning"
    | "running"
    | "verifying"
    | "completed"
    | "failed"
    | "stopped"
    | "escalated";
  agentState:
    | "idle"
    | "planning"
    | "executing"
    | "observing"
    | "diagnosing"
    | "repairing"
    | "retrying"
    | "verifying"
    | "waiting"
    | "completed"
    | "failed"
    | "escalated";
  plan: string | null;
  result: string | null;
  error: string | null;
  modelId: string;
  stepCount: number;
  maxSteps: number;
  retryCount: number;
  tokensIn: number;
  tokensOut: number;
  lockedAt: string | null;
  lockOwner: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface StepRow {
  id: string;
  runId: string;
  seq: number;
  kind:
    | "plan"
    | "thought"
    | "action"
    | "observation"
    | "critic"
    | "error"
    | "final"
    | "note"
    | "understand"
    | "evaluate"
    | "retry"
    | "escalate"
    | "diagnose"
    | "repair"
    | "verify"
    | "transition";
  name: string | null;
  input: unknown;
  output: unknown;
  latencyMs: number | null;
  createdAt: string;
}

export interface MemoryRow {
  id: string;
  kind: "fact" | "procedure" | "feedback" | "note";
  content: string;
  tags: string[];
  importance: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  role: "brandon" | "kaira" | "system";
  content: string;
  objectiveId: string | null;
  createdAt: string;
}

export interface StatusResponse {
  ok: boolean;
  agent: { name: string; version: string; role: string };
  db: { ok: boolean };
  model: {
    provider: string;
    label?: string;
    model: string;
    baseUrl?: string;
    hasApiKey?: boolean;
    available: boolean;
    detail: string;
    models: string[];
  };
  worker: { online: boolean; lastSeenAt: string | null; owner: string | null };
  counts: {
    objectives: Record<string, number>;
    runs: Record<string, number>;
  };
  workspace: { root: string };
}

export interface TaskRow {
  id: string;
  objectiveId: string;
  title: string;
  description: string;
  state:
    | "idle"
    | "planning"
    | "executing"
    | "observing"
    | "diagnosing"
    | "repairing"
    | "retrying"
    | "verifying"
    | "waiting"
    | "completed"
    | "failed"
    | "escalated";
  depth: number;
  retryCount: number;
  maxRetries: number;
  runId: string | null;
  result: string | null;
  error: string | null;
  order: number;
  dependencies: number[];
  priority: number;
  toolName: string | null;
  toolInput: unknown;
  actionResult: unknown;
  errorInfo: unknown;
  verificationStatus: string;
  verificationDetail: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ToolSpecRow {
  name: string;
  category: "fs" | "exec" | "web" | "memory";
  description: string;
  parameters: Record<string, unknown>;
}
