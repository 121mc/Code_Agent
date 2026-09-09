import { readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { DEFAULT_AGENT_LIMITS, validateLimit } from "./limits.js";

export async function loadAgentLimits(configRoot = getAgentRoot()) {
  const env = await readConfigFile(join(configRoot, ".env"));
  const read = (key: string, fallback: number, minimum = 1) => {
    const value = env[key];
    return value === undefined ? fallback : validateLimit(key, value.trim() ? Number(value) : NaN, minimum);
  };
  return {
    maxAutomaticRepairAttempts: read("CODE_AGENT_MAX_REPAIR_ATTEMPTS", DEFAULT_AGENT_LIMITS.maxAutomaticRepairAttempts, 0),
    maxToolCalls: read("CODE_AGENT_MAX_TOOL_CALLS", DEFAULT_AGENT_LIMITS.maxToolCalls),
    maxLlmTurns: read("CODE_AGENT_MAX_LLM_TURNS", DEFAULT_AGENT_LIMITS.maxLlmTurns)
  };
}

export interface ModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface DisplayModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export function getAgentRoot(moduleUrl = import.meta.url): string {
  let directory = dirname(realpathSync(fileURLToPath(moduleUrl)));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate code-agent package root.");
    directory = parent;
  }
  return directory;
}

// The optional root is for isolated configuration tests, never the task workspace.
export async function loadModelConfig(configRoot = getAgentRoot()): Promise<ModelConfig> {
  const envPath = join(configRoot, ".env");
  const env = await readConfigFile(envPath);
  const baseURL = env.CODE_AGENT_BASE_URL;
  const apiKey = env.CODE_AGENT_API_KEY;
  const model = env.CODE_AGENT_MODEL;

  if (!baseURL) {
    throw new Error(`Missing CODE_AGENT_BASE_URL in ${envPath}.`);
  }
  if (!apiKey) {
    throw new Error(`Missing CODE_AGENT_API_KEY in ${envPath}.`);
  }
  if (!model) {
    throw new Error(`Missing CODE_AGENT_MODEL in ${envPath}.`);
  }

  return { baseURL, apiKey, model };
}

export function maskConfigForDisplay(config: ModelConfig): DisplayModelConfig {
  return {
    baseURL: config.baseURL,
    apiKey: maskSecret(config.apiKey),
    model: config.model
  };
}

async function readConfigFile(envPath: string): Promise<Record<string, string | undefined>> {
  try {
    const raw = await readFile(envPath, "utf8");
    return parseEnv(raw.replace(/^\uFEFF/, ""));
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return "***";
  }

  return `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}
