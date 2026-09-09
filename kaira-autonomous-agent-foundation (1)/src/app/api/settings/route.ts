import { z } from "zod";
import {
  getProvider,
  resolveModelConfig,
  saveModelConfig,
  type ModelConfig,
} from "@/agent/model";

export const dynamic = "force-dynamic";

/** Effective model configuration (API key never leaves the server). */
export async function GET() {
  const cfg = await resolveModelConfig();
  return Response.json({
    ok: true,
    settings: {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      hasApiKey: Boolean(cfg.apiKey),
    },
  });
}

const schema = z.object({
  provider: z.enum(["ollama", "openai_compatible"]),
  model: z.string().max(200).optional(),
  baseUrl: z.string().max(300).optional(),
  apiKey: z.string().max(500).optional(),
  testOnly: z.boolean().optional(),
});

/**
 * Save model settings, or live-test a candidate configuration
 * without persisting (testOnly: true).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const current = await resolveModelConfig();
  const next: ModelConfig = {
    provider: parsed.data.provider,
    model: parsed.data.model?.trim() ?? current.model,
    baseUrl: parsed.data.baseUrl?.trim() || current.baseUrl,
    apiKey:
      parsed.data.apiKey === undefined || parsed.data.apiKey === ""
        ? parsed.data.apiKey === ""
          ? undefined
          : current.apiKey
        : parsed.data.apiKey,
  };
  const provider = getProvider(next);
  const status = await provider.status();
  if (!parsed.data.testOnly) {
    await saveModelConfig(next);
  }
  return Response.json({
    ok: true,
    saved: !parsed.data.testOnly,
    status,
    settings: {
      provider: next.provider,
      model: next.model,
      baseUrl: next.baseUrl,
      hasApiKey: Boolean(next.apiKey),
    },
  });
}
