# Base44 Dev Environment — Kaira

## What this is
Kaira is a Next.js 16 + PostgreSQL (Drizzle ORM) autonomous AI operator app.
The app code lives in the subdirectory `kaira-autonomous-agent-foundation (1)/`.

## How it runs (docker-compose.base44.yml)
- **postgres**: PostgreSQL 16 with db `app_db`, user/password `postgres`.
- **web**: Node 22, bind-mounts the project subdirectory, runs `npm install &&
  npx drizzle-kit push && npm run dev` on port 3000. Uses named volumes for
  `node_modules` and `.next` so they persist across restarts.

## Key details
- `drizzle.config.ts` reads `DATABASE_URL` from env (falls back to
  `127.0.0.1:5432/app_db` for local dev). In compose it points to the
  `postgres` service.
- `next.config.ts` sets `allowedDevOrigins` from `BASE44_PUBLIC_HOST_SUFFIX`
  so the preview origin can access dev assets/HMR.
- The model backend (Ollama) is **optional**. Without it, the status API
  truthfully reports it as unavailable and runs pause safely. No external
  credentials are required to boot the app.
- The worker (`npm run worker`) is a separate process not started by compose;
  the UI's in-app driver can advance runs without it.

## Verify it works
- `curl localhost:3000/api/status` → `{"ok": true, "db": {"ok": true}, ...}`
- `curl localhost:3000/api/health` → `{"ok": true}`
- Mission Control UI renders at `/` with nav to Memory and Tool Bench.
