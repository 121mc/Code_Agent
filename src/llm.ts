import type { ModelConfig } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMClient {
  complete(messages: ChatMessage[]): Promise<string>;
}

export type FetchLike = typeof fetch;

const PROVIDER_ERROR_BODY_LIMIT = 1000;

export class OpenAICompatibleClient implements LLMClient {
  constructor(
    private readonly config: ModelConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const response = await this.fetchImpl(`${trimTrailingSlash(this.config.baseURL)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      const providerError = await readProviderErrorText(response);
      const detail = providerError ? `: ${providerError}` : "";
      throw new Error(`LLM request failed with HTTP ${response.status}${detail}.`);
    }

    const json = await parseJsonResponse(response);
    const content = json.choices?.[0]?.message?.content;

    if (typeof content !== "string") {
      throw new Error("LLM response did not include message content.");
    }

    return content;
  }
}

export function buildSystemPrompt(projectMemory: string): string {
  return [
    "You are a lightweight terminal coding agent.",
    "Use the custom JSON protocol exactly.",
    "Respond with one JSON object of type plan, tool_call, or final.",
    "After one plan response, continue with tool_call responses or final. Do not emit repeated plan responses.",
    "Never access files outside the workspace.",
    "Prefer small edits and relevant tests.",
    "",
    "Available tools and required args:",
    "- search args: { query: string } - Search workspace text files for exact text.",
    "- read_file args: { path: string } - Read one workspace-relative text file.",
    "- edit_file args: { path: string; search: string; replace: string } - Replace the first exact text match in one file.",
    "- run_command args: { command: string } - Run one allowed test, lint, or build command.",
    "- diff args: {} - Show the current workspace diff.",
    "",
    "Instruction priority:",
    "1. Built-in safety rules",
    "2. Current explicit user instructions",
    "3. Claude.md project instructions",
    "4. Agent default behavior",
    "",
    "Project memory:",
    projectMemory || "(none)"
  ].join("\n");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function readProviderErrorText(response: Response): Promise<string> {
  try {
    return capProviderErrorText((await response.text()).trim());
  } catch {
    return "";
  }
}

function capProviderErrorText(value: string): string {
  if (value.length <= PROVIDER_ERROR_BODY_LIMIT) {
    return value;
  }

  return `${value.slice(0, PROVIDER_ERROR_BODY_LIMIT)}...`;
}

async function parseJsonResponse(response: Response): Promise<{
  choices?: Array<{ message?: { content?: string } }>;
}> {
  try {
    return await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
  } catch {
    throw new Error("LLM response was not valid JSON.");
  }
}
