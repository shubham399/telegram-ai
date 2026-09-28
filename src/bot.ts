import { Telegraf, type Context } from 'telegraf'
import { env, ALLOWED_USER_IDS } from './config'
import { Logger } from './logger'
import { SessionStore } from './session-store'
import { MemoryStore } from './memory-store'
import { ConversationStore } from './conversation-store'
import type { JobStore } from './job-store'
import { processUserMessage } from './ai'
import { summarizeConversation, messagesTokens } from './history'
import { maskPii, maskUserId } from './pii'
import { userQueue } from './queue'
import { agents } from './agents'
import { istTimeIn } from './time'
import { UserState, KEY_SESSION, KEY_AGENT, KEY_MODEL, DEFAULT_SESSION } from './user-state'
import type { ConversationScope } from './conversation-store'
import { createRequest, cancelFor, isCancelled, markFinished } from './request-registry'
import { router } from './model-router'
import type { LoopStore } from './loop-store'
import type { NoteStore } from './note-store'
import type { TodoStore } from './todo-store'
import type { UsageLedger } from './usage-ledger'
import type { Maintenance } from './maintenance'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

const log = new Logger('bot')

export interface BotDeps {
  sessionStore: SessionStore
  conversationStore: ConversationStore
  userState: UserState
  loopStore: LoopStore
  noteStore: NoteStore
  todoStore: TodoStore
  usageLedger: UsageLedger
  maintenance: Maintenance
  memoryStore?: MemoryStore
  jobStore?: JobStore
}

export function createBot(deps: BotDeps) {
  const {
    sessionStore,
    conversationStore,
    userState,
    loopStore,
    noteStore,
    todoStore,
    usageLedger,
    maintenance,
    memoryStore,
    jobStore,
  } = deps

  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN)
  const SESSION_TIMEOUT_MS = 10 * 60 * 1000
  const convLog = log.child('conversations')

  /**
   * Compaction budget. Token-based rather than message-count based because the
   * two things that actually blow up a conversation are a single 16k-char tool
   * result and a long assistant reply — both of which are 2 messages, not 20.
   */
  const CONV_TOKEN_BUDGET = 60_000
  const CONV_KEEP_RECENT = 10

  /** A clarify awaiting a button press. Bounded by TTL so it cannot leak. */
  const pendingClarify = new Map<string, { options: string[]; messageId: number; at: number }>()
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000
    for (const [userId, entry] of pendingClarify) {
      if (entry.at < cutoff) pendingClarify.delete(userId)
    }
  }, 60_000).unref()

  const newSessionId = (): string =>
    `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`

  /** The conversation this turn belongs to. */
  const scopeFor = (userId: string): ConversationScope => ({
    sessionId: userState.get(userId, KEY_SESSION) ?? DEFAULT_SESSION,
    agentName: userState.get(userId, KEY_AGENT) ?? 'default',
  })

  /**
   * Pick the agent for a turn: an explicit `/agent` pin wins, otherwise the
   * specialist whose keywords match.
   */
  function routeAgent(userId: string, text: string): string {
    const pinned = userState.get(userId, KEY_AGENT)
    if (pinned && agents.has(pinned)) {
      log.debug(`Pinned agent "${pinned}" for ${maskUserId(userId)}`)
      return pinned
    }
    const matched = agents.select(text)
    if (matched) {
      log.info(`Routed ${maskUserId(userId)} to agent "${matched.name}"`)
      return matched.name
    }
    return 'default'
  }

  bot.use((ctx: Context, next) => {
    const userId = ctx.from?.id?.toString()
    if (!userId || !ALLOWED_USER_IDS.includes(userId)) {
      log.warn(`Blocked non-whitelisted user: ${userId ?? '???'}`)
      ctx.reply('You are not authorized to use this bot.').catch(() => {})
      return
    }
    log.debug(`Whitelist pass: user ${maskUserId(userId)}`)
    return next()
  })

  /** The IST clock plus `offsetMinutes`, wrapping at midnight. */
  function istTimeInOffset(offsetMinutes: number): { hour: number; minute: number } {
    const { h, m } = istTimeIn()
    const totalMin = h * 60 + m + offsetMinutes
    return { hour: Math.floor(totalMin / 60) % 24, minute: totalMin % 60 }
  }

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
      const { hour, minute } = istTimeInOffset(offsetMinutes)
      const result = jobStore.create(uid, task, 'once', hour, minute, undefined, false).message
      log.info(`Direct scheduling: "${maskPii(text.slice(0, 120))}" -> once at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST`)
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
      const result = jobStore.create(uid, task, 'once', hour, minute, undefined, false).message
      log.info(`Direct scheduling: "${maskPii(text.slice(0, 120))}" -> once at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST`)
      return { handled: true, reply: `✅ ${result}` }
    }

    const genericInMatch = lower.match(/^(?!i\b|we\b|my\b|he\b|she\b|it\b|they\b|i'|we'|he'|she'|it'|they')(.+)\s+in\s+(\d+)\s*(min|mins|minute|minutes|hour|hours)\s*$/i)
    if (genericInMatch && !lower.startsWith('remind')) {
      const task = genericInMatch[1].trim()
      const amount = parseInt(genericInMatch[2])
      const unit = genericInMatch[3].toLowerCase()
      const offsetMinutes = unit.startsWith('hour') ? amount * 60 : amount
      const { hour, minute } = istTimeInOffset(offsetMinutes)
      jobStore.create(uid, task, 'once', hour, minute, undefined, true)
      log.info(`Direct scheduling (generic): "${maskPii(text.slice(0, 120))}" -> once at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST, needsAi=true`)
      return { handled: true, reply: `✅ Scheduled "${task}" for ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST. I'll work on it then.` }
    }

    if (lower.startsWith('remind me') || lower.startsWith('remind me to')) {
      log.warn(`Direct scheduling: unparseable remind request — "${maskPii(text.slice(0, 120))}"`)
    }

    return { handled: false }
  }

  /**
   * Fold the older half of a conversation into its rolling summary once the
   * token budget is exceeded. Never throws — a failed compaction just means we
   * try again next turn.
   */
  async function compactIfNeeded(userId: string, scope: ConversationScope): Promise<void> {
    const stored = conversationStore.list(userId, scope)
    if (stored.length <= CONV_KEEP_RECENT) return

    if (messagesTokens(stored) <= CONV_TOKEN_BUDGET) return

    // Keep the newest half so the tail of the conversation survives verbatim.
    const keepLast = Math.max(CONV_KEEP_RECENT, Math.floor(stored.length / 2))
    const dropped = stored.slice(0, stored.length - keepLast)

    try {
      const summary = await summarizeConversation(dropped, conversationStore.getSummary(userId, scope) ?? undefined)
      if (!summary) {
        convLog.warn(`Compaction produced no summary for ${maskUserId(userId)}; leaving history intact`)
        return
      }
      conversationStore.compact(userId, scope, keepLast, summary)
    } catch (err) {
      convLog.warn(`Compaction failed for ${maskUserId(userId)}: ${err}`)
    }
  }

  async function processTextMessage(ctx: Context, userId: string, text: string, replyOpts: object) {
    const msgLog = log.child(`user:${maskUserId(userId)}`)

    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => clearInterval(typingInterval))
    }, 4000)

    const request = { id: '' }
    let loopId = ''

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
      msgLog.info(`Composio session: ${existingSessionId ? 'reusing' : 'new (none found)'}`)

      // The composio session and the conversation are unrelated lifetimes. A
      // session that timed out server-side says nothing about the user's history,
      // and the runner already mints a fresh session when reuse is rejected. This
      // used to delete the whole conversation whenever the row expired.
      const scope = scopeFor(userId)
      const agentName = routeAgent(userId, text)
      const loopId = loopStore.start(userId, scope, `${request.id}-${agentName}`)
      const modelOverride = userState.get(userId, KEY_MODEL) ?? undefined
      msgLog.debug(`Scope: session=${scope.sessionId} agent=${agentName}`)

      const storedHistory = conversationStore.listWithSummary(userId, scope)
      msgLog.debug(`History before: ${storedHistory.length} entries, ~${messagesTokens(storedHistory)} tokens`)

      const aiMessages: ChatCompletionMessageParam[] = [
        ...storedHistory,
        { role: 'user', content: text },
      ]

      try {
        msgLog.info('Calling processUserMessage')
        const created = createRequest(userId)
        request.id = created.id
        const { text: finalText, messages: updatedMessages, composioSessionId, totalSteps, finishReason, lastToolResult } = await processUserMessage({
          messages: aiMessages,
          entityId: userId,
          existingSessionId,
          agentName,
          model: modelOverride,
          requestId: request.id,
          // Checkpoint so a crash mid-run resumes instead of restarting. Stale
          // loops from a previous process are finished, not resumed here: the
          // bot owns an interactive turn, and resuming would double-answer.
          checkpoint: { onStep: (step, messages) => loopStore.record(loopId, step, messages) },
          noteStore,
          todoStore,
          usageLedger,
          maintenance,
          onToolCall: (toolName: string, args?: Record<string, unknown>) => {
            msgLog.info(`Tool call: ${toolName}`)
            const msg = toolUxMessage(toolName, args)
            if (msg) {
              ctx.reply(msg, replyOpts).catch(() => msgLog.warn('Failed to send tool-call msg'))
            }
          },
          onToolResult: (_toolName: string, _summary: string) => {
            // suppress raw tool-result messages — UX handled in toolUxMessage/call
          },
          memoryStore,
          jobStore,
        })

        msgLog.info(`Composio session: ${composioSessionId}`)
        msgLog.info(`Agent completed: ${totalSteps} steps, finish=${finishReason}`)
        sessionStore.upsert(userId, composioSessionId)

        if (isCancelled(request.id)) {
          msgLog.warn('Run was cancelled by /stop; discarding partial history')
          if (loopId) loopStore.finish(loopId, 'failed')
        } else {
          const newToStore = updatedMessages.slice(storedHistory.length)
          conversationStore.append(userId, scope, newToStore)
        }

        // Awaited on purpose: fire-and-forget compaction used to race the next
        // message, so history could exceed the budget indefinitely.
        await compactIfNeeded(userId, scope)
        convLog.debug(`Conversation ${maskUserId(userId)}: now ${conversationStore.count(userId, scope)} entries`)

        clearInterval(typingInterval)

        if (finalText) {
          // A clarify() turn renders as tappable buttons; anything else is prose.
          const clarify = parseClarify(finalText)
          if (clarify) {
            msgLog.info(`Rendering clarify with ${clarify.options.length} option(s)`)
            pendingClarify.set(userId, {
              options: clarify.options,
              messageId: (ctx.message as any)?.message_id,
              at: Date.now(),
            })
            await ctx.reply(`❓ ${clarify.question}`, {
              ...replyOpts,
              reply_markup: {
                inline_keyboard: clarify.options.map((option, i) => [
                  { text: option, callback_data: `clarify:${i}` },
                ]),
              },
            })
            return
          }

          const outputCheck = sanitizeOutput(finalText)
          if (outputCheck.flagged) {
            msgLog.warn(`Output leak detected: ${outputCheck.pattern}`)
          }
          msgLog.info(`Reply: "${maskPii(finalText.slice(0, 200))}"`)
          await ctx.reply(finalText, replyOpts)
        } else if (lastToolResult) {
          msgLog.warn('No final text from AI, falling back to last tool result')
          await ctx.reply(lastToolResult, replyOpts)
        } else {
          msgLog.warn('No final text from AI, sending fallback reply')
          await ctx.reply('Done! What else can I help with?', replyOpts)
        }

        if (loopId) loopStore.finish(loopId, 'done')
        sessionStore.updateActivity(userId)
        msgLog.info('Message processed successfully')
      } finally {
        markFinished(userId, request.id)
        clearInterval(typingInterval)
      }
    } catch (err) {
      if (request.id) markFinished(userId, request.id)
      if (loopId) loopStore.finish(loopId, 'failed')
      msgLog.error('Error processing message')
      const message = err instanceof Error ? err.message : 'Unknown error'
      await ctx.reply(`⚠️ Error: ${message}`, replyOpts).catch(
        () => msgLog.warn('Failed to send error reply'),
      )
    }
  }

  /**
   * Commands that need no model. Kept as a table so a new one is a single entry
   * rather than another `if` in the hot path.
   */
  const COMMANDS: Record<string, (ctx: Context, userId: string, arg: string) => Promise<unknown>> = {
    '/start': async ctx => {
      return ctx.reply(
        'Hi! Send me any message and I\'ll use my tools to help you.\n\n' +
        '/new — fresh conversation\n' +
        '/session — show or switch sessions\n' +
        '/clear — wipe this conversation\n' +
        '/agent — pin or unpin a specialist\n' +
        '/model — override the model\n' +
        '/stop — cancel what I am doing',
      )
    },

    '/new': async (ctx, userId) => {
      const id = newSessionId()
      userState.set(userId, KEY_SESSION, id)
      log.info(`New session for ${maskUserId(userId)}: ${id}`)
      return ctx.reply('🆕 New conversation. What are we working on?')
    },

    '/session': async (ctx, userId, arg) => {
      const wanted = arg.trim()
      if (!wanted) {
        const current = userState.get(userId, KEY_SESSION) ?? DEFAULT_SESSION
        return ctx.reply(`Current session: \`${current}\`\nUse \`/session <name>\` to switch.`)
      }
      if (wanted === 'default') userState.delete(userId, KEY_SESSION)
      else userState.set(userId, KEY_SESSION, wanted)
      log.info(`Session switch for ${maskUserId(userId)}: ${wanted}`)
      return ctx.reply(`Switched to session \`${wanted}\`.`)
    },

    '/clear': async (ctx, userId) => {
      const scope = scopeFor(userId)
      conversationStore.clear(userId, scope)
      return ctx.reply('🧹 Cleared this conversation.')
    },

    '/agent': async (ctx, userId, arg) => {
      const wanted = arg.trim().toLowerCase()
      if (!wanted || wanted === 'list') {
        const pinned = userState.get(userId, KEY_AGENT) ?? 'default'
        const lines = agents.list().map(a => `\`${a.name}\`${a.name === pinned ? ' ← pinned' : ''} — ${a.description}`)
        return ctx.reply(`🤖 Agents (pinned: \`${pinned}\`)\n${lines.join('\n')}\n\nUse \`/agent <name>\` or \`/agent auto\` to unpin.`)
      }
      if (wanted === 'auto') {
        userState.delete(userId, KEY_AGENT)
        return ctx.reply('🤖 Unpinned — I will pick the agent per message.')
      }
      if (!agents.has(wanted)) {
        return ctx.reply(`Unknown agent \`${wanted}\`. Available: ${agents.names.join(', ')}`)
      }
      userState.set(userId, KEY_AGENT, wanted)
      log.info(`Pinned agent "${wanted}" for ${maskUserId(userId)}`)
      return ctx.reply(`🤖 Pinned to \`${wanted}\`.`)
    },

    '/model': async (ctx, userId, arg) => {
      const wanted = arg.trim()
      if (!wanted) {
        const current = userState.get(userId, KEY_MODEL)
        return ctx.reply(`Model: \`${current ?? router.activeModel}\` (default). Use \`/model reset\` to clear.`)
      }
      if (wanted === 'reset') userState.delete(userId, KEY_MODEL)
      else userState.set(userId, KEY_MODEL, wanted)
      return ctx.reply(`Model set to \`${wanted}\`.`)
    },

    '/stop': async (ctx, userId) => {
      const stopped = cancelFor(userId)
      return ctx.reply(stopped ? '🛑 Stopping.' : 'Nothing is running right now.')
    },
  }

  bot.on('text', (ctx: Context) => {
    const userId = ctx.from!.id.toString()
    const text = (ctx.message as any).text

    // Commands resolve before anything else: no queue, no typing indicator, no
    // model. They must work even while an agent run is in flight.
    const [maybeCommand, ...rest] = text.trim().split(/\s+/)
    const handler = maybeCommand?.toLowerCase()
    if (handler && Object.prototype.hasOwnProperty.call(COMMANDS, handler)) {
      log.debug(`Command ${handler} from ${maskUserId(userId)}`)
      return Promise.resolve(COMMANDS[handler](ctx, userId, rest.join(' '))).catch(err =>
        log.error(`Command ${handler} failed: ${err instanceof Error ? err.message : err}`),
      )
    }

    const sanitized = sanitizeInput(text)
    if (sanitized.flagged) {
      log.warn(`Injection attempt from ${maskUserId(userId)}: pattern="${sanitized.pattern}", text="${maskPii(text.slice(0, 200))}"`)
    }

    const originalMessageId = (ctx.message as any).message_id
    const replyOpts = { reply_parameters: { message_id: originalMessageId } }

    // Deliberately not awaited: the agent run can take minutes, and holding the
    // update pipeline open would block every other user's message. The queue keeps
    // this user's own turns in order.
    void userQueue.enqueue(userId, () => processTextMessage(ctx, userId, text, replyOpts))
      .catch(err => log.error(`Queued turn failed for ${maskUserId(userId)}: ${err}`))
  })

  bot.on('sticker', (ctx: Context) => {
    const userId = ctx.from!.id.toString()
    const emoji = (ctx.message as any).sticker?.emoji ?? null
    const text = emoji ?? '[Sticker]'
    const originalMessageId = (ctx.message as any).message_id
    const replyOpts = { reply_parameters: { message_id: originalMessageId } }

    void userQueue.enqueue(userId, () => processTextMessage(ctx, userId, text, replyOpts))
      .catch(err => log.error(`Queued sticker turn failed for ${maskUserId(userId)}: ${err}`))
  })

  /**
   * Answer buttons for `clarify`. The chosen index is mapped back to the option
   * text in `pendingClarify`, keyed by user, and fed to the agent as a normal turn
   * — a callback query cannot drive the agent loop itself, and routing it through
   * the normal path keeps one code path for conversation history.
   */
  bot.action(/^clarify:(\d+)$/, async (ctx: Context) => {
    const userId = ctx.from!.id.toString()
    const index = Number(((ctx as any).match as RegExpMatchArray)[1])
    const pending = pendingClarify.get(userId)
    if (!pending) {
      await ctx.answerCbQuery('That question has expired — ask me again.')
      return
    }
    const option = pending.options[index]
    pendingClarify.delete(userId)
    await ctx.answerCbQuery()
    if (!option) {
      await ctx.reply('That option is no longer available.')
      return
    }
    log.info(`User ${maskUserId(userId)} answered clarify with option ${index}`)
    const replyOpts = { reply_parameters: { message_id: pending.messageId } }
    void userQueue
      .enqueue(userId, () => processTextMessage(ctx, userId, option, replyOpts))
      .catch(err => log.error(`Clarified turn failed for ${maskUserId(userId)}: ${err}`))
  })

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

const CLARIFY_RE = /^CLARIFY:\s*(.+?)\n\n((?:\d+\.\s.+\n?)+)/

/**
 * Recognise the `clarify` tool's return value so it can be shown as buttons rather
 * than as a wall of text. Returns null for ordinary replies.
 */
function parseClarify(text: string): { question: string; options: string[] } | null {
  const match = text.match(CLARIFY_RE)
  if (!match) return null
  const options = match[2]
    .split('\n')
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
  if (options.length < 2) return null
  return { question: match[1].trim(), options }
}

function toolUxMessage(toolName: string, args?: Record<string, unknown>): string | null {
  if (toolName === 'composio') {
    const action = args?.action as string
    const tool = args?.tool as string | undefined
    const query = args?.query as string | undefined
    if (action === 'search') {
      return query?.toLowerCase().includes('gmail')
        ? '🔍 Checking your Gmail...'
        : '🔍 Looking up available services...'
    }
    if (action === 'execute') {
      const upper = (tool ?? '').toUpperCase()
      if (upper.includes('GMAIL')) return '📬 Fetching your emails...'
      if (upper.includes('CALENDAR')) return '📅 Checking your calendar...'
      if (upper.includes('GITHUB')) return '🐙 Checking GitHub...'
      if (upper.includes('DRIVE')) return '📁 Checking Google Drive...'
      return '⚙️ Running request...'
    }
    return '⚙️ Processing...'
  }
  if (toolName === 'memory') return null
  if (toolName === 'compute') return null
  return `🔧 ${toolName}…`
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
