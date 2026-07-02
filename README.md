# telegram-ai

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-%23e3e3e3?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/lang-TypeScript-%233178C6?logo=typescript)](https://www.typescriptlang.org/)

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
| `AI_BASE_URL` | | `https://api.openai.com/v1` |
| `MODEL` | | `gpt-4o-mini` |
| `AGENT_MAX_STEPS` | | `10` |
| `MAX_TOOL_RESULT_CHARS` | | `16000` (cap on tool result size fed back to the model) |

## Run

```bash
# dev (watch)
bun run --watch src/index.ts

# production
npm start
```

## Architecture

`bot.ts` → whitelist → `processUserMessage()` (ai.ts) → composio + custom tools → streamText response → Telegram.

Custom tools in `src/tools/`. Admin-only tools get `adminOnly` export.

SQLite stores for sessions, memory, jobs. Bun Web Workers for background scheduling.
