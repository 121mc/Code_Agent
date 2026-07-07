import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, normalize, relative } from "node:path";
import { classifyFileAction, isPathInsideRoot, resolveWorkspacePath } from "../permissions.js";
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

export interface FileToolOptions {
  skipPermissionCheck?: boolean;
  approvedRealPath?: string;
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const MAX_READ_BYTES = 256_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface WorkspaceFile {
  path: string;
  relativePath: string;
}

export async function runSearchTool(root: string, args: SearchArgs): Promise<ToolResult> {
  if (!args.query.trim()) {
    return { ok: false, output: "Search query must not be empty." };
  }

  try {
    const rootRealPath = await realpath(root);
    const lines: string[] = [];

    for await (const file of walkTextFiles(rootRealPath, rootRealPath)) {
      const content = await readSmallTextFile(file.path);
      if (content === undefined) {
        continue;
      }

      content.split(/\r?\n/).forEach((line, index) => {
        if (line.includes(args.query)) {
          lines.push(`${file.relativePath}:${index + 1}: ${line}`);
        }
      });
    }

    return {
      ok: true,
      output: lines.length > 0 ? lines.join("\n") : "No matches found."
    };
  } catch (error) {
    return { ok: false, output: formatError("Search failed", error) };
  }
}

export async function runReadFileTool(
  root: string,
  args: ReadFileArgs,
  session?: SessionState,
  options: FileToolOptions = {}
): Promise<ToolResult> {
  const workspaceFile = await resolveWorkspaceFile(root, args.path, "read", options);
  if (!workspaceFile.ok) {
    return workspaceFile.result;
  }

  const content = await readWorkspaceTextFile(workspaceFile.file);
  if (!content.ok) {
    return content.result;
  }

  session && recordReadFile(session, workspaceFile.file.relativePath);
  return { ok: true, output: content.text };
}

export async function runEditFileTool(
  root: string,
  session: SessionState,
  args: EditFileArgs,
  options: FileToolOptions = {}
): Promise<ToolResult> {
  if (!args.search) {
    return { ok: false, output: "Edit search text must not be empty." };
  }

  const workspaceFile = await resolveWorkspaceFile(root, args.path, "edit", options);
  if (!workspaceFile.ok) {
    return workspaceFile.result;
  }

  const content = await readWorkspaceTextFile(workspaceFile.file);
  if (!content.ok) {
    return content.result;
  }

  const before = content.text;
  if (!before.includes(args.search)) {
    return { ok: false, output: `Search text was not found in ${workspaceFile.file.relativePath}.` };
  }

  const after = before.replace(args.search, args.replace);
  recordModifiedFile(session, workspaceFile.file.relativePath, before);

  try {
    await writeFile(workspaceFile.file.path, after);
  } catch (error) {
    return { ok: false, output: formatError(`Failed to edit ${workspaceFile.file.relativePath}`, error) };
  }

  return { ok: true, output: `Edited ${workspaceFile.file.relativePath}.` };
}

async function* walkTextFiles(rootRealPath: string, directory: string): AsyncGenerator<WorkspaceFile> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        yield* walkTextFiles(rootRealPath, join(directory, entry.name));
      }
      continue;
    }

    if (entry.isFile() && isLikelyTextFile(entry.name)) {
      const path = join(directory, entry.name);
      const file = await resolveSearchFile(rootRealPath, path);
      if (file !== undefined) {
        yield file;
      }
    }
  }
}

async function resolveWorkspaceFile(
  root: string,
  requestedPath: string,
  action: "read" | "edit",
  options: FileToolOptions
): Promise<{ ok: true; file: WorkspaceFile } | { ok: false; result: ToolResult }> {
  const permission = classifyFileAction(root, requestedPath, action);
  if (permission.decision === "block" || (permission.decision === "confirm" && !options.skipPermissionCheck)) {
    return { ok: false, result: { ok: false, output: permission.reason } };
  }

  try {
    const rootRealPath = await realpath(root);
    const resolved = resolveWorkspacePath(root, requestedPath);
    const candidateRealPath = await realpath(resolved);

    if (!isPathInsideRoot(rootRealPath, candidateRealPath)) {
      return { ok: false, result: { ok: false, output: "Path is outside the workspace." } };
    }

    if (options.approvedRealPath && !sameRealPath(candidateRealPath, options.approvedRealPath)) {
      return { ok: false, result: { ok: false, output: "Approved file target changed before execution." } };
    }

    const relativePath = toWorkspaceRelativePath(rootRealPath, candidateRealPath);
    const realPermission = classifyFileAction(rootRealPath, relativePath, action);
    if (realPermission.decision === "block" || (realPermission.decision === "confirm" && !options.skipPermissionCheck)) {
      return { ok: false, result: { ok: false, output: realPermission.reason } };
    }

    return {
      ok: true,
      file: {
        path: candidateRealPath,
        relativePath
      }
    };
  } catch (error) {
    return { ok: false, result: { ok: false, output: formatError(`Unable to access ${requestedPath}`, error) } };
  }
}

async function resolveSearchFile(rootRealPath: string, filePath: string): Promise<WorkspaceFile | undefined> {
  try {
    const fileRealPath = await realpath(filePath);
    if (!isPathInsideRoot(rootRealPath, fileRealPath)) {
      return undefined;
    }

    const relativePath = toWorkspaceRelativePath(rootRealPath, fileRealPath);
    const permission = classifyFileAction(rootRealPath, relativePath, "read");
    if (permission.decision !== "allow") {
      return undefined;
    }

    return {
      path: fileRealPath,
      relativePath
    };
  } catch {
    return undefined;
  }
}

async function readWorkspaceTextFile(
  file: WorkspaceFile
): Promise<{ ok: true; text: string } | { ok: false; result: ToolResult }> {
  let fileStat;
  try {
    fileStat = await stat(file.path);
  } catch (error) {
    return { ok: false, result: { ok: false, output: formatError(`Unable to access ${file.relativePath}`, error) } };
  }

  if (!fileStat.isFile()) {
    return { ok: false, result: { ok: false, output: `${file.relativePath} is not a file.` } };
  }

  if (fileStat.size > MAX_READ_BYTES) {
    return { ok: false, result: { ok: false, output: `File is too large to read automatically: ${file.relativePath}` } };
  }

  let content;
  try {
    content = await readFile(file.path);
  } catch (error) {
    return { ok: false, result: { ok: false, output: formatError(`Unable to read ${file.relativePath}`, error) } };
  }

  if (hasNullByte(content)) {
    return { ok: false, result: { ok: false, output: `File appears to be binary: ${file.relativePath}` } };
  }

  const text = decodeUtf8(content);
  if (text === undefined) {
    return { ok: false, result: { ok: false, output: `File is not valid UTF-8 text: ${file.relativePath}` } };
  }

  return { ok: true, text };
}

async function readSmallTextFile(filePath: string): Promise<string | undefined> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_READ_BYTES) {
      return undefined;
    }

    const content = await readFile(filePath);
    return hasNullByte(content) ? undefined : decodeUtf8(content);
  } catch {
    return undefined;
  }
}

function toWorkspaceRelativePath(rootRealPath: string, filePath: string): string {
  return relative(rootRealPath, filePath).replace(/\\/g, "/");
}

function sameRealPath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function decodeUtf8(content: Buffer): string | undefined {
  try {
    return UTF8_DECODER.decode(content);
  } catch {
    return undefined;
  }
}

function formatError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
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
