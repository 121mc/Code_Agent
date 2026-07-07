import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { classifyFileAction, resolveWorkspacePath } from "../permissions.js";
import { recordModifiedFile, recordReadFile, type SessionState } from "../session.js";

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface SearchArgs {
  query: string;
}

export interface ReadFileArgs {
  path: string;
}

export interface EditFileArgs {
  path: string;
  search: string;
  replace: string;
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const MAX_READ_BYTES = 256_000;

export async function runSearchTool(root: string, args: SearchArgs): Promise<ToolResult> {
  if (!args.query.trim()) {
    return { ok: false, output: "Search query must not be empty." };
  }

  const lines: string[] = [];
  for await (const filePath of walkTextFiles(root, root)) {
    const content = await readFile(filePath, "utf8");
    content.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(args.query)) {
        lines.push(`${relative(root, filePath)}:${index + 1}: ${line}`);
      }
    });
  }

  return {
    ok: true,
    output: lines.length > 0 ? lines.join("\n") : "No matches found."
  };
}

export async function runReadFileTool(
  root: string,
  args: ReadFileArgs,
  session?: SessionState
): Promise<ToolResult> {
  const permission = classifyFileAction(root, args.path, "read");
  if (permission.decision !== "allow") {
    return { ok: false, output: permission.reason };
  }

  const resolved = resolveWorkspacePath(root, args.path);
  const fileStat = await stat(resolved);
  if (fileStat.size > MAX_READ_BYTES) {
    return { ok: false, output: `File is too large to read automatically: ${args.path}` };
  }

  const content = await readFile(resolved, "utf8");
  session && recordReadFile(session, args.path);
  return { ok: true, output: content };
}

export async function runEditFileTool(
  root: string,
  session: SessionState,
  args: EditFileArgs
): Promise<ToolResult> {
  const permission = classifyFileAction(root, args.path, "edit");
  if (permission.decision !== "allow") {
    return { ok: false, output: permission.reason };
  }

  if (!args.search) {
    return { ok: false, output: "Edit search text must not be empty." };
  }

  const resolved = resolveWorkspacePath(root, args.path);
  const before = await readFile(resolved, "utf8");
  if (!before.includes(args.search)) {
    return { ok: false, output: `Search text was not found in ${args.path}.` };
  }

  const after = before.replace(args.search, args.replace);
  await writeFile(resolved, after);
  recordModifiedFile(session, args.path, before);

  return { ok: true, output: `Edited ${args.path}.` };
}

async function* walkTextFiles(root: string, directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        yield* walkTextFiles(root, join(directory, entry.name));
      }
      continue;
    }

    if (entry.isFile() && isLikelyTextFile(entry.name)) {
      const path = join(directory, entry.name);
      const permission = classifyFileAction(root, relative(root, path), "read");
      if (permission.decision === "allow") {
        yield path;
      }
    }
  }
}

function isLikelyTextFile(fileName: string): boolean {
  if (fileName.startsWith(".env")) {
    return false;
  }

  const name = basename(fileName).toLowerCase();
  return ![
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".pdf",
    ".zip",
    ".gz",
    ".exe",
    ".dll"
  ].some((extension) => name.endsWith(extension));
}
