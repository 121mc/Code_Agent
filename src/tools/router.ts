import type { ToolCallResponse } from "../protocol.js";
import { recordObservation, type SessionState } from "../session.js";
import { runEditFileTool, runReadFileTool, runSearchTool, type ToolResult } from "./file-tools.js";
import { runCommandTool, runDiffTool } from "./process-tools.js";

export interface RouterOptions {
  isGitRepository?: boolean;
}

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
      return dispatchReadFile(root, session, call.args);
    case "edit_file":
      return dispatchEditFile(root, session, call.args);
    case "run_command":
      return dispatchRunCommand(root, call.args);
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
  args: Record<string, unknown>
): Promise<ToolResult> | ToolResult {
  if (typeof args.path !== "string") {
    return { ok: false, output: "read_file.path must be a string." };
  }

  return runReadFileTool(root, { path: args.path }, session);
}

function dispatchEditFile(
  root: string,
  session: SessionState,
  args: Record<string, unknown>
): Promise<ToolResult> | ToolResult {
  if (
    typeof args.path !== "string" ||
    typeof args.search !== "string" ||
    typeof args.replace !== "string"
  ) {
    return { ok: false, output: "edit_file.path, edit_file.search, and edit_file.replace must be strings." };
  }

  return runEditFileTool(root, session, {
    path: args.path,
    search: args.search,
    replace: args.replace
  });
}

function dispatchRunCommand(root: string, args: Record<string, unknown>): Promise<ToolResult> | ToolResult {
  if (typeof args.command !== "string") {
    return { ok: false, output: "run_command.command must be a string." };
  }

  return runCommandTool(root, { command: args.command });
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
