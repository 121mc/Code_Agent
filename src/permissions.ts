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

  if (/^(npm|pnpm|yarn)\s+(test|run\s+test|run\s+build|run\s+lint|lint|build)$/.test(lower)) {
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

function hasDestructiveCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return [
    /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b/,
    /\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bdel\s+\//,
    /\brmdir\s+\/s\b/,
    /\brd\s+\/s\b/,
    /\bremove-item\b[\s\S]*\b-recurse\b/
  ].some((pattern) => pattern.test(lower));
}

function hasShellControlSyntax(command: string): boolean {
  return /[\r\n;&|`<>]/.test(command) || command.includes("$(");
}
