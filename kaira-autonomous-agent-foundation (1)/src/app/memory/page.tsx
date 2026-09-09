"use client";

import { useState } from "react";
import { MemoryStick, Plus, Search, Trash2 } from "lucide-react";
import { useApi, timeAgo } from "@/lib/useApi";
import type { MemoryRow } from "@/lib/types";
import { Panel, SectionTitle, StatusPill } from "@/components/ui";

const KIND_TONE: Record<string, "mint" | "ruby" | "ember" | "lilac" | "mist"> = {
  fact: "mint",
  procedure: "lilac",
  feedback: "ember",
  note: "mist",
};

export default function MemoryPage() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const list = useApi<{ ok: boolean; memories: MemoryRow[] }>(
    `/api/memories${query ? `?q=${encodeURIComponent(query)}` : ""}`,
    8000,
  );
  const [content, setContent] = useState("");
  const [kind, setKind] = useState("fact");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const add = async () => {
    if (!content.trim() || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: content.trim(),
          kind,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8),
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setContent("");
      setTags("");
      await list.refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/memories/${id}`, { method: "DELETE" });
    await list.refresh();
  };

  return (
    <div className="space-y-6 pt-4">
      <div className="animate-rise">
        <p className="font-mono text-[10.5px] tracking-[0.34em] text-ember">LONG-TERM MEMORY</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">What Kaira remembers</h1>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-mist">
          Durable facts, procedures and preferences stored in PostgreSQL. Kaira recalls these
          before planning; Brandon can teach her directly here. Retrieval is keyword-based today,
          vector retrieval plugs into the same table later.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel className="lg:col-span-1 h-fit">
          <SectionTitle>TEACH KAIRA</SectionTitle>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            placeholder={'e.g. "Brandon prefers TypeScript strict mode and pnpm."'}
            className="input-field w-full resize-none p-3 text-[13px] text-ink placeholder:text-mist/50"
          />
          <div className="mt-3 flex gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="input-field px-3 py-2 text-[12px] text-ink"
            >
              <option value="fact">fact</option>
              <option value="procedure">procedure</option>
              <option value="feedback">feedback</option>
              <option value="note">note</option>
            </select>
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="tags, comma-separated"
              className="input-field flex-1 px-3 py-2 font-mono text-[12px] text-ink placeholder:text-mist/50"
            />
          </div>
          <button
            onClick={() => void add()}
            disabled={!content.trim() || busy}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-ember px-4 py-2 font-mono text-[11px] font-semibold tracking-[0.14em] text-black transition-all hover:brightness-110 disabled:opacity-40"
          >
            <Plus size={13} />
            {busy ? "COMMITTING…" : "COMMIT TO MEMORY"}
          </button>
          {note && <p className="mt-2 font-mono text-[11px] text-ruby">{note}</p>}
        </Panel>

        <div className="lg:col-span-2">
          <div className="input-field mb-4 flex items-center gap-2.5 px-3.5 py-2.5">
            <Search size={14} className="text-mist" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setQuery(q)}
              placeholder="Search memory by keywords… (Enter)"
              className="w-full bg-transparent font-mono text-[12.5px] text-ink placeholder:text-mist/50 focus:outline-none"
            />
          </div>
          <div className="space-y-3">
            {(list.data?.memories ?? []).length === 0 && (
              <Panel className="border-dashed">
                <div className="flex items-center gap-3 text-[13px] text-mist">
                  <MemoryStick size={15} className="text-ember" />
                  {query ? "No memories matched." : "Memory is empty — teach Kaira something, or she'll save what she learns while working."}
                </div>
              </Panel>
            )}
            {(list.data?.memories ?? []).map((m, i) => (
              <div key={m.id} className="animate-rise" style={{ animationDelay: `${i * 40}ms` }}>
                <Panel className="panel-hover">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <StatusPill tone={KIND_TONE[m.kind] ?? "mist"} label={m.kind} />
                      {m.tags.map((t) => (
                        <span key={t} className="rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-mist">
                          {t}
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-mist">{timeAgo(m.createdAt)}</span>
                      <button
                        onClick={() => void remove(m.id)}
                        className="rounded-md p-1 text-mist transition-colors hover:bg-rubydim hover:text-ruby"
                        title="Forget this"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <p className="mt-2.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink/85">{m.content}</p>
                </Panel>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
