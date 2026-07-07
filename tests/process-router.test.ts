import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/session.js";
import { runCommandTool, runDiffTool, type CommandExecutor } from "../src/tools/process-tools.js";
import { dispatchToolCall } from "../src/tools/router.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-process-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("process tools", () => {
  it("runs allowed commands through the injected executor and returns output", async () => {
    const root = await tempRoot();
    const session = createSession("run tests");
    const executor = vi.fn<CommandExecutor>().mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      output: "test output"
    });

    const result = await runCommandTool(root, session, { command: "npm test" }, { executor });

    expect(result).toEqual({ ok: true, output: "test output" });
    expect(executor).toHaveBeenCalledWith(root, { command: "npm test", timeoutMs: 120_000 });
    expect(session.commandResults).toEqual([
      {
        command: "npm test",
        exitCode: 0,
        timedOut: false,
        output: "test output"
      }
    ]);
  });

  it("blocks git reset --hard without invoking the executor", async () => {
    const root = await tempRoot();
    const session = createSession("blocked command");
    const executor = vi.fn<CommandExecutor>();

    const result = await runCommandTool(root, session, { command: "git reset --hard" }, { executor });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Destructive command");
    expect(executor).not.toHaveBeenCalled();
    expect(session.commandResults).toEqual([]);
  });

  it("creates snapshot diffs for non-Git workspaces", async () => {
    const root = await tempRoot();
    const session = createSession("change file");
    await writeFile(join(root, "a.txt"), "after\n");
    session.preEditSnapshots.set("a.txt", "before\n");
    session.filesModified.push("a.txt");

    const result = await runDiffTool(root, session, false);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("--- a/a.txt");
    expect(result.output).toContain("+++ b/a.txt");
    expect(result.output).toContain("-before");
    expect(result.output).toContain("+after");
  });

  it("shows removed duplicate lines in non-Git snapshot diffs", async () => {
    const root = await tempRoot();
    const session = createSession("remove duplicate line");
    await writeFile(join(root, "a.txt"), "same\n");
    session.preEditSnapshots.set("a.txt", "same\nsame\n");
    session.filesModified.push("a.txt");

    const result = await runDiffTool(root, session, false);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("--- a/a.txt");
    expect(result.output).toContain("-same");
  });

  it("shows added duplicate lines in non-Git snapshot diffs", async () => {
    const root = await tempRoot();
    const session = createSession("add duplicate line");
    await writeFile(join(root, "a.txt"), "same\nsame\n");
    session.preEditSnapshots.set("a.txt", "same\n");
    session.filesModified.push("a.txt");

    const result = await runDiffTool(root, session, false);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("--- a/a.txt");
    expect(result.output).toContain("+same");
  });

  it("shows reordered lines in non-Git snapshot diffs", async () => {
    const root = await tempRoot();
    const session = createSession("reorder lines");
    await writeFile(join(root, "a.txt"), "second\nfirst\n");
    session.preEditSnapshots.set("a.txt", "first\nsecond\n");
    session.filesModified.push("a.txt");

    const result = await runDiffTool(root, session, false);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("--- a/a.txt");
    expect(result.output).toMatch(/^[+-](first|second)$/m);
  });

  it("omits large non-Git snapshot diffs with a clear summary", async () => {
    const root = await tempRoot();
    const session = createSession("large diff");
    const before = Array.from({ length: 350 }, (_, index) => `before-${index}`).join("\n") + "\n";
    const after = Array.from({ length: 350 }, (_, index) => `after-${index}`).join("\n") + "\n";
    await writeFile(join(root, "large.txt"), after);
    session.preEditSnapshots.set("large.txt", before);
    session.filesModified.push("large.txt");

    const result = await runDiffTool(root, session, false);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("large.txt");
    expect(result.output).toContain("Large diff omitted");
    expect(result.output).toContain("before 350 lines");
    expect(result.output).toContain("after 350 lines");
  });
});

describe("tool router", () => {
  it("dispatches search tool calls and records observations", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "a.ts"), "const parseUser = true;\n");
    const session = createSession("search");

    const result = await dispatchToolCall(root, session, {
      type: "tool_call",
      tool: "search",
      args: { query: "parseUser" }
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("a.ts:1");
    expect(session.observations).toEqual([{ tool: "search", ok: true, output: result.output }]);
  });

  it("rejects invalid args and records failed observations", async () => {
    const root = await tempRoot();
    const session = createSession("search");

    const result = await dispatchToolCall(root, session, {
      type: "tool_call",
      tool: "search",
      args: { query: 123 }
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("search.query");
    expect(session.observations).toEqual([{ tool: "search", ok: false, output: result.output }]);
    expect(session.errors).toEqual([result.output]);
  });

  it("dispatches edit_file with validated string args", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "a.ts"), "export const value = 1;\n");
    const session = createSession("edit");

    const result = await dispatchToolCall(root, session, {
      type: "tool_call",
      tool: "edit_file",
      args: {
        path: "a.ts",
        search: "export const value = 1;",
        replace: "export const value = 2;"
      }
    });

    expect(result.ok).toBe(true);
    expect(await readFile(join(root, "a.ts"), "utf8")).toContain("value = 2");
    expect(session.filesModified).toEqual(["a.ts"]);
  });
});
