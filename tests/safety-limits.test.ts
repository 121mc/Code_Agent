import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
      message: expect.stringContaining("npm install left-pad")
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
      message: expect.stringContaining("npm install left-pad")
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

  it("prompts for the canonical sensitive target when reading through a workspace symlink", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await symlink(join(root, ".env"), join(root, "link.txt"), "file");
    const session = createSession("read linked secret");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(true);

    const result = await dispatchToolCall(
      root,
      session,
      { type: "tool_call", tool: "read_file", args: { path: "link.txt" } },
      { confirm }
    );

    expect(result).toEqual({ ok: true, output: "SECRET=1\n" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith({
      kind: "file",
      message: expect.stringMatching(/read[\s\S]*link\.txt[\s\S]*\.env/)
    });
    expect(session.filesRead).toEqual([".env"]);
  });

  it("rejects reading a symlink whose target changes after approval", async () => {
    const root = await tempRoot();
    const linkPath = join(root, "link.txt");
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await writeFile(join(root, ".env.local"), "LOCAL_SECRET=2\n");
    await symlink(join(root, ".env"), linkPath, "file");
    const session = createSession("read retargeted secret");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockImplementation(async () => {
      await rm(linkPath, { force: true });
      await symlink(join(root, ".env.local"), linkPath, "file");
      return true;
    });

    const result = await dispatchToolCall(
      root,
      session,
      { type: "tool_call", tool: "read_file", args: { path: "link.txt" } },
      { confirm }
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/target.*(changed|mismatch)|approved.*target/i);
    expect(result.output).not.toContain("LOCAL_SECRET");
    expect(session.filesRead).toEqual([]);
  });

  it("denies reads through symlinks to sensitive targets without modifying session reads", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await symlink(join(root, ".env"), join(root, "link.txt"), "file");
    const session = createSession("read linked secret");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(false);

    const result = await dispatchToolCall(
      root,
      session,
      { type: "tool_call", tool: "read_file", args: { path: "link.txt" } },
      { confirm }
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not approved/i);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith({
      kind: "file",
      message: expect.stringMatching(/read[\s\S]*link\.txt[\s\S]*\.env/)
    });
    expect(session.filesRead).toEqual([]);
  });

  it("blocks reads through symlinks to outside targets even when confirmation is available", async () => {
    const root = await tempRoot();
    const outsideRoot = await tempRoot();
    await writeFile(join(outsideRoot, "secret.txt"), "SECRET=1\n");
    await symlink(join(outsideRoot, "secret.txt"), join(root, "link.txt"), "file");
    const session = createSession("read outside link");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(true);

    const result = await dispatchToolCall(
      root,
      session,
      { type: "tool_call", tool: "read_file", args: { path: "link.txt" } },
      { confirm }
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
    expect(confirm).not.toHaveBeenCalled();
    expect(session.filesRead).toEqual([]);
  });

  it("prompts for the canonical sensitive target when editing through a workspace symlink", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await symlink(join(root, ".env"), join(root, "link.txt"), "file");
    const session = createSession("edit linked secret");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(true);

    const result = await dispatchToolCall(
      root,
      session,
      {
        type: "tool_call",
        tool: "edit_file",
        args: {
          path: "link.txt",
          search: "SECRET=1",
          replace: "SECRET=2"
        }
      },
      { confirm }
    );

    expect(result.ok).toBe(true);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SECRET=2\n");
    expect(confirm).toHaveBeenCalledWith({
      kind: "file",
      message: expect.stringMatching(/edit[\s\S]*link\.txt[\s\S]*\.env/)
    });
    expect(session.filesModified).toEqual([".env"]);
  });

  it("rejects editing a symlink whose target changes after approval", async () => {
    const root = await tempRoot();
    const linkPath = join(root, "link.txt");
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await writeFile(join(root, ".env.local"), "LOCAL_SECRET=2\n");
    await symlink(join(root, ".env"), linkPath, "file");
    const session = createSession("edit retargeted secret");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockImplementation(async () => {
      await rm(linkPath, { force: true });
      await symlink(join(root, ".env.local"), linkPath, "file");
      return true;
    });

    const result = await dispatchToolCall(
      root,
      session,
      {
        type: "tool_call",
        tool: "edit_file",
        args: {
          path: "link.txt",
          search: "LOCAL_SECRET=2",
          replace: "LOCAL_SECRET=3"
        }
      },
      { confirm }
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/target.*(changed|mismatch)|approved.*target/i);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(await readFile(join(root, ".env.local"), "utf8")).toBe("LOCAL_SECRET=2\n");
    expect(session.filesModified).toEqual([]);
  });

  it("denies edits through symlinks to sensitive targets without modifying the target", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await symlink(join(root, ".env"), join(root, "link.txt"), "file");
    const session = createSession("edit linked secret");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(false);

    const result = await dispatchToolCall(
      root,
      session,
      {
        type: "tool_call",
        tool: "edit_file",
        args: {
          path: "link.txt",
          search: "SECRET=1",
          replace: "SECRET=2"
        }
      },
      { confirm }
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not approved/i);
    expect(await readFile(join(root, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(confirm).toHaveBeenCalledWith({
      kind: "file",
      message: expect.stringMatching(/edit[\s\S]*link\.txt[\s\S]*\.env/)
    });
    expect(session.filesModified).toEqual([]);
  });

  it("includes the edit target in large edit confirmation prompts", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "large.ts"), "const value = 1;\n");
    const session = createSession("large edit");
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(false);
    const largeReplacement = `const value = 2;\n${"x".repeat(5_001)}`;

    const result = await dispatchToolCall(
      root,
      session,
      {
        type: "tool_call",
        tool: "edit_file",
        args: {
          path: "large.ts",
          search: "const value = 1;",
          replace: largeReplacement
        }
      },
      { confirm }
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not approved/i);
    expect(confirm).toHaveBeenCalledWith({
      kind: "limit",
      message: expect.stringMatching(/large edit[\s\S]*large\.ts/i)
    });
    expect(await readFile(join(root, "large.ts"), "utf8")).toBe("const value = 1;\n");
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

  it("allows one automatic repair attempt for focused vitest commands and summarizes the latest failure", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "4.1.10" } }));
    const context = await loadProjectContext(root);
    const confirm = vi.fn<(prompt: ConfirmationPrompt) => Promise<boolean>>().mockResolvedValue(true);
    const commandExecutor = vi.fn<CommandExecutor>().mockResolvedValue({
      exitCode: 1,
      timedOut: false,
      output: "vitest failed\n"
    });
    const llm = new MockLLM([
      JSON.stringify({ type: "plan", summary: "Run focused tests", steps: ["Run vitest", "Repair once"] }),
      JSON.stringify({ type: "tool_call", tool: "run_command", args: { command: "npx vitest run" } }),
      JSON.stringify({ type: "tool_call", tool: "run_command", args: { command: "npx vitest run" } })
    ]);

    const result = await runAgentTask({
      userRequest: "run focused tests and repair once",
      context,
      llm,
      routerOptions: { confirm, commandExecutor }
    });

    expect(result.final.summary).toMatch(/Stopped after .*test/i);
    expect(result.final.tests).toBe("npx vitest run exited 1");
    expect(result.session.automaticRepairAttempts).toBe(1);
    expect(result.session.commandResults).toHaveLength(2);
    expect(commandExecutor).toHaveBeenCalledTimes(2);
  });
});
