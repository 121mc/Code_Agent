#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { runCli } from "./cli.js";

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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runCli({ argv });
}

const entryUrl = pathToFileURL(process.argv[1] ?? "").href;

if (import.meta.url === entryUrl) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`code-agent failed: ${message}`);
    process.exitCode = 1;
  });
}
