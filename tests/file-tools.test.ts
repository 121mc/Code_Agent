import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/session.js";
import { runEditFileTool, runReadFileTool, runSearchTool } from "../src/tools/file-tools.js";

const tempRoots: string[] = [];
const MAX_READ_BYTES = 256_000;
const INVALID_UTF8_BYTES = Buffer.from([0xff, 0xfe, 0x41, 0x42, 0x43, 0xfd]);

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

  it("blocks reads through workspace symlinks that point outside the workspace", async () => {
    const root = await tempRoot();
    const outsideRoot = await tempRoot();
    const outsidePath = join(outsideRoot, "secret.txt");
    await writeFile(outsidePath, "secret\n");
    await symlink(outsidePath, join(root, "link.txt"), "file");

    const result = await runReadFileTool(root, { path: "link.txt" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
  });

  it("blocks reads outside the workspace", async () => {
    const root = await tempRoot();

    const result = await runReadFileTool(root, { path: "../outside.txt" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
  });

  it("returns a controlled error for missing file reads", async () => {
    const root = await tempRoot();

    const result = await runReadFileTool(root, { path: "missing.ts" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("missing.ts");
  });

  it("returns a controlled error for directory reads", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src"));

    const result = await runReadFileTool(root, { path: "src" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("not a file");
  });

  it("does not read oversized files during search", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "large.ts"), `needle${"x".repeat(MAX_READ_BYTES)}`);

    const result = await runSearchTool(root, { query: "needle" });

    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("large.ts:1");
  });

  it("rejects files with null bytes when reading", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "binary.dat"), Buffer.from([0x68, 0x00, 0x69]));

    const result = await runReadFileTool(root, { path: "binary.dat" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("binary");
  });

  it("rejects invalid UTF-8 files when reading", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "invalid.dat"), INVALID_UTF8_BYTES);

    const result = await runReadFileTool(root, { path: "invalid.dat" });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/binary|utf-?8|text/i);
  });

  it("skips invalid UTF-8 files during search", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "invalid.dat"), INVALID_UTF8_BYTES);

    const result = await runSearchTool(root, { query: "\uFFFD" });

    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("invalid.dat");
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

  it("blocks edits through workspace symlinks that point outside the workspace", async () => {
    const root = await tempRoot();
    const outsideRoot = await tempRoot();
    const outsidePath = join(outsideRoot, "secret.txt");
    await writeFile(outsidePath, "secret = 1;\n");
    await symlink(outsidePath, join(root, "link.txt"), "file");
    const session = createSession("change secret");

    const result = await runEditFileTool(root, session, {
      path: "link.txt",
      search: "secret = 1;",
      replace: "secret = 2;"
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
    expect(await readFile(outsidePath, "utf8")).toBe("secret = 1;\n");
    expect(session.filesModified).toEqual([]);
    expect(session.preEditSnapshots.size).toBe(0);
  });

  it("rejects oversized files before editing", async () => {
    const root = await tempRoot();
    const original = `export const value = 1;\n${"x".repeat(MAX_READ_BYTES)}`;
    await writeFile(join(root, "large.ts"), original);
    const session = createSession("change value");

    const result = await runEditFileTool(root, session, {
      path: "large.ts",
      search: "export const value = 1;",
      replace: "export const value = 2;"
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("too large");
    expect(await readFile(join(root, "large.ts"), "utf8")).toBe(original);
    expect(session.filesModified).toEqual([]);
  });

  it("rejects files with null bytes before editing", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "binary.dat"), Buffer.from([0x76, 0x00, 0x31]));
    const session = createSession("change binary");

    const result = await runEditFileTool(root, session, {
      path: "binary.dat",
      search: "v",
      replace: "w"
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("binary");
    expect(session.filesModified).toEqual([]);
  });

  it("rejects invalid UTF-8 files before editing without corrupting bytes", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "invalid.dat"), INVALID_UTF8_BYTES);
    const session = createSession("change invalid file");

    const result = await runEditFileTool(root, session, {
      path: "invalid.dat",
      search: "ABC",
      replace: "XYZ"
    });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/binary|utf-?8|text/i);
    expect(await readFile(join(root, "invalid.dat"))).toEqual(INVALID_UTF8_BYTES);
    expect(session.filesModified).toEqual([]);
    expect(session.preEditSnapshots.size).toBe(0);
  });

  it("records the pre-edit snapshot before reporting write failures", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "parser.ts"), "export const value = 1;\n");
    const session = createSession("handle write failure");
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      writeFile: vi.fn().mockRejectedValue(new Error("disk full"))
    }));

    try {
      const { runEditFileTool: runEditFileToolWithWriteFailure } = await import("../src/tools/file-tools.js");

      const result = await runEditFileToolWithWriteFailure(root, session, {
        path: "parser.ts",
        search: "export const value = 1;",
        replace: "export const value = 2;"
      });

      expect(result.ok).toBe(false);
      expect(result.output).toContain("disk full");
      expect(session.filesModified).toEqual([]);
      expect(session.preEditSnapshots.get("parser.ts")).toBe("export const value = 1;\n");
      expect(await readFile(join(root, "parser.ts"), "utf8")).toBe("export const value = 1;\n");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("records modified files by canonical workspace-relative path", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "parser.ts"), "export const value = 1;\n");
    const session = createSession("change aliased path");

    const result = await runEditFileTool(root, session, {
      path: "src/../parser.ts",
      search: "export const value = 1;",
      replace: "export const value = 2;"
    });

    expect(result.ok).toBe(true);
    expect(session.filesModified).toEqual(["parser.ts"]);
    expect(session.preEditSnapshots.get("parser.ts")).toBe("export const value = 1;\n");
  });
});
