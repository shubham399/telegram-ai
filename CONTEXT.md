# Telegram AI Agent

Telegram bot: whitelisted user messages → AI (OpenAI-compatible) → Composio tool execution. Polling mode. No HTTP server.

## Glossary

| Term | Meaning |
|------|---------|
| **User** | Telegram user; sessions keyed by `telegram_user_id` |
| **Whitelist** | `TELEGRAM_ALLOWED_USERS` env var (comma-separated IDs) |
| **Composio Session** | Per-user tool runtime session; created on first message, reused after |
| **Bot** | Telegraf instance running on Bun (polling mode) |
| **Streaming UX** | Step messages: user sees intermediate "Calling tool...", "Result: ...", then final answer |
| **Runtime** | Bun — local / long-running process |
