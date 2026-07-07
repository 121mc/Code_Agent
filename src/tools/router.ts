import { normalize } from "node:path";
import type { ToolCallResponse } from "../protocol.js";
import { classifyCommand, classifyFileAction, type PermissionResult } from "../permissions.js";
import { recordObservation, type SessionState } from "../session.js";
import { runEditFileTool, runReadFileTool, runSearchTool, type ToolResult } from "./file-tools.js";
import { runCommandTool, runDiffTool, type CommandExecutor } from "./process-tools.js";

export interface ConfirmationPrompt {
  kind: "file" | "command" | "limit";
  message: string;
}

export interface RouterOptions {
  confirm?: (prompt: ConfirmationPrompt) => Promise<boolean>;
  commandExecutor?: CommandExecutor;
  maxModifiedFiles?: number;
  isGitRepository?: boolean;
}

const DEFAULT_MAX_MODIFIED_FILES = 5;
const LARGE_PATCH_BYTES = 5_000;
const LARGE_PATCH_CHANGED_LINES = 120;

export async function dispatchToolCall(
  root: string,
  session: SessionState,
  call: ToolCallResponse,
  options: RouterOptions = {}
): Promise<ToolResult> {
  const result = await safeDispatch(root, session, call, options);
  recordObservation(session, { tool: call.tool, ok: result.ok, output: result.output });
  return result;
}

async function safeDispatch(
  root: string,
  session: SessionState,
  call: ToolCallResponse,
  options: RouterOptions
): Promise<ToolResult> {
  try {
    return await dispatch(root, session, call, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Tool ${call.tool} failed: ${message}` };
  }
}

async function dispatch(
  root: string,
  session: SessionState,
  call: ToolCallResponse,
  options: RouterOptions
): Promise<ToolResult> {
  switch (call.tool) {
    case "search":
      return dispatchSearch(root, call.args);
    case "read_file":
      return dispatchReadFile(root, session, call.args, options);
    case "edit_file":
      return dispatchEditFile(root, session, call.args, options);
    case "run_command":
      return dispatchRunCommand(root, session, call.args, options);
    case "diff":
      return dispatchDiff(root, session, call.args, options);
    default:
      return { ok: false, output: `Unsupported tool: ${String(call.tool)}` };
  }
}

function dispatchSearch(root: string, args: Record<string, unknown>): Promise<ToolResult> | ToolResult {
  if (typeof args.query !== "string") {
    return { ok: false, output: "search.query must be a string." };
  }

  return runSearchTool(root, { query: args.query });
}

function dispatchReadFile(
  root: string,
  session: SessionState,
  args: Record<string, unknown>,
  options: RouterOptions
): Promise<ToolResult> | ToolResult {
  if (typeof args.path !== "string") {
    return { ok: false, output: "read_file.path must be a string." };
  }

  return dispatchFileReadWithPermission(root, session, args.path, options);
}

async function dispatchFileReadWithPermission(
  root: string,
  session: SessionState,
  path: string,
  options: RouterOptions
): Promise<ToolResult> {
  const approval = await approvePermission(classifyFileAction(root, path, "read"), "file", options);
  if (!approval.ok) {
    return approval.result;
  }

  return runReadFileTool(root, { path }, session, {
    skipPermissionCheck: approval.skipPermissionCheck
  });
}

async function dispatchEditFile(
  root: string,
  session: SessionState,
  args: Record<string, unknown>,
  options: RouterOptions
): Promise<ToolResult> {
  if (
    typeof args.path !== "string" ||
    typeof args.search !== "string" ||
    typeof args.replace !== "string"
  ) {
    return { ok: false, output: "edit_file.path, edit_file.search, and edit_file.replace must be strings." };
  }

  const editArgs = {
    path: args.path,
    search: args.search,
    replace: args.replace
  };
  const approval = await approvePermission(classifyFileAction(root, editArgs.path, "edit"), "file", options);
  if (!approval.ok) {
    return approval.result;
  }

  const limitApproval = await approveEditLimits(session, editArgs, options);
  if (!limitApproval.ok) {
    return limitApproval.result;
  }

  return runEditFileTool(root, session, editArgs, {
    skipPermissionCheck: approval.skipPermissionCheck
  });
}

async function dispatchRunCommand(
  root: string,
  session: SessionState,
  args: Record<string, unknown>,
  options: RouterOptions
): Promise<ToolResult> {
  if (typeof args.command !== "string") {
    return { ok: false, output: "run_command.command must be a string." };
  }

  const approval = await approvePermission(classifyCommand(args.command), "command", options);
  if (!approval.ok) {
    return approval.result;
  }

  return runCommandTool(root, session, { command: args.command }, {
    executor: options.commandExecutor,
    skipPermissionCheck: approval.skipPermissionCheck
  });
}

function dispatchDiff(
  root: string,
  session: SessionState,
  args: Record<string, unknown>,
  options: RouterOptions
): Promise<ToolResult> | ToolResult {
  if (Object.keys(args).length > 0) {
    return { ok: false, output: "diff args must be an empty object." };
  }

  return runDiffTool(root, session, options.isGitRepository ?? false);
}

type ApprovalResult =
  | { ok: true; skipPermissionCheck: boolean }
  | { ok: false; result: ToolResult };

async function approvePermission(
  permission: PermissionResult,
  kind: "file" | "command",
  options: RouterOptions
): Promise<ApprovalResult> {
  if (permission.decision === "block") {
    return { ok: false, result: { ok: false, output: permission.reason } };
  }

  if (permission.decision === "allow") {
    return { ok: true, skipPermissionCheck: false };
  }

  const approved = await requestConfirmation(options, { kind, message: permission.reason });
  if (!approved.ok) {
    return approved;
  }

  return { ok: true, skipPermissionCheck: true };
}

async function approveEditLimits(
  session: SessionState,
  args: { path: string; search: string; replace: string },
  options: RouterOptions
): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
  const maxModifiedFiles = options.maxModifiedFiles ?? DEFAULT_MAX_MODIFIED_FILES;
  const pathKey = normalizeWorkspacePath(args.path);
  if (maxModifiedFiles >= 0 && !session.filesModified.includes(pathKey) && session.filesModified.length >= maxModifiedFiles) {
    const approved = await requestConfirmation(options, {
      kind: "limit",
      message: `Editing ${args.path} would modify more than ${maxModifiedFiles} files in this session.`
    });
    if (!approved.ok) {
      return approved;
    }
  }

  const patchBytes = Buffer.byteLength(args.search, "utf8") + Buffer.byteLength(args.replace, "utf8");
  const changedLines = countChangedLines(args.search, args.replace);
  if (patchBytes > LARGE_PATCH_BYTES || changedLines > LARGE_PATCH_CHANGED_LINES) {
    const approved = await requestConfirmation(options, {
      kind: "limit",
      message: `Large edit requires confirmation: ${patchBytes} bytes and ${changedLines} changed lines.`
    });
    if (!approved.ok) {
      return approved;
    }
  }

  return { ok: true };
}

async function requestConfirmation(
  options: RouterOptions,
  prompt: ConfirmationPrompt
): Promise<{ ok: true } | { ok: false; result: ToolResult }> {
  const approved = options.confirm ? await options.confirm(prompt) : false;
  if (approved) {
    return { ok: true };
  }

  return {
    ok: false,
    result: {
      ok: false,
      output: `${prompt.kind} action was not approved: ${prompt.message}`
    }
  };
}

function normalizeWorkspacePath(path: string): string {
  return normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function countChangedLines(search: string, replace: string): number {
  return countLines(search) + countLines(replace);
}

function countLines(text: string): number {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}
