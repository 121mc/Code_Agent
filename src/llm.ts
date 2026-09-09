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

export interface NetworkOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export class OpenAICompatibleClient implements LLMClient {
  constructor(
    private readonly config: ModelConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly network: NetworkOptions = {}
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const response = await this.request({
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

  private async request(init: RequestInit): Promise<Response> {
    const endpoint = `${trimTrailingSlash(this.config.baseURL)}/chat/completions`;
    let hostname: string;
    try {
      const url = new URL(endpoint);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
      hostname = url.hostname;
    } catch {
      throw new Error("Invalid CODE_AGENT_BASE_URL in code-agent root .env; use an HTTP(S) API base URL without embedded credentials.");
    }
    const retries = this.network.retries ?? 2;
    const timeoutMs = this.network.timeoutMs ?? 120_000;
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        return await this.fetchImpl(endpoint, { ...init, signal });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const rawCode = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
        // Never echo arbitrary exception text: it can contain headers or credentials.
        const knownCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
          "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT",
          "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"]);
        const code = typeof rawCode === "string" && knownCodes.has(rawCode) ? rawCode : "NETWORK_ERROR";
        const timedOut = signal.aborted || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name));
        const transient = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "NETWORK_ERROR"].includes(code);
        if (!timedOut && transient && attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, (this.network.retryDelayMs ?? 500) * (attempt + 1)));
          continue;
        }
        const hint = timedOut ? `Request timed out after ${timeoutMs / 1000}s; retry or check the model service.`
          : code === "ENOTFOUND" || code === "EAI_AGAIN" ? "DNS lookup failed; check the base URL and DNS/network connection."
          : code.includes("CERT") || code.includes("SIGNATURE") ? "TLS certificate verification failed; check the server certificate and local trust configuration."
          : "Check the API service, network/firewall and proxy configuration, then retry.";
        throw new Error(`LLM connection to ${hostname} failed (${timedOut ? "TIMEOUT" : code}) after ${attempt + 1} attempt(s). ${hint}`);
      }
    }
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
    "Create missing solution and test files with create_file. Run tests and use failures to repair the code until tests pass or the repair budget is exhausted.",
    "",
    `Command shell: ${process.platform === "win32" ? "Windows cmd.exe (invoke powershell or pwsh explicitly for PowerShell syntax)" : "/bin/sh"}. Prefer non-interactive commands.`,
    "Available tools and required args:",
    "- search args: { query: string } - Search workspace text files for exact text.",
    "- read_file args: { path: string } - Read one workspace-relative text file.",
    "- create_file args: { path: string; content: string } - Create a new UTF-8 file, including missing parent directories. Never overwrites existing files; use edit_file for those.",
    "- edit_file args: { path: string; search: string; replace: string } - Replace the first exact text match in one file.",
    "- run_command args: { command: string } - Execute any shell command without confirmation, including scripts, dependency installation, network requests, Git, pipelines and redirection. Commands run in the task workspace with the current user permissions and a 120-second timeout.",
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
