# Lightweight Terminal Coding Agent Design

Date: 2026-07-07

## Goal

Build a lightweight terminal-style coding agent inspired by Claude Code. The MVP focuses on small-scope code modifications in a local repository. Users describe a development task in natural language, and the agent plans the work, searches and reads relevant files, edits code, runs tests or build commands, and presents the resulting diff.

The first version should be useful for real local development while staying simple enough to implement and audit.

## Scope

### In Scope

- Node.js + TypeScript CLI.
- Interactive REPL as the primary experience.
- One-shot command entry for single tasks.
- OpenAI-compatible LLM configuration with `baseURL`, `apiKey`, and `model`.
- Custom JSON tool protocol instead of provider-specific native tool calling.
- Project root is the startup directory.
- `Claude.md` in the project root as project-level memory and instructions.
- Small-scope source code and test edits.
- Search, read, edit, command execution, and diff tools.
- Git-first diff display, with internal touched-file diff for non-Git projects.
- Automatic execution for low-risk source edits and test/build commands.
- Confirmation for high-risk edits and commands.

### Out of Scope For MVP

- Full-screen TUI.
- Multi-repository workspaces.
- Long-term cross-project memory.
- Complex autonomous feature development.
- Large refactors across many modules.
- Native provider-specific tool calling.
- Background daemons or remote execution.

## User Experience

The agent starts in the repository root:

```bash
code-agent
```

It also supports a one-shot command:

```bash
code-agent "change this function to handle empty arrays"
```

The REPL flow:

```text
$ code-agent
> Fix parseUser when the input is empty

Plan:
1. Search for parseUser
2. Read implementation and tests
3. Update empty-input handling
4. Run relevant tests
5. Show diff

Running search...
Reading files...
Editing src/parseUser.ts...
Running npm test -- parseUser...

Done.
Changed files:
- src/parseUser.ts
- src/parseUser.test.ts

Tests: passed
```

Built-in commands:

- `/help`: Show available commands.
- `/init`: Create an initial `Claude.md`.
- `/diff`: Show current changes.
- `/status`: Show the current task state.
- `/config`: Show active model configuration without revealing secrets.
- `/exit`: Exit the REPL.

## Project Memory

The project root may contain `Claude.md`. This file is the project-level memory and instruction source.

At task start, the agent reads `Claude.md` and injects its contents into the LLM context. The file should store:

- Project conventions.
- Common commands.
- Directory notes.
- Testing instructions.
- Coding style preferences.
- Files or paths that should not be touched.
- Project-specific workflow notes.

The agent should generate `Claude.md` through `/init` if it does not exist.

Instruction priority:

1. Built-in safety rules.
2. Current explicit user instructions.
3. `Claude.md` project instructions.
4. Agent default behavior.

The default generated file is named `Claude.md`. The agent may also read `CLAUDE.md` for compatibility, but `Claude.md` is the canonical file for this project.

## Architecture

```text
CLI/REPL
  -> Project Context Loader
     -> Claude.md Reader
     -> Workspace Detector
     -> Git Detector
  -> Agent Orchestrator
     -> LLM Client
     -> Tool Router
        -> Search Tool
        -> File Read Tool
        -> File Edit Tool
        -> Command Tool
        -> Diff Tool
     -> Permission Guard
     -> Session State
```

### CLI/REPL

Handles startup, input, output, risk confirmations, command shortcuts, and final summaries. The REPL is the primary experience. The one-shot command path should reuse the same agent orchestration code.

### Project Context Loader

Locks the workspace to the startup directory and gathers initial context:

- Current root path.
- `Claude.md` contents.
- Whether the directory is a Git repository.
- Package manager and likely test/build commands.
- Basic ignore patterns for large or generated directories.

### Agent Orchestrator

Maintains the plan-execute-observe loop. It builds LLM prompts, accepts structured model responses, invokes tools through the router, stores observations, and decides when the task is complete or blocked.

### LLM Client

Implements OpenAI-compatible chat completion calls. Configuration comes from environment variables and optionally a local config file:

- `CODE_AGENT_BASE_URL`
- `CODE_AGENT_API_KEY`
- `CODE_AGENT_MODEL`
- `.code-agent/config.json`

The MVP may start with non-streaming responses. Streaming can be added after the core loop is stable.

### Tool Router

Parses custom JSON tool calls and dispatches them to concrete tools. It validates the requested tool name, arguments, workspace boundaries, and permission result before execution.

### Permission Guard

Classifies file and command actions as allowed, confirm-required, or blocked.

### Session State

Tracks the current task:

- User request.
- Plan and step status.
- Tool observations.
- Files read.
- Files modified.
- Pre-edit snapshots for touched files.
- Test and command results.
- Errors and retries.

## Agent Loop

The MVP uses batch planning followed by stepwise execution:

1. User enters a task.
2. Agent loads `Claude.md`, workspace metadata, recent state, and tool definitions.
3. LLM returns a structured plan.
4. CLI shows the plan and continues by default, while allowing the user to stop or adjust.
5. LLM emits one tool call at a time using the custom JSON protocol.
6. Tool Router validates and executes the tool call.
7. Observation is added to session state and returned to the LLM.
8. The loop continues until the LLM emits a final response or the agent hits a limit.
9. CLI displays summary, changed files, test status, and diff.

Loop limits:

- Maximum 20 tool calls per task.
- Maximum 5 modified files per task before confirmation.
- Confirmation required for large patches.
- Stop after 3 consecutive tool failures.
- Default command timeout is 2 minutes.
- One automatic test-failure repair attempt is allowed; a second failure stops the task and shows logs.

## Custom JSON Protocol

The model must respond with one of three top-level response types.

Plan:

```json
{
  "type": "plan",
  "summary": "Adjust input validation and update the related test",
  "steps": [
    "Search for the target function",
    "Read implementation and tests",
    "Edit implementation",
    "Run relevant tests",
    "Show diff"
  ]
}
```

Tool call:

```json
{
  "type": "tool_call",
  "tool": "search",
  "args": {
    "query": "parseUser"
  }
}
```

Final:

```json
{
  "type": "final",
  "summary": "Updated parseUser to handle empty input and added a test.",
  "tests": "npm test -- parseUser passed",
  "changedFiles": [
    "src/parseUser.ts",
    "src/parseUser.test.ts"
  ]
}
```

If the LLM returns invalid JSON, the agent asks it to repair the response using the required schema.

## Tools

### Search Tool

Searches text within the workspace. Prefer fast search behavior equivalent to `rg`. It should ignore generated and dependency directories by default.

### File Read Tool

Reads text files within the workspace. It rejects paths outside the workspace and avoids binary or oversized files.

### File Edit Tool

Applies small edits to text files. Before writing, it stores a pre-edit snapshot in session state. Edits are allowed automatically for normal source, test, and documentation files, subject to risk checks.

### Command Tool

Runs commands in the workspace. Test and build commands can run automatically. Risky commands require confirmation.

### Diff Tool

Uses `git diff` when the workspace is a Git repository. For non-Git directories, it compares touched-file snapshots against current content.

## Permission Model

File access is limited to the startup directory and its descendants.

Default ignored or sensitive paths:

- `.git/`
- `node_modules/`
- `dist/`
- `build/`
- `.env*`
- private keys and certificates
- binary or very large files

Automatically allowed:

- Reading normal source, test, and documentation files.
- Searching workspace text files.
- Small edits to normal source, test, and documentation files.
- Test, lint, and build commands such as `npm test`, `pnpm test`, `yarn test`, `npm run build`, and `pnpm run lint`.

Confirmation required:

- Dependency installation or package changes.
- Network commands such as `curl` or `wget`.
- Delete commands.
- Git history or remote commands such as `git reset` and `git push`.
- Editing `.env*`, lockfiles, CI configuration, permissions scripts, or many files.
- Running background services.
- Commands that access system directories.

Blocked:

- Paths outside the workspace.
- Attempts to reveal or write secrets without user confirmation.
- Shell commands classified as destructive without explicit approval.

## Error Handling

- Invalid JSON responses trigger a schema repair prompt.
- Tool failures become observations for the LLM.
- Repeated failures stop the loop with a clear explanation.
- Command timeouts stop the command and summarize partial output if available.
- Test failure allows one automatic repair attempt.
- Diff generation failure falls back to listing modified files and snapshots when possible.

## Testing Strategy

Unit tests:

- JSON protocol parsing.
- Permission classification.
- Workspace path containment.
- Command risk classification.
- Diff generation.
- `Claude.md` loading and instruction priority.

Integration tests:

- Run against temporary fixture repositories.
- Use a mock LLM with fixed responses for plan, tool calls, and final output.
- Verify search, read, edit, test execution, and diff display.
- Verify high-risk command and file-edit confirmation paths.

Manual acceptance:

- Create a small TypeScript sample project.
- Ask the agent to perform a small code modification.
- Confirm it searches relevant files, edits code, runs tests, and shows a useful diff.

## MVP Completion Criteria

- Agent can start from a repository root.
- Agent can read and use `Claude.md`.
- Agent can produce a structured plan from a natural language task.
- Agent can search and read relevant files.
- Agent can apply small code edits automatically.
- Agent can run relevant test or build commands.
- Agent can show final changed files and diff.
- Agent can block or request confirmation for high-risk files and commands.
- Agent can run with a mock LLM in automated tests.
