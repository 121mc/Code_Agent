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
  it("allows test, lint, and build commands", () => {
    expect(classifyCommand("npm test").decision).toBe("allow");
    expect(classifyCommand("pnpm run lint").decision).toBe("allow");
    expect(classifyCommand("npm run build").decision).toBe("allow");
  });

  it("requires confirmation for dependency and network commands", () => {
    expect(classifyCommand("npm install left-pad").decision).toBe("confirm");
    expect(classifyCommand("curl https://example.com").decision).toBe("confirm");
  });

  it("blocks destructive shell commands", () => {
    expect(classifyCommand("rm -rf /").decision).toBe("block");
    expect(classifyCommand("rm -fr /").decision).toBe("block");
    expect(classifyCommand("git reset --hard").decision).toBe("block");
  });

  it("blocks destructive commands embedded after low-risk commands", () => {
    expect(classifyCommand("npm test $(rm -rf dist)").decision).toBe("block");
    expect(classifyCommand("npm test\nrm -rf dist").decision).toBe("block");
    expect(classifyCommand("npm test && rm -rf /").decision).toBe("block");
    expect(classifyCommand("npm test; git reset --hard").decision).toBe("block");
  });

  it("requires confirmation for non-destructive shell chaining and substitution", () => {
    expect(classifyCommand("npm test && npm run build").decision).toBe("confirm");
    expect(classifyCommand("npm test $(echo ok)").decision).toBe("confirm");
  });

  it("requires confirmation for git remote and history commands", () => {
    expect(classifyCommand("git push").decision).toBe("confirm");
    expect(classifyCommand("git pull").decision).toBe("confirm");
    expect(classifyCommand("git fetch").decision).toBe("confirm");
    expect(classifyCommand("git rebase main").decision).toBe("confirm");
    expect(classifyCommand("git checkout main").decision).toBe("confirm");
  });

  it("requires confirmation for elevated and encoded commands", () => {
    expect(classifyCommand("sudo npm test").decision).toBe("confirm");
    expect(classifyCommand("powershell -EncodedCommand SQBFAFgA").decision).toBe("confirm");
    expect(classifyCommand("pwsh -EncodedCommand SQBFAFgA").decision).toBe("confirm");
  });

  it("requires confirmation for unrecognized commands", () => {
    expect(classifyCommand("node scripts/custom-task.js").decision).toBe("confirm");
  });
});
