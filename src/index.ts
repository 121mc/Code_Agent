#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { runCli } from "./cli.js";

export { buildHelpText } from "./help.js";

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
