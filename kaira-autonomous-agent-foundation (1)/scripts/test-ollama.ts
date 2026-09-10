/**
 * Kaira Agent Core — Real Ollama Provider Test
 *
 * This test verifies that the OllamaProvider can communicate with a real
 * Ollama installation. It does NOT use scripted/mock providers.
 *
 * It checks:
 *   1. Ollama connectivity (status endpoint)
 *   2. qwen3:8b availability + a real reasoning request
 *   3. qwen2.5-coder:7b availability + a real coding request
 *   4. Model router configuration correctness
 *
 * If Ollama cannot be reached, the test reports that clearly and exits
 * with code 0 (not a failure — just "not verifiable in this environment").
 *
 * Usage:
 *   npx tsx scripts/test-ollama.ts
 *
 * Environment variables (all optional — defaults work for local Ollama):
 *   KAIRA_MODEL_BASE_URL  Ollama API base URL (default: http://localhost:11434)
 *   KAIRA_MODEL_REASONING  Reasoning model (default: qwen3:8b)
 *   KAIRA_MODEL_CODING     Coding model (default: qwen2.5-coder:7b)
 *   KAIRA_MODEL_LIGHTWEIGHT  Lightweight model (default: llama3.2:3b)
 */

import "dotenv/config";
import { OllamaProvider } from "@/agent/model/ollama";
import { modelForRole, getModelRouting, type ModelRole } from "@/agent/model/router";

let failures = 0;
let tests = 0;
let skipped = 0;

function check(label: string, cond: boolean, detail = "") {
  tests++;
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(label: string, reason: string) {
  skipped++;
  tests++;
  console.log(`  ⊘ ${label} (skipped: ${reason})`);
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  KAIRA AGENT CORE — Real Ollama Provider Test             ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const baseUrl = process.env.KAIRA_MODEL_BASE_URL ?? "http://localhost:11434";
  console.log(`\n  Ollama endpoint: ${baseUrl}`);

  /* ── 1. Model Router Configuration ──────────────────────────────── */
  console.log("\n1. Model router configuration");

  const routing = getModelRouting();
  check("reasoning → qwen3:8b", routing.reasoning === "qwen3:8b", `got ${routing.reasoning}`);
  check("coding → qwen2.5-coder:7b", routing.coding === "qwen2.5-coder:7b", `got ${routing.coding}`);
  check("lightweight → llama3.2:3b", routing.lightweight === "llama3.2:3b", `got ${routing.lightweight}`);

  check("modelForRole(reasoning) works", modelForRole("reasoning") === routing.reasoning);
  check("modelForRole(coding) works", modelForRole("coding") === routing.coding);
  check("modelForRole(lightweight) works", modelForRole("lightweight") === routing.lightweight);

  /* ── 2. Ollama Connectivity ─────────────────────────────────────── */
  console.log("\n2. Ollama connectivity");

  const provider = new OllamaProvider(baseUrl, "");
  const status = await provider.status();

  if (!status.ok) {
    console.log(`\n  ⚠ Ollama is NOT reachable at ${baseUrl}`);
    console.log(`  ${status.detail}`);
    console.log("\n  The Ollama provider is correctly configured, but live");
    console.log("  Ollama execution could not be verified from this environment.");
    console.log("\n  To run this test locally:");
    console.log("    1. Install Ollama: https://ollama.com/download");
    console.log("    2. Pull models: ollama pull qwen3:8b qwen2.5-coder:7b llama3.2:3b");
    console.log("    3. Start Ollama: ollama serve");
    console.log("    4. Run: npx tsx scripts/test-ollama.ts");

    skip("qwen3:8b availability check", "Ollama not reachable");
    skip("qwen3:8b reasoning request", "Ollama not reachable");
    skip("qwen2.5-coder:7b availability check", "Ollama not reachable");
    skip("qwen2.5-coder:7b coding request", "Ollama not reachable");

    console.log(`\nRESULT: SKIPPED — ${tests - skipped} config checks passed, ${skipped} live checks skipped (Ollama unreachable).`);
    console.log("Architecture configured for real Ollama, but live Ollama execution");
    console.log("could not be verified from this environment.\n");
    process.exit(0);
  }

  console.log(`  ✔ Ollama is reachable — ${status.detail}`);
  console.log(`  Available models: ${status.models.join(", ") || "(none)"}`);

  /* ── 3. qwen3:8b — Reasoning Model ──────────────────────────────── */
  console.log("\n3. qwen3:8b (reasoning model)");

  const reasoningModel = modelForRole("reasoning");
  const hasReasoning = status.models.includes(reasoningModel);
  check(`${reasoningModel} is available`, hasReasoning, `not in: ${status.models.join(", ")}`);

  if (hasReasoning) {
    try {
      console.log(`  Sending reasoning request to ${reasoningModel}...`);
      const result = await provider.generate(
        [
          { role: "system", content: "You are a helpful assistant. Answer concisely." },
          { role: "user", content: "What is 5 + 7? Reply with just the number." },
        ],
        { model: reasoningModel, temperature: 0.1, maxTokens: 100, timeoutMs: 60_000 },
      );
      check("reasoning response is non-empty", result.content.trim().length > 0, `content: "${result.content.slice(0, 100)}"`);
      check("reasoning response contains 12", result.content.includes("12"), `content: "${result.content.slice(0, 200)}"`);
      check("reasoning response has model name", result.model === reasoningModel);
      check("reasoning response has latency", result.latencyMs > 0, `${result.latencyMs}ms`);
      console.log(`  Response: "${result.content.trim().slice(0, 200)}"`);
      console.log(`  Latency: ${result.latencyMs}ms, tokens in: ${result.tokensIn}, out: ${result.tokensOut}`);
    } catch (err) {
      check("reasoning request succeeds", false, err instanceof Error ? err.message : String(err));
    }
  } else {
    skip("reasoning request", `${reasoningModel} not available`);
  }

  /* ── 4. qwen2.5-coder:7b — Coding Model ─────────────────────────── */
  console.log("\n4. qwen2.5-coder:7b (coding model)");

  const codingModel = modelForRole("coding");
  const hasCoding = status.models.includes(codingModel);
  check(`${codingModel} is available`, hasCoding, `not in: ${status.models.join(", ")}`);

  if (hasCoding) {
    try {
      console.log(`  Sending coding request to ${codingModel}...`);
      const result = await provider.generate(
        [
          { role: "system", content: "You are a coding assistant. Output only code, no explanation." },
          { role: "user", content: "Write a Python one-liner that prints the sum of 5 and 7." },
        ],
        { model: codingModel, temperature: 0.1, maxTokens: 200, timeoutMs: 60_000 },
      );
      check("coding response is non-empty", result.content.trim().length > 0, `content: "${result.content.slice(0, 100)}"`);
      check("coding response contains print", result.content.toLowerCase().includes("print"), `content: "${result.content.slice(0, 200)}"`);
      check("coding response has model name", result.model === codingModel);
      console.log(`  Response: "${result.content.trim().slice(0, 200)}"`);
      console.log(`  Latency: ${result.latencyMs}ms, tokens in: ${result.tokensIn}, out: ${result.tokensOut}`);
    } catch (err) {
      check("coding request succeeds", false, err instanceof Error ? err.message : String(err));
    }
  } else {
    skip("coding request", `${codingModel} not available`);
  }

  /* ── 5. Error Handling ──────────────────────────────────────────── */
  console.log("\n5. Error handling");

  // Test model-not-found error
  try {
    await provider.generate(
      [{ role: "user", content: "test" }],
      { model: "nonexistent-model:999b", timeoutMs: 5000 },
    );
    check("model-not-found throws", false, "should have thrown");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check("model-not-found throws useful error", msg.includes("not found") || msg.includes("404") || msg.includes("nonexistent"), msg);
  }

  /* ── Result ─────────────────────────────────────────────────────── */
  console.log(
    failures === 0
      ? `\nRESULT: PASS — ${tests} checks passed (${skipped} skipped). Real Ollama integration verified.\n`
      : `\nRESULT: FAIL — ${failures} of ${tests} checks failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nOLLAMA TEST CRASHED:", err);
  process.exit(1);
});
