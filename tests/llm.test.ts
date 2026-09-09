import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleClient, buildSystemPrompt } from "../src/llm.js";

describe("LLM client", () => {
  const config = { baseURL: "https://llm.example/v1", apiKey: "test-private-key", model: "test-model" };

  it("retries transient connection failures and succeeds", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
    const client = new OpenAICompatibleClient(config, fetcher, { retryDelayMs: 0 });
    await expect(client.complete([])).resolves.toBe("ok");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports the underlying code after bounded retries without leaking exception text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("test-private-key", { cause: { code: "UND_ERR_SOCKET", message: "test-private-key" } }));
    const client = new OpenAICompatibleClient(config, fetcher, { retryDelayMs: 0 });
    let message = "";
    try { await client.complete([]); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("UND_ERR_SOCKET");
    expect(message).toContain("3 attempt(s)");
    expect(message).not.toContain("test-private-key");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not retry certificate failures or HTTP authentication failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } }));
    await expect(new OpenAICompatibleClient(config, fetcher).complete([])).rejects.toThrow("TLS certificate");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockReset().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    await expect(new OpenAICompatibleClient(config, fetcher).complete([])).rejects.toThrow("HTTP 401");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out requests without repeatedly retrying a slow service", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      throw new Error("unreachable");
    });
    await expect(new OpenAICompatibleClient(config, fetcher, { timeoutMs: 10 }).complete([])).rejects.toThrow("TIMEOUT");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("builds a system prompt with memory, rules, and tool parameter docs", () => {
    const prompt = buildSystemPrompt("Project memory");

    expect(prompt).toContain("Project memory");
    expect(prompt).toContain("custom JSON protocol");
    expect(prompt).toContain("search args: { query: string }");
    expect(prompt).toContain("read_file args: { path: string }");
    expect(prompt).toContain("create_file args: { path: string; content: string }");
    expect(prompt).toContain("edit_file args: { path: string; search: string; replace: string }");
    expect(prompt).toContain("run_command args: { command: string }");
    expect(prompt).toContain("diff args: {}");
  });

  it("calls OpenAI-compatible chat completions", async () => {
    const requests: Array<{ input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }> = [];
    const client = new OpenAICompatibleClient(
      {
        baseURL: "https://llm.example/v1/",
        apiKey: "secret",
        model: "test-model"
      },
      async (input, init) => {
        requests.push({ input, init });
        return new Response(JSON.stringify({
          choices: [{ message: { content: "{\"type\":\"final\",\"summary\":\"done\",\"tests\":\"not run\",\"changedFiles\":[]}" } }]
        }), { status: 200 });
      }
    );

    const response = await client.complete([{ role: "user", content: "hello" }]);

    expect(response).toContain("\"type\":\"final\"");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("https://llm.example/v1/chat/completions");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2
    });
  });

  it("includes provider error response text in non-OK errors", async () => {
    const client = new OpenAICompatibleClient(
      {
        baseURL: "https://llm.example/v1",
        apiKey: "secret",
        model: "test-model"
      },
      async () => new Response("rate limited by provider", { status: 429 })
    );

    let thrown: unknown;
    try {
      await client.complete([{ role: "user", content: "hello" }]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("LLM request failed with HTTP 429");
    expect((thrown as Error).message).toContain("rate limited by provider");
  });

  it("throws a clear error when message content is missing", async () => {
    const client = new OpenAICompatibleClient(
      {
        baseURL: "https://llm.example/v1",
        apiKey: "secret",
        model: "test-model"
      },
      async () => new Response(JSON.stringify({
        choices: [{ message: {} }]
      }), { status: 200 })
    );

    await expect(client.complete([{ role: "user", content: "hello" }]))
      .rejects
      .toThrow("LLM response did not include message content.");
  });

  it("throws a clear client error for malformed JSON responses", async () => {
    const client = new OpenAICompatibleClient(
      {
        baseURL: "https://llm.example/v1",
        apiKey: "secret",
        model: "test-model"
      },
      async () => new Response("not json", { status: 200 })
    );

    await expect(client.complete([{ role: "user", content: "hello" }]))
      .rejects
      .toThrow("LLM response was not valid JSON.");
  });
});
