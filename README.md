# Lightweight Terminal Coding Agent

Node.js and TypeScript CLI for a lightweight local coding agent.

## Development

```bash
npm install
npm test
npm run build
npm run dev -- --help
```

## Runtime Configuration

The agent reads OpenAI-compatible settings from environment variables or `.code-agent/config.json`:

- `CODE_AGENT_BASE_URL`
- `CODE_AGENT_API_KEY`
- `CODE_AGENT_MODEL`

Example `.code-agent/config.json`:

```json
{
  "baseURL": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4.1-mini"
}
```

## Usage

```bash
code-agent
code-agent "change this function to handle empty arrays"
```

Built-in commands:

- `/help`: show available commands.
- `/init`: create an initial `Claude.md`.
- `/diff`: show current changes.
- `/status`: show current task state.
- `/config`: show active model configuration without revealing secrets.
- `/exit`: exit the REPL.

## Manual Acceptance

1. Create a small TypeScript sample project in a temporary directory.
2. Add a `Claude.md` with project conventions and test commands.
3. Configure `CODE_AGENT_BASE_URL`, `CODE_AGENT_API_KEY`, and `CODE_AGENT_MODEL`.
4. Run `code-agent "change parseUser so empty input returns anonymous"`.
5. Confirm the agent prints a plan, searches and reads relevant files, applies one small edit, runs an allowed test or build command when requested by the model, and prints changed files plus a diff.
