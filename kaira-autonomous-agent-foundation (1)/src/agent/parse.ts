/**
 * Robust extraction of the agent's JSON action envelope from model output.
 *
 * Small local models often wrap JSON in prose or code fences, so we scan for
 * balanced-brace objects (ignoring braces inside strings) and accept the
 * first candidate that matches the agent protocol.
 */

export type AgentAction =
  | { type: "action"; thought: string; tool: string; input: Record<string, unknown> }
  | { type: "final"; thought: string; final: string }
  | { type: "invalid"; reason: string; raw: string };

function* candidateJsonObjects(text: string): Generator<string> {
  // Prefer fenced code blocks first — models that fence usually fence JSON.
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    yield m[1];
  }
  yield text;
}

function balancedObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse(text: string): Record<string, unknown> | null {
  const candidate = balancedObject(text);
  if (!candidate) return null;
  try {
    const obj = JSON.parse(candidate);
    return obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseAgentResponse(raw: string): AgentAction {
  for (const candidate of candidateJsonObjects(raw)) {
    const obj = tryParse(candidate);
    if (!obj) continue;
    const thought = typeof obj.thought === "string" ? obj.thought : "";
    if (typeof obj.final === "string") {
      if (!obj.final.trim()) {
        return { type: "invalid", reason: '"final" was empty', raw: raw.slice(0, 400) };
      }
      return { type: "final", thought, final: obj.final };
    }
    if (obj.action && typeof obj.action === "object") {
      const action = obj.action as Record<string, unknown>;
      if (typeof action.tool !== "string" || !action.tool.trim()) {
        return { type: "invalid", reason: '"action.tool" missing', raw: raw.slice(0, 400) };
      }
      return {
        type: "action",
        thought,
        tool: action.tool,
        input:
          action.input && typeof action.input === "object"
            ? (action.input as Record<string, unknown>)
            : {},
      };
    }
  }
  return {
    type: "invalid",
    reason: "No valid JSON action object found in the response",
    raw: raw.slice(0, 400),
  };
}

export interface CriticVerdict {
  valid: boolean;
  complete: boolean;
  reason: string;
}

export function parseCriticResponse(raw: string): CriticVerdict {
  for (const candidate of candidateJsonObjects(raw)) {
    const obj = tryParse(candidate);
    if (!obj) continue;
    if (typeof obj.complete === "boolean") {
      return {
        valid: true,
        complete: obj.complete,
        reason: typeof obj.reason === "string" ? obj.reason : "",
      };
    }
  }
  return { valid: false, complete: false, reason: "critic returned unparseable output" };
}
