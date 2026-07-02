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
| **Streaming UX** | Step messages: user sees intermediate "Calling tool...", "Result: ...", then final answer |
| **Runtime** | Bun — local / long-running process |
