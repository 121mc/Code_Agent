import { describe, expect, it } from "vitest";
import { buildHelpText } from "../src/index.js";

describe("CLI smoke behavior", () => {
  it("prints the expected command list in help text", () => {
    expect(buildHelpText()).toContain("code-agent");
    expect(buildHelpText()).toContain("/help");
    expect(buildHelpText()).toContain("/init");
    expect(buildHelpText()).toContain("/diff");
    expect(buildHelpText()).toContain("/status");
    expect(buildHelpText()).toContain("/config");
    expect(buildHelpText()).toContain("/exit");
  });
});
