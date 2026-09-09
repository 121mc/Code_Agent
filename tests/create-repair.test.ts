import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentTask } from "../src/agent.js";
import { loadAgentLimits } from "../src/config.js";
import { loadProjectContext } from "../src/project-context.js";
import { createSession } from "../src/session.js";
import { dispatchToolCall } from "../src/tools/router.js";
import { runDiffTool } from "../src/tools/process-tools.js";

const execute = promisify(execFile);
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "code-agent-create-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const create = (path: string, content = "hello\n") => ({ type: "tool_call" as const, tool: "create_file" as const, args: { path, content } });

describe("creating files", () => {
  it("creates nested and empty files, records changes and refuses overwrites", async () => {
    const root = await fixture();
    const session = createSession("create files");
    expect((await dispatchToolCall(root, session, create("solutions/nested/main.ts"))).ok).toBe(true);
    expect((await dispatchToolCall(root, session, create("empty.txt", ""))).ok).toBe(true);
    expect(await readFile(join(root, "solutions/nested/main.ts"), "utf8")).toBe("hello\n");
    expect(session.filesCreated).toEqual(["solutions/nested/main.ts", "empty.txt"]);
    expect((await dispatchToolCall(root, session, create("solutions/nested/main.ts", "overwrite"))).ok).toBe(false);
    expect(await readFile(join(root, "solutions/nested/main.ts"), "utf8")).toBe("hello\n");
    expect((await runDiffTool(root, session, false)).output).toContain("+hello");
  });

  it("blocks escapes and junctions, including dangling file symlinks", async () => {
    const root = await fixture();
    const outside = await fixture();
    await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await symlink(join(outside, "missing.txt"), join(root, "dangling.txt"), "file");
    for (const path of ["../escape.txt", "linked/sub/new.txt", "dangling.txt", "node_modules/new.txt", ".git/new.txt"]) {
      const session = createSession("reject unsafe create");
      expect((await dispatchToolCall(root, session, create(path))).ok).toBe(false);
      expect(session.filesModified).toEqual([]);
    }
    await expect(readFile(join(outside, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outside, "sub/new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces sensitive-file and size/count approval before creating directories", async () => {
    const root = await fixture();
    const session = createSession("approval");
    expect((await dispatchToolCall(root, session, create("new/.env"))).ok).toBe(false);
    await expect(readFile(join(root, "new/.env"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await dispatchToolCall(root, session, create("new/.env"), { confirm: async () => true })).ok).toBe(true);
    expect((await dispatchToolCall(root, session, create("large.txt", "x".repeat(5001)))).ok).toBe(false);
    expect((await dispatchToolCall(root, session, create("next.txt"), { maxModifiedFiles: 1 })).ok).toBe(false);
    expect(session.filesCreated).toEqual(["new/.env"]);
  });

  it("rechecks the target after confirmation", async () => {
    const root = await fixture();
    const outside = await fixture();
    const result = await dispatchToolCall(root, createSession("recheck"), create("nested/.env"), {
      confirm: async () => {
        await symlink(outside, join(root, "nested"), process.platform === "win32" ? "junction" : "dir");
        return true;
      }
    });
    expect(result.ok).toBe(false);
    await expect(readFile(join(outside, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("includes new files alongside tracked Git changes", async () => {
    const root = await fixture();
    await execute("git", ["init"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "before\n");
    await execute("git", ["add", "tracked.txt"], { cwd: root });
    await writeFile(join(root, "tracked.txt"), "after\n");
    const session = createSession("create in git");
    await dispatchToolCall(root, session, create("new.txt"));
    const diff = await runDiffTool(root, session, true);
    expect(diff.output).toContain("+after");
    expect(diff.output).toContain("+++ b/new.txt");
    expect(diff.output).toContain("+hello");
  });
});

describe("repair budgets", () => {
  it("creates code and tests and fixes real failing tests over multiple rounds", async () => {
    const root = await fixture();
    const responses = [
      { type: "plan", summary: "Implement value", steps: ["Create code and test", "Test and repair"] },
      create("solution.cjs", "module.exports = 0;\n"),
      create("solution.test.cjs", "const assert = require('node:assert/strict'); assert.equal(require('./solution.cjs'), 2);\n"),
      { type: "tool_call", tool: "run_command", args: { command: "node --test solution.test.cjs" } },
      { type: "tool_call", tool: "edit_file", args: { path: "solution.cjs", search: "= 0", replace: "= 1" } },
      { type: "tool_call", tool: "run_command", args: { command: "node --test solution.test.cjs" } },
      { type: "tool_call", tool: "edit_file", args: { path: "solution.cjs", search: "= 1", replace: "= 2" } },
      { type: "tool_call", tool: "run_command", args: { command: "node --test solution.test.cjs" } },
      { type: "final", summary: "Tests passed", tests: "", changedFiles: [] }
    ];
    const result = await runAgentTask({ userRequest: "implement value", context: await loadProjectContext(root),
      llm: { complete: async () => JSON.stringify(responses.shift()) } });
    expect(result.final.tests).toBe("node --test solution.test.cjs exited 0");
    expect(result.session.automaticRepairAttempts).toBe(2);
    expect(result.session.commandResults.map(result => result.exitCode)).toEqual([1, 1, 0]);
    expect(result.final.changedFiles).toEqual(["solution.cjs", "solution.test.cjs"]);
  });

  it.each([0, 5])("stops at the configured repair budget %s, not the three-tool-failure limit", async (budget) => {
    const root = await fixture();
    let turns = 0;
    const result = await runAgentTask({ userRequest: "test", context: await loadProjectContext(root),
      maxAutomaticRepairAttempts: budget,
      llm: { complete: async () => JSON.stringify(turns++ === 0
        ? { type: "plan", summary: "test", steps: ["test"] }
        : { type: "tool_call", tool: "run_command", args: { command: "npm test" } }) },
      routerOptions: { commandExecutor: async () => ({ exitCode: 1, timedOut: false, output: "failed" }) }
    });
    expect(result.session.commandResults).toHaveLength(budget + 1);
    expect(result.session.automaticRepairAttempts).toBe(budget);
    expect(result.final.summary).toContain(`repair limit (${budget})`);
  });

  it("does not spend repair budget on a denied test command", async () => {
    const root = await fixture();
    let turns = 0;
    const result = await runAgentTask({ userRequest: "test", context: await loadProjectContext(root),
      llm: { complete: async () => JSON.stringify(turns++ === 0
        ? { type: "plan", summary: "test", steps: ["test"] }
        : { type: "tool_call", tool: "run_command", args: { command: "npm test && echo done" } }) }
    });
    expect(result.session.automaticRepairAttempts).toBe(0);
    expect(result.session.commandResults).toEqual([]);
    expect(result.final.summary).toContain("repeated tool failures");
  });

  it("loads optional limits from .env and rejects invalid values", async () => {
    const root = await fixture();
    expect(await loadAgentLimits(root)).toEqual({ maxAutomaticRepairAttempts: 5, maxToolCalls: 80, maxLlmTurns: 120 });
    await writeFile(join(root, ".env"), "CODE_AGENT_MAX_REPAIR_ATTEMPTS=9\nCODE_AGENT_MAX_TOOL_CALLS=150\nCODE_AGENT_MAX_LLM_TURNS=220\n");
    expect(await loadAgentLimits(root)).toEqual({ maxAutomaticRepairAttempts: 9, maxToolCalls: 150, maxLlmTurns: 220 });
    await writeFile(join(root, ".env"), "CODE_AGENT_MAX_REPAIR_ATTEMPTS=-1\n");
    await expect(loadAgentLimits(root)).rejects.toThrow("CODE_AGENT_MAX_REPAIR_ATTEMPTS");
  });
});
