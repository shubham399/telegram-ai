# telegram-ai

Telegram bot: every message from a whitelisted user is an AI prompt
powered by any OpenAI-compatible API + Composio tool execution.

## Glossary

| Term | Meaning |
|------|---------|
| **User** | Telegram user; sessions keyed by `telegram_user_id` |
| **Whitelist** | `TELEGRAM_ALLOWED_USERS` env var (comma-separated IDs) |
| **AI Model** | Configurable via `MODEL` env var |
| **Composio Session** | Per-user tool runtime session; created on first message, reused after |
| **Bot** | Telegraf instance running on Bun (polling mode) |
| **Tool UX** | Step messages: user sees intermediate "Calling tool...", "Result: ...", then final answer |
| **Runtime** | Bun — local / long-running process |
| **Session** | A named conversation thread. One user has several; `/session` picks the active one |
| **Scope** | The `(user, session, agent)` triple that history is keyed by. Two scopes never see each other's messages |
| **Agent** | A specialist persona with its own tool allow-list, defined in `agents/<name>/agent.json` |
| **Routing** | Which agent handles a message: a pinned choice via `/agent`, else keyword match, else `default` |
| **Delegation** | One agent handing a sub-task to another via the `delegate_task` tool. Capped at depth 2 |
| **Tool result** | What a tool hands back. Capped at `MAX_TOOL_RESULT_CHARS` and truncated, never dropped |
| **Clarify** | When the agent is genuinely blocked it emits a `CLARIFY:` line; the bot turns it into inline buttons |
| **Loop** | One user request from first message to final answer, including tool steps |
| **Checkpoint** | The per-step cache in `step_caches` that lets an interrupted loop resume |
| **Usage ledger** | Per-user, per-model token totals, appended by the router on every call |
| **Maintenance** | Startup + periodic work: message retention, WAL checkpoint, `VACUUM` |
| **Primary / fallback** | Two model endpoints. The fallback engages on 401/402/403/429/5xx and then stays engaged until reset |

## Decisions worth remembering

- **One process, one SQLite handle.** No workers, no HTTP server, polling only.
  Simpler to reason about and the deployment is a single `bun start`.
- **Native function calling is the contract.** `TOOL: name {json}` parsing is a
  fallback for weak models and is never advertised in the prompt.
- **History survives the Composio session.** They have unrelated lifetimes; a
  dropped Composio session must not cost the user their conversation.
- **Fallback is sticky on purpose.** Auto-reverting would flap between providers
  during a partial outage. The flag file makes the state visible and reversible.
- **Tool allow-lists fail closed.** An unlisted tool is invisible, so a typo in
  `agent.json` costs capability instead of leaking it.
- **Tests are per-suite processes.** `bun run check` type-checks, then runs each
  `test/*.test.ts` in its own process so env and module state cannot leak between
  suites.
