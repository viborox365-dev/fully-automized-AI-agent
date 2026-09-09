/**
 * Per-process guard preventing two API requests from driving the same run
 * concurrently. Cross-process safety comes from the run lock in Postgres;
 * this covers in-flight requests within this server process.
 */
const globalForRuns = globalThis as typeof globalThis & {
  __kairaInFlightRuns?: Set<string>;
};

const inFlight = (globalForRuns.__kairaInFlightRuns ??= new Set<string>());

export function tryAcquireRunApi(runId: string): boolean {
  if (inFlight.has(runId)) return false;
  inFlight.add(runId);
  return true;
}

export function releaseRunApi(runId: string): void {
  inFlight.delete(runId);
}
