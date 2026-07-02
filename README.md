# Telegram AI Agent

Telegram bot — whitelisted messages → AI → tool execution (Composio + custom). Polling mode, no HTTP server.

## Setup

```bash
bun install
cp .env.example .env.local
# edit .env.local with your tokens
bun run --watch src/index.ts
```

## Env

| Var | Required | Default |
|-----|----------|---------|
| `TELEGRAM_BOT_TOKEN` | ✓ | — |
| `TELEGRAM_ALLOWED_USERS` | ✓ | — (comma-separated IDs) |
| `COMPOSIO_API_KEY` | ✓ | — |
| `AI_API_KEY` | ✓ | — |
| `AI_BASE_URL` | | (any OpenAI-compatible endpoint) |
| `MODEL` | | `gpt-4o-mini` |

## Run

```bash
# dev (watch)
bun run --watch src/index.ts

# production
npm start
```

## Architecture

`bot.ts` → whitelist → `processUserMessage()` (ai.ts) → composio + custom tools → streamText response → Telegram.

Custom tools in `src/tools/`.

SQLite stores for sessions, memory, jobs. Bun Web Workers for background scheduling.
