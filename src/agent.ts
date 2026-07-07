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

  while (llmTurnCount < maxLlmTurns) {
    if (session.toolCallCount >= maxToolCalls) {
      return {
        final: {
          type: "final",
          summary: "Stopped after reaching the tool call limit.",
          tests: summarizeTests(session),
          changedFiles: session.filesModified
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
          changedFiles: session.filesModified
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
      session.plan = parsed.response.steps;
      input.onPlan?.(parsed.response);
      messages.push({ role: "assistant", content: JSON.stringify(parsed.response) });
      messages.push({ role: "user", content: "Continue with the first tool call." });
      continue;
    }

    if (parsed.response.type === "final") {
      return { final: parsed.response, session };
    }

    const observation = await dispatchToolCall(
      input.context.root,
      session,
      parsed.response,
      { isGitRepository: input.context.isGitRepository }
    );

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
      changedFiles: session.filesModified
    },
    session
  };
}

function summarizeTests(session: SessionState): string {
  const testCommand = session.commandResults.find((result) => /\b(test|build|lint)\b/.test(result.command));
  if (!testCommand) {
    return "not run";
  }

  return `${testCommand.command} exited ${testCommand.exitCode ?? "unknown"}`;
}
