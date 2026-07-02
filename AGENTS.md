# Telegram AI Agent — AI Agent Guide

## Project
Telegram bot: whitelisted user messages → AI (OpenAI-compatible) → Composio tool execution. Polling mode. No HTTP server.

## Stack
- **Runtime**: Bun (local long-running process)
- **Framework**: Telegraf v4
- **AI SDK**: `ai` v6 + `@ai-sdk/openai`
- **Tools**: Composio (`@composio/core`) + custom tools
- **Config**: Zod schema from `process.env`; Bun auto-loads `.env.local`
- **DB**: SQLite via `bun:sqlite` (no ORM)
- **Scheduling**: Bun Web Workers for background AI tasks

## Key files
| File | Purpose |
|------|---------|
| `src/index.ts` | Entry, wires stores → `createBot()` |
| `src/bot.ts` | Telegraf setup: whitelist middleware, /start, text handler, streaming UX |
| `src/ai.ts` | AI agent loop: system prompt, composio + custom tools, streamText |
| `src/config.ts` | Zod env schema, exports typed config |
| `src/tools/` | Custom tool definitions registered in `src/ai.ts` |
| `prompts/system.txt` | LLM system prompt — rules, format, tool usage policy |
| `CONTEXT.md` | Glossary, project decisions |
| `.env.example` | Env var reference |
| `src/session-store.ts` | SQLite CRUD for composio sessions |
| `src/memory-store.ts` | SQLite CRUD for user memory |
| `src/conversation-store.ts` | SQLite CRUD for per-user conversation history + compaction |
| `src/job-store.ts` | SQLite CRUD for scheduled jobs |
| `src/scheduler.ts` | Master process spawns worker for polling loop |

## Patterns
- Custom tools: define in `src/tools/<name>.ts`, export factory function `create<Name>Tool(entityId)`, register in `src/ai.ts` `processUserMessage()`
- Tool params: Zod schema with `.describe()` for LLM hints
- Streaming UX: `onToolCall` → "🔧 Calling...", `onToolResult` → "📎 Result:..."
- Non-COMPOSIO_ tools show streaming messages; composio tools are silent
- Conversation: SQLite (`conversation_messages`), trimmed to MAX_CONV_MESSAGES (20) via async compaction — oldest rows fold into one summary pair in place, so the summary lives in conversation history, not a side-channel. Cleared when the composio session expires/is missing.
- Scheduling: client-side regex intercept BEFORE AI agent loop (parseScheduling in bot.ts)

## Env vars
| Var | Required | Notes |
|-----|----------|-------|
| TELEGRAM_BOT_TOKEN | yes | From BotFather |
| TELEGRAM_ALLOWED_USERS | yes | Comma-separated Telegram IDs |
| COMPOSIO_API_KEY | yes | Composio API |
| AI_API_KEY | yes | OpenAI-compatible key |
| AI_BASE_URL | no | Default: none (use any OpenAI-compatible endpoint) |
| MODEL | no | gpt-4o-mini |
| LOG_LEVEL | no | INFO |

## Commands
```bash
# Dev (watch mode)
bun run --watch src/index.ts

# Type check
npx tsc --noEmit

# Production (PM2)
npm start

# Logs
npm run logs
```

## Conventions
- No ORM — raw SQLite queries
- No Express/HTTP — pure polling
- Logger: `const log = new Logger('name')` in `src/logger.ts`
- PII masking: `maskPii(str)` from `src/pii.ts` before logging user data
- Tool file names: kebab-case
- One `ponytail:` comment per deliberate simplification naming the ceiling + upgrade path
