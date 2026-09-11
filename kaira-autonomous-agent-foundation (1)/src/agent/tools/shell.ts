import { z } from "zod";
import { exec } from "node:child_process";
import { ensureWorkspace } from "../workspace";
import type { Tool } from "./types";

/**
 * shell_exec — run a command inside the workspace.
 *
 * Safety model (documented, honest):
 *  - cwd is pinned to the sandboxed workspace root
 *  - the base binary must be in an allowlist (KAIRA_SHELL_ALLOW env, CSV)
 *  - hard timeout (max 120s) and output cap (20k chars)
 *  - environment is scrubbed (no inherited secrets)
 * This is a strong local-first default, not a security sandbox for hostile
 * instructions; see docs/ARCHITECTURE.md for hardening roadmap.
 */

const DEFAULT_ALLOWLIST = [
  "node", "npm", "npx", "python3", "python", "git",
  "ls", "cat", "echo", "pwd", "grep", "find", "wc", "head", "tail",
  "sort", "uniq", "mkdir", "touch", "cp", "mv", "curl", "date", "shasum",
];

function allowlist(): Set<string> {
  const env = process.env.KAIRA_SHELL_ALLOW;
  const list = env ? env.split(",") : DEFAULT_ALLOWLIST;
  return new Set(list.map((s) => s.trim()).filter(Boolean));
}

function baseBinary(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  return first.replace(/^["']|["']$/g, "").split("/").pop() ?? "";
}

const MAX_OUTPUT = 20_000;

export const shellExec = {
  name: "shell_exec",
  category: "exec",
  description:
    "Run a shell command inside the workspace (cwd = workspace root). Allowed binaries: node, npm, npx, python, git, curl, and core utilities. Use to run code, install packages, and verify results.",
  schema: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  }),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command line to execute" },
      timeoutMs: { type: "number", description: "Timeout in ms (default 30000, max 120000)" },
    },
    required: ["command"],
  },
  async execute(input: { command: string; timeoutMs?: number }) {
    const bin = baseBinary(input.command);
    const allowed = allowlist();
    if (!bin || !allowed.has(bin)) {
      return {
        ok: false,
        output: `Command rejected: "${bin || input.command}" is not in the shell allowlist. Allowed: ${[...allowed].join(", ")}`,
      };
    }
    const cwd = ensureWorkspace();
    const timeout = input.timeoutMs ?? 30_000;
    const started = Date.now();
    return await new Promise((resolve) => {
      exec(
        input.command,
        {
          cwd,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: cwd,
            LANG: "C.UTF-8",
            TERM: "dumb",
            NODE_ENV: "production",
            npm_config_fund: "false",
            npm_config_audit: "false",
          },
        },
        (error, stdout, stderr) => {
          const combined = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
          const truncated = combined.length > MAX_OUTPUT;
          const body = truncated ? combined.slice(0, MAX_OUTPUT) : combined;
          // Determine actual exit code
          let exitCode = 0;
          if (error) {
            if ((error as { killed?: boolean }).killed) {
              exitCode = -1; // timed out
            } else if (typeof (error as { code?: number | string }).code === "number") {
              exitCode = (error as { code: number }).code;
            } else {
              exitCode = 1;
            }
          }
          const meta = `exit=${exitCode} · ${Date.now() - started}ms${truncated ? " · output truncated" : ""}`;
          if (error && !stdout && !stderr) {
            resolve({
              ok: false,
              output: `Command failed to run (${meta}): ${error.message.slice(0, 300)}`,
              data: { exitCode, durationMs: Date.now() - started, stdout: "", stderr: error.message.slice(0, 500) },
            });
            return;
          }
          resolve({
            ok: !error,
            output: `$ ${input.command}\n${meta}\n${body}`.trim(),
            data: {
              exitCode,
              durationMs: Date.now() - started,
              stdout: stdout.slice(0, 10_000),
              stderr: stderr.slice(0, 10_000),
            },
          });
        },
      );
    });
  },
} satisfies Tool<{ command: string; timeoutMs?: number }>;
