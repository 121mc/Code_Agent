import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentTask } from "../src/agent.js";
import type { ChatMessage, LLMClient } from "../src/llm.js";
import { loadProjectContext } from "../src/project-context.js";
import { createSession } from "../src/session.js";
import type { CommandExecutor } from "../src/tools/process-tools.js";
import { dispatchToolCall, type ConfirmationPrompt } from "../src/tools/router.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-safety-"));
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

describe("confirmation paths and safety limits", () => {
  it("rejects confirm-required commands when confirmation is denied", async () => {
    const root = await tempRoot();
    const session = createSession("install dependency");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(false);
    const commandExecutor = vi.fn<CommandExecutor>().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      output: "installed\n"
    });

    const result = await dispatchToolCall(
      root,
      session,
      { type: "tool_call", tool: "run_command", args: { command: "npm install left-pad" } },
      { confirm, commandExecutor }
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not approved/i);
    expect(confirm).toHaveBeenCalledWith({
      kind: "command",
      message: expect.stringContaining("Dependency changes require confirmation")
    });
    expect(commandExecutor).not.toHaveBeenCalled();
    expect(session.commandResults).toEqual([]);
    expect(session.observations).toEqual([{ tool: "run_command", ok: false, output: result.output }]);
  });

  it("runs confirm-required commands after approval and records command results", async () => {
    const root = await tempRoot();
    const session = createSession("install dependency");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(true);
    const commandExecutor = vi.fn<CommandExecutor>().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      output: "installed\n"
    });

    const result = await dispatchToolCall(
      root,
      session,
      { type: "tool_call", tool: "run_command", args: { command: "npm install left-pad" } },
      { confirm, commandExecutor }
    );

    expect(result).toEqual({ ok: true, output: "installed\n" });
    expect(confirm).toHaveBeenCalledWith({
      kind: "command",
      message: expect.stringContaining("Dependency changes require confirmation")
    });
    expect(commandExecutor).toHaveBeenCalledWith(root, {
      command: "npm install left-pad",
      timeoutMs: 120_000
    });
    expect(session.commandResults).toEqual([
      {
        command: "npm install left-pad",
        exitCode: 0,
        timedOut: false,
        output: "installed\n"
      }
    ]);
  });

  it("asks for confirmation before editing a sixth file", async () => {
    const root = await tempRoot();
    for (let index = 1; index <= 6; index += 1) {
      await writeFile(join(root, `file-${index}.ts`), `export const value = ${index};\n`);
    }
    const session = createSession("edit many files");
    session.filesModified.push("file-1.ts", "file-2.ts", "file-3.ts", "file-4.ts", "file-5.ts");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(false);

    const result = await dispatchToolCall(
      root,
      session,
      {
        type: "tool_call",
        tool: "edit_file",
        args: {
          path: "file-6.ts",
          search: "export const value = 6;",
          replace: "export const value = 60;"
        }
      },
      { confirm }
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not approved/i);
    expect(confirm).toHaveBeenCalledWith({
      kind: "limit",
      message: expect.stringContaining("more than 5 files")
    });
    expect(await readFile(join(root, "file-6.ts"), "utf8")).toBe("export const value = 6;\n");
    expect(session.filesModified).toEqual(["file-1.ts", "file-2.ts", "file-3.ts", "file-4.ts", "file-5.ts"]);
  });

  it("records thrown tool exceptions as failed observations", async () => {
    const root = await tempRoot();
    const session = createSession("run tests");
    const commandExecutor = vi.fn<CommandExecutor>().mockRejectedValue(new Error("executor exploded"));

    const result = await dispatchToolCall(
      root,
      session,
      { type: "tool_call", tool: "run_command", args: { command: "npm test" } },
      { commandExecutor }
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Tool run_command failed: executor exploded");
    expect(session.observations).toEqual([{ tool: "run_command", ok: false, output: result.output }]);
    expect(session.errors).toEqual([result.output]);
  });

  it("allows one automatic repair attempt after a failed test command and stops after the second failure", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));
    const context = await loadProjectContext(root);
    const commandExecutor = vi.fn<CommandExecutor>().mockResolvedValue({
      exitCode: 1,
      timedOut: false,
      output: "test failed\n"
    });
    const llm = new MockLLM([
      JSON.stringify({ type: "plan", summary: "Run tests", steps: ["Run npm test", "Repair once if needed"] }),
      JSON.stringify({ type: "tool_call", tool: "run_command", args: { command: "npm test" } }),
      JSON.stringify({ type: "tool_call", tool: "run_command", args: { command: "npm test" } })
    ]);

    const result = await runAgentTask({
      userRequest: "run tests and repair once",
      context,
      llm,
      routerOptions: { commandExecutor }
    });

    expect(result.final.summary).toMatch(/Stopped after .*test/i);
    expect(result.session.automaticRepairAttempts).toBe(1);
    expect(result.session.commandResults).toHaveLength(2);
    expect(result.session.commandResults.map((commandResult) => commandResult.exitCode)).toEqual([1, 1]);
    expect(commandExecutor).toHaveBeenCalledTimes(2);
    expect(llm.calls).toHaveLength(3);

    const firstFailedObservation = JSON.parse(llm.calls[2]?.at(-1)?.content ?? "{}") as { output?: string };
    expect(firstFailedObservation.output).toContain(
      "One automatic repair attempt is allowed. Diagnose and emit the next tool call."
    );
  });
});
