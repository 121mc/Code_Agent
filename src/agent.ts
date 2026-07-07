import { buildRepairPrompt, parseAgentResponse, type FinalResponse, type PlanResponse } from "./protocol.js";
import { buildSystemPrompt, type ChatMessage, type LLMClient } from "./llm.js";
import type { ProjectContext } from "./project-context.js";
import { createSession, type SessionState } from "./session.js";
import { dispatchToolCall } from "./tools/router.js";

export interface RunAgentTaskInput {
  userRequest: string;
  context: ProjectContext;
  llm: LLMClient;
  maxToolCalls?: number;
  maxLlmTurns?: number;
  onPlan?: (plan: PlanResponse) => void;
}

export interface RunAgentTaskResult {
  final: FinalResponse;
  session: SessionState;
}

const DEFAULT_MAX_TOOL_CALLS = 20;
const DEFAULT_MAX_LLM_TURNS = 40;
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

export async function runAgentTask(input: RunAgentTaskInput): Promise<RunAgentTaskResult> {
  const session = createSession(input.userRequest);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(input.context.memory) },
    { role: "user", content: input.userRequest }
  ];

  const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxLlmTurns = input.maxLlmTurns ?? DEFAULT_MAX_LLM_TURNS;
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

    const observation = await dispatchToolCall(
      input.context.root,
      session,
      parsed.response,
      { isGitRepository: input.context.isGitRepository }
    );
    recordCommandResultIfNeeded(session, parsed.response, observation);

    messages.push({ role: "assistant", content: JSON.stringify(parsed.response) });
    messages.push({
      role: "user",
      content: JSON.stringify({
        type: "observation",
        tool: parsed.response.tool,
        ok: observation.ok,
        output: observation.output
      })
    });
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
  const testSummary = summarizeTests(session);
  return {
    ...final,
    tests: testSummary === "not run" ? final.tests : testSummary,
    changedFiles: [...session.filesModified]
  };
}

function recordCommandResultIfNeeded(
  session: SessionState,
  response: { tool: string; args: Record<string, unknown> },
  observation: { ok: boolean; output: string }
): void {
  if (response.tool !== "run_command" || typeof response.args.command !== "string") {
    return;
  }

  session.commandResults.push({
    command: response.args.command,
    exitCode: observation.ok ? 0 : null,
    timedOut: false,
    output: observation.output
  });
}

function summarizeTests(session: SessionState): string {
  for (let index = session.commandResults.length - 1; index >= 0; index -= 1) {
    const commandResult = session.commandResults[index];
    if (commandResult && /\b(test|build|lint)\b/.test(commandResult.command)) {
      return `${commandResult.command} exited ${commandResult.exitCode ?? "unknown"}`;
    }
  }

  return "not run";
}
