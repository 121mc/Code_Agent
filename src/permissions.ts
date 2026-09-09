import { isAbsolute, normalize, relative, resolve } from "node:path";

export type PermissionDecision = "allow" | "confirm" | "block";
export type FileAction = "read" | "edit" | "create";

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
  if (!command.trim() || command.includes("\0")) {
    return { decision: "block", reason: "Command must be non-empty and contain no null bytes." };
  }
  return { decision: "allow", reason: "Shell commands are enabled without confirmation." };
}
