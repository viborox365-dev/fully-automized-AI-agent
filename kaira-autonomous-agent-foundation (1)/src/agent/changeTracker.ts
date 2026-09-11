/**
 * Kaira Agent Core — Engineering Change Tracker (Phase 3)
 *
 * Records every file modification, deletion, and directory creation for
 * auditability. Captures before/after content where practical, the model
 * responsible, and command/test results.
 *
 * If the workspace is a Git repository, captures useful Git information
 * (branch, changed files, diff stat) without auto-committing or pushing.
 */

import { db } from "@/db";
import { changes } from "@/db/schema";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { workspaceRoot } from "./workspace";

export interface ChangeRecord {
  objectiveId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  operation: string;
  path: string;
  beforeContent?: string | null;
  afterContent?: string | null;
  model?: string | null;
  commandOutput?: string | null;
  repairAttempt?: number;
}

/** Record an engineering change to the database. */
export async function recordChange(record: ChangeRecord): Promise<void> {
  try {
    await db.insert(changes).values({
      objectiveId: record.objectiveId ?? null,
      runId: record.runId ?? null,
      taskId: record.taskId ?? null,
      operation: record.operation,
      path: record.path,
      beforeContent: record.beforeContent ?? null,
      afterContent: record.afterContent ?? null,
      model: record.model ?? null,
      commandOutput: record.commandOutput ?? null,
      repairAttempt: record.repairAttempt ?? 0,
    });
  } catch (err) {
    // Change tracking is best-effort — don't break execution if DB is unavailable
    console.warn("[kaira-changeTracker] Failed to record change:", err);
  }
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  changedFiles?: string[];
  diffStat?: string;
}

/** Detect if the workspace is a Git repo and capture useful info. */
export function getGitInfo(): GitInfo {
  const root = workspaceRoot();
  try {
    if (!fs.existsSync(path.join(root, ".git"))) {
      return { isRepo: false };
    }

    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    const statusOutput = execSync("git status --porcelain", {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    const changedFiles = statusOutput
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim());

    let diffStat = "";
    try {
      diffStat = execSync("git diff --stat", {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    } catch {
      // diff may fail if no changes staged
    }

    return { isRepo: true, branch, changedFiles, diffStat };
  } catch {
    return { isRepo: false };
  }
}

/** Format Git info as a readable string for logs and reports. */
export function formatGitInfo(info: GitInfo): string {
  if (!info.isRepo) return "(not a git repository)";
  const parts = [`branch: ${info.branch ?? "unknown"}`];
  if (info.changedFiles?.length) {
    parts.push(`changed files: ${info.changedFiles.join(", ")}`);
  }
  if (info.diffStat) {
    parts.push(`diff stat:\n${info.diffStat}`);
  }
  return parts.join("\n");
}
