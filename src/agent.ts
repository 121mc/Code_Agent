import { buildRepairPrompt, parseAgentResponse, type FinalResponse, type PlanResponse } from "./protocol.js";
import { buildSystemPrompt, type ChatMessage, type LLMClient } from "./llm.js";
import type { ProjectContext } from "./project-context.js";
import { createSession, type SessionState } from "./session.js";
import { dispatchToolCall, type RouterOptions } from "./tools/router.js";
import { DEFAULT_AGENT_LIMITS, validateLimit } from "./limits.js";

export interface RunAgentTaskInput {
  userRequest: string;
  context: ProjectContext;
  llm: LLMClient;
  maxToolCalls?: number;
  maxLlmTurns?: number;
  maxAutomaticRepairAttempts?: number;
  routerOptions?: RouterOptions;
  onPlan?: (plan: PlanResponse) => void;
}

export interface RunAgentTaskResult {
  final: FinalResponse;
  session: SessionState;
}

const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
const MAX_OBSERVATION_OUTPUT_BYTES = 12_000;

export async function runAgentTask(input: RunAgentTaskInput): Promise<RunAgentTaskResult> {
  const session = createSession(input.userRequest);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(input.context.memory) },
    { role: "user", content: input.userRequest }
  ];

  const maxToolCalls = validateLimit("maxToolCalls", input.maxToolCalls ?? DEFAULT_AGENT_LIMITS.maxToolCalls);
  const maxLlmTurns = validateLimit("maxLlmTurns", input.maxLlmTurns ?? DEFAULT_AGENT_LIMITS.maxLlmTurns);
  const maxRepairs = validateLimit("maxAutomaticRepairAttempts", input.maxAutomaticRepairAttempts ?? DEFAULT_AGENT_LIMITS.maxAutomaticRepairAttempts, 0);
  let llmTurnCount = 0;
  let hasAcceptedPlan = false;

  while (llmTurnCount < maxLlmTurns) {
    if (session.toolCallCount >= maxToolCalls) {
      return {
        final: {
          type: "final",
          summary: "Stopped after reaching the tool call limit.",
          tests: summarizeTests(session),
          changedFiles: [...session.filesModified]
        },
        session
      };
    }

    if (session.consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
      return {
        final: {
          type: "final",
          summary: "Stopped after repeated tool failures.",
          tests: summarizeTests(session),
          changedFiles: [...session.filesModified]
        },
        session
      };
    }

    const raw = await input.llm.complete(messages);
    llmTurnCount += 1;
    const parsed = parseAgentResponse(raw);

    if (!parsed.ok) {
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: buildRepairPrompt(raw) });
      continue;
    }

    if (parsed.response.type === "plan") {
      hasAcceptedPlan = true;
      session.plan = parsed.response.steps;
      input.onPlan?.(parsed.response);
      messages.push({ role: "assistant", content: JSON.stringify(parsed.response) });
      messages.push({ role: "user", content: "Continue with the first tool call." });
      continue;
    }

    if (parsed.response.type === "final") {
      return { final: reconcileFinalResponse(parsed.response, session), session };
    }

    if (!hasAcceptedPlan) {
      messages.push({ role: "assistant", content: JSON.stringify(parsed.response) });
      messages.push({
        role: "user",
        content: "A plan response is required before any tool_call. Return a plan JSON object first."
      });
      continue;
    }

    const previousCommandCount = session.commandResults.length;
    const observation = await dispatchToolCall(
      input.context.root,
      session,
      parsed.response,
      { ...input.routerOptions, isGitRepository: input.context.isGitRepository }
    );
    const testFailureAction = handleFailedTestCommand(session, parsed.response, observation, maxRepairs,
      session.commandResults.length > previousCommandCount);

    messages.push({ role: "assistant", content: JSON.stringify(parsed.response) });
    messages.push({
      role: "user",
      content: JSON.stringify({
        type: "observation",
        tool: parsed.response.tool,
        ok: observation.ok,
        output: compactObservationOutput(
          testFailureAction.guidance
            ? appendRepairGuidance(observation.output, session.automaticRepairAttempts, maxRepairs)
            : observation.output
        )
      })
    });

    if (testFailureAction.stop) {
      return {
        final: {
          type: "final",
          summary: `Stopped after exhausting the automatic repair limit (${maxRepairs}).`,
          tests: summarizeTests(session),
          changedFiles: [...session.filesModified]
        },
        session
      };
    }
  }

  return {
    final: {
      type: "final",
      summary: "Stopped after reaching the LLM turn limit.",
      tests: summarizeTests(session),
      changedFiles: [...session.filesModified]
    },
    session
  };
}

function reconcileFinalResponse(final: FinalResponse, session: SessionState): FinalResponse {
  return {
    ...final,
    tests: summarizeTests(session),
    changedFiles: [...session.filesModified]
  };
}

function handleFailedTestCommand(
  session: SessionState,
  response: { tool: string; args: Record<string, unknown> },
  observation: { ok: boolean; output: string },
  maxRepairs: number,
  commandExecuted: boolean
): { guidance: boolean; stop: boolean } {
  if (
    observation.ok || !commandExecuted ||
    response.tool !== "run_command" ||
    typeof response.args.command !== "string" ||
    !isTestCommand(response.args.command)
  ) {
    return { guidance: false, stop: false };
  }

  // An executed failing test is repair feedback, not a broken tool invocation.
  session.consecutiveToolFailures = 0;
  if (session.automaticRepairAttempts < maxRepairs) {
    session.automaticRepairAttempts += 1;
    return { guidance: true, stop: false };
  }

  return { guidance: false, stop: true };
}

function appendRepairGuidance(output: string, attempt: number, maximum: number): string {
  return [
    output,
    `Automatic repair attempt ${attempt}/${maximum}. Diagnose the test failure, fix the code, and rerun tests.`
  ].join("\n");
}

function compactObservationOutput(output: string): string {
  const originalBytes = Buffer.byteLength(output, "utf8");
  if (originalBytes <= MAX_OBSERVATION_OUTPUT_BYTES) {
    return output;
  }

  const marker = [
    "",
    `[... output truncated: ${originalBytes} bytes total. Showing the start and end only; use search for specific text before editing. ...]`,
    ""
  ].join("\n");
  const edgeBudget = MAX_OBSERVATION_OUTPUT_BYTES - Buffer.byteLength(marker, "utf8");
  const headBudget = Math.ceil(edgeBudget / 2);
  const tailBudget = Math.floor(edgeBudget / 2);

  return [
    takeUtf8Prefix(output, headBudget),
    marker,
    takeUtf8Suffix(output, tailBudget)
  ].join("");
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;

  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }

    bytes += charBytes;
    end += char.length;
  }

  return value.slice(0, end);
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  const chars = Array.from(value);
  let bytes = 0;
  let start = chars.length;

  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index] ?? "";
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }

    bytes += charBytes;
    start = index;
  }

  return chars.slice(start).join("");
}

function summarizeTests(session: SessionState): string {
  for (let index = session.commandResults.length - 1; index >= 0; index -= 1) {
    const commandResult = session.commandResults[index];
    if (commandResult && isCheckCommand(commandResult.command)) {
      return `${commandResult.command} exited ${commandResult.exitCode ?? "unknown"}`;
    }
  }

  return "not run";
}

function isTestCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return /\btest\b/.test(normalized) || /\b(vitest|jest|mocha)\b/.test(normalized);
}

function isCheckCommand(command: string): boolean {
  return isTestCommand(command) || /\b(build|lint)\b/.test(command.toLowerCase());
}
