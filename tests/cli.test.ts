import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHelpText } from "../src/index.js";
import { formatPlan, handleSlashCommand } from "../src/cli.js";

const tempRoots: string[] = [];
const configEnvKeys = ["CODE_AGENT_BASE_URL", "CODE_AGENT_API_KEY", "CODE_AGENT_MODEL"] as const;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-agent-cli-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  );
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

  it("writes a config error and continues when config is missing", async () => {
    const root = await tempRoot();
    const output: string[] = [];

    await withClearedConfigEnv(async () => {
      const result = await handleSlashCommand("/config", { root, write: (line) => output.push(line) });

      expect(result).toBe("continue");
      expect(output.join("\n")).toContain("Missing CODE_AGENT");
    });
  });

  it("writes masked config and continues when config is present", async () => {
    const root = await tempRoot();
    const output: string[] = [];
    await mkdir(join(root, ".code-agent"));
    await writeFile(join(root, ".code-agent", "config.json"), JSON.stringify({
      baseURL: "https://llm.example/v1",
      apiKey: "sk-test-secret",
      model: "test-model"
    }));

    await withClearedConfigEnv(async () => {
      const result = await handleSlashCommand("/config", { root, write: (line) => output.push(line) });

      expect(result).toBe("continue");
      expect(output.join("\n")).toContain('"apiKey": "sk-...cret"');
      expect(output.join("\n")).toContain('"model": "test-model"');
      expect(output.join("\n")).not.toContain("sk-test-secret");
    });
  });

  it("writes a clear diff message outside Git workspaces", async () => {
    const root = await tempRoot();
    const output: string[] = [];

    const result = await handleSlashCommand("/diff", { root, write: (line) => output.push(line) });

    expect(result).toBe("continue");
    expect(output.join("\n")).toContain(
      "Diff is only available for Git workspaces or files modified during the current task."
    );
  });

  it("contains diff command failures and continues", async () => {
    const root = await tempRoot();
    const output: string[] = [];
    await writeFile(join(root, "package.json"), "{ bad json");

    const result = await handleSlashCommand("/diff", { root, write: (line) => output.push(line) });

    expect(result).toBe("continue");
    expect(output.join("\n")).toContain("Command failed:");
  });

  it("exits cleanly when piped input closes after a contained slash command failure", async () => {
    const root = await tempRoot();

    const result = await runCliProcess(root, "/config\n");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Missing CODE_AGENT");
    expect(result.stderr).not.toContain("code-agent failed");
  });

  it("continues after unknown commands", async () => {
    const root = await tempRoot();
    const output: string[] = [];

    const result = await handleSlashCommand("/bogus", { root, write: (line) => output.push(line) });

    expect(result).toBe("continue");
    expect(output.join("\n")).toContain("Unknown command");
  });

  it("keeps index help stable", () => {
    expect(buildHelpText()).toContain("code-agent \"describe a small coding task\"");
  });
});

async function withClearedConfigEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = new Map(configEnvKeys.map((key) => [key, process.env[key]]));
  for (const key of configEnvKeys) {
    delete process.env[key];
  }

  try {
    return await fn();
  } finally {
    for (const key of configEnvKeys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function runCliProcess(root: string, stdin: string): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const key of configEnvKeys) {
    delete env[key];
  }

  const child = spawn(process.execPath, [
    join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    join(process.cwd(), "src", "index.ts")
  ], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  child.stdin.end(stdin);

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });
  });
}
