# telegram-ai — AI Agent Guide

## Project
Telegram bot: whitelisted user messages → AI (OpenAI-compatible) → Composio tool execution. Polling mode. No HTTP server.

## Stack
- **Runtime**: Bun (local long-running process)
- **Framework**: Telegraf v4
- **AI SDK**: OpenAI SDK (`openai` v6, Chat Completions API)
- **Composio**: `@composio/core` + `@composio/openai` (OpenAIResponsesProvider)
- **Tools**: Auto-loaded from `src/tools/` (each file exports `toolName` + `createTool(ctx)`)
- **Config**: Zod schema from `process.env`; Bun auto-loads `.env.local`
- **DB**: SQLite via `bun:sqlite` (no ORM)
- **Scheduling**: Bun Web Workers for background AI tasks

## Key files
| File | Purpose |
|------|---------|
| `src/index.ts` | Entry, wires stores → `createBot()` |
| `src/bot.ts` | Telegraf setup: whitelist middleware, /start, text handler, streaming UX |
| `src/ai.ts` | AI agent loop: OpenAI SDK Chat Completions, manual agentic loop, auto-loads tools from `src/tools/` |
| `src/config.ts` | Zod env schema, exports typed config |
| `src/tool-def.ts` | CustomToolDef + ToolContext type definitions |
| `src/tools/composio-tool.ts` | Single composio tool: search + execute actions (replaces raw meta-tools) |
| `src/tools/compute.ts` | IST time tool |
| `src/tools/memory-tool.ts` | User memory tool (needsMemory) |
| `src/tools/job-tool.ts` | Scheduled jobs tool (needsJobStore) |
| `prompts/system.txt` | LLM system prompt — rules, format, tool usage policy |
| `CONTEXT.md` | Glossary, project decisions |
| `.env.example` | Env var reference |
| `src/session-store.ts` | SQLite CRUD for composio sessions |
| `src/memory-store.ts` | SQLite CRUD for user memory |
| `src/conversation-store.ts` | SQLite CRUD for per-user conversation history + compaction |
| `src/job-store.ts` | SQLite CRUD for scheduled jobs |
| `src/scheduler.ts` | Master process spawns worker for polling loop |

## Patterns
- Custom tools: add `.ts` file in `src/tools/` with exports: `toolName`, `createTool(ctx)`, optional `adminOnly`/`needsMemory`/`needsJobStore`. Auto-loaded by `loadTools()` in `ai.ts`.
- Admin-only tools: set `export const adminOnly = true` in tool file. Auto-skipped for non-admin users.
- Tool params: Zod schema with `.describe()` for LLM hints
- Streaming UX: `onToolCall` → "🔧 Calling...", `onToolResult` → "📎 Result:..."
- composio tool handles all third-party integrations via `session.search()` + `session.execute()`; LLM calls `composio({action:"search", query:"..."})` then `composio({action:"execute", tool:"SLUG", args:{...}})`
- Conversation: SQLite (`conversation_messages`), trimmed to MAX_CONV_MESSAGES (20) via async compaction — messages stored as full JSON blob. Cleared when the composio session expires/is missing.
- Scheduling: client-side regex intercept BEFORE AI agent loop (parseScheduling in bot.ts)

## Env vars
| Var | Required | Notes |
|-----|----------|-------|
| TELEGRAM_BOT_TOKEN | yes | From BotFather |
| TELEGRAM_ALLOWED_USERS | yes | Comma-separated Telegram IDs |
| COMPOSIO_API_KEY | yes | Composio API |
| AI_API_KEY | yes | OpenAI-compatible key |
| AI_BASE_URL | default | https://api.openai.com/v1 |
| MODEL | default | gpt-4o-mini |
| LOG_LEVEL | default | INFO |
| MAX_TOOL_RESULT_CHARS | default | 16000 — caps tool result size before it's appended to apiMessages, prevents context-window blowout on large tool payloads (e.g. Gmail fetch) |

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
- Tool file names: kebab-case (`composio-tool.ts`)
- One `ponytail:` comment per deliberate simplification naming the ceiling + upgrade path
