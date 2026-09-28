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
| `ADMIN_USER_IDS` | | empty — nobody is admin, every admin tool stays hidden |
| `FALLBACK_MODEL` | | second model used when the primary returns 401/402/403/429/5xx |
| `FALLBACK_BASE_URL` / `FALLBACK_API_KEY` | | default to the primary's |
| `MAX_OUTPUT_TOKENS` | | set this for providers that require an explicit cap (deepseek, glm) |
| `PROVIDER_HEADERS` | | JSON object of extra HTTP headers, keyed by base-URL substring |

> Once fallback trips it writes `data/.fallback-active` and stays on the fallback
> across restarts, so a transient provider outage does not silently resolve on its
> own. Delete that file (or call `router.resetFallbackState()`) to return to the
> primary.

## Bot commands

| Command | Effect |
|---------|--------|
| `/start` | Usage summary |
| `/new` | Start a fresh session |
| `/session [name\|default]` | Show or switch the active session |
| `/clear` | Wipe the current (session, agent) conversation |
| `/agent [name\|list\|auto]` | Pin a specialist agent, list them, or go back to auto-routing |
| `/model [name\|reset]` | Override the model for your own chats |
| `/stop` | Cancel whatever is running right now |

## Specialist agents

Drop a directory in `agents/` to add one:

```
agents/email/agent.json     # name, description, keywords, tools
agents/email/SOUL.md        # optional persona, appended to the system prompt
```

`keywords` route a message to the agent with no LLM call; `tools` is a
least-privilege allow-list. See `AGENTS.md` for the schema. Delete the directory
and the bot falls back to a single built-in `default` agent.

## Run

```bash
# dev (watch)
bun run --watch src/index.ts

# type check + full test suite
bun run check

# production
npm start
```

## Architecture

```
bot.ts ──▶ model-router.ts ──▶ AI model
  │                             │
  │                             ▼
  │                        ai.ts (agent loop)
  │                             │
  │                             ├── tool-exec.ts ──▶ src/tools/*  +  Composio
  │                             │                    note · todo · search · web
  │                             │                    translate · clarify · ops
  │                             └── agents.ts        keyword routing, allow-lists
  │
  ├──▶ conversation-store   (user × session × agent, compacted)
  ├──▶ user-state           (current session, pinned agent, model override)
  └──▶ queue.ts             (one turn per user at a time)

scheduler.ts (30s poll) ──▶ task-runner.ts ──▶ send.ts
bot startup          ──▶ loop-resume.ts  (finish runs a crash interrupted)
                       maintenance.ts    (retention, WAL checkpoint, VACUUM)
```

- **Model access** goes through `model-router.ts` only. It owns retries and the
  primary→fallback switch, and records token usage as a side effect.
- **Tools** live in `src/tools/`, one file per tool, auto-loaded. `adminOnly`
  hides a tool from non-admins.
- **Scheduling** is an in-process poll loop, not a worker or a cron.
- **Long runs checkpoint each step**, so a crash resumes rather than restarts.
- See `AGENTS.md` for the conventions and the reasoning behind them.
