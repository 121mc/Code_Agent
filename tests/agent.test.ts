import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentTask } from "../src/agent.js";
import type { ChatMessage, LLMClient } from "../src/llm.js";
import { loadProjectContext } from "../src/project-context.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-agent-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MockLLM implements LLMClient {
  private index = 0;
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly responses: string[]) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const response = this.responses[this.index];
    this.index += 1;
    if (response === undefined) {
      throw new Error("MockLLM response exhausted.");
    }
    return response;
  }
}

describe("agent orchestrator", () => {
  it("plans, runs one tool at a time, and returns a final summary", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parser.ts"), "export const parseUser = true;\n");
    const context = await loadProjectContext(root);
    const llm = new MockLLM([
      JSON.stringify({ type: "plan", summary: "Search parser", steps: ["Search parseUser", "Finish"] }),
      JSON.stringify({ type: "tool_call", tool: "search", args: { query: "parseUser" } }),
      JSON.stringify({ type: "final", summary: "Found parser", tests: "not run", changedFiles: [] })
    ]);
    const printedPlans: string[] = [];

    const result = await runAgentTask({
      userRequest: "find parseUser",
      context,
      llm,
      onPlan: (plan) => printedPlans.push(plan.summary)
    });

    expect(result.final.summary).toBe("Found parser");
    expect(result.session.plan).toEqual(["Search parseUser", "Finish"]);
    expect(printedPlans).toEqual(["Search parser"]);
    expect(result.session.observations).toHaveLength(1);
  });

  it("asks the model to repair invalid JSON", async () => {
    const root = await tempRoot();
    const context = await loadProjectContext(root);
    const llm = new MockLLM([
      "not json",
      JSON.stringify({ type: "final", summary: "Stopped cleanly", tests: "not run", changedFiles: [] })
    ]);

    const result = await runAgentTask({ userRequest: "do work", context, llm });

    expect(result.final.summary).toBe("Stopped cleanly");
  });

  it("does not dispatch tool calls before a plan is accepted", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parser.ts"), "export const parseUser = true;\n");
    const context = await loadProjectContext(root);
    const earlyToolCall = { type: "tool_call", tool: "read_file", args: { path: "parser.ts" } };
    const plan = { type: "plan", summary: "Read parser", steps: ["Read parser"] };
    const validToolCall = { type: "tool_call", tool: "read_file", args: { path: "parser.ts" } };
    const llm = new MockLLM([
      JSON.stringify(earlyToolCall),
      JSON.stringify(plan),
      JSON.stringify(validToolCall),
      JSON.stringify({ type: "final", summary: "Read parser", tests: "not run", changedFiles: [] })
    ]);

    const result = await runAgentTask({ userRequest: "read parser", context, llm });

    expect(result.session.toolCallCount).toBe(1);
    expect(result.session.observations).toHaveLength(1);
    expect(result.session.observations[0]?.tool).toBe("read_file");
    expect(llm.calls[1]?.at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining("plan")
    });
    expect(llm.calls[1]?.at(-1)?.content).not.toContain("\"type\":\"observation\"");
  });

  it("reconciles final changed files to session state", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parser.ts"), "export const parseUser = true;\n");
    const context = await loadProjectContext(root);
    const llm = new MockLLM([
      JSON.stringify({ type: "plan", summary: "Edit parser", steps: ["Edit parser"] }),
      JSON.stringify({
        type: "tool_call",
        tool: "edit_file",
        args: {
          path: "parser.ts",
          search: "export const parseUser = true;",
          replace: "export const parseUser = false;"
        }
      }),
      JSON.stringify({ type: "final", summary: "Edited parser", tests: "not run", changedFiles: ["fake.ts"] })
    ]);

    const result = await runAgentTask({ userRequest: "edit parser", context, llm });

    expect(result.session.filesModified).toEqual(["parser.ts"]);
    expect(result.final.changedFiles).toEqual(["parser.ts"]);
  });

  it("uses the latest recorded test command summary in final responses", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(0)\"",
        build: "node -e \"process.exit(0)\""
      }
    }));
    const context = await loadProjectContext(root);
    const llm = new MockLLM([
      JSON.stringify({ type: "plan", summary: "Run checks", steps: ["Test", "Build"] }),
      JSON.stringify({ type: "tool_call", tool: "run_command", args: { command: "npm test" } }),
      JSON.stringify({ type: "tool_call", tool: "run_command", args: { command: "npm run build" } }),
      JSON.stringify({ type: "final", summary: "Ran checks", tests: "stale model tests", changedFiles: [] })
    ]);

    const result = await runAgentTask({ userRequest: "run checks", context, llm });

    expect(result.session.commandResults.map((commandResult) => commandResult.command)).toEqual([
      "npm test",
      "npm run build"
    ]);
    expect(result.final.tests).toBe("npm run build exited 0");
  });

  it("sends plan and observation messages in order", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parser.ts"), "export const parseUser = true;\n");
    const context = await loadProjectContext(root);
    const plan = { type: "plan", summary: "Search parser", steps: ["Search parser"] };
    const toolCall = { type: "tool_call", tool: "search", args: { query: "parseUser" } };
    const llm = new MockLLM([
      JSON.stringify(plan),
      JSON.stringify(toolCall),
      JSON.stringify({ type: "final", summary: "Found parser", tests: "not run", changedFiles: [] })
    ]);

    await runAgentTask({ userRequest: "find parser", context, llm });

    expect(llm.calls[1]?.slice(-2)).toEqual([
      { role: "assistant", content: JSON.stringify(plan) },
      { role: "user", content: "Continue with the first tool call." }
    ]);
    expect(llm.calls[2]?.at(-2)).toEqual({ role: "assistant", content: JSON.stringify(toolCall) });
    const observationMessage = llm.calls[2]?.at(-1);
    expect(observationMessage?.role).toBe("user");
    expect(JSON.parse(observationMessage?.content ?? "{}")).toMatchObject({
      type: "observation",
      tool: "search",
      ok: true
    });
  });

  it("stops after reaching the tool call limit", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parser.ts"), "export const parseUser = true;\n");
    const context = await loadProjectContext(root);
    const llm = new MockLLM([
      JSON.stringify({ type: "plan", summary: "Search parser", steps: ["Search parser"] }),
      JSON.stringify({ type: "tool_call", tool: "search", args: { query: "parseUser" } }),
      JSON.stringify({ type: "final", summary: "Should not be used", tests: "not run", changedFiles: [] })
    ]);

    const result = await runAgentTask({ userRequest: "find parser", context, llm, maxToolCalls: 1 });

    expect(result.final.summary).toBe("Stopped after reaching the tool call limit.");
    expect(result.session.toolCallCount).toBe(1);
    expect(llm.calls).toHaveLength(2);
  });

  it("stops invalid JSON repair loops at the LLM turn limit", async () => {
    const root = await tempRoot();
    const context = await loadProjectContext(root);
    const llm = new MockLLM(["not json", "still not json", "also not json"]);

    const result = await runAgentTask({ userRequest: "do work", context, llm, maxLlmTurns: 3 });

    expect(result.final.summary).toContain("Stopped after reaching the LLM turn limit");
    expect(result.session.toolCallCount).toBe(0);
  });

  it("stops repeated plan responses at the LLM turn limit", async () => {
    const root = await tempRoot();
    const context = await loadProjectContext(root);
    const llm = new MockLLM([
      JSON.stringify({ type: "plan", summary: "Plan one", steps: ["Search"] }),
      JSON.stringify({ type: "plan", summary: "Plan two", steps: ["Search again"] }),
      JSON.stringify({ type: "plan", summary: "Plan three", steps: ["Still planning"] })
    ]);

    const result = await runAgentTask({ userRequest: "do work", context, llm, maxLlmTurns: 3 });

    expect(result.final.summary).toContain("Stopped after reaching the LLM turn limit");
    expect(result.session.toolCallCount).toBe(0);
  });

  it("stops after repeated tool failures", async () => {
    const root = await tempRoot();
    const context = await loadProjectContext(root);
    const llm = new MockLLM([
      JSON.stringify({ type: "plan", summary: "Read missing", steps: ["Read missing file"] }),
      JSON.stringify({ type: "tool_call", tool: "read_file", args: { path: "../secret.txt" } }),
      JSON.stringify({ type: "tool_call", tool: "read_file", args: { path: "../secret.txt" } }),
      JSON.stringify({ type: "tool_call", tool: "read_file", args: { path: "../secret.txt" } })
    ]);

    const result = await runAgentTask({ userRequest: "read outside", context, llm });

    expect(result.final.summary).toContain("Stopped after repeated tool failures");
    expect(result.session.consecutiveToolFailures).toBe(3);
  });
});
