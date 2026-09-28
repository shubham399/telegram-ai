# telegram-ai — AI Agent Guide

## Project
Telegram bot: whitelisted user messages → AI (OpenAI-compatible) → Composio tool execution. Polling mode. No HTTP server.

## Stack
- **Runtime**: Bun (local long-running process)
- **Framework**: Telegraf v4
- **AI SDK**: OpenAI SDK (`openai` v6, Chat Completions API)
- **Composio**: `@composio/core` (OpenAIProvider)
- **Tools**: Auto-loaded from `src/tools/` (each file exports `toolName` + `createTool(ctx)`)
- **Config**: Zod schema from `process.env`; Bun auto-loads `.env.local`
- **DB**: SQLite via `bun:sqlite` (no ORM)
- **Scheduling**: in-process 30s poll loop in the same Bun process as the bot

## Key files
| File | Purpose |
|------|---------|
| `src/index.ts` | Entry, wires stores → `createBot()` |
| `src/bot.ts` | Telegraf setup: whitelist middleware, /start, text handler, tool UX |
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
| `src/task-store.ts` | SQLite CRUD for scheduled tasks + crash recovery |
| `src/db.ts` | Sole owner of the SQLite connection (pragmas, migrations, WAL checkpoint) |
| `src/scheduler.ts` | In-process 30s poll loop: due-job dispatch + task execution |
| `src/task-runner.ts` | Runs one scheduled task end to end (agent loop → persist → deliver) |
| `src/send.ts` | Chunked Telegram sender for code with no `Context` (scheduler) |
| `src/queue.ts` | Per-user serial task queue (turns must not interleave) |
| `src/history.ts` | Token estimates, provider-safe replay (`sanitizeHistory`), summarisation |
| `src/model-router.ts` | Primary/fallback model selection + failure classification + retries |
| `src/tool-exec.ts` | Runs one tool call (local or Composio) under a timeout |
| `src/admin.ts` | `isAdmin()` — the one place admin authorisation is decided |
| `src/agents.ts` | Agent catalogue (`agents/*/agent.json`), keyword router, tool allow-lists |
| `src/user-state.ts` | Per-user pointers: current session, pinned agent, model override |
| `src/loop-store.ts` | Crash-resume checkpoints (`active_loops` + `step_caches`) |
| `src/loop-resume.ts` | Boot-time recovery of runs interrupted by a crash |
| `src/note-store.ts` | User notes (user-visible, unbounded, searchable) |
| `src/todo-store.ts` | The user's to-do list (no schedule attached) |
| `src/usage-ledger.ts` | Per-call token accounting, written by the router |
| `src/maintenance.ts` | Retention, WAL checkpoint, VACUUM, FTS5 conversation search |
| `src/request-registry.ts` | In-flight runs, so `/stop` can cancel one |

## Patterns
- Custom tools: add `.ts` file in `src/tools/` with exports: `toolName`, `createTool(ctx)`, optional `adminOnly`/`needsMemory`/`needsJobStore`. Auto-loaded by `loadTools()` in `ai.ts`.
- Admin-only tools: set `export const adminOnly = true` in tool file. Auto-skipped for non-admin users.
- Tool params: Zod schema with `.describe()` for LLM hints
- Tool UX: `onToolCall` → "🔧 Calling...", `onToolResult` → "📎 Result:..."
- Composio tools are loaded as native OpenAI function calls from the composio session; custom tools in `src/tools/` use text-based `TOOL:` parsing.
- Conversation: SQLite (`conversation_messages`), trimmed to MAX_CONV_MESSAGES (20) via async compaction — messages stored as a full JSON blob, and a summary row that compaction converges on. Scoped to (user, session, agent); only `/clear` and retention delete rows.
- Scheduling: client-side regex intercept BEFORE AI agent loop (parseScheduling in bot.ts)
- Tool calls: native function calling is the contract. `TOOL: name {json}` text parsing is a fallback for models that cannot emit native calls — never advertise it in the prompt.
- Tool execution goes through `runTool()` in `src/tool-exec.ts`, which owns the timeout and result truncation. Do not call `.execute()` directly from the agent loop.
- Model access goes through `router.complete()` in `src/model-router.ts`. It is the ONLY place that retries — the OpenAI clients are built with `maxRetries: 0` so the policy is not applied twice.
- Bot handlers must not `await` the agent run. Enqueue and return (`userQueue`); otherwise one slow turn blocks every user and every command.
- One process, one SQLite handle: `getDb()` from `src/db.ts` is the only connection. Do not open `new Database(...)` anywhere else.
- Jobs with `needs_ai = 0` are delivered as plain text by the scheduler and never enter the agent loop.
- Conversation history is keyed by **(user, session, agent)**. Never query `conversation_messages` by user alone — that leaks one scope's history into another.
- The Composio session and the conversation are unrelated lifetimes. A missing or expired Composio session must never delete history.
- Agent routing is keyword-based and deterministic. Ties resolve by lead position, then longest keyword, then name — never by directory order.
- An agent's `tools` list is a least-privilege allow-list. A tool absent from the list is invisible to that agent, so a mistake in `agent.json` fails closed.
- `delegate_task` is the only way one agent calls another, and it is capped at depth 2.
- Every model call goes through `router.complete()`. It records the usage ledger itself; do not add token counting anywhere else.
- A long run checkpoints each step to `step_caches`. Boot-time recovery is what turns a crash into a resume instead of a restart.

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
| ADMIN_USER_IDS | no | Comma-separated admin IDs. Empty ⇒ nobody is admin and every `adminOnly` tool is hidden |
| FALLBACK_MODEL | no | Auto-activates on 401/402/403/429/5xx from the primary. Once tripped it writes `data/.fallback-active` and **stays** on the fallback across restarts — clear that file (or call `router.resetFallbackState()`) to go back |
| FALLBACK_BASE_URL | no | Defaults to AI_BASE_URL |
| FALLBACK_API_KEY | no | Defaults to AI_API_KEY |
| PRIMARY_RETRY_COUNT | default | 2 — retries of the primary before switching to fallback |
| MAX_OUTPUT_TOKENS | no | Set for providers that require an explicit cap (deepseek, glm) |
| PROVIDER_HEADERS | no | JSON object of extra HTTP headers keyed by base-URL substring |
| PRIMARY_UA / FALLBACK_UA | no | Per-model `User-Agent` override |
| MAX_TOOL_RESULT_CHARS | default | 16000 — caps tool result size before it's appended to apiMessages, prevents context-window blowout on large tool payloads (e.g. Gmail fetch) |

## Bot commands
| Command | Effect |
|---------|--------|
| `/start` | Usage summary |
| `/new` | Start a fresh session (history for the current agent is not deleted, just left behind) |
| `/session [name\|default]` | Show or switch the active session |
| `/clear` | Wipe the current (session, agent) conversation |
| `/agent [name\|list\|auto]` | Pin a specialist, list them, or unpin for per-message routing |
| `/model [name\|reset]` | Override the model for this user, or clear it |
| `/stop` | Cancel the in-flight run |

## Specialist agents
`agents/<name>/agent.json` defines a specialist. It is optional — with no `agents/` directory the bot runs the built-in `default` agent and nothing breaks.

```json
{
  "name": "email",
  "description": "Reads, searches, drafts and summarises email.",
  "keywords": ["email", "mail", "inbox", "gmail"],
  "tools": ["composio", "memory", "note", "search"]
}
```

- `keywords` route a message without an LLM call. Matched on **word boundaries** — `mail` will not fire on "email".
- `tools` is an allow-list. `*` means everything; `composio` grants the whole Composio catalogue in one token. Anything unlisted is hidden.
- `agents/<name>/SOUL.md` is appended to the system prompt as the agent's persona, after the base rules so it cannot override them.

## Development
```bash
# Dev (watch mode)
bun run --watch src/index.ts

# Type check + tests
bun run check

# Production (PM2)
npm start

# Logs
npm run logs
```

## Conventions
- No ORM — raw SQLite queries
- No Express/HTTP — pure polling
- Logger: `const log = new Logger('name')` in `src/logger.ts`
- PII masking: mandatory at every log site. `maskPii` for user content, `maskUserId` for user ids, `maskSessionId` for session ids. Never log raw tool arguments — log the argument *keys*.
- Tool file names: kebab-case (`composio-tool.ts`)
- One `ponytail:` comment per deliberate simplification naming the ceiling + upgrade path
