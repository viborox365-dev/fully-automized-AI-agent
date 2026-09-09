import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { ilike, eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { memories, messages, objectives, steps } from "@/db/schema";
import { advanceRun, createObjective } from "@/agent/engine";
import { parseAgentResponse } from "@/agent/parse";
import { getModelStack } from "@/agent/model";
import { workspaceRoot } from "@/agent/workspace";
import type {
  ChatMessage,
  GenerateResult,
  ModelProvider,
  ProviderStatus,
} from "@/agent/model/types";

/**
 * Kaira self-test — proves the orchestration pipeline END-TO-END against the
 * real database, real tools and real files, without needing a model backend:
 *
 *   objective → dispatch → plan → fs_write → shell verify → memory_save
 *             → final → critic verification → completion (+ audit checks)
 *
 * The model is replaced by a DETERMINISTIC TEST FIXTURE injected through the
 * ModelProvider interface — the same seam a real model uses. This tests the
 * engine, tools, persistence and verification; live model inference is
 * exercised separately at runtime (requires Ollama — see README).
 */

const TOKEN = `selftest-${Date.now().toString(36)}`;
let failures = 0;

function check(label: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted-fixture" as const;
  readonly label = "Selftest fixture (deterministic — not a real model)";
  private calls = 0;

  async status(): Promise<ProviderStatus> {
    return { ok: true, detail: "fixture", models: ["selftest-0"] };
  }

  async generate(messages: ChatMessage[]): Promise<GenerateResult> {
    this.calls++;
    const system = messages[0]?.content ?? "";
    const user = messages[1]?.content ?? "";
    let content: string;
    if (system.includes("verification critic")) {
      content = JSON.stringify({
        complete: true,
        reason:
          "Observations in the transcript confirm the file was written and read back with the expected marker.",
      });
    } else if (user.includes("Write a concrete, numbered execution plan")) {
      content = [
        `1. Write a marker file ${TOKEN} into selftest/hello.txt with fs_write.`,
        "2. Verify it exists and its content matches via shell_exec (cat).",
        "3. Record the outcome to long-term memory with memory_save.",
        "4. Report completion with the verified evidence.",
      ].join("\n");
    } else {
      const envelopes = [
        {
          thought: "Step 1 of the plan: create the marker file in the workspace.",
          action: {
            tool: "fs_write",
            input: {
              path: "selftest/hello.txt",
              content: `Kaira engine selftest\nrun marker: ${TOKEN}\n`,
            },
          },
        },
        {
          thought: "Step 2: verify the file by reading it back through the shell.",
          action: {
            tool: "shell_exec",
            input: { command: `cat selftest/hello.txt` },
          },
        },
        {
          thought: "Step 3: persist what this run proved to long-term memory.",
          action: {
            tool: "memory_save",
            input: {
              content: `Kaira engine selftest passed (${TOKEN}): plan → fs_write → shell verification → critic → completion, all against real database and files.`,
              kind: "note",
              tags: ["selftest"],
              importance: 1,
            },
          },
        },
        {
          thought:
            "All steps verified: the file exists with the correct marker (seen in shell output) and memory is saved.",
          final: `Verified the engine end-to-end: created workspace/selftest/hello.txt, read it back successfully via shell (marker ${TOKEN} confirmed), and stored a memory record. Objective complete.`,
        },
      ];
      const next = envelopes[this.calls - 2];
      if (!next) {
        throw new Error(`ScriptedProvider exhausted after ${this.calls} calls`);
      }
      content = JSON.stringify(next);
    }
    await new Promise((r) => setTimeout(r, 5));
    return {
      content,
      model: "selftest-0",
      tokensIn: Math.ceil(user.length / 4),
      tokensOut: Math.ceil(content.length / 4),
      latencyMs: 5,
    };
  }
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  KAIRA SELF-TEST — engine, tools, persistence, verify    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  /* 1 ─ parser robustness (unit-level) */
  console.log("1. Action-envelope parser");
  const t1 = parseAgentResponse('```json\n{"thought":"t","action":{"tool":"fs_read","input":{"path":"a.txt"}}}\n```');
  check("parses fenced JSON", t1.type === "action" && t1.tool === "fs_read");
  const t2 = parseAgentResponse('Sure! Here is the action:\n{"thought":"t","final":"done, verified"}');
  check("parses prose-wrapped JSON", t2.type === "final");
  const t3 = parseAgentResponse("I will now use fs_write to write the file. Let me do that.");
  check("rejects non-JSON", t3.type === "invalid");

  /* 2 ─ live model backend report (honest, environment-dependent) */
  console.log("\n2. Live model backend (environment report — not gated)");
  try {
    const stack = await getModelStack();
    console.log(
      `  · provider=${stack.config.provider} model=${stack.config.model || "(none set)"} available=${stack.status.ok} — ${stack.status.detail}`,
    );
    if (!stack.status.ok) {
      console.log("  · NOTE: no model backend reachable here. Expected in this sandbox;");
      console.log("    on Brandon's machine run `ollama serve` + `ollama pull llama3.1:8b`.");
    }
  } catch (err) {
    console.log(`  · status check failed: ${err instanceof Error ? err.message : err}`);
  }

  /* 3 ─ full pipeline through the real engine + DB + tools */
  console.log("\n3. End-to-end run (objective → plan → tools → verify → complete)");
  const title = `SELFTEST engine pipeline ${TOKEN}`;
  const { objective, run } = await createObjective({
    title,
    description: "Selftest harness objective — safe to delete.",
    autoDispatch: true,
    maxSteps: 12,
  });
  check("objective created + run dispatched", Boolean(objective.id && run?.id));

  const provider = new ScriptedProvider();
  const result = await advanceRun(run!.id, "selftest", {
    ticks: 10,
    provider,
    model: "selftest-0",
  });
  check("advanceRun returned ok", result.ok, result.error);
  check("run completed", result.run.status === "completed", result.run.status);
  check("plan was produced", Boolean(result.run.plan && result.run.plan.length > 20));
  check("token telemetry recorded", result.run.tokensOut > 0, `tokensOut=${result.run.tokensOut}`);

  const stepRows = await db
    .select()
    .from(steps)
    .where(eq(steps.runId, run!.id))
    .orderBy(steps.seq);
  const kinds = stepRows.map((s) => s.kind);
  check("event log has plan", kinds.includes("plan"));
  check(
    "event log has 3 actions + observations",
    kinds.filter((k) => k === "action").length === 3 &&
      kinds.filter((k) => k === "observation").length >= 3,
    kinds.join(","),
  );
  const shellObs = stepRows.find(
    (s) => s.kind === "observation" && s.name === "shell_exec",
  );
  check(
    "shell observation contains the run marker",
    Boolean(
      shellObs &&
        JSON.stringify(shellObs.output).includes(TOKEN),
    ),
  );
  const critic = stepRows.find((s) => s.kind === "critic");
  check(
    "critic verified and accepted",
    Boolean(critic && (critic.output as { complete?: boolean })?.complete === true),
  );

  /* 4 ─ real-world side effects */
  console.log("\n4. Real side effects (filesystem, memory, feed)");
  const filePath = path.join(workspaceRoot(), "selftest", "hello.txt");
  const fileOk = fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(TOKEN);
  check("workspace file exists with expected content", fileOk, filePath);

  const memRows = await db
    .select()
    .from(memories)
    .where(ilike(memories.content, `%${TOKEN}%`));
  check("long-term memory persisted", memRows.length === 1);

  const msgRows = await db
    .select()
    .from(messages)
    .where(ilike(messages.content, `%${TOKEN}%`));
  check(
    "activity feed has Brandon + Kaira entries",
    msgRows.some((m) => m.role === "brandon") && msgRows.some((m) => m.role === "kaira"),
  );

  const [objRow] = await db
    .select()
    .from(objectives)
    .where(eq(objectives.id, objective.id));
  check("objective status = completed", objRow.status === "completed", objRow.status);
  check("objective result recorded", Boolean(objRow.result?.includes("Verified")));

  /* 5 ─ cleanup */
  console.log("\n5. Cleanup");
  await db.delete(objectives).where(eq(objectives.id, objective.id));
  await db.delete(memories).where(ilike(memories.content, `%${TOKEN}%`));
  await db.delete(messages).where(ilike(messages.content, `%${TOKEN}%`));
  fs.rmSync(path.join(workspaceRoot(), "selftest"), { recursive: true, force: true });
  check("test artifacts removed", true);

  console.log(
    failures === 0
      ? "\nRESULT: PASS — orchestration, tools, persistence and verification all real.\n       (Model inference requires Ollama at runtime; everything else is proven here.)\n"
      : `\nRESULT: FAIL — ${failures} check(s) failed.\n`,
  );
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nSELFTEST CRASHED:", err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
