"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Brain,
  CircleCheckBig,
  FastForward,
  ListChecks,
  Loader2,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
  StepForward,
  TerminalSquare,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useApi, timeAgo, fmtNumber } from "@/lib/useApi";
import type { ObjectiveRow, RunRow, StepRow } from "@/lib/types";
import { Panel, SectionTitle, StatusPill, TermBlock, runTone } from "@/components/ui";

const ACTIVE = ["queued", "planning", "running", "verifying"];

/* ------------------------------ step rendering ----------------------------- */

function StepShell({
  icon: Icon,
  tone,
  title,
  step,
  Meta,
  children,
}: {
  icon: typeof Brain;
  tone: string;
  title: string;
  step: StepRow;
  Meta?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative pl-9 animate-rise" style={{ animationDelay: "40ms" }}>
      <span className={`absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-md border border-line bg-panel ${tone}`}>
        <Icon size={13} strokeWidth={2} />
      </span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[11px] font-semibold tracking-[0.1em] text-ink/90">{title}</span>
        <span className="font-mono text-[10px] text-mist/70">#{step.seq}</span>
        {step.latencyMs != null && (
          <span className="font-mono text-[10px] text-mist/70">{fmtNumber(step.latencyMs)}ms</span>
        )}
        {Meta}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

function StepItem({ step }: { step: StepRow }) {
  const out = (step.output ?? {}) as Record<string, unknown>;

  switch (step.kind) {
    case "plan":
      return (
        <StepShell icon={ListChecks} tone="text-lilac" title="PLAN · model" step={step}>
          <TermBlock tone="lilac">{String(out.plan ?? "")}</TermBlock>
        </StepShell>
      );
    case "action":
      return (
        <StepShell
          icon={step.name === "shell_exec" ? TerminalSquare : Wrench}
          tone="text-ember"
          title={step.name ?? "tool"}
          step={step}
          Meta={<span className="font-mono text-[10px] text-mist">{String(out.model ?? "")}</span>}
        >
          {Boolean(out.thought) && (
            <p className="mb-2 text-[12.5px] italic leading-relaxed text-mist">{String(out.thought)}</p>
          )}
          <TermBlock>{JSON.stringify(step.input, null, 2)}</TermBlock>
        </StepShell>
      );
    case "observation":
      return (
        <StepShell
          icon={out.ok === false ? TriangleAlert : CircleCheckBig}
          tone={out.ok === false ? "text-ruby" : "text-mint"}
          title={`OBSERVED · ${step.name ?? ""}`}
          step={step}
        >
          <TermBlock tone={out.ok === false ? "error" : "mint"}>{String(out.output ?? "")}</TermBlock>
        </StepShell>
      );
    case "error":
      return (
        <StepShell icon={TriangleAlert} tone="text-ruby" title={`ERROR · ${step.name ?? "step"}`} step={step}>
          <TermBlock tone="error">
            {`${String(out.message ?? "")}${out.feedback ? `\n\n→ ${String(out.feedback)}` : ""}`}
          </TermBlock>
        </StepShell>
      );
    case "critic":
      return (
        <StepShell
          icon={ShieldCheck}
          tone="text-lilac"
          title="VERIFICATION CRITIC"
          step={step}
          Meta={
            <StatusPill
              tone={out.complete === true ? "mint" : out.complete === false ? "ruby" : "mist"}
              label={out.complete === true ? "accepted" : out.complete === false ? "rejected" : "skipped"}
            />
          }
        >
          {Boolean(out.reason) && <p className="text-[12.5px] leading-relaxed text-mist">{String(out.reason)}</p>}
        </StepShell>
      );
    case "final":
      return (
        <StepShell icon={CircleCheckBig} tone="text-ember" title="COMPLETION REPORT · proposed" step={step}>
          {Boolean(out.thought) && <p className="mb-2 text-[12.5px] italic text-mist">{String(out.thought)}</p>}
          <div className="rounded-lg border border-ember/25 bg-emberdim/50 p-3 text-[13px] leading-relaxed text-ink">
            {String(out.final ?? "")}
          </div>
        </StepShell>
      );
    default:
      return (
        <StepShell icon={Brain} tone="text-mist" title={step.kind.toUpperCase()} step={step}>
          <p className="text-[12.5px] text-mist">{JSON.stringify(step.output)}</p>
        </StepShell>
      );
  }
}

/* ---------------------------------- page ----------------------------------- */

export default function ObjectivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const bundle = useApi<{ ok: boolean; objective: ObjectiveRow; runs: RunRow[] }>(
    `/api/objectives/${id}`,
    3000,
  );
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const runs = bundle.data?.runs ?? [];
  const runId = selectedRun && runs.some((r) => r.id === selectedRun) ? selectedRun : runs[0]?.id;

  const runDetail = useApi<{ ok: boolean; run: RunRow; steps: StepRow[] }>(
    runId ? `/api/runs/${runId}` : "/api/health",
    1400,
  );
  const run = runDetail.data?.run ?? runs[0] ?? null;
  const steps = runDetail.data?.run.id === run?.id ? runDetail.data.steps : [];
  const active = run ? ACTIVE.includes(run.status) : false;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // auto-scroll timeline to the newest step while a run is live
  useEffect(() => {
    if (active && timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [steps.length, active]);

  const act = async (kind: "dispatch" | "advance" | "loop" | "stop") => {
    if (busy) return;
    setBusy(kind);
    setNote(null);
    try {
      let res: Response;
      if (kind === "dispatch") {
        res = await fetch(`/api/objectives/${id}/dispatch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } else if (kind === "stop") {
        res = await fetch(`/api/runs/${run!.id}/stop`, { method: "POST" });
      } else {
        res = await fetch(`/api/runs/${run!.id}/advance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticks: kind === "loop" ? 25 : 1 }),
        });
      }
      const json = await res.json();
      if (!json.ok) setNote(json.error ?? "action failed");
      await Promise.all([bundle.refresh(), runDetail.refresh()]);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const objective = bundle.data?.objective;
  if (bundle.data && !objective) {
    return <p className="pt-16 text-center font-mono text-sm text-mist">objective not found</p>;
  }

  return (
    <div className="space-y-6 pt-2">
      {/* header */}
      <div className="animate-rise">
        <Link href="/" className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.14em] text-mist hover:text-ember transition-colors">
          <ArrowLeft size={12} /> MISSION CONTROL
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {objective && <StatusPill tone={runTone(run?.status ?? objective.status)} label={run?.status ?? objective.status} pulse={active} />}
              <span className="font-mono text-[10px] text-mist">opened {timeAgo(objective?.createdAt)}</span>
            </div>
            <h1 className="mt-2 max-w-3xl text-2xl font-bold leading-snug tracking-tight sm:text-3xl">
              {objective?.title ?? "…"}
            </h1>
            {objective?.description && (
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-mist">{objective.description}</p>
            )}
          </div>
          {/* controls */}
          <div className="flex flex-wrap items-center gap-2">
            {!run && (
              <Ctrl icon={Play} label="DISPATCH RUN" primary onClick={() => void act("dispatch")} busy={busy === "dispatch"} disabled={busy !== null} />
            )}
            {run && !active && (
              <Ctrl icon={RotateCcw} label="DISPATCH NEW RUN" primary onClick={() => void act("dispatch")} busy={busy === "dispatch"} disabled={busy !== null} />
            )}
            {run && active && (
              <>
                <Ctrl icon={StepForward} label="STEP" onClick={() => void act("advance")} busy={busy === "advance"} disabled={busy !== null} />
                <Ctrl icon={FastForward} label="DRIVE (×25)" primary onClick={() => void act("loop")} busy={busy === "loop"} disabled={busy !== null} />
                <Ctrl icon={Square} label="STOP" danger onClick={() => void act("stop")} busy={busy === "stop"} disabled={busy !== null} />
              </>
            )}
          </div>
        </div>
      </div>

      {note && (
        <div className="panel border-ember/30 bg-emberdim/40 p-3 font-mono text-[11.5px] text-ember animate-rise">
          {note.includes("Model call failed") || note.includes("ollama") || note.includes("reach")
            ? `MODEL OFFLINE — ${note} · start Ollama (ollama serve) or pick a provider in MODEL BACKEND, then drive again.`
            : note}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* timeline */}
        <div className="lg:col-span-2">
          <SectionTitle
            right={
              active && (
                <span className="text-shimmer font-mono text-[10.5px] tracking-[0.18em]">KAIRA IS WORKING</span>
              )
            }
          >
            EXECUTION LOG
          </SectionTitle>
          <Panel live={active} className="p-0">
            <div ref={timelineRef} className="max-h-[640px] space-y-6 overflow-y-auto p-5">
              {steps.length === 0 && (
                <div className="py-8 text-center">
                  <p className="font-mono text-[11.5px] text-mist">
                    {!run
                      ? "No run yet — dispatch one and Kaira begins with a plan."
                      : active
                        ? "Run queued — waiting for a driver (npm run worker, or use the controls above)."
                        : "Run produced no steps."}
                  </p>
                </div>
              )}
              {steps.map((s) => (
                <StepItem key={s.id} step={s} />
              ))}
              {active && steps.length > 0 && (
                <div className="flex items-center gap-2 pl-9 pt-1">
                  <Loader2 size={13} className="animate-spin-slow text-ember" />
                  <span className="font-mono text-[10.5px] tracking-[0.14em] text-mist">
                    {run?.status === "planning" ? "DRAFTING PLAN…" : run?.status === "verifying" ? "VERIFYING RESULT…" : "AWAITING NEXT TICK"}
                  </span>
                </div>
              )}
            </div>
          </Panel>
        </div>

        {/* side rail */}
        <div className="space-y-6">
          {run && (
            <Panel>
              <SectionTitle>RUN</SectionTitle>
              <dl className="space-y-2.5 font-mono text-[11.5px]">
                <Row k="model" v={run.modelId || "—"} />
                <Row k="steps" v={`${run.stepCount} / ${run.maxSteps}`} />
                <Row k="tokens" v={`${fmtNumber(run.tokensIn)} in · ${fmtNumber(run.tokensOut)} out`} />
                <Row k="driver" v={active ? run.lockOwner ?? "awaiting driver" : "—"} />
                <Row k="started" v={run.startedAt ? timeAgo(run.startedAt) : "—"} />
                <Row k="finished" v={run.finishedAt ? timeAgo(run.finishedAt) : "—"} />
              </dl>
              {run.error && (
                <div className="mt-3 rounded-lg border border-ruby/25 bg-rubydim/50 p-3 font-mono text-[11px] leading-relaxed text-ruby">
                  {run.error}
                </div>
              )}
            </Panel>
          )}

          {runs.length > 1 && (
            <Panel>
              <SectionTitle>RUN HISTORY</SectionTitle>
              <div className="space-y-2">
                {runs.map((r, i) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRun(r.id)}
                    className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 font-mono text-[11px] transition-colors ${
                      r.id === runId
                        ? "border-ember/40 bg-emberdim/40 text-ember"
                        : "border-line text-mist hover:border-linebright hover:text-ink"
                    }`}
                  >
                    <span>run {runs.length - i} · {r.status}</span>
                    <span>{timeAgo(r.createdAt)}</span>
                  </button>
                ))}
              </div>
            </Panel>
          )}

          {objective?.result && (
            <Panel>
              <SectionTitle>OUTCOME</SectionTitle>
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink/85">{objective.result}</p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-mist/70">{k}</dt>
      <dd className="truncate text-right text-ink/85">{v}</dd>
    </div>
  );
}

function Ctrl({
  icon: Icon,
  label,
  onClick,
  busy,
  disabled,
  primary = false,
  danger = false,
}: {
  icon: typeof Play;
  label: string;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-2 rounded-lg px-4 py-2 font-mono text-[11px] font-semibold tracking-[0.12em] transition-all disabled:opacity-40 ${
        primary
          ? "bg-ember text-black hover:brightness-110"
          : danger
            ? "border border-ruby/40 text-ruby hover:bg-rubydim"
            : "border border-line text-mist hover:border-linebright hover:text-ink"
      }`}
    >
      {busy ? <Loader2 size={13} className="animate-spin-slow" /> : <Icon size={13} />}
      {busy ? "WORKING" : label}
    </button>
  );
}
