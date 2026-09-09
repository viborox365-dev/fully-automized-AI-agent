# KAIRA

**A persistent, local-first, model-agnostic autonomous AI operator.**
Give her an objective — she plans, uses real tools, verifies her work, and
reports back. No chatbot cosplay, no paid APIs required.

> v0.1 foundation: engine, tools, persistence, verification, control plane.
> Built to grow into a multi-agent workforce — see `docs/ARCHITECTURE.md`.

## What is actually working (and tested)

- **Objective → completion loop**: plan → think/act/observe → critic
  verification → completion, persisted step-by-step in PostgreSQL and
  resumable across crashes.
- **Real tools** in a sandboxed workspace: filesystem read/write/list/search,
  shell execution (allowlisted, timed, capped), HTTP fetch, long-term memory
  (PostgreSQL).
- **Model-agnostic model layer**: Ollama (default, local) and any
  OpenAI-compatible server (LM Studio, vLLM, …). Swap in Settings — no code
  changes.
- **Autonomous worker** (`npm run worker`) that claims queued runs
  (`FOR UPDATE SKIP LOCKED`) and drives them without human clicks — plus an
  in-UI driver for environments without the worker.
- **Mission Control UI**: live execution timeline, system status (model /
  worker / DB — all real health checks), memory browser, tool bench.
- **`npm run selftest`**: end-to-end proof of the pipeline against the real
  database and filesystem using a deterministic fixture provider (prints
  PASS/FAIL; cleans up after itself).

Honesty note: model *inference* requires a running model backend (e.g. Ollama)
on your machine. The status API reports availability truthfully; without a
backend, runs pause safely instead of faking output.

## Quickstart

```bash
# 0. prerequisites: PostgreSQL running (DATABASE_URL in .env), Node 20+

# 1. install + prepare
npm install
npm run db:push            # create tables (drizzle-kit push)

# 2. bring up a local model backend (in its own terminal)
ollama serve
ollama pull llama3.1:8b    # or qwen2.5:7b, mistral, … any instruct model

# 3. verify the foundation (optional but recommended)
npm run selftest

# 4. start
npm run worker             # terminal A — the autonomous driver
npm run dev                # terminal B — Mission Control at http://localhost:3000

# 5. give Kaira her first objective in the UI, e.g.:
#    "List the files in your workspace, then write a short README describing
#     what an operator agent needs, saved as notes/operator-readme.md"
```

## Configuration (`env`, all optional)

| var                     | default                     | purpose                                   |
|-------------------------|-----------------------------|-------------------------------------------|
| `DATABASE_URL`          | (required)                  | PostgreSQL connection                      |
| `KAIRA_PROVIDER`        | `ollama`                    | `ollama` or `openai_compatible`            |
| `KAIRA_MODEL`           | auto-pick first installed   | e.g. `llama3.1:8b`                         |
| `KAIRA_MODEL_BASE_URL`  | per-provider default        | e.g. `http://localhost:1234/v1` (LM Studio)|
| `KAIRA_WORKSPACE`       | `./workspace`               | sandbox root for fs/shell tools            |
| `KAIRA_MAX_STEPS`       | `20`                        | per-run step budget                        |
| `KAIRA_MODEL_TIMEOUT_MS`| `180000`                    | local models on CPU can be slow            |
| `KAIRA_SHELL_ALLOW`     | built-in dev allowlist      | CSV of allowed shell binaries              |

Settings changed in the UI (Mission Control → MODEL BACKEND) take precedence
over env and persist in the database.

## Repository map

```
src/agent/engine.ts        the loop: tick/plan/act/verify, run lifecycle
src/agent/model/           ModelProvider interface + ollama + openai-compatible
src/agent/tools/           registry + fs/shell/http/memory tools (real)
src/agent/parse.ts         balanced-brace JSON action-envelope extraction
src/agent/prompts.ts       identity, protocol, planning, critic prompts
src/agent/workspace.ts     sandbox root + path-escape protection
src/worker/runner.ts       long-running autonomous driver
src/app/                   Mission Control UI + REST API (control plane)
scripts/selftest.ts        end-to-end pipeline proof (deterministic)
docs/ARCHITECTURE.md       the deep contract + extension roadmap
workspace/                 Kaira's sandbox (everything she creates lives here)
```
