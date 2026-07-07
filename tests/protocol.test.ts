import { describe, expect, it } from "vitest";
import { buildRepairPrompt, parseAgentResponse } from "../src/protocol.js";

describe("custom JSON protocol", () => {
  it("parses plan responses", () => {
    const result = parseAgentResponse(JSON.stringify({
      type: "plan",
      summary: "Update input validation",
      steps: ["Search", "Edit", "Test"]
    }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.response.type).toBe("plan");
  });

  it("parses tool calls", () => {
    const result = parseAgentResponse(JSON.stringify({
      type: "tool_call",
      tool: "search",
      args: { query: "parseUser" }
    }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.response.type).toBe("tool_call");
  });

  it("parses final responses", () => {
    const result = parseAgentResponse(JSON.stringify({
      type: "final",
      summary: "Updated parseUser",
      tests: "npm test passed",
      changedFiles: ["src/parseUser.ts"]
    }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.response.type).toBe("final");
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
});
