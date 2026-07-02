import { readFileSync } from 'fs'
import { join } from 'path'
import { createOpenAI } from '@ai-sdk/openai'
import { Composio } from '@composio/core'
import { VercelProvider } from '@composio/vercel'
import { streamText, stepCountIs, isLoopFinished, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import { Logger } from './logger'
import { env, AGENT_MAX_STEPS, MAX_TOKENS, MODEL, AI_API_KEY, AI_BASE_URL } from './config'
import { maskPii } from './pii'
import type { MemoryStore } from './memory-store'
import type { JobStore } from './job-store'

const log = new Logger('ai')

const openai = createOpenAI({
  baseURL: AI_BASE_URL,
  apiKey: AI_API_KEY,
})

export const model = openai.chat(MODEL)

export const composio = new Composio({
  apiKey: env.COMPOSIO_API_KEY,
  provider: new VercelProvider() as any,
})

const SYSTEM_PROMPT = readFileSync(join(import.meta.dir, '..', 'prompts', 'system.txt'), 'utf-8').trim()
log.info(`System prompt loaded (${SYSTEM_PROMPT.length} chars)`)
log.debug(`System prompt: ${SYSTEM_PROMPT}`)

function summarizeResult(result: unknown): string {
  if (typeof result === 'string') return truncate(result, 300)
  if (typeof result === 'object' && result !== null) {
    try {
      return truncate(JSON.stringify(result), 300)
    } catch {
      return String(result)
    }
  }
  return truncate(String(result), 300)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

export async function summarizeConversation(
  messages: ModelMessage[],
  existingSummary?: string,
): Promise<string> {
  const prior = existingSummary ? `Prior summary:\n${existingSummary}\n\n` : ''
  const transcript = messages
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant'
      const raw = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as any[]).filter(p => p.type === 'text').map((p: any) => p.text).join(' ')
          : ''
      return raw.trim() ? `${role}: ${raw.slice(0, 600)}` : null
    })
    .filter(Boolean)
    .join('\n')

  if (!transcript) return existingSummary ?? ''

  const result = streamText({
    model,
    system: 'You are a conversation summarizer. Output a concise factual summary (max 150 words): topics discussed, tasks completed, decisions made, user facts learned. Plain text only.',
    messages: [{ role: 'user', content: `${prior}Conversation to summarize:\n${transcript}` }],
    stopWhen: [stepCountIs(1)],
  })
  return (await result.text).trim()
}

export interface ProcessResult {
  text: string
  messages: ModelMessage[]
  composioSessionId: string
  totalSteps: number
  finishReason: string
}

export async function processUserMessage(
  messages: ModelMessage[],
  entityId: string,
  existingSessionId: string | null,
  onToolCall: (toolName: string) => void,
  onToolResult: (toolName: string, summary: string) => void,
  maxSteps: number = AGENT_MAX_STEPS,
  memoryStore?: MemoryStore,
  jobStore?: JobStore,
): Promise<ProcessResult> {
  let session
  if (existingSessionId) {
    log.info(`Reusing composio session ${existingSessionId} for entity ${entityId}`)
    session = await composio.toolRouter.use(existingSessionId)
  } else {
    log.info(`Creating new composio session for entity ${entityId}`)
    session = await composio.create(entityId, { manageConnections: { enable: true, waitForConnections: true } })
    log.info(`Composio session created: ${session.sessionId}`)
  }

  const IST_OFFSET_MS = 5.5 * 3600 * 1000
  const istNow = new Date(Date.now() + IST_OFFSET_MS)
  const istTimeStr = `${String(istNow.getUTCHours()).padStart(2, '0')}:${String(istNow.getUTCMinutes()).padStart(2, '0')}`
  let systemPrompt = `Current IST time: ${istTimeStr}\n${SYSTEM_PROMPT}`
  if (memoryStore) {
    const memory = memoryStore.list(entityId)
    const entries = Object.entries(memory)
    if (entries.length > 0) {
      systemPrompt += `\n\n## User Memory\n${entries.map(([k, v]) => `${k}: ${v}`).join('\n')}`
      log.info(`Injected ${entries.length} memory entries for user ${entityId}`)
    }
  }

  const TOOLS_TIMEOUT_MS = 60_000
  log.info(`Fetching tools for session ${session.sessionId} (timeout ${TOOLS_TIMEOUT_MS}ms)`)
  const composioTools = await Promise.race([
    session.tools(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Tools fetch timed out')), TOOLS_TIMEOUT_MS),
    ),
  ])
  const toolNames = Object.keys(composioTools)
  log.info(`Loaded ${toolNames.length} composio tools: ${toolNames.join(', ')}`)

  const IST_OFFSET_MS_AI = 5.5 * 3600 * 1000
  const nowIST = () => {
    const d = new Date(Date.now() + IST_OFFSET_MS_AI)
    return { h: d.getUTCHours(), m: d.getUTCMinutes() }
  }
  const fmtIST = (h: number, m: number) =>
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

  let tools: Record<string, any> = { ...composioTools }
  tools.compute = tool({
    description: 'Current IST time or time arithmetic. Use for relative time calculations instead of guessing. Supports day wrapping.',
    inputSchema: z.object({
      action: z.enum(['get_time', 'add_time']),
      time: z.string().optional().describe('For add_time: base time in HH:MM IST.'),
      amount: z.number().optional().describe('For add_time: minutes to add (positive integer).'),
    }),
    execute: async ({ action, time, amount }) => {
      log.info(`tool compute: action=${action} time=${time ?? '-'} amount=${amount ?? '-'}`)
      if (action === 'get_time') {
        const { h, m } = nowIST()
        const result = `Current IST time: ${fmtIST(h, m)}`
        log.info(`tool compute result: ${result}`)
        return result
      }
      if (action === 'add_time') {
        if (!time || amount == null) return 'time and amount required'
        const [h, m] = time.split(':').map(Number)
        if (isNaN(h) || isNaN(m)) return `invalid time "${time}" — use HH:MM`
        const totalMin = h * 60 + m + Math.max(0, Math.floor(amount))
        const wrappedH = Math.floor(totalMin / 60) % 24
        const wrappedM = totalMin % 60
        const days = Math.floor(totalMin / 1440)
        const dayLabel = days === 0 ? '' : days === 1 ? ' (next day)' : ` (${days} days later)`
        const result = `${fmtIST(wrappedH, wrappedM)}${dayLabel}`
        log.info(`tool compute result: ${result}`)
        return result
      }
      return 'invalid action — use get_time or add_time'
    },
  })
  if (memoryStore) {
    tools.memory = tool({
      description: 'Remember or retrieve information about the current user. Use for names, preferences, facts, and anything the user should not have to repeat. "list" action returns all stored keys and values.',
      inputSchema: z.object({
        action: z.enum(['get', 'set', 'delete', 'list']),
        key: z.string().optional().describe('Key to get/set/delete. Required for get/set/delete.'),
        value: z.string().optional().describe('Value to store. Required for set.'),
      }),
      execute: async ({ action, key, value }) => {
        log.info(`tool memory: action=${action} key=${key ?? '-'} value=${value !== undefined ? maskPii(String(value)) : '-'}`)
        switch (action) {
          case 'get': {
            if (!key) return 'key required for get'
            const val = memoryStore.get(entityId, key)
            return val ?? `no memory for key "${key}"`
          }
          case 'set': {
            if (!key || value === undefined) return 'key and value required for set'
            memoryStore.set(entityId, key, value)
            return `stored "${key}" = "${value}"`
          }
          case 'delete': {
            if (!key) return 'key required for delete'
            memoryStore.delete(entityId, key)
            return `deleted "${key}"`
          }
          case 'list': {
            const all = memoryStore.list(entityId)
            const entries = Object.entries(all)
            if (entries.length === 0) return 'no stored memory'
            return entries.map(([k, v]) => `${k}: ${v}`).join('\n')
          }
        }
      },
    })
  }

  if (jobStore) {
    let jobCreated = false
    tools.createScheduledJob = tool({
      description: 'Manage scheduled jobs — create, list, or cancel. All times IST (UTC+5:30). Call ONCE per request — tool will reject duplicates.',
      inputSchema: z.object({
        action: z.enum(['create', 'list', 'cancel']).describe('create = schedule new job, list = show active jobs, cancel = remove by jobId or task text'),
        task: z.string().optional().describe('For create: what to do at scheduled time. For cancel: text to match against existing jobs (supports partial match). Use task OR jobId, not both.'),
        jobId: z.number().int().positive().optional().describe('For cancel: cancel job by ID (e.g. 3). Use task OR jobId, not both.'),
        scheduleType: z.enum(['once', 'daily', 'weekdays', 'weekly']).optional().describe('Required for create. once = single, daily = every day, weekdays = Mon-Fri, weekly = specific day'),
        time: z.string().optional().describe('Required for create unless offset_minutes is set. Time in IST, 24h HH:MM (e.g. "09:00", "18:30").'),
        offset_minutes: z.number().int().positive().optional().describe('Alternative to time: minutes from now. Use for "in 2 min", "in 1 hour", "in 30 min". Tool computes target HH:MM internally. Do not use with time.'),
        dayOfWeek: z.string().optional().describe('Required if scheduleType=weekly. Day name in English (e.g. "monday"). Ignored otherwise.'),
        needsAi: z.boolean().optional().describe('Set true if task needs AI tool execution (e.g. "check email", "summarize", "generate report"). Omit or false for simple text reminders.'),
      }),
      execute: async ({ action, task, jobId, scheduleType, time, offset_minutes, dayOfWeek, needsAi }) => {
        if (action === 'list') {
          log.info(`tool createScheduledJob: action=list`)
          const jobs = jobStore.listByUser(entityId)
          if (jobs.length === 0) return 'No active scheduled jobs.'
          return jobs.map(j => `#${j.id} — ${j.scheduleType} at ${j.hour.toString().padStart(2, '0')}:${j.minute.toString().padStart(2, '0')} IST — "${j.task}"`).join('\n')
        }
        if (action === 'cancel') {
          if (jobId) {
            log.info(`tool createScheduledJob: action=cancel jobId=${jobId}`)
            const result = jobStore.cancelById(jobId, entityId)
            return result ?? 'No matching job found.'
          }
          if (!task) return 'Task text or jobId required for cancellation.'
          log.info(`tool createScheduledJob: action=cancel task="${task}"`)
          const result = jobStore.cancelByTask(entityId, task)
          return result ?? 'No matching job found.'
        }
        if (jobCreated) {
          log.warn(`tool createScheduledJob: duplicate create blocked for entity ${entityId}`)
          return 'Already scheduled. Tell user it\'s done — no more tool calls needed.'
        }
        if (!task || !scheduleType) return 'task, scheduleType required for create.'
        if (!time && offset_minutes == null) return 'time or offset_minutes required for create.'
        let hour: number, minute: number
        if (time) {
          ;[hour, minute] = time.split(':').map(Number)
          log.info(`tool createScheduledJob: action=create task="${task}" type=${scheduleType} time=${time} hour=${hour} min=${minute} needsAi=${needsAi}`)
        } else {
          const { h, m } = nowIST()
          const totalMin = h * 60 + m + Math.max(1, Math.floor(offset_minutes!))
          hour = Math.floor(totalMin / 60) % 24
          minute = totalMin % 60
          log.info(`tool createScheduledJob: action=create task="${task}" type=${scheduleType} offset=${offset_minutes}min -> ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST needsAi=${needsAi}`)
        }
        const dowMap: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
        const dayOfWeekNum = dayOfWeek ? dowMap[dayOfWeek.toLowerCase()] : undefined
        const result = jobStore.create(entityId, task, scheduleType, hour, minute, dayOfWeekNum, needsAi)
        log.info(`tool createScheduledJob result: ${result}`)
        jobCreated = true
        return result
      },
    })
  }

  const AI_TIMEOUT_MS = 180_000
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => {
    log.warn(`AI agent timeout after ${AI_TIMEOUT_MS}ms for entity ${entityId}`)
    abortController.abort()
  }, AI_TIMEOUT_MS)

  const firstChunkWarningId = setTimeout(() => {
    log.warn(`No response from model after 30s for entity ${entityId} — still waiting`)
  }, 30_000)

  log.info(`Starting agent loop (max ${maxSteps} steps), timeout ${AI_TIMEOUT_MS}ms`)

  // GLM-4 leaks <|channel|>commentary tokens into tool names; sanitize on lookup
  const sanitizedTools = new Proxy(tools, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.includes('<|')) {
        const clean = prop.split('<|')[0]
        if (clean !== prop) log.warn(`Sanitized tool name: "${prop}" → "${clean}"`)
        return (target as any)[clean]
      }
      return (target as any)[prop]
    },
    has(target, prop) {
      if (typeof prop === 'string' && prop.includes('<|')) {
        return prop.split('<|')[0] in target
      }
      return prop in target
    },
  }) as typeof tools

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools: sanitizedTools,
    maxOutputTokens: MAX_TOKENS,
    stopWhen: [isLoopFinished(), stepCountIs(maxSteps)],
    abortSignal: abortController.signal,
  })

  const loopStartTime = Date.now()
  let step = 0
  let toolCallCount = 0
  let stepToolCalls: string[] = []
  let timedOut = false
  let gotFirstChunk = false
  let accumulatedText = ''

  try {
    for await (const chunk of result.fullStream) {
      if (!gotFirstChunk) {
        gotFirstChunk = true
        clearTimeout(firstChunkWarningId)
        const elapsed = Date.now() - loopStartTime
        log.info(`First chunk received after ${elapsed}ms`)
      }
      if (chunk.type === 'start-step') {
        step++
        stepToolCalls = []
        log.info(`Step ${step}/${maxSteps} started`)
      } else if (chunk.type === 'text-delta') {
        accumulatedText += chunk.text
      } else if (chunk.type === 'finish-step') {
        log.info(`Step ${step}/${maxSteps} finished: reason=${chunk.finishReason}, tools=${stepToolCalls.join(', ') || 'none'}`)
      } else if (chunk.type === 'tool-call') {
        toolCallCount++
        const cleanToolName = chunk.toolName.includes('<|') ? chunk.toolName.split('<|')[0] : chunk.toolName
        stepToolCalls.push(cleanToolName)
        const toolArgs = 'input' in chunk ? (chunk as any).input : (chunk as any).args
        log.info(`  Tool call: ${cleanToolName}(args=${maskPii(truncate(JSON.stringify(toolArgs), 200))})`)
        onToolCall(cleanToolName)
      } else if (chunk.type === 'tool-result') {
        const cleanToolName = chunk.toolName.includes('<|') ? chunk.toolName.split('<|')[0] : chunk.toolName
        log.info(`  Tool result: ${cleanToolName} -> ${maskPii(truncate(summarizeResult(chunk.output), 100))}`)
        onToolResult(cleanToolName, summarizeResult(chunk.output))
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      timedOut = true
      log.warn(`Agent loop aborted for entity ${entityId}: timeout`)
    } else {
      log.error(`Agent loop error for entity ${entityId}: ${err}`)
      throw err
    }
  } finally {
    clearTimeout(timeoutId)
  }

  if (timedOut || abortController.signal.aborted) {
    log.warn(`Agent loop timed out for entity ${entityId}: timedOut=${timedOut}, aborted=${abortController.signal.aborted}`)
    return {
      text: '⚠️ I took too long to respond. Please try again or rephrase your request.',
      messages: [],
      composioSessionId: session.sessionId,
      totalSteps: step,
      finishReason: 'timeout',
    }
  }

  log.info(`Agent loop complete: ${step} steps, ${toolCallCount} tool calls`)

  let finalText = ''
  let response: any = { messages: [] }
  let finishReason = ''
  try {
    finalText = await result.text
    // result.text is empty when finishReason=tool-calls; fall back to stream-accumulated text
    if (!finalText && accumulatedText) {
      log.info('result.text empty, using accumulated text-delta fallback')
      finalText = accumulatedText
    }
    response = await result.response
    finishReason = await result.finishReason
    log.info(`Final response: ${finalText ? maskPii(truncate(finalText, 200)) : '(empty)'}, finish=${finishReason}`)
  } catch (err: unknown) {
    log.warn(`Failed to read final result for entity ${entityId}: ${err}`)
    finalText = '⚠️ I encountered an issue processing your request. Please try again.'
    response = { messages: [] }
    finishReason = 'error'
  }

  return {
    text: finalText,
    messages: response.messages as ModelMessage[],
    composioSessionId: session.sessionId,
    totalSteps: step,
    finishReason,
  }
}
