import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentTask } from "../src/agent.js";
import type { LLMClient } from "../src/llm.js";
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

  constructor(private readonly responses: string[]) {}

  async complete(): Promise<string> {
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
