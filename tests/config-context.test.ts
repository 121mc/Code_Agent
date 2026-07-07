import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelConfig, maskConfigForDisplay } from "../src/config.js";
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
  it("loads environment configuration and masks secrets for display", async () => {
    const root = await tempRoot();
    const config = await loadModelConfig(root, {
      CODE_AGENT_BASE_URL: "https://llm.example/v1",
      CODE_AGENT_API_KEY: "sk-test-secret",
      CODE_AGENT_MODEL: "test-model"
    });

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

  it("loads .code-agent/config.json when env values are absent", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".code-agent"));
    await writeFile(join(root, ".code-agent", "config.json"), JSON.stringify({
      baseURL: "https://local.example/v1",
      apiKey: "local-key",
      model: "local-model"
    }));

    await expect(loadModelConfig(root, {})).resolves.toEqual({
      baseURL: "https://local.example/v1",
      apiKey: "local-key",
      model: "local-model"
    });
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
