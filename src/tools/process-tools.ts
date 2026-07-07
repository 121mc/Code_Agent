import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { classifyCommand } from "../permissions.js";
import type { SessionState } from "../session.js";
import type { ToolResult } from "./file-tools.js";

export type { ToolResult } from "./file-tools.js";

const execAsync = promisify(exec);
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DIFF_COMMAND_TIMEOUT_MS = 30_000;
const MAX_LCS_DIFF_CELLS = 100_000;

export interface RunCommandArgs {
  command: string;
  timeoutMs?: number;
}

export interface CommandExecutorResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export type CommandExecutor = (root: string, args: Required<RunCommandArgs>) => Promise<CommandExecutorResult>;

export async function runCommandTool(
  root: string,
  args: RunCommandArgs,
  executor: CommandExecutor = defaultCommandExecutor
): Promise<ToolResult> {
  const permission = classifyCommand(args.command);
  if (permission.decision !== "allow") {
    return { ok: false, output: permission.reason };
  }

  const result = await executor(root, {
    command: args.command,
    timeoutMs: args.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  });

  return {
    ok: result.exitCode === 0 && !result.timedOut,
    output: result.output
  };
}

export async function runDiffTool(
  root: string,
  session: SessionState,
  isGitRepository: boolean
): Promise<ToolResult> {
  if (isGitRepository) {
    try {
      const { stdout, stderr } = await execAsync("git diff --", {
        cwd: root,
        timeout: DIFF_COMMAND_TIMEOUT_MS,
        windowsHide: true
      });
      return { ok: true, output: stdout || stderr || "No diff." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `git diff failed: ${message}` };
    }
  }

  const chunks: string[] = [];
  for (const file of session.filesModified) {
    const before = session.preEditSnapshots.get(file);
    if (before === undefined) {
      continue;
    }

    try {
      const after = await readFile(join(root, file), "utf8");
      chunks.push(renderSimpleDiff(file, before, after));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: `Diff failed for ${file}: ${message}` };
    }
  }

  return { ok: true, output: chunks.length > 0 ? chunks.join("\n") : "No diff." };
}

export async function defaultCommandExecutor(
  root: string,
  args: Required<RunCommandArgs>
): Promise<CommandExecutorResult> {
  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd: root,
      timeout: args.timeoutMs,
      windowsHide: true
    });
    return { exitCode: 0, timedOut: false, output: stdout + stderr };
  } catch (error) {
    if (isExecError(error)) {
      return {
        exitCode: typeof error.code === "number" ? error.code : null,
        timedOut: error.killed === true,
        output: `${error.stdout ?? ""}${error.stderr ?? ""}` || error.message
      };
    }

    return {
      exitCode: null,
      timedOut: false,
      output: String(error)
    };
  }
}

export function renderSimpleDiff(file: string, before: string, after: string): string {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const lines = [`--- a/${file}`, `+++ b/${file}`];

  if (beforeLines.length * afterLines.length > MAX_LCS_DIFF_CELLS) {
    lines.push(`Large diff omitted for ${file}: before ${beforeLines.length} lines, after ${afterLines.length} lines.`);
    return lines.join("\n");
  }

  const lcs = buildLcsTable(beforeLines, afterLines);
  let beforeIndex = 0;
  let afterIndex = 0;

  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < afterLines.length &&
      (beforeIndex === beforeLines.length || lcs[beforeIndex][afterIndex + 1] >= lcs[beforeIndex + 1][afterIndex])
    ) {
      lines.push(`+${afterLines[afterIndex]}`);
      afterIndex += 1;
    } else if (beforeIndex < beforeLines.length) {
      lines.push(`-${beforeLines[beforeIndex]}`);
      beforeIndex += 1;
    }
  }

  return lines.join("\n");
}

function splitDiffLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function buildLcsTable(beforeLines: string[], afterLines: string[]): number[][] {
  const table = Array.from({ length: beforeLines.length + 1 }, () =>
    Array.from({ length: afterLines.length + 1 }, () => 0)
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex][afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? table[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(table[beforeIndex + 1][afterIndex], table[beforeIndex][afterIndex + 1]);
    }
  }

  return table;
}

export function isExecError(error: unknown): error is Error & {
  code?: number | string;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
} {
  return typeof error === "object" && error !== null && "message" in error;
}
