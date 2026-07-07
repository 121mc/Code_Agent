import { describe, expect, it } from "vitest";
import { OpenAICompatibleClient, buildSystemPrompt } from "../src/llm.js";

describe("LLM client", () => {
  it("builds a system prompt with memory, rules, and tool parameter docs", () => {
    const prompt = buildSystemPrompt("Project memory");

    expect(prompt).toContain("Project memory");
    expect(prompt).toContain("custom JSON protocol");
    expect(prompt).toContain("search args: { query: string }");
    expect(prompt).toContain("read_file args: { path: string }");
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
