# Kaira Autonomous Agent — Local Windows Setup Guide

This guide explains how to run the Kaira Agent Core locally on Windows with a real Ollama installation.

## Prerequisites

### 1. Install Node.js
- Download from https://nodejs.org (LTS version, e.g. v20+)
- Verify: `node --version`

### 2. Install PostgreSQL
- Download from https://www.postgresql.org/download/windows/
- During installation, note the password you set for the `postgres` user
- Verify: `psql -U postgres -c "SELECT 1"`

### 3. Install Ollama
- Download from https://ollama.com/download
- Install and verify: `ollama --version`

### 4. Pull Required Models

Open PowerShell or Command Prompt and run:

```powershell
ollama pull qwen3:8b
ollama pull qwen2.5-coder:7b
ollama pull llama3.2:3b
```

This downloads the models (several GB each — be patient). Verify they're installed:

```powershell
ollama list
```

You should see all three models listed.

### 5. Start Ollama

Ollama runs as a background service after installation. Verify it's running:

```powershell
curl http://localhost:11434/api/tags
```

If it's not running, start it manually:

```powershell
ollama serve
```

## Project Setup

### 1. Clone and Install

```powershell
git clone <your-repo-url> kaira-autonomous-agent
cd kaira-autonomous-agent\kaira-autonomous-agent-foundation (1)
npm install
```

### 2. Create the Database

```powershell
# Connect to PostgreSQL and create the database
psql -U postgres -c "CREATE DATABASE app_db;"
```

### 3. Configure Environment Variables

Create a `.env` file in the project root (`kaira-autonomous-agent-foundation (1)\.env`):

```env
# Database
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/app_db

# Model provider (default: ollama)
KAIRA_PROVIDER=ollama
KAIRA_MODEL_BASE_URL=http://localhost:11434

# Model routing (these are the defaults — only change if using different models)
KAIRA_MODEL_REASONING=qwen3:8b
KAIRA_MODEL_CODING=qwen2.5-coder:7b
KAIRA_MODEL_LIGHTWEIGHT=llama3.2:3b

# Optional: increase timeout for slow first-time model loading (ms)
KAIRA_MODEL_TIMEOUT_MS=300000
```

Replace `YOUR_PASSWORD` with your PostgreSQL password.

### 4. Push Database Schema

```powershell
npx drizzle-kit push
```

This creates all required tables in PostgreSQL.

## Verification

### Step 1: Verify Ollama Connectivity

```powershell
npx tsx scripts/test-ollama.ts
```

This test will:
1. Check that Ollama is reachable at the configured URL
2. Verify `qwen3:8b` is available and respond to a reasoning request
3. Verify `qwen2.5-coder:7b` is available and respond to a coding request
4. Verify model-not-found error handling

Expected output:
```
✔ Ollama is reachable — 3 model(s) available
✔ qwen3:8b is available
✔ reasoning response is non-empty
✔ qwen2.5-coder:7b is available
✔ coding response is non-empty
RESULT: PASS — Real Ollama integration verified.
```

### Step 2: Verify the Model Router

The model router is tested as part of `test-ollama.ts`:

```
✔ reasoning → qwen3:8b
✔ coding → qwen2.5-coder:7b
✔ lightweight → llama3.2:3b
```

### Step 3: Run the Agent Core Against Real Models

To run the Agent Core with real Ollama models (no scripted providers):

```powershell
npx tsx -e "
  import { createObjective } from './src/agent/engine';
  import { runAgentCore } from './src/agent/core';

  const { objective } = await createObjective({
    title: 'Create a Python file called calculator_test.py that adds 5 and 7 and prints the result. Execute it and verify the output is 12.',
  });

  const result = await runAgentCore(objective.id);
  console.log('Result:', result.status, result.result ?? result.error);
"
```

This will:
1. Use `qwen3:8b` to generate a structured execution plan
2. Execute the plan using real tools (create file, run Python)
3. Use `qwen2.5-coder:7b` for any code repair if needed
4. Verify the actual output
5. Report COMPLETED or FAILED

### Step 4: Run All Tests

```powershell
# Phase 1 kernel tests (uses scripted providers — no Ollama needed)
npx tsx scripts/test-kernel.ts

# Phase 2 Agent Core tests (uses scripted providers — no Ollama needed)
npx tsx scripts/test-phase2.ts

# Real Ollama provider test (requires Ollama running)
npx tsx scripts/test-ollama.ts

# Existing selftest (uses scripted providers)
npx tsx scripts/selftest.ts

# TypeScript type checking
npx tsc --noEmit
```

## How the Model Routing Works

The Agent Core uses three models for different purposes:

| Role | Model | Used For |
|------|-------|----------|
| reasoning | qwen3:8b | Planning, diagnosis, understanding |
| coding | qwen2.5-coder:7b | Code generation, repair actions |
| lightweight | llama3.2:3b | Quick tasks, simple responses |

Models are loaded on demand by Ollama — not all need to be loaded simultaneously. The first request to a model may be slow as Ollama loads it into memory.

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `KAIRA_PROVIDER` | `ollama` | Provider type: `ollama` or `openai_compatible` |
| `KAIRA_MODEL_BASE_URL` | `http://localhost:11434` | Ollama API base URL |
| `KAIRA_MODEL` | (empty) | Default model (overrides routing if set) |
| `KAIRA_MODEL_REASONING` | `qwen3:8b` | Model for reasoning/planning |
| `KAIRA_MODEL_CODING` | `qwen2.5-coder:7b` | Model for coding/repair |
| `KAIRA_MODEL_LIGHTWEIGHT` | `llama3.2:3b` | Model for lightweight tasks |
| `KAIRA_MODEL_TIMEOUT_MS` | `180000` | Per-request timeout in ms |
| `KAIRA_MAX_STEPS` | `20` | Max steps per run |
| `KAIRA_MAX_RETRIES` | `3` | Max retries per task |

### Using a Remote Ollama Instance

If Ollama is running on a different machine (e.g., a GPU server), set:

```env
KAIRA_MODEL_BASE_URL=http://192.168.1.100:11434
```

Ensure Ollama on the remote machine is configured to accept external connections (set `OLLAMA_HOST=0.0.0.0` when starting Ollama).

## Phase 3: Engineering Agent

Phase 3 adds real engineering capabilities to the Agent Core. The agent can now:

- Inspect workspace files and directory structure
- Create, modify, and delete files
- Execute commands (tests, linters, type checkers, builds)
- Detect available project tooling automatically
- Track all file changes with before/after content
- Recover from real failures (syntax errors, test failures, command failures)
- Verify outcomes against acceptance criteria

### Engineering Workspace Configuration

The engineering workspace is configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `KAIRA_WORKSPACE` | `<project>/workspace` | Root directory for all file operations |
| `KAIRA_MAX_FILE_SIZE` | `1048576` (1MB) | Max file size for read/write |
| `KAIRA_MAX_CHANGE_SIZE` | `512000` (512KB) | Max content size per write operation |
| `KAIRA_ALLOW_DELETE` | `true` | Allow file deletion (set `false` to disable) |
| `KAIRA_SHELL_ALLOW` | (built-in list) | Comma-separated list of allowed shell commands |

### Engineering Tools

| Tool | Description |
|------|-------------|
| `fs_write` | Create or modify a file (tracks before/after content) |
| `fs_read` | Read a file from the workspace |
| `fs_list` | List directory contents |
| `fs_search` | Search file contents |
| `fs_tree` | Show directory tree structure |
| `fs_exists` | Check if a file/directory exists |
| `fs_mkdir` | Create a directory |
| `fs_delete` | Delete a file (directories not allowed) |
| `detect_tooling` | Detect available test/lint/typecheck/build commands |
| `shell_exec` | Execute a command in the workspace |

### Running the Engineering Agent Locally

```powershell
# Run all Phase 3 engineering tests (uses scripted providers, no Ollama needed)
npx tsx scripts/test-phase3.ts

# Run the agent against a real engineering objective with real Ollama models
npx tsx -e "
  import { createObjective } from './src/agent/engine';
  import { runAgentCore } from './src/agent/core';

  const { objective } = await createObjective({
    title: 'Create a Python file called calc.py that adds 5 and 7 and prints the result. Execute it and verify the output is 12.',
  });

  const result = await runAgentCore(objective.id);
  console.log('Result:', result.status, result.result ?? result.error);
"
```

### Change Tracking

All file modifications are recorded in the `changes` table with:
- Operation type (create, modify, delete, mkdir)
- File path
- Before/after content
- Model responsible
- Command/test results
- Repair attempt number

If the workspace is a Git repository, Git info (branch, changed files, diff stat) is available via `getGitInfo()`. The agent does NOT auto-commit, push, or publish anything.

## Troubleshooting

### "Cannot reach Ollama" error
- Ensure Ollama is running: `ollama serve`
- Check the URL in your `.env` file
- Verify with: `curl http://localhost:11434/api/tags`

### "Model not found" error
- Pull the model: `ollama pull qwen3:8b`
- List installed models: `ollama list`

### "Request timed out" error
- First-time model loading is slow — increase timeout: `KAIRA_MODEL_TIMEOUT_MS=300000`
- Ensure you have enough RAM/VRAM for the model

### Database connection error
- Verify PostgreSQL is running
- Check your `DATABASE_URL` in `.env`
- Ensure the database exists: `psql -U postgres -c "CREATE DATABASE app_db;"`
- Push the schema: `npx drizzle-kit push`
