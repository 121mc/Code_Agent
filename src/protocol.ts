export const TOOL_NAMES = ["search", "read_file", "edit_file", "run_command", "diff"] as const;

export type ToolName = typeof TOOL_NAMES[number];

export interface PlanResponse {
  type: "plan";
  summary: string;
  steps: string[];
}

export interface ToolCallResponse {
  type: "tool_call";
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface FinalResponse {
  type: "final";
  summary: string;
  tests: string;
  changedFiles: string[];
}

export type AgentResponse = PlanResponse | ToolCallResponse | FinalResponse;

export type ParseResult =
  | { ok: true; response: AgentResponse }
  | { ok: false; error: string };

export function parseAgentResponse(raw: string): ParseResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    return { ok: false, error: "Model response must be valid JSON." };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "Model response must be a JSON object." };
  }

  if (parsed.type === "plan") {
    if (typeof parsed.summary !== "string") {
      return { ok: false, error: "Plan response requires string summary." };
    }
    if (!Array.isArray(parsed.steps) || !parsed.steps.every((step) => typeof step === "string")) {
      return { ok: false, error: "Plan response requires string steps array." };
    }
    return { ok: true, response: { type: "plan", summary: parsed.summary, steps: parsed.steps } };
  }

  if (parsed.type === "tool_call") {
    if (typeof parsed.tool !== "string" || !isToolName(parsed.tool)) {
      return { ok: false, error: `Unsupported tool: ${String(parsed.tool)}` };
    }
    if (!isRecord(parsed.args)) {
      return { ok: false, error: "Tool call requires object args." };
    }
    return { ok: true, response: { type: "tool_call", tool: parsed.tool, args: parsed.args } };
  }

  if (parsed.type === "final") {
    if (typeof parsed.summary !== "string") {
      return { ok: false, error: "Final response requires string summary." };
    }
    if (typeof parsed.tests !== "string") {
      return { ok: false, error: "Final response requires string tests." };
    }
    if (!Array.isArray(parsed.changedFiles) || !parsed.changedFiles.every((file) => typeof file === "string")) {
      return { ok: false, error: "Final response requires string changedFiles array." };
    }
    return {
      ok: true,
      response: {
        type: "final",
        summary: parsed.summary,
        tests: parsed.tests,
        changedFiles: parsed.changedFiles
      }
    };
  }

  return { ok: false, error: "Response type must be plan, tool_call, or final." };
}

export function buildRepairPrompt(raw: string): string {
  return [
    "Your previous response did not match the required JSON protocol.",
    "Return exactly one JSON object with one of these shapes:",
    "{\"type\":\"plan\",\"summary\":\"...\",\"steps\":[\"...\"]}",
    "{\"type\":\"tool_call\",\"tool\":\"search\",\"args\":{\"query\":\"...\"}}",
    "{\"type\":\"final\",\"summary\":\"...\",\"tests\":\"...\",\"changedFiles\":[\"...\"]}",
    "Previous response:",
    raw
  ].join("\n");
}

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
