import { stdout as output, stdin as input } from "node:process";
import { createInterface } from "node:readline/promises";
import { runAgentTask } from "./agent.js";
import { loadModelConfig, maskConfigForDisplay } from "./config.js";
import { buildHelpText } from "./index.js";
import { OpenAICompatibleClient, type LLMClient } from "./llm.js";
import { createInitialClaudeMd, loadProjectContext } from "./project-context.js";
import { createSession } from "./session.js";
import { runDiffTool } from "./tools/process-tools.js";

export type SlashCommandResult = "continue" | "exit";

export interface CliIO {
  root: string;
  write: (line: string) => void;
}

export interface RunCliOptions {
  argv?: string[];
  root?: string;
  llm?: LLMClient;
}

export function formatPlan(_summary: string, steps: string[]): string {
  return [
    "Plan:",
    ...steps.map((step, index) => `${index + 1}. ${step}`)
  ].join("\n");
}

export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const root = options.root ?? process.cwd();

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(buildHelpText());
    return;
  }

  if (argv.length > 0) {
    await runOneShot(argv.join(" "), root, options.llm);
    return;
  }

  await runRepl(root, options.llm);
}

export async function handleSlashCommand(command: string, io: CliIO): Promise<SlashCommandResult> {
  const trimmed = command.trim();

  if (trimmed === "/help") {
    io.write(buildHelpText());
    return "continue";
  }

  if (trimmed === "/init") {
    const result = await createInitialClaudeMd(io.root);
    io.write(result === "created" ? "Claude.md created." : "Claude.md already exists.");
    return "continue";
  }

  if (trimmed === "/diff") {
    const context = await loadProjectContext(io.root);
    const session = createSession("manual diff");
    const result = await runDiffTool(io.root, session, context.isGitRepository);
    io.write(result.output);
    return "continue";
  }

  if (trimmed === "/status") {
    io.write("No active task.");
    return "continue";
  }

  if (trimmed === "/config") {
    const config = await loadModelConfig(io.root);
    io.write(JSON.stringify(maskConfigForDisplay(config), null, 2));
    return "continue";
  }

  if (trimmed === "/exit") {
    return "exit";
  }

  io.write(`Unknown command: ${trimmed}`);
  return "continue";
}

async function runOneShot(userRequest: string, root: string, injectedLlm?: LLMClient): Promise<void> {
  const context = await loadProjectContext(root);
  const llm = injectedLlm ?? new OpenAICompatibleClient(await loadModelConfig(root));
  const result = await runAgentTask({
    userRequest,
    context,
    llm,
    onPlan: (plan) => console.log(formatPlan(plan.summary, plan.steps))
  });

  console.log("Done.");
  console.log(result.final.summary);
  console.log(`Tests: ${result.final.tests}`);
  console.log("Changed files:");
  for (const file of result.final.changedFiles) {
    console.log(`- ${file}`);
  }
}

async function runRepl(root: string, injectedLlm?: LLMClient): Promise<void> {
  const rl = createInterface({ input, output });
  console.log("code-agent");

  try {
    while (true) {
      const line = await rl.question("> ");
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith("/")) {
        const result = await handleSlashCommand(trimmed, { root, write: (value) => console.log(value) });
        if (result === "exit") {
          break;
        }
        continue;
      }

      await runOneShot(trimmed, root, injectedLlm);
    }
  } finally {
    rl.close();
  }
}
