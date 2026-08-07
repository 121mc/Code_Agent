#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCli } from "./cli.js";

export { buildHelpText } from "./help.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runCli({ argv });
}

export function isMainModule(moduleUrl: string, entryPath: string | undefined): boolean {
  if (!entryPath) {
    return false;
  }

  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`code-agent failed: ${message}`);
    process.exitCode = 1;
  });
}
