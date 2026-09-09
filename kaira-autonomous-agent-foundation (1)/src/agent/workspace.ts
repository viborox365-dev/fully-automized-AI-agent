import path from "node:path";
import fs from "node:fs";

/**
 * Kaira's workspace — the only directory her filesystem and shell tools may
 * touch. Defaults to <project>/workspace, override with KAIRA_WORKSPACE.
 */
export function workspaceRoot(): string {
  const root =
    process.env.KAIRA_WORKSPACE ?? path.join(process.cwd(), "workspace");
  return path.resolve(root);
}

export function ensureWorkspace(): string {
  const root = workspaceRoot();
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Resolve a user-supplied path against the workspace and refuse anything that
 * escapes it. This is the security boundary for all filesystem tools.
 */
export function resolveInWorkspace(rel: string): string {
  const root = workspaceRoot();
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${rel}`);
  }
  return resolved;
}

/** Present an absolute path relative to the workspace (for outputs). */
export function displayPath(abs: string): string {
  return path.relative(workspaceRoot(), abs) || ".";
}
