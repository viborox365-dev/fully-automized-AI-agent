import { z } from "zod";
import type { Tool } from "./types";

/**
 * http_fetch — real HTTP GET with a size cap and timeout.
 * format "text" strips HTML down to readable text; "raw" returns as-is.
 */
export const httpFetch = {
  name: "http_fetch",
  category: "web",
  description:
    "Fetch a URL over HTTP(S) and return its content. Use for research: documentation, web pages, APIs. Only GET requests; content is capped.",
  schema: z.object({
    url: z.string().url(),
    format: z.enum(["text", "raw"]).optional(),
    maxBytes: z.number().int().min(1024).max(1_000_000).optional(),
  }),
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL to fetch" },
      format: { type: "string", enum: ["text", "raw"], description: "'text' strips HTML (default), 'raw' returns untouched" },
      maxBytes: { type: "number", description: "Max bytes to download (default 200000)" },
    },
    required: ["url"],
  },
  async execute(input: { url: string; format?: "text" | "raw"; maxBytes?: number }) {
    const cap = input.maxBytes ?? 200_000;
    const started = Date.now();
    let res: globalThis.Response;
    try {
      res = await fetch(input.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(25_000),
        headers: {
          "User-Agent": "Kaira/0.1 (autonomous agent; local research)",
          Accept: "text/html,application/json,text/plain,*/*",
        },
      });
    } catch (err) {
      return {
        ok: false,
        output: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!res.ok) {
      return { ok: false, output: `HTTP ${res.status} ${res.statusText} for ${input.url}` };
    }
    const contentType = res.headers.get("content-type") ?? "unknown";
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, output: "Response had no body." };
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
      if (received > cap) {
        truncated = true;
        chunks.push(value!.subarray(0, value!.length - (received - cap)));
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (value) chunks.push(value);
    }
    let body = new TextDecoder("utf-8", { fatal: false }).decode(
      concat(chunks),
    );
    const format =
      input.format ?? (contentType.includes("html") ? "text" : "raw");
    if (format === "text" && contentType.includes("html")) {
      body = htmlToText(body);
    }
    return {
      ok: true,
      output: `HTTP ${res.status} · ${contentType} · ${received} bytes${truncated ? ` (truncated to ${cap})` : ""} · ${Date.now() - started}ms\n\n${body.slice(0, 40_000)}`,
      data: { status: res.status, contentType, bytes: received, truncated },
    };
  },
} satisfies Tool<{ url: string; format?: "text" | "raw"; maxBytes?: number }>;

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
