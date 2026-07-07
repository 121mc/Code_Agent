import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHelpText } from "../src/index.js";
import { formatPlan, handleSlashCommand } from "../src/cli.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-cli-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("slash commands", () => {
  it("formats a plan for display before tool execution", () => {
    expect(formatPlan("Fix parser", ["Search parseUser", "Read files", "Edit implementation"])).toBe([
      "Plan:",
      "1. Search parseUser",
      "2. Read files",
      "3. Edit implementation"
    ].join("\n"));
  });

  it("shows help", async () => {
    const root = await tempRoot();
    const output: string[] = [];

    const result = await handleSlashCommand("/help", { root, write: (line) => output.push(line) });

    expect(result).toBe("continue");
    expect(output.join("\n")).toContain("/help");
  });

  it("creates Claude.md through init", async () => {
    const root = await tempRoot();
    const output: string[] = [];

    const result = await handleSlashCommand("/init", { root, write: (line) => output.push(line) });

    expect(result).toBe("continue");
    expect(output.join("\n")).toContain("Claude.md created");
  });

  it("exits on /exit", async () => {
    const root = await tempRoot();

    await expect(handleSlashCommand("/exit", { root, write: () => undefined })).resolves.toBe("exit");
  });

  it("keeps index help stable", () => {
    expect(buildHelpText()).toContain("code-agent \"describe a small coding task\"");
  });
});
