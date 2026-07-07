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
    const requests: unknown[] = [];
    const client = new OpenAICompatibleClient(
      {
        baseURL: "https://llm.example/v1",
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
  });
});
