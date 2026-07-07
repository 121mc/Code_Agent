import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "../src/session.js";
import { runEditFileTool, runReadFileTool, runSearchTool } from "../src/tools/file-tools.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-tools-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file tools", () => {
  it("searches text files inside the workspace", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parser.ts"), "export function parseUser() { return null; }\n");

    const result = await runSearchTool(root, { query: "parseUser" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("parser.ts:1");
  });

  it("reads a workspace file", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parser.ts"), "hello\n");

    const result = await runReadFileTool(root, { path: "parser.ts" });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello\n");
  });

  it("blocks reads outside the workspace", async () => {
    const root = await tempRoot();

    const result = await runReadFileTool(root, { path: "../outside.txt" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
  });

  it("applies exact small edits and records snapshots", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parser.ts"), "export const value = 1;\n");
    const session = createSession("change value");

    const result = await runEditFileTool(root, session, {
      path: "parser.ts",
      search: "export const value = 1;",
      replace: "export const value = 2;"
    });

    expect(result.ok).toBe(true);
    expect(session.filesModified).toEqual(["parser.ts"]);
    expect(session.preEditSnapshots.get("parser.ts")).toBe("export const value = 1;\n");
  });
});
