/**
 * Kaira Agent Core — Engineering Tools (Phase 3)
 *
 * Additional filesystem and tooling-detection tools that extend the existing
 * tool layer for real engineering work. All filesystem tools enforce the
 * same workspace sandbox boundary as the Phase 1 tools.
 */

import { z } from "zod";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  displayPath,
  ensureWorkspace,
  resolveInWorkspace,
} from "../workspace";
import { ENGINEERING_LIMITS } from "../safeguards";
import { recordChange } from "../changeTracker";
import type { Tool } from "./types";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".pytest_cache",
]);

/* --------------------------------- fs_delete -------------------------------- */

export const fsDelete = {
  name: "fs_delete",
  category: "fs",
  description:
    "Delete a file inside the workspace. Does NOT delete directories. Destructive — disabled if KAIRA_ALLOW_DELETE=false.",
  schema: z.object({
    path: z.string().min(1),
  }),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
    },
    required: ["path"],
  },
  async execute(
    input: { path: string },
    ctx: Parameters<Tool["execute"]>[1],
  ) {
    if (!ENGINEERING_LIMITS.ALLOW_DELETE) {
      return {
        ok: false,
        output: "File deletion is disabled (KAIRA_ALLOW_DELETE=false).",
      };
    }
    const abs = resolveInWorkspace(input.path);
    const stat = await fsSync.promises.stat(abs).catch(() => null);
    if (!stat) {
      return { ok: false, output: `File not found: ${displayPath(abs)}` };
    }
    if (stat.isDirectory()) {
      return {
        ok: false,
        output: `Cannot delete directory with fs_delete. Only files can be deleted.`,
      };
    }
    // Capture before content for change tracking
    const before = await fsSync.promises
      .readFile(abs, "utf8")
      .catch(() => null);
    await fsSync.promises.unlink(abs);
    // Record change
    await recordChange({
      runId: ctx.runId,
      objectiveId: ctx.objectiveId,
      taskId: ctx.taskId,
      operation: "delete",
      path: displayPath(abs),
      beforeContent: before,
    });
    return {
      ok: true,
      output: `Deleted ${displayPath(abs)}`,
      data: { path: displayPath(abs) },
    };
  },
} satisfies Tool<{ path: string }>;

/* --------------------------------- fs_mkdir --------------------------------- */

export const fsMkdir = {
  name: "fs_mkdir",
  category: "fs",
  description:
    "Create a directory inside the workspace. Creates parent directories as needed.",
  schema: z.object({
    path: z.string().min(1),
  }),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory path" },
    },
    required: ["path"],
  },
  async execute(
    input: { path: string },
    ctx: Parameters<Tool["execute"]>[1],
  ) {
    const abs = resolveInWorkspace(input.path);
    await fs.mkdir(abs, { recursive: true });
    await recordChange({
      runId: ctx.runId,
      objectiveId: ctx.objectiveId,
      taskId: ctx.taskId,
      operation: "mkdir",
      path: displayPath(abs),
    });
    return {
      ok: true,
      output: `Created directory ${displayPath(abs)}`,
      data: { path: displayPath(abs) },
    };
  },
} satisfies Tool<{ path: string }>;

/* --------------------------------- fs_exists -------------------------------- */

export const fsExists = {
  name: "fs_exists",
  category: "fs",
  description:
    "Check whether a file or directory exists in the workspace. Returns type (file/dir/none).",
  schema: z.object({
    path: z.string().min(1),
  }),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative path" },
    },
    required: ["path"],
  },
  async execute(input: { path: string }) {
    const abs = resolveInWorkspace(input.path);
    const exists = fsSync.existsSync(abs);
    if (!exists) {
      return {
        ok: true,
        output: `does not exist: ${displayPath(abs)}`,
        data: { exists: false, type: "none" },
      };
    }
    const stat = await fsSync.promises.stat(abs).catch(() => null);
    const type = stat?.isDirectory() ? "directory" : "file";
    return {
      ok: true,
      output: `${type}: ${displayPath(abs)} exists`,
      data: { exists: true, type },
    };
  },
} satisfies Tool<{ path: string }>;

/* --------------------------------- fs_tree ---------------------------------- */

interface TreeNode {
  name: string;
  type: "file" | "dir";
  size: number;
  children?: TreeNode[];
}

export const fsTree = {
  name: "fs_tree",
  category: "fs",
  description:
    "Show a tree view of the workspace directory structure. Useful for understanding project layout before making changes.",
  schema: z.object({
    path: z.string().optional(),
    maxDepth: z.number().int().min(1).max(10).optional(),
  }),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Subdirectory (default: workspace root)" },
      maxDepth: { type: "number", description: "Max tree depth (default 4, max 10)" },
    },
    required: [],
  },
  async execute(input: { path?: string; maxDepth?: number }) {
    ensureWorkspace();
    const abs = resolveInWorkspace(input.path ?? ".");
    const maxDepth = input.maxDepth ?? 4;

    const build = async (
      dir: string,
      depth: number,
    ): Promise<TreeNode[]> => {
      if (depth > maxDepth) return [];
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const nodes: TreeNode[] = [];
      for (const item of items) {
        if (SKIP_DIRS.has(item.name)) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          const children = depth < maxDepth ? await build(full, depth + 1) : [];
          nodes.push({
            name: item.name,
            type: "dir",
            size: 0,
            children: children.length ? children : undefined,
          });
        } else {
          const stat = await fsSync.promises.stat(full).catch(() => null);
          nodes.push({
            name: item.name,
            type: "file",
            size: stat?.size ?? 0,
          });
        }
      }
      return nodes;
    };

    const tree = await build(abs, 0);

    // Render as text
    const render = (nodes: TreeNode[], prefix: string): string => {
      return nodes
        .map((n, i, arr) => {
          const last = i === arr.length - 1;
          const branch = last ? "└── " : "├── ";
          const line = `${prefix}${branch}${n.name}${n.type === "dir" ? "/" : ` (${n.size}b)`}`;
          const childPrefix = prefix + (last ? "    " : "│   ");
          return n.children
            ? line + "\n" + render(n.children, childPrefix)
            : line;
        })
        .join("\n");
    };

    const output = render(tree, "");
    return {
      ok: true,
      output: output || "(empty directory)",
      data: { root: displayPath(abs), tree },
    };
  },
} satisfies Tool<{ path?: string; maxDepth?: number }>;

/* ------------------------------ detect_tooling ------------------------------ */

interface ToolingInfo {
  language: string;
  testCommands: string[];
  lintCommands: string[];
  typecheckCommands: string[];
  buildCommands: string[];
  runCommands: string[];
}

export const detectTooling = {
  name: "detect_tooling",
  category: "exec",
  description:
    "Detect available project tooling (test runners, linters, type checkers, build tools) by inspecting the workspace for package.json, pyproject.toml, Cargo.toml, go.mod, etc. Use before running commands to know what's available.",
  schema: z.object({}),
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute() {
    const root = ensureWorkspace();
    const info: ToolingInfo = {
      language: "",
      testCommands: [],
      lintCommands: [],
      typecheckCommands: [],
      buildCommands: [],
      runCommands: [],
    };

    // Node.js / TypeScript
    const pkgPath = path.join(root, "package.json");
    if (fsSync.existsSync(pkgPath)) {
      info.language = info.language ? `${info.language}, Node.js` : "Node.js";
      try {
        const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8"));
        const scripts = pkg.scripts ?? {};
        if (scripts.test && scripts.test !== "echo \"Error: no test specified\" && exit 1") {
          info.testCommands.push("npm test");
        }
        if (scripts.lint) info.lintCommands.push("npm run lint");
        if (scripts.typecheck) info.typecheckCommands.push("npm run typecheck");
        if (scripts.build) info.buildCommands.push("npm run build");
        if (scripts.start) info.runCommands.push("npm start");
      } catch {
        // invalid package.json
      }
      if (fsSync.existsSync(path.join(root, "tsconfig.json"))) {
        info.typecheckCommands.push("npx tsc --noEmit");
      }
    }

    // Python
    const hasPython =
      fsSync.existsSync(path.join(root, "pyproject.toml")) ||
      fsSync.existsSync(path.join(root, "setup.py")) ||
      fsSync.existsSync(path.join(root, "requirements.txt"));
    if (hasPython) {
      info.language = info.language ? `${info.language}, Python` : "Python";
      info.testCommands.push("pytest");
      info.runCommands.push("python3");
      if (fsSync.existsSync(path.join(root, ".flake8")) || fsSync.existsSync(path.join(root, "setup.cfg"))) {
        info.lintCommands.push("flake8");
      }
    }

    // Rust
    if (fsSync.existsSync(path.join(root, "Cargo.toml"))) {
      info.language = info.language ? `${info.language}, Rust` : "Rust";
      info.testCommands.push("cargo test");
      info.buildCommands.push("cargo build");
      info.lintCommands.push("cargo clippy");
    }

    // Go
    if (fsSync.existsSync(path.join(root, "go.mod"))) {
      info.language = info.language ? `${info.language}, Go` : "Go";
      info.testCommands.push("go test ./...");
      info.buildCommands.push("go build");
      info.runCommands.push("go run");
    }

    // Make
    if (fsSync.existsSync(path.join(root, "Makefile"))) {
      info.buildCommands.push("make");
    }

    const lines: string[] = [];
    if (info.language) lines.push(`Language: ${info.language}`);
    if (info.testCommands.length) lines.push(`Test: ${info.testCommands.join(", ")}`);
    if (info.lintCommands.length) lines.push(`Lint: ${info.lintCommands.join(", ")}`);
    if (info.typecheckCommands.length) lines.push(`Typecheck: ${info.typecheckCommands.join(", ")}`);
    if (info.buildCommands.length) lines.push(`Build: ${info.buildCommands.join(", ")}`);
    if (info.runCommands.length) lines.push(`Run: ${info.runCommands.join(", ")}`);

    return {
      ok: true,
      output: lines.length ? lines.join("\n") : "No project tooling detected.",
      data: info,
    };
  },
} satisfies Tool<Record<string, never>>;
