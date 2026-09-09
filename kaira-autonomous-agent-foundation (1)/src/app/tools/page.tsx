"use client";

import { useState } from "react";
import { CircleCheckBig, Loader2, Play, TriangleAlert, Wrench } from "lucide-react";
import { useApi } from "@/lib/useApi";
import type { ToolSpecRow } from "@/lib/types";
import { Panel, SectionTitle, StatusPill, TermBlock } from "@/components/ui";

const CAT_TONE: Record<string, "mint" | "ruby" | "ember" | "lilac" | "mist"> = {
  fs: "lilac",
  exec: "ember",
  web: "mint",
  memory: "mist",
};

const EXAMPLES: Record<string, string> = {
  fs_write: JSON.stringify({ path: "notes/hello.md", content: "# Hello from Kaira\n" }, null, 2),
  fs_read: JSON.stringify({ path: "notes/hello.md" }, null, 2),
  fs_list: JSON.stringify({ path: ".", recursive: true }, null, 2),
  fs_search: JSON.stringify({ pattern: "Kaira", maxResults: 10 }, null, 2),
  shell_exec: JSON.stringify({ command: "ls -la" }, null, 2),
  http_fetch: JSON.stringify({ url: "https://example.com", format: "text" }, null, 2),
  memory_save: JSON.stringify({ content: "Tool bench verification entry.", kind: "note" }, null, 2),
  memory_search: JSON.stringify({ query: "verification", limit: 5 }, null, 2),
};

export default function ToolsPage() {
  const list = useApi<{ ok: boolean; tools: ToolSpecRow[]; workspace: { root: string } }>("/api/tools", 15000);
  const [selected, setSelected] = useState<string | null>(null);
  const tools = list.data?.tools ?? [];
  const current = tools.find((t) => t.name === selected) ?? tools[0] ?? null;

  const [input, setInput] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  const effectiveInput = input.trim() ? input : "";

  const execute = async () => {
    if (!current || busy) return;
    setBusy(true);
    setResult(null);
    setParseErr(null);
    let payload: unknown = {};
    try {
      payload = effectiveInput ? JSON.parse(effectiveInput) : {};
    } catch {
      setParseErr("Invalid JSON input");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch(`/api/tools/${current.name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: payload }),
      });
      const json = await res.json();
      setResult(json.result ?? { ok: false, output: json.error ?? "failed" });
    } catch (err) {
      setResult({ ok: false, output: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 pt-4">
      <div className="animate-rise">
        <p className="font-mono text-[10.5px] tracking-[0.34em] text-ember">CAPABILITY REGISTRY</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Tool Bench</h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-mist">
          Every capability Kaira can use — executed through the exact same validation and
          execution path the engine uses. Test tools here before trusting them on a run.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-2 lg:col-span-2">
          {tools.map((t) => (
            <button
              key={t.name}
              onClick={() => {
                setSelected(t.name);
                setInput(EXAMPLES[t.name] ?? "{}");
                setResult(null);
                setParseErr(null);
              }}
              className={`panel panel-hover w-full p-4 text-left ${
                current?.name === t.name ? "border-ember/40" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-mono text-[13px] font-semibold text-ink">
                  <Wrench size={13} className="text-ember" />
                  {t.name}
                </span>
                <StatusPill tone={CAT_TONE[t.category] ?? "mist"} label={t.category} />
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-mist">{t.description}</p>
            </button>
          ))}
        </div>

        <div className="lg:col-span-3">
          {current && (
            <Panel className="space-y-4">
              <div>
                <SectionTitle>SCHEMA · {current.name}</SectionTitle>
                <TermBlock maxH={false}>{JSON.stringify(current.parameters, null, 2)}</TermBlock>
              </div>
              <div>
                <SectionTitle
                  right={
                    <button
                      onClick={() => setInput(EXAMPLES[current.name] ?? "{}")}
                      className="font-mono text-[10px] tracking-[0.12em] text-ember hover:brightness-125"
                    >
                      FILL EXAMPLE
                    </button>
                  }
                >
                  INPUT (JSON)
                </SectionTitle>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  rows={6}
                  placeholder="{}"
                  className="input-field mono-block w-full resize-y p-3 text-ink placeholder:text-mist/50"
                  spellCheck={false}
                />
                {parseErr && <p className="mt-1.5 font-mono text-[11px] text-ruby">{parseErr}</p>}
              </div>
              <button
                onClick={() => void execute()}
                disabled={busy}
                className="flex items-center gap-2 rounded-lg bg-ember px-4 py-2 font-mono text-[11px] font-semibold tracking-[0.14em] text-black transition-all hover:brightness-110 disabled:opacity-40"
              >
                {busy ? <Loader2 size={13} className="animate-spin-slow" /> : <Play size={13} />}
                {busy ? "EXECUTING…" : "EXECUTE TOOL"}
              </button>
              {result && (
                <div className="animate-rise">
                  <div className="mb-2 flex items-center gap-2">
                    {result.ok ? (
                      <CircleCheckBig size={14} className="text-mint" />
                    ) : (
                      <TriangleAlert size={14} className="text-ruby" />
                    )}
                    <span className={`font-mono text-[11px] tracking-[0.12em] ${result.ok ? "text-mint" : "text-ruby"}`}>
                      {result.ok ? "EXECUTED OK" : "TOOL REPORTED FAILURE"}
                    </span>
                  </div>
                  <TermBlock tone={result.ok ? "default" : "error"}>{result.output}</TermBlock>
                </div>
              )}
              {list.data?.workspace.root && (
                <p className="font-mono text-[10px] text-mist/70">sandbox: {list.data.workspace.root}</p>
              )}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
