"use client";

import type { ReactNode } from "react";

/** Colored status pill with optional pulsing dot. */
export function StatusPill({
  tone,
  label,
  pulse = false,
}: {
  tone: "mint" | "ruby" | "ember" | "lilac" | "mist";
  label: string;
  pulse?: boolean;
}) {
  const tones: Record<string, string> = {
    mint: "text-mint bg-mintdim border-mint/25",
    ruby: "text-ruby bg-rubydim border-ruby/25",
    ember: "text-ember bg-emberdim border-ember/25",
    lilac: "text-lilac bg-lilacdim border-lilac/25",
    mist: "text-mist bg-white/[0.04] border-line",
  };
  const dot: Record<string, string> = {
    mint: "text-mint",
    ruby: "text-ruby",
    ember: "text-ember",
    lilac: "text-lilac",
    mist: "text-mist",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.12em] uppercase ${tones[tone]}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${dot[tone]} ${
          pulse ? "animate-pulse-dot" : ""
        }`}
      />
      {label}
    </span>
  );
}

export function runTone(status: string): "mint" | "ruby" | "ember" | "lilac" | "mist" {
  switch (status) {
    case "completed":
      return "mint";
    case "failed":
      return "ruby";
    case "running":
    case "verifying":
    case "active":
      return "ember";
    case "planning":
    case "queued":
    case "pending":
      return "lilac";
    default:
      return "mist";
  }
}

export function SectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="font-mono text-[11px] font-medium tracking-[0.28em] text-mist">
        {children}
      </h2>
      {right}
    </div>
  );
}

/** Terminal-style block showing tool observations. */
export function TermBlock({
  children,
  tone = "default",
  maxH = true,
}: {
  children: string;
  tone?: "default" | "error" | "mint" | "lilac";
  maxH?: boolean;
}) {
  const tones: Record<string, string> = {
    default: "border-line text-mist",
    error: "border-ruby/30 text-ruby",
    mint: "border-mint/25 text-mint",
    lilac: "border-lilac/25 text-lilac",
  };
  return (
    <pre
      className={`mono-block overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-black/40 p-3 ${tones[tone]} ${
        maxH ? "max-h-72 overflow-y-auto" : ""
      }`}
    >
      {children}
    </pre>
  );
}

export function Panel({
  children,
  className = "",
  live = false,
}: {
  children: ReactNode;
  className?: string;
  live?: boolean;
}) {
  return (
    <div className={`panel p-5 ${live ? "edge-live" : ""} ${className}`}>
      {children}
    </div>
  );
}
