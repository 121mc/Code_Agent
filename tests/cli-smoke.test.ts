import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildHelpText, isMainModule } from "../src/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI smoke behavior", () => {
  it("prints the expected command list in help text", () => {
    expect(buildHelpText()).toContain("code-agent");
    expect(buildHelpText()).toContain("/help");
    expect(buildHelpText()).toContain("/init");
    expect(buildHelpText()).toContain("/diff");
    expect(buildHelpText()).toContain("/status");
    expect(buildHelpText()).toContain("/config");
    expect(buildHelpText()).toContain("/exit");
  });

  it("recognizes the CLI entry through a linked directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-agent-entry-"));
    tempRoots.push(root);
    const realDirectory = join(root, "real");
    const linkedDirectory = join(root, "linked");
    await mkdir(realDirectory);
    await writeFile(join(realDirectory, "index.js"), "");
    await symlink(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");

    expect(isMainModule(
      pathToFileURL(join(realDirectory, "index.js")).href,
      join(linkedDirectory, "index.js")
    )).toBe(true);
  });
});
