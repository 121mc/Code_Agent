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
