import { stdout as output, stdin as input } from "node:process";
import { createInterface } from "node:readline/promises";
import { runAgentTask } from "./agent.js";
import { loadModelConfig, maskConfigForDisplay } from "./config.js";
import { buildHelpText } from "./help.js";
import { OpenAICompatibleClient, type LLMClient } from "./llm.js";
import { createInitialClaudeMd, loadProjectContext } from "./project-context.js";
import { createSession } from "./session.js";
import { runDiffTool } from "./tools/process-tools.js";
import type { ConfirmationPrompt } from "./tools/router.js";

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
    await runOneShot(argv.join(" "), root, options.llm, confirmInTerminal);
    return;
  }

  await runRepl(root, options.llm);
}

export async function handleSlashCommand(command: string, io: CliIO): Promise<SlashCommandResult> {
  try {
    return await runSlashCommand(command, io);
  } catch (error) {
    io.write(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
    return "continue";
  }
}

async function runSlashCommand(command: string, io: CliIO): Promise<SlashCommandResult> {
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
    if (!context.isGitRepository) {
      io.write("Diff is only available for Git workspaces or files modified during the current task.");
      return "continue";
    }

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
    try {
      const config = await loadModelConfig(io.root);
      io.write(JSON.stringify(maskConfigForDisplay(config), null, 2));
    } catch (error) {
      io.write(error instanceof Error ? error.message : String(error));
    }
    return "continue";
  }

  if (trimmed === "/exit") {
    return "exit";
  }

  io.write(`Unknown command: ${trimmed}`);
  return "continue";
}

async function runOneShot(
  userRequest: string,
  root: string,
  injectedLlm?: LLMClient,
  confirm?: (prompt: ConfirmationPrompt) => Promise<boolean>
): Promise<void> {
  const context = await loadProjectContext(root);
  const llm = injectedLlm ?? new OpenAICompatibleClient(await loadModelConfig(root));
  const result = await runAgentTask({
    userRequest,
    context,
    llm,
    routerOptions: { confirm },
    onPlan: (plan) => console.log(formatPlan(plan.summary, plan.steps))
  });
  const diff = await runDiffTool(root, result.session, context.isGitRepository);

  console.log("Done.");
  console.log(result.final.summary);
  console.log(`Tests: ${result.final.tests}`);
  console.log("Changed files:");
  for (const file of result.final.changedFiles) {
    console.log(`- ${file}`);
  }
  console.log("Diff:");
  console.log(diff.output);
}

async function runRepl(root: string, injectedLlm?: LLMClient): Promise<void> {
  const rl = createInterface({ input, output });
  console.log("code-agent");

  try {
    while (true) {
      let line: string;
      try {
        line = await rl.question("> ");
      } catch (error) {
        if (isReadlineClosedError(error)) {
          break;
        }
        throw error;
      }

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

      await runOneShot(trimmed, root, injectedLlm, (prompt) => confirmWithReadline(rl, prompt));
    }
  } finally {
    rl.close();
  }
}

async function confirmInTerminal(prompt: ConfirmationPrompt): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    return await confirmWithReadline(rl, prompt);
  } finally {
    rl.close();
  }
}

async function confirmWithReadline(
  rl: ReturnType<typeof createInterface>,
  prompt: ConfirmationPrompt
): Promise<boolean> {
  const answer = await rl.question(`${prompt.message} [y/N] `);
  return /^(y|yes)$/i.test(answer.trim());
}

function isReadlineClosedError(error: unknown): boolean {
  return error instanceof Error && error.message === "readline was closed";
}
