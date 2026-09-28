/**
 * Telegram delivery used by anything that has no `Telegram.Context` in hand
 * (i.e. the scheduler). Bot handlers use ctx.reply instead.
 *
 * Single-responsibility: chunk a message to fit Telegram's 4096-char limit and
 * POST it. Returns a boolean instead of throwing so callers can decide whether a
 * delivery failure is fatal — a failed notification must never re-run the AI.
 */
import { env } from './config'
import { Logger } from './logger'

const log = new Logger('send')
const MAX_TG_MSG = 4096

async function sendChunk(chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      log.warn(`Telegram API ${res.status} for ${chatId}: ${body.slice(0, 200)}`)
      return false
    }
    return true
  } catch (err) {
    log.warn(`Telegram send threw for ${chatId}: ${err}`)
    return false
  }
}

export function sendTelegram(chatId: string, text: string): Promise<boolean> {
  if (text.length <= MAX_TG_MSG) return sendChunk(chatId, text)

  // Prefer breaking on a newline near the limit; fall back to a hard cut.
  let remaining = text
  const chunks: Promise<boolean>[] = []
  while (remaining.length > 0) {
    if (remaining.length <= MAX_TG_MSG) {
      chunks.push(sendChunk(chatId, remaining))
      break
    }
    const window = remaining.slice(0, MAX_TG_MSG)
    const lastNewline = window.lastIndexOf('\n')
    const cutAt = lastNewline > MAX_TG_MSG - 300 ? lastNewline + 1 : MAX_TG_MSG
    chunks.push(sendChunk(chatId, remaining.slice(0, cutAt)))
    remaining = remaining.slice(cutAt)
  }
  return Promise.all(chunks).then(results => results.every(Boolean))
}

/** Mention a user so a proactive notification is actually noticed. */
export function mention(chatId: string): string {
  return `<a href="tg://user?id=${chatId}">@here</a>`
}
