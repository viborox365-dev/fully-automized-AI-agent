"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tiny polling fetch hook. Polls on an interval while the tab is visible,
 * exposes a manual refresh, and never throws — `data` is null until the
 * first successful response.
 */
export function useApi<T>(path: string, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(path, { cache: "no-store" });
      const json = (await res.json()) as T;
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [path]);

  useEffect(() => {
    void refresh();
    const start = () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(() => {
        if (document.visibilityState === "visible") void refresh();
      }, intervalMs);
    };
    start();
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        start();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer.current) clearInterval(timer.current);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtNumber(n: number): string {
  return n.toLocaleString("en-US");
}
