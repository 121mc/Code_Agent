import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentRoot, loadModelConfig, maskConfigForDisplay } from "../src/config.js";
import { createInitialClaudeMd, loadProjectContext } from "../src/project-context.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("model configuration", () => {
  it("loads root .env configuration and masks secrets for display", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".env"), [
      'CODE_AGENT_BASE_URL=https://llm.example/v1',
      'CODE_AGENT_API_KEY="sk-test-secret"',
      'CODE_AGENT_MODEL=test-model'
    ].join("\n"));
    const config = await loadModelConfig(root);

    expect(config).toEqual({
      baseURL: "https://llm.example/v1",
      apiKey: "sk-test-secret",
      model: "test-model"
    });
    expect(maskConfigForDisplay(config)).toEqual({
      baseURL: "https://llm.example/v1",
      apiKey: "sk-...cret",
      model: "test-model"
    });
  });

  it("does not fall back to legacy JSON or process environment", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".code-agent"));
    await writeFile(join(root, ".code-agent", "config.json"), '{"apiKey":"legacy"}');
    await expect(loadModelConfig(root)).rejects.toThrow("Missing CODE_AGENT_BASE_URL");
  });

  it("supports BOM, CRLF, comments and quoted hash characters", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".env"), '\uFEFF# configuration\r\nCODE_AGENT_BASE_URL=https://example.com/v1\r\nCODE_AGENT_API_KEY="test#key=123"\r\nCODE_AGENT_MODEL=test-model # comment\r\n');
    await expect(loadModelConfig(root)).resolves.toEqual({
      baseURL: "https://example.com/v1", apiKey: "test#key=123", model: "test-model"
    });
  });

  it("locates the package root from source and compiled modules", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "package.json"), '{}');
    for (const folder of ["src", "dist/src"]) {
      await mkdir(join(root, folder), { recursive: true });
      const entry = join(root, folder, "config.js");
      await writeFile(entry, "");
      expect(getAgentRoot(pathToFileURL(entry).href)).toBe(root);
    }
  });

});

describe("project context", () => {
  it("loads Claude.md before CLAUDE.md", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "CLAUDE.md"), "Compatibility memory");
    await writeFile(join(root, "Claude.md"), "Canonical memory");

    const context = await loadProjectContext(root);

    expect(context.root).toBe(root);
    expect(context.memoryFileName).toBe("Claude.md");
    expect(context.memory).toBe("Canonical memory");
  });

  it("detects package manager and likely commands", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "pnpm-lock.yaml"), "");
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { test: "vitest run", build: "tsc -p tsconfig.json", lint: "eslint ." }
    }));

    const context = await loadProjectContext(root);

    expect(context.packageManager).toBe("pnpm");
    expect(context.likelyCommands).toEqual(["pnpm test", "pnpm run build", "pnpm run lint"]);
  });

  it("creates initial Claude.md content", async () => {
    const root = await tempRoot();

    await createInitialClaudeMd(root);

    const content = await readFile(join(root, "Claude.md"), "utf8");
    expect(content).toContain("# Project Memory");
    expect(content).toContain("Testing Commands");
  });
});
