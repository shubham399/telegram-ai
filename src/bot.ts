import { Telegraf, type Context } from 'telegraf'
import { env, ALLOWED_USER_IDS, SESSION_TIMEOUT_MS } from './config'
import { Logger } from './logger'
import { SessionStore } from './session-store'
import { MemoryStore } from './memory-store'
import { ConversationStore } from './conversation-store'
import type { JobStore } from './job-store'
import { processUserMessage, summarizeConversation } from './ai'
import { startScheduler } from './scheduler'
import { maskPii } from './pii'
import type { ModelMessage } from 'ai'

const log = new Logger('bot')

export function createBot(sessionStore: SessionStore, conversationStore: ConversationStore, memoryStore?: MemoryStore, jobStore?: JobStore) {
  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN)
  const MAX_CONV_MESSAGES = 20
  const convLog = log.child('conversations')

  bot.use((ctx: Context, next) => {
    const userId = ctx.from?.id?.toString()
    if (!userId || !ALLOWED_USER_IDS.includes(userId)) {
      log.warn(`Blocked non-whitelisted user: ${userId ?? '???'}`)
      ctx.reply('You are not authorized to use this bot.').catch(() => {})
      return
    }
    log.debug(`Whitelist pass: user ${userId}`)
    return next()
  })

  function parseScheduling(text: string, uid: string): { handled: boolean; reply?: string } {
    if (!jobStore) return { handled: false }

    const lower = text.toLowerCase().trim()

    const listMatch = lower.match(/^(list|show)\s.*(reminder|job|schedule)/i)
    if (listMatch) {
      const jobs = jobStore.listByUser(uid)
      if (jobs.length === 0) return { handled: true, reply: 'No active scheduled jobs.' }
      const lines = jobs.map(j => `#${j.id} — ${j.scheduleType} at ${String(j.hour).padStart(2, '0')}:${String(j.minute).padStart(2, '0')} IST — "${j.task}"`)
      return { handled: true, reply: `📋 Scheduled jobs:\n${lines.join('\n')}` }
    }

    const cancelByIdMatch = lower.match(/cancel\s+(?:job\s*#?\s*|#)?\s*(\d+)(?:\s*$|\n)/im)
    if (cancelByIdMatch) {
      const result = jobStore.cancelById(parseInt(cancelByIdMatch[1]), uid)
      return { handled: true, reply: result ?? 'No matching job found.' }
    }

    const cancelMatch = lower.match(/cancel.*(reminder|job|schedule).*[:in]?\s*(.+)/i)
    if (cancelMatch && cancelMatch[2]) {
      const result = jobStore.cancelByTask(uid, cancelMatch[2].trim())
      return { handled: true, reply: result ?? 'No matching job found.' }
    }
    const cancelSimple = lower.match(/cancel\s+(.+)/i)
    if (cancelSimple && (lower.includes('reminder') || lower.includes('job') || lower.includes('schedule') || lower.includes('all'))) {
      const result = jobStore.cancelByTask(uid, cancelSimple[1].trim())
      return { handled: true, reply: result ?? 'No matching job found.' }
    }

    const remindMatch = lower.match(/remind\s+me\s+(?:to\s+)?(?:in|after)\s+(\d+)\s*(min|mins|minute|minutes|hour|hours)(?:\s+(?:to\s+)?(.+))?/i)
    if (remindMatch) {
      const amount = parseInt(remindMatch[1])
      const unit = remindMatch[2].toLowerCase()
      const task = remindMatch[3]?.trim() || 'reminder'
      const offsetMinutes = unit.startsWith('hour') ? amount * 60 : amount
      const IST_OFFSET = 5.5 * 3600 * 1000
      const now = new Date(Date.now() + IST_OFFSET)
      const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMinutes
      const hour = Math.floor(totalMin / 60) % 24
      const minute = totalMin % 60
      const result = jobStore.create(uid, task, 'once', hour, minute, undefined, false)
      log.info(`Direct scheduling: "${text}" -> once at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST, task="${task}"`)
      return { handled: true, reply: `✅ ${result}` }
    }

    const remindAtMatch = lower.match(/remind\s+me\s+(?:to\s+)?at\s+(\d{1,2})[.:](\d{2})\s*(am|pm)?\s*(?:to\s+)?(.+)/i)
    if (remindAtMatch) {
      let hour = parseInt(remindAtMatch[1])
      const minute = parseInt(remindAtMatch[2])
      const meridian = remindAtMatch[3]
      const task = remindAtMatch[4]?.trim() || 'reminder'
      if (meridian?.toLowerCase() === 'pm' && hour < 12) hour += 12
      if (meridian?.toLowerCase() === 'am' && hour === 12) hour = 0
      const result = jobStore.create(uid, task, 'once', hour, minute, undefined, false)
      log.info(`Direct scheduling: "${text}" -> once at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST, task="${task}"`)
      return { handled: true, reply: `✅ ${result}` }
    }

    const genericInMatch = lower.match(/^(?!i\b|we\b|my\b|he\b|she\b|it\b|they\b|i'|we'|he'|she'|it'|they')(.+)\s+in\s+(\d+)\s*(min|mins|minute|minutes|hour|hours)\s*$/i)
    if (genericInMatch && !lower.startsWith('remind')) {
      const task = genericInMatch[1].trim()
      const amount = parseInt(genericInMatch[2])
      const unit = genericInMatch[3].toLowerCase()
      const offsetMinutes = unit.startsWith('hour') ? amount * 60 : amount
      const IST_OFFSET = 5.5 * 3600 * 1000
      const now = new Date(Date.now() + IST_OFFSET)
      const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMinutes
      const hour = Math.floor(totalMin / 60) % 24
      const minute = totalMin % 60
      const result = jobStore.create(uid, task, 'once', hour, minute, undefined, true)
      log.info(`Direct scheduling (generic): "${text}" -> once at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST, needsAi=true, task="${task}"`)
      return { handled: true, reply: `✅ Scheduled "${task}" for ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST. I'll work on it then.` }
    }

    if (lower.startsWith('remind me') || lower.startsWith('remind me to')) {
      log.warn(`Direct scheduling: unparseable remind request — "${text}"`)
    }

    return { handled: false }
  }

  async function processTextMessage(ctx: Context, userId: string, text: string, replyOpts: object) {
    const msgLog = log.child(`user:${userId}`)

    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => clearInterval(typingInterval))
    }, 4000)

    try {
      msgLog.info(`Received: "${maskPii(text.slice(0, 100))}"`)

      const scheduled = parseScheduling(text, userId)
      if (scheduled.handled) {
        clearInterval(typingInterval)
        msgLog.info(`Handled by direct scheduling`)
        await ctx.reply(scheduled.reply!, replyOpts)
        return
      }

      const existingRow = sessionStore.get(userId, SESSION_TIMEOUT_MS)
      const existingSessionId = existingRow?.composioSessionId ?? null
      msgLog.info(`Session: ${existingSessionId ? existingSessionId : 'new (none found)'}`)
      // Session gone (new user or timed out) means composio tool context is stale — drop conversation history with it.
      if (!existingSessionId) conversationStore.clear(userId)

      const storedHistory = conversationStore.list(userId)
      msgLog.debug(`History before: ${storedHistory.length} entries`)

      const aiMessages: ModelMessage[] = [
        ...storedHistory,
        { role: 'user' as const, content: text },
      ]

      try {
        msgLog.info('Calling processUserMessage')
        const { text: finalText, messages: updatedMessages, composioSessionId, totalSteps, finishReason } = await processUserMessage(
          aiMessages,
          userId,
          existingSessionId,
          (toolName: string) => {
            msgLog.info(`Tool call: ${toolName}`)
            if (!toolName.startsWith('COMPOSIO_')) {
              ctx.reply(`🔧 Calling *${escapeMd(toolName)}*…`, { parse_mode: 'MarkdownV2', ...replyOpts }).catch(
                () => msgLog.warn('Failed to send tool-call msg'),
              )
            }
          },
          (toolName: string, summary: string) => {
            msgLog.info(`Tool result: ${toolName} (${summary.length} chars)`)
            if (!toolName.startsWith('COMPOSIO_')) {
              ctx.reply(`📎 Result: ${escapeMd(summary)}`, { parse_mode: 'MarkdownV2', ...replyOpts }).catch(
                () => msgLog.warn('Failed to send tool-result msg'),
              )
            }
          },
          undefined,
          memoryStore,
          jobStore,
        )

        msgLog.info(`Composio session: ${composioSessionId}`)
        msgLog.info(`Agent completed: ${totalSteps} steps, finish=${finishReason}`)
        sessionStore.upsert(userId, composioSessionId)

        conversationStore.append(userId, [{ role: 'user' as const, content: text }, ...updatedMessages])

        const totalCount = conversationStore.count(userId)
        if (totalCount > MAX_CONV_MESSAGES) {
          const excess = conversationStore.list(userId).slice(0, totalCount - MAX_CONV_MESSAGES)
          summarizeConversation(excess)
            .then(summary => conversationStore.compact(userId, MAX_CONV_MESSAGES, summary))
            .catch(e => convLog.warn(`Compaction failed for ${userId}: ${e}`))
        }
        convLog.debug(`Conversation ${userId}: now ${totalCount} entries`)

        clearInterval(typingInterval)

        if (finalText) {
          const outputCheck = sanitizeOutput(finalText)
          if (outputCheck.flagged) {
            msgLog.warn(`Output leak detected: ${outputCheck.pattern}`)
          }
          msgLog.info(`Reply: "${maskPii(finalText.slice(0, 200))}"`)
          await ctx.reply(finalText, replyOpts)
        } else if (finishReason !== 'tool-calls') {
          msgLog.warn('No final text from AI, sending fallback reply')
          await ctx.reply('Done! What else can I help with?', replyOpts)
        }

        sessionStore.updateActivity(userId)
        msgLog.info('Message processed successfully')
      } finally {
        clearInterval(typingInterval)
      }
    } catch (err) {
      msgLog.error('Error processing message')
      const message = err instanceof Error ? err.message : 'Unknown error'
      await ctx.reply(`⚠️ Error: ${message}`, replyOpts).catch(
        () => msgLog.warn('Failed to send error reply'),
      )
    }
  }

  bot.on('text', async (ctx: Context) => {
    const userId = ctx.from!.id.toString()
    const text = (ctx.message as any).text

    if (text === '/start') {
      log.info(`User ${userId} sent /start`)
      await ctx.reply('Hi! Send me any message and I\'ll use my tools to help you.')
      return
    }

    const sanitized = sanitizeInput(text)
    if (sanitized.flagged) {
      log.warn(`Injection attempt from ${userId}: pattern="${sanitized.pattern}", text="${maskPii(text.slice(0, 200))}"`)
    }

    const originalMessageId = (ctx.message as any).message_id
    const replyOpts = { reply_parameters: { message_id: originalMessageId } }

    await processTextMessage(ctx, userId, text, replyOpts)
  })

  bot.on('sticker', async (ctx: Context) => {
    const userId = ctx.from!.id.toString()
    const emoji = (ctx.message as any).sticker?.emoji ?? null
    const text = emoji ?? '[Sticker]'
    const originalMessageId = (ctx.message as any).message_id
    const replyOpts = { reply_parameters: { message_id: originalMessageId } }

    await processTextMessage(ctx, userId, text, replyOpts)
  })

  if (jobStore) {
    startScheduler(jobStore)
  }

  bot.catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('409') || msg.includes('Conflict')) {
      log.warn('409 Conflict detected, re-launching bot in 5s...')
      setTimeout(() => {
        bot.launch().catch(e => log.error(`Re-launch failed: ${e instanceof Error ? e.message : e}`))
      }, 5000)
      return
    }
    log.error(`Unhandled Telegraf error: ${msg}`)
    if (err instanceof Error && err.stack) log.debug(`Telegraf stack: ${err.stack}`)
  })

  return bot
}

function escapeMd(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|messages|rules)/i, label: 'ignore-prior-instructions' },
  { pattern: /forget\s+(all\s+)?(previous|above|prior)\s+(instructions|messages|rules)/i, label: 'forget-prior-instructions' },
  { pattern: /you\s+are\s+(now|not\s+an?\s+AI|a\s+free|ChatGPT|GPT)/i, label: 'identity-override' },
  { pattern: /system\s+(prompt|instruction|message)/i, label: 'system-prompt-query' },
  { pattern: /reveal\s+(your|the)\s+(system\s+)?prompt/i, label: 'reveal-system-prompt' },
  { pattern: /output\s+(your|the)\s+(system\s+)?prompt/i, label: 'output-system-prompt' },
  { pattern: /repeat\s+(after|everything|all\s+(the\s+)?(above|previous))/i, label: 'repeat-prompt' },
  { pattern: /DAN|do\s+anything\s+now|jailbreak/i, label: 'jailbreak-keyword' },
]

function sanitizeInput(text: string): { flagged: boolean; pattern?: string } {
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return { flagged: true, pattern: label }
    }
  }
  return { flagged: false }
}

const OUTPUT_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?(previous|above)\s+(instructions|rules)/i, label: 'output-contains-ignore-instructions' },
  { pattern: /system\s+(prompt|instruction|message)\s*[:=]/i, label: 'output-contains-system-prompt' },
]

function sanitizeOutput(text: string): { flagged: boolean; pattern?: string } {
  for (const { pattern, label } of OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      return { flagged: true, pattern: label }
    }
  }
  return { flagged: false }
}
