export interface ToolObservation {
  tool: string;
  ok: boolean;
  output: string;
}

export interface CommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export interface SessionState {
  userRequest: string;
  plan: string[];
  observations: ToolObservation[];
  filesRead: string[];
  filesModified: string[];
  preEditSnapshots: Map<string, string>;
  commandResults: CommandResult[];
  errors: string[];
  toolCallCount: number;
  consecutiveToolFailures: number;
  automaticRepairAttempts: number;
}

export function createSession(userRequest: string): SessionState {
  return {
    userRequest,
    plan: [],
    observations: [],
    filesRead: [],
    filesModified: [],
    preEditSnapshots: new Map<string, string>(),
    commandResults: [],
    errors: [],
    toolCallCount: 0,
    consecutiveToolFailures: 0,
    automaticRepairAttempts: 0
  };
}

export function recordObservation(session: SessionState, observation: ToolObservation): void {
  session.observations.push(observation);
  session.toolCallCount += 1;

  if (observation.ok) {
    session.consecutiveToolFailures = 0;
  } else {
    session.consecutiveToolFailures += 1;
    session.errors.push(observation.output);
  }
}

export function recordReadFile(session: SessionState, path: string): void {
  if (!session.filesRead.includes(path)) {
    session.filesRead.push(path);
  }
}

export function recordPreEditSnapshot(session: SessionState, path: string, snapshot: string): void {
  if (!session.preEditSnapshots.has(path)) {
    session.preEditSnapshots.set(path, snapshot);
  }
}

export function recordModifiedFile(session: SessionState, path: string): void {
  if (!session.filesModified.includes(path)) {
    session.filesModified.push(path);
  }
}
