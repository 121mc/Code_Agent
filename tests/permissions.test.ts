import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  classifyCommand,
  classifyFileAction,
  isPathInsideRoot,
  resolveWorkspacePath
} from "../src/permissions.js";

describe("workspace path containment", () => {
  it("allows paths inside the root", () => {
    const root = resolve("repo");

    expect(isPathInsideRoot(root, join(root, "src", "index.ts"))).toBe(true);
  });

  it("blocks paths outside the root", () => {
    const root = resolve("repo");
    const outside = resolve("outside", "secrets.txt");

    expect(isPathInsideRoot(root, outside)).toBe(false);
  });

  it("resolves relative paths against the root", () => {
    const root = resolve("repo");

    expect(resolveWorkspacePath(root, join("src", "index.ts"))).toBe(join(root, "src", "index.ts"));
  });
});

describe("file permission classification", () => {
  it("allows normal source reads and edits", () => {
    const root = resolve("repo");

    expect(classifyFileAction(root, "src/index.ts", "read").decision).toBe("allow");
    expect(classifyFileAction(root, "tests/index.test.ts", "edit").decision).toBe("allow");
  });

  it("requires confirmation for sensitive files", () => {
    const root = resolve("repo");

    expect(classifyFileAction(root, ".env", "read").decision).toBe("confirm");
    expect(classifyFileAction(root, "config/.env", "read").decision).toBe("confirm");
    expect(classifyFileAction(root, "src/.env.local", "read").decision).toBe("confirm");
    expect(classifyFileAction(root, "package-lock.json", "edit").decision).toBe("confirm");
  });

  it("blocks files outside the workspace", () => {
    const root = resolve("repo");

    expect(classifyFileAction(root, "../secret.txt", "read").decision).toBe("block");
  });

  it("blocks files in generated or internal directories", () => {
    const root = resolve("repo");

    expect(classifyFileAction(root, ".git/config", "read").decision).toBe("block");
    expect(classifyFileAction(root, "node_modules/pkg/index.js", "read").decision).toBe("block");
    expect(classifyFileAction(root, "dist/index.js", "edit").decision).toBe("block");
  });
});

describe("command permission classification", () => {
  it.each([
    "npm test", "npm install left-pad", "python scripts/task.py", "git status",
    "curl https://example.com", "node scripts/custom-task.js", "npm test && npm run build",
    "echo hello > output.txt", "git reset --hard", "rm -rf generated", "pwsh -Command Get-Date"
  ])("allows shell commands without confirmation: %s", (command) => {
    expect(classifyCommand(command).decision).toBe("allow");
  });
  it.each(["", "  ", "echo\0bad"])("rejects invalid command text", (command) => {
    expect(classifyCommand(command).decision).toBe("block");
  });
});
