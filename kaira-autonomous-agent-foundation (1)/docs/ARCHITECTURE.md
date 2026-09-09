# Kaira — Architecture (v0.1 foundation)

Kaira is a **persistent, local-first, model-agnostic autonomous AI operator**.
This document is the contract for how the foundation works and how it grows.

## Design commitments (non-negotiable)

1. **Real work or honest failure.** No simulated capabilities. Every tool
   executes for real; every claim in the UI is backed by a database row or a
   live health check. If the model backend is unreachable, the system says so
   and pauses safely — it never pretends to think.
2. **Model-agnostic.** The engine only sees the `ModelProvider` interface.
   Swapping models/providers requires zero engine changes.
3. **Local-first.** Default stack runs fully offline: Ollama + PostgreSQL +
   the workspace sandbox. No paid API is required.
4. **Persistence over process.** All state lives in PostgreSQL. Processes
   (web server, workers) are disposable and resumable.
5. **Modular growth.** New capabilities = new tool registrations or new
   providers, never engine rewrites.

## System layers

```
┌─────────────────────────────────────────────────────────────┐
│  CONTROL PLANE (Next.js)                                    │
│  Mission Control UI · Tool Bench · Memory · Settings        │
│  REST API: objectives / runs / tools / memories / settings  │
└──────────────┬──────────────────────────────┬───────────────┘
               │ drives (API-in-process)      │ manages
┌──────────────▼──────────────────────────────▼───────────────┐
│  ENGINE  (src/agent/engine.ts)                              │
│  plan → [think → act → observe]* → critic verify → done     │
│  strict JSON action-envelope (ReAct) · parse-fail feedback  │
│  run lock lease (2 min) · step budgets · infra-fail pause   │
└───────┬──────────────────────────┬──────────────────────────┘
        │ ModelProvider            │ ToolRegistry
┌───────▼────────┐        ┌────────▼─────────────────────────┐
│ MODEL LAYER     │        │ TOOLS (real, validated, sandboxed)│
│ ollama          │        │ fs_* · shell_exec · http_fetch    │
│ openai-compat   │        │ memory_save / memory_search       │
│ + your adapter  │        │ + registerTool(...) = new ability │
└─────────────────┘        └────────┬──────────────────────────┘
                                    │
┌───────────────────────────────────▼──────────────────────────┐
│ POSTGRESQL — the single source of truth                      │
│ objectives · runs · steps (append-only event log)            │
│ memories · messages · kv (settings, worker heartbeat)        │
└──────────────────────────────────────────────────────────────┘

DRIVERS (either, both, or many — same engine):
  · worker:  `npm run worker`   claims runs FOR UPDATE SKIP LOCKED
  · API:     POST /api/runs/:id/advance {ticks}  (in-app driving)
```

## Execution semantics

- **Objective** — a goal from Brandon. Lifecycle:
  `pending → active → (completed | failed) | paused | archived`.
- **Run** — one execution attempt. Lifecycle:
  `queued → planning → running → verifying → (completed | failed) | stopped`.
- **Step** — immutable event in the run's log (`plan`, `action`,
  `observation`, `critic`, `final`, `error`). The timeline UI is a direct
  rendering of this log — nothing is hidden.
- **Driver lock** — a run can only be driven by one process at a time
  (`locked_at` + `lock_owner`, 2-minute lease, renewed per tick). If a driver
  dies mid-run, the lease expires and another picks the run up **exactly
  where it stopped**, because every step is already in Postgres.
- **Step budget** — `max_steps` (default 20) prevents unbounded loops.
  Exhaustion fails the run with an explicit reason.
- **Infra failure ≠ agent failure.** A model transport error pauses the run
  (recorded as an `error` step + `runs.error`) without burning the step
  budget incorrectly; the run resumes when the backend returns.

## Model layer (`src/agent/model/`)

```ts
interface ModelProvider {
  id: string; label: string;
  status(): Promise<ProviderStatus>;            // live health + model list
  generate(messages, opts): Promise<GenerateResult>; // content + tokens + latency
}
```

Ships with:
- **OllamaProvider** — default; talks to `http://localhost:11434` (`/api/chat`,
  non-streaming; real token counts from `eval_count`).
- **OpenAICompatibleProvider** — LM Studio, llama.cpp server, vLLM, Ollama
  compat shim, OpenRouter… anything exposing `/v1/chat/completions`.

Configuration resolution: **Settings UI (kv table) → env (`KAIRA_PROVIDER`,
`KAIRA_MODEL`, `KAIRA_MODEL_BASE_URL`) → defaults**. Adding a provider =
one class + one switch case.

**Prompt protocol.** Local models are unreliable at vendor-specific tool-call
APIs, so the engine uses a strict single-JSON-object envelope
(`{thought, action:{tool,input}}` or `{thought, final}`), with
balanced-brace extraction (`src/agent/parse.ts`) and corrective feedback on
parse failure (3 consecutive failures → honest run failure). When a future
model does native tool calling reliably, add a provider capability flag and
an adapter — the engine contract already supports it.

**Verification.** When the model proposes `final`, a **critic pass** (separate
prompt, low temperature) reviews the transcript and returns
`{complete, reason}`. Rejection feeds back into the loop; acceptance closes
the run. Nothing completes unverified unless the critic itself fails to
respond — and that is recorded in the log explicitly.

## Tool layer (`src/agent/tools/`)

Every tool: zod-validated input, JSON-schema advertisement, real execution,
`ToolResult {ok, output, data}`. Execution never throws through the boundary.

| tool         | what it really does                                              |
|--------------|------------------------------------------------------------------|
| `fs_write`   | writes files under the workspace (path-escape proofed)           |
| `fs_read`    | reads with offset/limit, truncation notices                       |
| `fs_list`    | directory listing (depth-capped, skips node_modules/.git)         |
| `fs_search`  | regex content search with caps                                    |
| `shell_exec` | allowlisted binaries (env-configurable), cwd=workspace, scrubbed env, ≤120s timeout, 20k output cap |
| `http_fetch` | real HTTP GET, size cap, HTML→text                                |
| `memory_save` / `memory_search` | durable Postgres memory (keyword retrieval; embedding column reserved) |

**Sandbox boundary:** `workspace/` inside the project (override
`KAIRA_WORKSPACE`). `resolveInWorkspace` refuses path escapes. Shell is for
trusted local operation under Brandon (this is his machine and his agent);
hardening (containers, seccomp) is roadmap, documented below.

## Testing honestly (`npm run selftest`)

`scripts/selftest.ts` injects a **deterministic scripted provider through the
exact ModelProvider seam** and drives a full run against the real Postgres,
real filesystem tools and real shell. It asserts: plan produced, 3 tool
actions + observations, tool evidence on disk, critic acceptance, memory
persisted, objective completed with result, activity feed written, token
telemetry non-zero. It then cleans up every artifact. Live model inference is
deliberately NOT part of the test — it depends on a local model being
installed, which the status API verifies at runtime instead.

## Extension roadmap (fits without rewrites)

1. **Sub-agents / workforce** — the worker already claims via SKIP LOCKED;
   N workers with distinct `owner` ids = N parallel operators. Add a
   `delegation` tool that creates child objectives; the parent run tracks them.
2. **Vector memory** — add `pgvector` + a local embedding model through
   Ollama; retrieval function swaps, table already reserved.
3. **Scheduler** — cron-like dispatcher writing runs into the same queue.
4. **Native tool-calling adapters** — provider capability flag, envelope
   translation at the model layer.
5. **Shell hardening** — per-run container or seatbelt profile behind the
   existing `shell_exec` boundary.
6. **Streaming UI** — SSE broadcast of `steps` inserts; tables already append-only.
