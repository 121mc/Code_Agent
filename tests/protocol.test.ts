import { describe, expect, it } from "vitest";
import { buildRepairPrompt, parseAgentResponse } from "../src/protocol.js";

describe("custom JSON protocol", () => {
  it("parses plan responses", () => {
    const response = {
      type: "plan",
      summary: "Update input validation",
      steps: ["Search", "Edit", "Test"]
    } as const;
    const result = parseAgentResponse(JSON.stringify(response));

    expect(result).toEqual({ ok: true, response });
  });

  it("parses tool calls", () => {
    const response = {
      type: "tool_call",
      tool: "search",
      args: { query: "parseUser" }
    } as const;
    const result = parseAgentResponse(JSON.stringify(response));

    expect(result).toEqual({ ok: true, response });
  });

  it("parses final responses", () => {
    const response = {
      type: "final",
      summary: "Updated parseUser",
      tests: "npm test passed",
      changedFiles: ["src/parseUser.ts"]
    } as const;
    const result = parseAgentResponse(JSON.stringify(response));

    expect(result).toEqual({ ok: true, response });
  });

  it("extracts a JSON object from surrounding model prose", () => {
    const response = {
      type: "plan",
      summary: "Update input validation",
      steps: ["Search", "Edit", "Test"]
    } as const;
    const result = parseAgentResponse([
      "I will use this plan:",
      JSON.stringify(response),
      "Then I will continue."
    ].join("\n"));

    expect(result).toEqual({ ok: true, response });
  });

  it("rejects invalid JSON with a useful repair prompt", () => {
    const result = parseAgentResponse("Plan: edit the file");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("valid JSON");
    expect(buildRepairPrompt("Plan: edit the file")).toContain("\"type\"");
  });

  it("rejects unknown tools", () => {
    const result = parseAgentResponse(JSON.stringify({
      type: "tool_call",
      tool: "delete_everything",
      args: {}
    }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("Unsupported tool");
  });

  it("rejects plan responses with invalid steps", () => {
    const result = parseAgentResponse(JSON.stringify({
      type: "plan",
      summary: "Update input validation",
      steps: "Search"
    }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("string steps array");
  });

  it("rejects tool calls with invalid args", () => {
    const result = parseAgentResponse(JSON.stringify({
      type: "tool_call",
      tool: "search",
      args: null
    }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("object args");
  });

  it("rejects final responses with invalid changedFiles", () => {
    const result = parseAgentResponse(JSON.stringify({
      type: "final",
      summary: "Updated parseUser",
      tests: "npm test passed",
      changedFiles: ["src/parseUser.ts", 42]
    }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("string changedFiles array");
  });

  it("rejects non-object top-level JSON", () => {
    const result = parseAgentResponse(JSON.stringify(["plan"]));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("JSON object");
  });

  it("rejects unsupported response types", () => {
    const result = parseAgentResponse(JSON.stringify({
      type: "status",
      summary: "Still working"
    }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("Response type");
  });
});
