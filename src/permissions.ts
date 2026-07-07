import { isAbsolute, normalize, relative, resolve } from "node:path";

export type PermissionDecision = "allow" | "confirm" | "block";
export type FileAction = "read" | "edit";

export interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
}

const SENSITIVE_FILE_PATTERNS = [
  /(^|\/)\.env.*$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /^\.github(\/|$)/,
  /(^|\/).*\.pem$/,
  /(^|\/).*\.key$/,
  /(^|\/).*\.crt$/
];

const BLOCKED_DIR_SEGMENTS = [".git", "node_modules", "dist", "build"];

export function resolveWorkspacePath(root: string, requestedPath: string): string {
  return normalize(isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath));
}

export function isPathInsideRoot(root: string, candidatePath: string): boolean {
  const normalizedRoot = normalize(resolve(root));
  const normalizedCandidate = normalize(resolve(candidatePath));
  const pathFromRoot = relative(normalizedRoot, normalizedCandidate);

  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export function classifyFileAction(root: string, requestedPath: string, action: FileAction): PermissionResult {
  const resolved = resolveWorkspacePath(root, requestedPath);

  if (!isPathInsideRoot(root, resolved)) {
    return { decision: "block", reason: "Path is outside the workspace." };
  }

  const relativePath = relative(normalize(resolve(root)), resolved).replace(/\\/g, "/");
  const segments = relativePath.split("/").filter(Boolean);

  if (segments.some((segment) => BLOCKED_DIR_SEGMENTS.includes(segment))) {
    return { decision: "block", reason: "Path is in a blocked generated or internal directory." };
  }

  if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(relativePath))) {
    return { decision: "confirm", reason: `Sensitive file ${action} requires confirmation.` };
  }

  return { decision: "allow", reason: `Normal workspace file ${action} is allowed.` };
}

export function classifyCommand(command: string): PermissionResult {
  if (hasDestructiveCommand(command)) {
    return { decision: "block", reason: "Destructive command is blocked." };
  }

  if (hasShellControlSyntax(command)) {
    return { decision: "confirm", reason: "Shell chaining or redirection requires confirmation." };
  }

  const normalized = command.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  if (isAllowedLowRiskCommand(lower)) {
    return { decision: "allow", reason: "Test, lint, or build command is allowed." };
  }

  if (/^(npm|pnpm|yarn)\s+(install|add|remove|update|upgrade|ci)(\s|$)/.test(lower)) {
    return { decision: "confirm", reason: "Dependency changes require confirmation." };
  }

  if (/^(curl|wget|git\s+push|git\s+pull|git\s+fetch|git\s+checkout|git\s+switch|git\s+rebase)(\s|$)/.test(lower)) {
    return { decision: "confirm", reason: "Network, remote, or history command requires confirmation." };
  }

  if (/(\s|^)(sudo|doas|runas|powershell\s+-encodedcommand|pwsh\s+-encodedcommand)(\s|$)/.test(lower)) {
    return { decision: "confirm", reason: "Elevated or encoded command requires confirmation." };
  }

  return { decision: "confirm", reason: "Unrecognized command requires confirmation." };
}

function isAllowedLowRiskCommand(command: string): boolean {
  return (
    /^(npm|pnpm|yarn)\s+(?:run\s+)?test(?:\s|$)/.test(command) ||
    /^(npm|pnpm|yarn)\s+(run\s+build|run\s+lint|lint|build)$/.test(command) ||
    /^npx\s+(vitest|jest|mocha)(?:\s|$)/.test(command) ||
    /^node\s+--test(?:\s|$)/.test(command)
  );
}

function hasDestructiveCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return (
    hasDestructiveRmCommand(lower) ||
    hasDestructiveRemoveItemCommand(lower) ||
    [
      /\bgit\s+reset\s+--hard\b/,
      /\bdel\s+\//,
      /\brmdir\s+\/s\b/,
      /\brd\s+\/s\b/
    ].some((pattern) => pattern.test(lower))
  );
}

function hasShellControlSyntax(command: string): boolean {
  return /[\r\n;&|`<>]/.test(command) || command.includes("$(");
}

function hasDestructiveRmCommand(command: string): boolean {
  const rmCommandPattern = /(^|[\s;&|(`$])rm\b/g;
  let match: RegExpExecArray | null;

  while ((match = rmCommandPattern.exec(command)) !== null) {
    const commandTail = getCommandTail(command, match.index + match[0].length);
    if (hasRecursiveAndForceRmFlags(commandTail)) {
      return true;
    }
  }

  return false;
}

function hasRecursiveAndForceRmFlags(commandTail: string): boolean {
  const tokens = commandTail.trim().split(/\s+/).filter(Boolean);
  let hasRecursive = false;
  let hasForce = false;

  for (const token of tokens) {
    if (/^--recursive(?:=.*)?$/.test(token)) {
      hasRecursive = true;
    } else if (/^--force(?:=.*)?$/.test(token)) {
      hasForce = true;
    } else if (/^-[a-z]+$/.test(token)) {
      hasRecursive = hasRecursive || token.includes("r");
      hasForce = hasForce || token.includes("f");
    }
  }

  return hasRecursive && hasForce;
}

function hasDestructiveRemoveItemCommand(command: string): boolean {
  const removeItemPattern = /(^|[\s;&|(`$])remove-item\b/g;
  let match: RegExpExecArray | null;

  while ((match = removeItemPattern.exec(command)) !== null) {
    const commandTail = getCommandTail(command, match.index + match[0].length);
    if (/(^|\s)-(r|re|rec|recu|recur|recurs|recurse|recursive)(?=$|\s|:)/.test(commandTail)) {
      return true;
    }
  }

  return false;
}

function getCommandTail(command: string, startIndex: number): string {
  return command.slice(startIndex).split(/[\r\n;&|`<>)]/, 1)[0] ?? "";
}
