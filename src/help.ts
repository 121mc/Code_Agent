export function buildHelpText(): string {
  return [
    "code-agent",
    "",
    "Usage:",
    "  code-agent",
    "  code-agent \"describe a small coding task\"",
    "",
    "Commands:",
    "  /help    Show available commands",
    "  /init    Create an initial Claude.md",
    "  /diff    Show current changes",
    "  /status  Show current task state",
    "  /config  Show active model configuration without secrets",
    "  /exit    Exit the REPL"
  ].join("\n");
}
