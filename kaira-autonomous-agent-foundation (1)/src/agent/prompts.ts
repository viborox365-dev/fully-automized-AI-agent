import type { ChatMessage } from "./model/types";
import type { Objective, Step } from "@/db/schema";

/**
 * Prompt architecture for Kaira.
 *
 * The engine drives a ReAct-style loop with a strict JSON action envelope,
 * because small local models follow an explicit single-object protocol far
 * more reliably than free-form tool calling. Prompts are pure functions —
 * easy to experiment with as models improve.
 */

export const KAIRA_IDENTITY = `You are Kaira, a persistent autonomous AI operator created and directed by your CEO, Brandon.
You receive objectives and accomplish them yourself: you plan, use tools to do real work in a sandboxed workspace, observe the real results, fix your own mistakes, and verify outcomes before reporting completion.
Honesty is a core directive: never claim a result you have not actually observed through a tool. If something fails, analyze why and try a different approach.`;

export function toolsSystemPrompt(toolsSection: string): string {
  return `${KAIRA_IDENTITY}

ACTION PROTOCOL — follow it exactly:
Respond with EXACTLY ONE JSON object and nothing else. No prose, no markdown, no code fences.

To call a tool:
{"thought":"<brief reasoning>","action":{"tool":"<tool name>","input":{...arguments...}}}

To finish the objective (only when it is genuinely accomplished and you have verified results):
{"thought":"<brief reasoning>","final":"<concise report to Brandon: what was done, what was verified, where outputs live>"}

Rules:
1. Never write anything outside the JSON object.
2. Use ONE tool per response, then wait for the observation.
3. Ground every claim in observations. Do not fabricate file contents, outputs, or results.
4. If a tool call fails, read the error, adjust, and retry with corrected input.
5. Prefer checking the workspace before writing files (avoid clobbering).

AVAILABLE TOOLS:
${toolsSection}`;
}

export function understandMessages(params: {
  objective: Objective;
  toolsSection: string;
  memories: string[];
}): ChatMessage[] {
  const { objective, toolsSection, memories } = params;
  const memoryBlock = memories.length
    ? `\nRelevant long-term memories:\n${memories.map((m) => `- ${m}`).join("\n")}`
    : "";
  return [
    {
      role: "system",
      content: `${KAIRA_IDENTITY}\n\nYou are in the UNDERSTANDING phase. Analyze the objective and describe what needs to be done, what tools you will need, and what a successful outcome looks like. Be concise (3–5 sentences). No tool calls yet.`,
    },
    {
      role: "user",
      content: `Objective from Brandon: ${objective.title}${objective.description ? `\nDetails: ${objective.description}` : ""}${memoryBlock}\n\nAvailable tools:\n${toolsSection}\n\nAnalyze this objective. What does accomplishing it require? What tools will you use? What does success look like? Be concise.`,
    },
  ];
}

export function planningMessages(params: {
  objective: Objective;
  toolsSection: string;
  memories: string[];
}): ChatMessage[] {
  const { objective, toolsSection, memories } = params;
  const memoryBlock = memories.length
    ? `\nRelevant long-term memories:\n${memories.map((m) => `- ${m}`).join("\n")}`
    : "";
  return [
    {
      role: "system",
      content: `${KAIRA_IDENTITY}\n\nYou are in the PLANNING phase. Produce a plan only — no tool calls yet.\nYour tools for execution will be:\n${toolsSection}`,
    },
    {
      role: "user",
      content: `Objective from Brandon: ${objective.title}${objective.description ? `\nDetails: ${objective.description}` : ""}${memoryBlock}

Write a concrete, numbered execution plan (3–8 steps). Each step must be achievable with the available tools. Include how you will VERIFY the objective is accomplished before finishing. Output the plan as plain numbered lines, nothing else.`,
    },
  ];
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s;
}

/** Render the run's event log into a compact transcript for the model. */
export function renderTranscript(steps: Step[], perObservationCap = 1500): string {
  if (steps.length === 0) return "(no steps taken yet)";
  const lines: string[] = [];
  for (const s of steps) {
    const out = (s.output ?? {}) as Record<string, unknown>;
    switch (s.kind) {
      case "plan":
        lines.push(`[plan]\n${truncate(String(out.plan ?? ""), 1200)}`);
        break;
      case "understand":
        lines.push(`[understand] ${truncate(String(out.analysis ?? ""), 600)}`);
        break;
      case "retry":
        lines.push(`[retry] attempt ${out.attempt ?? "?"}/${out.maxRetries ?? "?"} — ${truncate(String(out.error ?? ""), 300)}`);
        break;
      case "action":
        lines.push(
          `[action] ${s.name}(${truncate(JSON.stringify(s.input ?? {}), 400)})`,
        );
        break;
      case "observation":
        lines.push(
          `[observation:${s.name}] ${out.ok === false ? "FAILED — " : ""}${truncate(String(out.output ?? ""), perObservationCap)}`,
        );
        break;
      case "error":
        lines.push(`[error] ${truncate(String(out.message ?? ""), 300)}${out.feedback ? `\n[system feedback] ${out.feedback}` : ""}`);
        break;
      case "critic":
        lines.push(`[critic] verdict=${out.complete === true ? "accept" : "reject"}${out.reason ? ` — ${truncate(String(out.reason), 300)}` : ""}`);
        break;
      case "final":
        lines.push(`[final proposed] ${truncate(String(out.final ?? ""), 400)}`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

export function reactMessages(params: {
  objective: Objective;
  plan: string;
  toolsSection: string;
  memories: string[];
  transcript: string;
}): ChatMessage[] {
  const { objective, plan, toolsSection, memories, transcript } = params;
  const memoryBlock = memories.length
    ? `Relevant long-term memories:\n${memories.map((m) => `- ${m}`).join("\n")}\n\n`
    : "";
  return [
    { role: "system", content: toolsSystemPrompt(toolsSection) },
    {
      role: "user",
      content: `${memoryBlock}Objective from Brandon: ${objective.title}${objective.description ? `\nDetails: ${objective.description}` : ""}

Plan:
${truncate(plan, 1600)}

Progress so far:
${transcript}

Decide the single next action. Respond with ONE JSON object only.`,
    },
  ];
}

export function criticMessages(params: {
  objective: Objective;
  plan: string;
  transcript: string;
  proposedFinal: string;
}): ChatMessage[] {
  const { objective, plan, transcript, proposedFinal } = params;
  return [
    {
      role: "system",
      content: `${KAIRA_IDENTITY}
You are acting as your own verification critic. Judge strictly whether the objective was genuinely accomplished, based ONLY on observed tool outputs in the transcript. Flag fabricated or unverified claims. Respond with exactly one JSON object and nothing else:
{"complete":true|false,"reason":"<why>"}`,
    },
    {
      role: "user",
      content: `Objective: ${objective.title}${objective.description ? `\nDetails: ${objective.description}` : ""}

Plan:
${truncate(plan, 1200)}

Execution transcript (recent):
${transcript}

Proposed completion report:
${truncate(proposedFinal, 1200)}

Was the objective genuinely accomplished and verified? JSON only.`,
    },
  ];
}

/** Feedback shown to the model after an unparseable response. */
export const PARSE_FEEDBACK =
  "Your previous response was not a valid action envelope. Respond with EXACTLY ONE JSON object: " +
  '{"thought":"...","action":{"tool":"<name>","input":{...}}} or {"thought":"...","final":"..."}. No prose, no code fences.';
