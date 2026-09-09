"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Brain,
  ChevronRight,
  Cpu,
  Database,
  FolderGit2,
  Loader2,
  Radio,
  SendHorizontal,
  Terminal,
  Zap,
} from "lucide-react";
import { useApi, timeAgo, fmtNumber } from "@/lib/useApi";
import type {
  MessageRow,
  ObjectiveRow,
  StatusResponse,
} from "@/lib/types";
import { Panel, SectionTitle, StatusPill, runTone } from "@/components/ui";

/* ------------------------------- primitives ------------------------------- */

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: typeof Brain;
  label: string;
  value: string;
  sub: string;
  tone: "mint" | "ruby" | "ember" | "mist";
}) {
  const dot = { mint: "text-mint", ruby: "text-ruby", ember: "text-ember", mist: "text-mist" }[tone];
  return (
    <Panel className="panel-hover">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-[0.24em] text-mist">{label}</span>
        <Icon size={15} className="text-mist" strokeWidth={1.8} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full bg-current animate-pulse-dot ${dot}`} />
        <span className="text-xl font-semibold tracking-tight">{value}</span>
      </div>
      <p className="mt-1 truncate font-mono text-[11px] text-mist">{sub}</p>
    </Panel>
  );
}

function ObjectiveCard({ o, index }: { o: ObjectiveRow; index: number }) {
  const run = o.latestRun ?? null;
  const isLive = run && ["queued", "planning", "running", "verifying"].includes(run.status);
  const pct = run ? Math.min(100, Math.round((run.stepCount / Math.max(1, run.maxSteps)) * 100)) : 0;
  return (
    <Link
      href={`/objectives/${o.id}`}
      className={`panel panel-hover group block p-4 ${isLive ? "edge-live" : ""}`}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusPill tone={runTone(run?.status ?? o.status)} label={run?.status ?? o.status} pulse={Boolean(isLive)} />
            <span className="font-mono text-[10px] text-mist">{timeAgo(o.createdAt)}</span>
          </div>
          <h3 className="mt-2 truncate text-[15px] font-medium text-ink group-hover:text-ember transition-colors">
            {o.title}
          </h3>
        </div>
        <ChevronRight size={16} className="mt-1 shrink-0 text-mist group-hover:text-ember group-hover:translate-x-0.5 transition-all" />
      </div>
      {run && (
        <div className="mt-3">
          <div className="flex items-center justify-between font-mono text-[10px] text-mist">
            <span>{run.modelId || "model — pending"}</span>
            <span>
              steps {run.stepCount}/{run.maxSteps}
              {run.tokensOut > 0 && ` · ${fmtNumber(run.tokensOut)} tok`}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`h-full rounded-full transition-all duration-700 ${
                run.status === "completed" ? "bg-mint" : run.status === "failed" ? "bg-ruby" : "bg-ember"
              }`}
              style={{ width: `${run.status === "completed" ? 100 : Math.max(4, pct)}%` }}
            />
          </div>
        </div>
      )}
    </Link>
  );
}

function ActivityItem({ m }: { m: MessageRow }) {
  const isBrandon = m.role === "brandon";
  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="flex items-center justify-between">
        <span
          className={`font-mono text-[10px] tracking-[0.2em] ${
            isBrandon ? "text-lilac" : m.role === "kaira" ? "text-ember" : "text-mist"
          }`}
        >
          {isBrandon ? "CEO · BRANDON" : m.role === "kaira" ? "KAIRA" : "SYSTEM"}
        </span>
        <span className="font-mono text-[10px] text-mist">{timeAgo(m.createdAt)}</span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink/85 line-clamp-4">
        {m.content}
      </p>
    </div>
  );
}

/* ------------------------------ model settings ----------------------------- */

function ModelSettings({ status, onSaved }: { status: StatusResponse | null; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("ollama");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (status && open) {
      setProvider(status.model.provider ?? "ollama");
      setModel(status.model.model ?? "");
      setBaseUrl(status.model.baseUrl ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (testOnly: boolean) => {
    setBusy(testOnly ? "test" : "save");
    setNote(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, baseUrl, testOnly }),
      });
      const json = await res.json();
      setNote(json.status?.ok ? `✓ reachable — ${json.status.detail}` : `✗ ${json.status?.detail ?? "unreachable"}${testOnly ? "" : " (saved anyway)"}`);
      if (!testOnly) onSaved();
    } catch (err) {
      setNote(`✗ ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between">
        <span className="font-mono text-[11px] tracking-[0.28em] text-mist">MODEL BACKEND</span>
        <ChevronRight size={14} className={`text-mist transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {!open && status && (
        <p className="mt-2 font-mono text-[11px] text-mist">
          {status.model.provider} · {status.model.model || "no model selected"}
        </p>
      )}
      {open && (
        <div className="mt-4 space-y-3">
          <div>
            <label className="font-mono text-[10px] tracking-[0.16em] text-mist">PROVIDER</label>
            <select
              value={provider}
              onChange={(e) => {
                const p = e.target.value;
                setProvider(p);
                setBaseUrl(p === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1");
              }}
              className="input-field mt-1 w-full px-3 py-2 text-sm text-ink"
            >
              <option value="ollama">Ollama — local models (default)</option>
              <option value="openai_compatible">OpenAI-compatible endpoint (LM Studio / vLLM / …)</option>
            </select>
          </div>
          <div>
            <label className="font-mono text-[10px] tracking-[0.16em] text-mist">MODEL</label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={provider === "ollama" ? "llama3.1:8b" : "model-id from /models"}
              className="input-field mt-1 w-full px-3 py-2 font-mono text-sm text-ink placeholder:text-mist/50"
            />
          </div>
          <div>
            <label className="font-mono text-[10px] tracking-[0.16em] text-mist">BASE URL</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="input-field mt-1 w-full px-3 py-2 font-mono text-sm text-ink"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => submit(true)}
              disabled={busy !== null}
              className="flex-1 rounded-lg border border-line px-3 py-2 font-mono text-[11px] tracking-[0.12em] text-mist hover:text-ink hover:border-linebright transition-colors disabled:opacity-50"
            >
              {busy === "test" ? "TESTING…" : "TEST CONNECTION"}
            </button>
            <button
              onClick={() => submit(false)}
              disabled={busy !== null}
              className="flex-1 rounded-lg bg-ember px-3 py-2 font-mono text-[11px] font-medium tracking-[0.12em] text-black hover:brightness-110 transition-all disabled:opacity-50"
            >
              {busy === "save" ? "SAVING…" : "SAVE"}
            </button>
          </div>
          {note && <p className="font-mono text-[11px] text-mist">{note}</p>}
        </div>
      )}
    </Panel>
  );
}

/* --------------------------------- composer -------------------------------- */

function Composer({ modelOnline }: { modelOnline: boolean }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/objectives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim(), autoDispatch: true }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "failed");
      router.push(`/objectives/${json.objective.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Panel className="relative overflow-hidden">
      <SectionTitle>GIVE KAIRA AN OBJECTIVE</SectionTitle>
      <div className="input-field flex items-start gap-3 p-4">
        <Zap size={16} className="mt-1 shrink-0 text-ember" strokeWidth={2.2} />
        <div className="flex-1">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void submit()}
            placeholder="e.g. Research the best local vector database options and write a comparison into research/vectordb.md"
            className="w-full bg-transparent text-[15px] text-ink placeholder:text-mist/60 focus:outline-none"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional details, constraints, definition of done…"
            rows={2}
            className="mt-2 w-full resize-none bg-transparent text-[13px] text-mist placeholder:text-mist/40 focus:outline-none"
          />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <p className="font-mono text-[10.5px] text-mist">
          {modelOnline
            ? "Dispatches immediately — Kaira plans, acts and verifies herself."
            : "Will queue and start once the model backend is online."}
        </p>
        <button
          onClick={() => void submit()}
          disabled={!title.trim() || busy}
          className="flex items-center gap-2 rounded-lg bg-ember px-4 py-2 font-mono text-[11px] font-semibold tracking-[0.14em] text-black transition-all hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
        >
          {busy ? <Loader2 size={13} className="animate-spin-slow" /> : <SendHorizontal size={13} />}
          {busy ? "DISPATCHING" : "DISPATCH"}
        </button>
      </div>
      {error && <p className="mt-2 font-mono text-[11px] text-ruby">{error}</p>}
    </Panel>
  );
}

/* ---------------------------------- page ----------------------------------- */

export default function MissionControl() {
  const status = useApi<StatusResponse>("/api/status", 5000);
  const objectives = useApi<{ ok: boolean; objectives: ObjectiveRow[] }>("/api/objectives", 4000);
  const activity = useApi<{ ok: boolean; messages: MessageRow[] }>("/api/activity", 6000);
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-GB", { hour12: false }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const s = status.data;
  const modelOnline = Boolean(s?.model.available);
  const objs = objectives.data?.objectives ?? [];
  const liveRuns = s ? Object.entries(s.counts.runs).filter(([k]) => ["queued", "planning", "running", "verifying"].includes(k)).reduce((n, [, v]) => n + v, 0) : 0;

  return (
    <div className="space-y-8">
      {/* hero strip */}
      <div className="flex flex-wrap items-end justify-between gap-4 pt-4 animate-rise">
        <div>
          <p className="font-mono text-[10.5px] tracking-[0.34em] text-ember">PERSISTENT AGENT SYSTEM · v{s?.agent.version ?? "0.1.0"}</p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight sm:text-5xl">
            Mission Control
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-mist">
            Kaira receives objectives, plans, performs real work with tools,
            verifies results, and remembers — locally, with replaceable open models.
          </p>
        </div>
        <div className="flex items-center gap-5 font-mono text-[11px] text-mist">
          <span className="flex items-center gap-2">
            <Radio size={12} className={s?.worker.online ? "text-mint" : "text-mist"} />
            {s?.worker.online ? "worker live" : "worker idle"}
          </span>
          <span className="tabular-nums text-ink/70">{clock}</span>
        </div>
      </div>

      {/* offline / onboarding banners — honest system state */}
      {s && !modelOnline && (
        <div className="panel border-ember/30 bg-emberdim/40 p-4 animate-rise">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-ember" />
            <div className="text-[13px] leading-relaxed">
              <p className="font-medium text-ember">Model backend offline</p>
              <p className="mt-1 text-mist">
                {s.model.detail || "No provider responded."} Runs pause safely and resume automatically once a model answers.
                Local-first default:
              </p>
              <div className="mono-block mt-2 rounded-lg border border-line bg-black/50 p-3 text-ink/90">
                <div># terminal 1 — model (pick one)</div>
                <div>ollama serve && ollama pull llama3.1:8b</div>
                <div># terminal 2 — autonomous driver</div>
                <div>npm run worker</div>
              </div>
              <p className="mt-2 text-mist">
                No Ollama? Any OpenAI-compatible server works — configure it in MODEL BACKEND on the right.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* system strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Brain}
          label="MODEL"
          value={s ? (modelOnline ? "ONLINE" : "OFFLINE") : "…"}
          sub={s ? `${s.model.provider} · ${s.model.model || s.model.detail}` : "probing…"}
          tone={s ? (modelOnline ? "mint" : "ruby") : "mist"}
        />
        <StatCard
          icon={Cpu}
          label="WORKER"
          value={s ? (s.worker.online ? "LIVE" : "IDLE") : "…"}
          sub={s?.worker.online ? `${s.worker.owner ?? "worker"} · seen ${timeAgo(s.worker.lastSeenAt)}` : "npm run worker — or drive runs from the UI"}
          tone={s ? (s.worker.online ? "mint" : "mist") : "mist"}
        />
        <StatCard
          icon={Activity}
          label="ACTIVE RUNS"
          value={String(liveRuns)}
          sub={`${s?.counts.objectives.active ?? 0} active objective(s) · ${s?.counts.runs.completed ?? 0} completed runs`}
          tone={liveRuns > 0 ? "ember" : "mist"}
        />
        <StatCard
          icon={Database}
          label="STATE"
          value={s?.db.ok ? "PERSISTENT" : "DOWN"}
          sub={s ? `pgsql · workspace ${s.workspace.root.split("/").slice(-2).join("/")}` : "…"}
          tone={s?.db.ok ? "mint" : "ruby"}
        />
      </div>

      {/* main grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Composer modelOnline={modelOnline} />

          <div>
            <SectionTitle
              right={<span className="font-mono text-[10px] text-mist">{objs.length} TOTAL</span>}
            >
              OBJECTIVES
            </SectionTitle>
            {objs.length === 0 ? (
              <Panel className="border-dashed">
                <div className="flex items-start gap-3">
                  <FolderGit2 size={16} className="mt-0.5 text-ember" />
                  <div className="text-[13px] leading-relaxed text-mist">
                    <p className="font-medium text-ink">No objectives yet — the system is ready.</p>
                    <p className="mt-1">
                      Bring the model online (<span className="font-mono text-ember">ollama pull llama3.1:8b</span>),
                      start the worker (<span className="font-mono text-ember">npm run worker</span>), then dispatch an
                      objective above. Kaira will plan, execute and verify without further input.
                    </p>
                    <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-mist/70">
                      <Terminal size={11} /> proof: npm run selftest — full pipeline against the real database
                    </p>
                  </div>
                </div>
              </Panel>
            ) : (
              <div className="space-y-3">
                {objs.map((o, i) => (
                  <ObjectiveCard key={o.id} o={o} index={i} />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <ModelSettings status={s ?? null} onSaved={() => void status.refresh()} />
          <Panel>
            <SectionTitle>ACTIVITY</SectionTitle>
            <div className="max-h-[420px] overflow-y-auto pr-1">
              {(activity.data?.messages ?? []).length === 0 ? (
                <p className="text-[12.5px] text-mist">
                  The Brandon ⇄ Kaira feed appears here — objectives, completions, failures.
                </p>
              ) : (
                (activity.data?.messages ?? []).map((m) => <ActivityItem key={m.id} m={m} />)
              )}
            </div>
            {objs.length > 0 && (
              <Link
                href={`/objectives/${objs[0].id}`}
                className="mt-3 flex items-center justify-center gap-1.5 rounded-lg border border-line py-2 font-mono text-[10.5px] tracking-[0.14em] text-mist hover:text-ember hover:border-ember/40 transition-colors"
              >
                OPEN LATEST OBJECTIVE <ArrowRight size={11} />
              </Link>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
