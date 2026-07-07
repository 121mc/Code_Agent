import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProjectContext {
  root: string;
  memoryFileName: "Claude.md" | "CLAUDE.md" | null;
  memory: string;
  isGitRepository: boolean;
  packageManager: "npm" | "pnpm" | "yarn" | "unknown";
  likelyCommands: string[];
  ignorePatterns: string[];
}

export const DEFAULT_IGNORE_PATTERNS = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".env",
  ".env.*"
];

export async function loadProjectContext(root = process.cwd()): Promise<ProjectContext> {
  const [memory, isGitRepository, packageManager, likelyCommands] = await Promise.all([
    loadMemory(root),
    detectGitRepository(root),
    detectPackageManager(root),
    detectLikelyCommands(root)
  ]);

  return {
    root,
    memoryFileName: memory.fileName,
    memory: memory.content,
    isGitRepository,
    packageManager,
    likelyCommands,
    ignorePatterns: DEFAULT_IGNORE_PATTERNS
  };
}

export async function createInitialClaudeMd(root = process.cwd()): Promise<"created" | "exists"> {
  const path = join(root, "Claude.md");
  if (await exists(path)) {
    return "exists";
  }

  await writeFile(path, [
    "# Project Memory",
    "",
    "## Project Conventions",
    "- Keep changes focused on the current task.",
    "- Prefer small, well-tested TypeScript modules.",
    "",
    "## Testing Commands",
    "- npm test",
    "- npm run build",
    "",
    "## Directory Notes",
    "- Source files live in src/.",
    "- Tests live in tests/.",
    "",
    "## Paths Not To Touch Without Confirmation",
    "- .env",
    "- .env.*",
    "- node_modules/",
    "- dist/"
  ].join("\n"));

  return "created";
}

async function loadMemory(root: string): Promise<{ fileName: ProjectContext["memoryFileName"]; content: string }> {
  const canonical = join(root, "Claude.md");
  if (await exists(canonical)) {
    return { fileName: "Claude.md", content: await readFile(canonical, "utf8") };
  }

  const compatibility = join(root, "CLAUDE.md");
  if (await exists(compatibility)) {
    return { fileName: "CLAUDE.md", content: await readFile(compatibility, "utf8") };
  }

  return { fileName: null, content: "" };
}

async function detectGitRepository(root: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(root: string): Promise<ProjectContext["packageManager"]> {
  if (await exists(join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await exists(join(root, "yarn.lock"))) {
    return "yarn";
  }
  if (await exists(join(root, "package-lock.json"))) {
    return "npm";
  }
  if (await exists(join(root, "package.json"))) {
    return "npm";
  }
  return "unknown";
}

async function detectLikelyCommands(root: string): Promise<string[]> {
  const packageJsonPath = join(root, "package.json");
  if (!(await exists(packageJsonPath))) {
    return [];
  }

  const packageManager = await detectPackageManager(root);
  const run = packageManager === "pnpm" ? "pnpm" : packageManager === "yarn" ? "yarn" : "npm";
  const raw = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
  const scripts = parsed.scripts ?? {};
  const commands: string[] = [];

  if (scripts.test) {
    commands.push(`${run} test`);
  }
  if (scripts.build) {
    commands.push(run === "npm" ? "npm run build" : `${run} run build`);
  }
  if (scripts.lint) {
    commands.push(run === "npm" ? "npm run lint" : `${run} run lint`);
  }

  return commands;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureConfigDirectory(root = process.cwd()): Promise<void> {
  await mkdir(join(root, ".code-agent"), { recursive: true });
}
