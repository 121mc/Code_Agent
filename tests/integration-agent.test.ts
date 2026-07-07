import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentTask } from "../src/agent.js";
import type { ChatMessage, LLMClient } from "../src/llm.js";
import { loadProjectContext } from "../src/project-context.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-integration-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ScriptedLLM implements LLMClient {
  private index = 0;
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly responses: string[]) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const response = this.responses[this.index];
    this.index += 1;
    if (response === undefined) {
      throw new Error("ScriptedLLM response exhausted.");
    }
    return response;
  }
}

describe("MVP integration", () => {
  it("searches, reads, edits, and reports changed files", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parseUser.ts"), [
      "export function parseUser(input: string): string {",
      "  return input.trim();",
      "}",
      ""
    ].join("\n"));

    const context = await loadProjectContext(root);
    const llm = new ScriptedLLM([
      JSON.stringify({
        type: "plan",
        summary: "Handle empty input",
        steps: ["Search parseUser", "Read file", "Edit implementation", "Show diff"]
      }),
      JSON.stringify({ type: "tool_call", tool: "search", args: { query: "parseUser" } }),
      JSON.stringify({ type: "tool_call", tool: "read_file", args: { path: "parseUser.ts" } }),
      JSON.stringify({
        type: "tool_call",
        tool: "edit_file",
        args: {
          path: "parseUser.ts",
          search: "  return input.trim();",
          replace: "  return input.trim() || \"anonymous\";"
        }
      }),
      JSON.stringify({ type: "tool_call", tool: "diff", args: {} }),
      JSON.stringify({
        type: "final",
        summary: "parseUser now handles empty input.",
        tests: "not run",
        changedFiles: ["parseUser.ts"]
      })
    ]);

    const result = await runAgentTask({ userRequest: "handle empty parseUser input", context, llm });

    expect(result.final.changedFiles).toEqual(["parseUser.ts"]);
    expect(result.final.tests).toBe("not run");
    expect(result.session.filesRead).toEqual(["parseUser.ts"]);
    expect(result.session.filesModified).toEqual(["parseUser.ts"]);
    expect(result.session.observations.at(-1)?.tool).toBe("diff");
  });
});
