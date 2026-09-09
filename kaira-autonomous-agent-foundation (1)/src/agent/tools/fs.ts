import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { displayPath, ensureWorkspace, resolveInWorkspace } from "../workspace";
import type { Tool } from "./types";

const MAX_READ_CHARS = 60_000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build"]);

/* --------------------------------- fs_write -------------------------------- */

export const fsWrite = {
  name: "fs_write",
  category: "fs",
  description:
    "Write text to a file inside the workspace. Creates parent directories and overwrites existing content. Use for creating source code, documents, notes.",
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      content: { type: "string", description: "Full file content to write" },
    },
    required: ["path", "content"],
  },
  async execute(input: { path: string; content: string }) {
    ensureWorkspace();
    const abs = resolveInWorkspace(input.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.content, "utf8");
    return {
      ok: true,
      output: `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${displayPath(abs)}`,
      data: { path: displayPath(abs), bytes: Buffer.byteLength(input.content, "utf8") },
    };
  },
} satisfies Tool<{ path: string; content: string }>;

/* --------------------------------- fs_read --------------------------------- */

export const fsRead = {
  name: "fs_read",
  category: "fs",
  description:
    "Read a text file from the workspace. Returns the content (truncated with a notice if very large).",
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_READ_CHARS).optional(),
  }),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      offset: { type: "number", description: "Character offset to start at" },
      limit: { type: "number", description: "Max characters to return" },
    },
    required: ["path"],
  },
  async execute(input: { path: string; offset?: number; limit?: number }) {
    const abs = resolveInWorkspace(input.path);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch {
      return { ok: false, output: `File not found: ${displayPath(abs)}` };
    }
    const start = input.offset ?? 0;
    const end = Math.min(raw.length, start + (input.limit ?? MAX_READ_CHARS));
    const slice = raw.slice(start, end);
    const truncated = end < raw.length;
    return {
      ok: true,
      output: `--- ${displayPath(abs)} (${raw.length} chars${truncated ? `, showing ${start}–${end}` : ""}) ---\n${slice}`,
      data: { path: displayPath(abs), size: raw.length, truncated },
    };
  },
} satisfies Tool<{ path: string; offset?: number; limit?: number }>;

/* --------------------------------- fs_list --------------------------------- */

interface ListedEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}

export const fsList = {
  name: "fs_list",
  category: "fs",
  description:
    "List files and directories in the workspace. Use to see what already exists before creating or modifying files.",
  schema: z.object({
    path: z.string().optional(),
    recursive: z.boolean().optional(),
  }),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory (default: root)" },
      recursive: { type: "boolean", description: "Recurse into subdirectories" },
    },
    required: [],
  },
  async execute(input: { path?: string; recursive?: boolean }) {
    ensureWorkspace();
    const abs = resolveInWorkspace(input.path ?? ".");
    const entries: ListedEntry[] = [];
    const maxDepth = input.recursive ? 5 : 1;
    const walk = async (dir: string, depth: number) => {
      if (entries.length >= 500) return;
      let items;
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (entries.length >= 500) break;
        if (SKIP_DIRS.has(item.name)) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          entries.push({ path: displayPath(full), type: "dir", size: 0 });
          if (depth < maxDepth) await walk(full, depth + 1);
        } else {
          const stat = await fs.stat(full).catch(() => null);
          entries.push({
            path: displayPath(full),
            type: "file",
            size: stat?.size ?? 0,
          });
        }
      }
    };
    await walk(abs, 1);
    const listing = entries
      .map((e) => `${e.type === "dir" ? "dir " : "file"}\t${e.size}\t${e.path}`)
      .join("\n");
    return {
      ok: true,
      output: listing
        ? `${entries.length} entr${entries.length === 1 ? "y" : "ies"}:\n${listing}`
        : "Directory is empty.",
      data: { entries },
    };
  },
} satisfies Tool<{ path?: string; recursive?: boolean }>;

/* -------------------------------- fs_search -------------------------------- */

export const fsSearch = {
  name: "fs_search",
  category: "fs",
  description:
    "Search file contents in the workspace for a text or regex pattern. Returns matching lines with file paths.",
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    maxResults: z.number().int().min(1).max(50).optional(),
  }),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex or plain text to search for" },
      path: { type: "string", description: "Subdirectory to search (default: root)" },
      maxResults: { type: "number" },
    },
    required: ["pattern"],
  },
  async execute(input: { pattern: string; path?: string; maxResults?: number }) {
    const abs = resolveInWorkspace(input.path ?? ".");
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, "i");
    } catch {
      regex = new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const max = input.maxResults ?? 25;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 6 || matches.length >= max) return;
      const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (matches.length >= max) break;
        if (SKIP_DIRS.has(item.name)) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(full, depth + 1);
        } else {
          const stat = await fs.stat(full).catch(() => null);
          if (!stat || stat.size > 512_000) continue;
          const content = await fs.readFile(full, "utf8").catch(() => null);
          if (!content) continue;
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && matches.length < max; i++) {
            if (regex.test(lines[i])) {
              matches.push({
                path: displayPath(full),
                line: i + 1,
                text: lines[i].slice(0, 300),
              });
            }
          }
        }
      }
    };
    await walk(abs, 1);
    return {
      ok: true,
      output: matches.length
        ? matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n")
        : `No matches for "${input.pattern}".`,
      data: { matches },
    };
  },
} satisfies Tool<{ pattern: string; path?: string; maxResults?: number }>;
