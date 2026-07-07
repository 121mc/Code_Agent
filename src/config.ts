import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

export async function loadModelConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<ModelConfig> {
  const fileConfig = await readConfigFile(root);

  const baseURL = env.CODE_AGENT_BASE_URL ?? fileConfig.baseURL;
  const apiKey = env.CODE_AGENT_API_KEY ?? fileConfig.apiKey;
  const model = env.CODE_AGENT_MODEL ?? fileConfig.model;

  if (!baseURL) {
    throw new Error("Missing CODE_AGENT_BASE_URL or .code-agent/config.json baseURL.");
  }
  if (!apiKey) {
    throw new Error("Missing CODE_AGENT_API_KEY or .code-agent/config.json apiKey.");
  }
  if (!model) {
    throw new Error("Missing CODE_AGENT_MODEL or .code-agent/config.json model.");
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

async function readConfigFile(root: string): Promise<Partial<ModelConfig>> {
  try {
    const raw = await readFile(join(root, ".code-agent", "config.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<ModelConfig>;
    return {
      baseURL: typeof parsed.baseURL === "string" ? parsed.baseURL : undefined,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined
    };
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
