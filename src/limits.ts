export const DEFAULT_AGENT_LIMITS = {
  maxAutomaticRepairAttempts: 5,
  maxToolCalls: 80,
  maxLlmTurns: 120
};

export function validateLimit(name: string, value: number, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  return value;
}
