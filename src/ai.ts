import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import OpenAI from 'openai'
import type { ChatCompletionTool, ChatCompletionMessageParam, ChatCompletionAssistantMessageParam } from 'openai/resources/chat/completions'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { Composio, OpenAIProvider } from '@composio/core'
import { Logger } from './logger'
import { env, AGENT_MAX_STEPS, MODEL, AI_API_KEY, AI_BASE_URL, MAX_TOOL_RESULT_CHARS } from './config'
import { maskPii } from './pii'
import type { MemoryStore } from './memory-store'
import type { JobStore } from './job-store'
import type { CustomToolDef, ToolContext } from './tool-def'

const log = new Logger('ai')

const client = new OpenAI({
  baseURL: AI_BASE_URL,
  apiKey: AI_API_KEY,
})

export const composio = new Composio({
  apiKey: env.COMPOSIO_API_KEY,
  provider: new OpenAIProvider(),
})

const SYSTEM_PROMPT = readFileSync(join(import.meta.dir, '..', 'prompts', 'system.txt'), 'utf-8').trim()
log.info(`System prompt loaded (${SYSTEM_PROMPT.length} chars)`)

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

const TEXT_TOOL_RE = /^TOOL:\s*(\w+)(?:\s+(.+))?$/im

function parseTextToolCalls(text: string, availableTools: Record<string, CustomToolDef>, composioNames: Set<string>): Array<{ name: string; args: Record<string, any> }> {
  const calls: Array<{ name: string; args: Record<string, any> }> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const match = trimmed.match(TEXT_TOOL_RE)
    if (match && (match[1] in availableTools || composioNames.has(match[1].toUpperCase()))) {
      let args: Record<string, any> = {}
      if (match[2]) {
        try { args = JSON.parse(match[2]) }
        catch { args = { value: match[2] } }
      }
      calls.push({ name: match[1], args })
    }
  }
  return calls
}

function stripTextToolCalls(text: string): string {
  return text.split('\n').filter(l => !TEXT_TOOL_RE.test(l.trim())).join('\n').trim()
}


function customToolToOpenAI(name: string, def: CustomToolDef): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name,
      description: def.description ?? '',
      parameters: zodToJsonSchema(def.parameters) as Record<string, unknown>,
    },
  }
}

async function loadTools(ctx: ToolContext): Promise<Record<string, CustomToolDef>> {
  const toolDir = join(import.meta.dir, 'tools')
  const files = readdirSync(toolDir).filter(f => f.endsWith('.ts') && !f.startsWith('_') && f !== 'index.ts')
  const tools: Record<string, CustomToolDef> = {}

  for (const file of files) {
    try {
      const mod = await import(join(toolDir, file))
      if (!mod.createTool) continue

      const name = mod.toolName ?? file.replace('.ts', '')
      if (mod.adminOnly) continue
      if (mod.needsMemory && !ctx.memoryStore) continue
      if (mod.needsJobStore && !ctx.jobStore) continue

      const tool = mod.createTool(ctx)
      if (tool) {
        tools[name] = tool
        log.info(`Loaded tool: ${name} (from ${file})`)
      }
    } catch (err) {
      log.warn(`Failed to load tool ${file}: ${err}`)
    }
  }

  return tools
}

export async function summarizeConversation(
  messages: ChatCompletionMessageParam[],
  existingSummary?: string,
): Promise<string> {
  const prior = existingSummary ? `Prior summary:\n${existingSummary}\n\n` : ''
  const transcript = messages
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant'
      const raw = typeof m.content === 'string' ? m.content : ''
      return raw.trim() ? `${role}: ${raw.slice(0, 600)}` : null
    })
    .filter(Boolean)
    .join('\n')

  if (!transcript) return existingSummary ?? ''

  const result = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a conversation summarizer. Output a concise factual summary (max 150 words): topics discussed, tasks completed, decisions made, user facts learned. Plain text only.' },
      { role: 'user', content: `${prior}Conversation to summarize:\n${transcript}` },
    ],
    max_tokens: 300,
  })
  return result.choices[0]?.message?.content?.trim() || ''
}

export interface ProcessResult {
  text: string
  messages: ChatCompletionMessageParam[]
  composioSessionId: string
  totalSteps: number
  finishReason: string
  lastToolResult?: string
}

export async function processUserMessage(
  messages: ChatCompletionMessageParam[],
  entityId: string,
  existingSessionId: string | null,
  onToolCall: (toolName: string, args?: Record<string, unknown>) => void,
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

  const ctx: ToolContext = { entityId, composioSession: session, memoryStore, jobStore }
  const customTools = await loadTools(ctx)

  let composioToolNames = new Set<string>()
  let composioOpenAITools: ChatCompletionTool[] = []
  try {
    const raw = await session.tools()
    if (Array.isArray(raw)) {
      composioOpenAITools = raw as ChatCompletionTool[]
      composioToolNames = new Set(composioOpenAITools.map(t => (t as any).function.name.toUpperCase()))
    }
  } catch (err: any) {
    log.warn(`Failed to load composio tools: ${err.message}`)
  }

  const toolNames = Object.keys(customTools)
  log.info(`Loaded ${toolNames.length} custom tools + ${composioOpenAITools.length} composio tools`)

  const customOpenAITools: ChatCompletionTool[] = Object.entries(customTools).map(
    ([name, def]) => customToolToOpenAI(name, def),
  )

  const allTools = [...composioOpenAITools, ...customOpenAITools]

  const toolDescriptions = Object.entries(customTools)
    .map(([name, def]) => `- ${name}: ${def.description ?? 'no description'}`)
    .join('\n')
  const composioToolDescs = composioOpenAITools.map(t => `- ${(t as any).function.name}: ${(t as any).function.description ?? 'composio tool'}`).join('\n')
  systemPrompt += `\n\n## Available Tools\n${toolDescriptions}${composioToolDescs ? '\n' + composioToolDescs : ''}`

  const AI_TIMEOUT_MS = 180_000
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => {
    log.warn(`AI agent timeout after ${AI_TIMEOUT_MS}ms for entity ${entityId}`)
    abortController.abort()
  }, AI_TIMEOUT_MS)

  log.info(`Starting agent loop (max ${maxSteps} steps), timeout ${AI_TIMEOUT_MS}ms`)

  const apiMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ]

  let step = 0
  let toolCallCount = 0
  let finalText = ''
  let timedOut = false
  let lastToolResult = ''

  try {
    for (step = 1; step <= maxSteps; step++) {
      log.info(`Step ${step}/${maxSteps} started`)

      const response = await client.chat.completions.create({
        model: MODEL,
        messages: apiMessages,
        tools: allTools.length > 0 ? allTools : undefined,
        stream: false,
      }, { signal: abortController.signal })

      const msg = response.choices?.[0]?.message
      if (!msg) break

      const hasNativeCalls = !!(msg.tool_calls && msg.tool_calls.length > 0)
      const textCalls = parseTextToolCalls(msg.content || '', customTools, composioToolNames)
      const hasTextCalls = textCalls.length > 0

      if (hasNativeCalls) {
        toolCallCount += msg.tool_calls!.length
        apiMessages.push(msg)

        for (const tcRaw of msg.tool_calls!) {
          const tc = tcRaw as any
          if (!tc.function) continue
          const name = tc.function.name
          const cleanName = name.includes('<|') ? name.split('<|')[0] : name
          log.info(`  Native call: ${cleanName}(${maskPii(truncate(tc.function.arguments, 200))})`)

          let result: any
          try {
            if (cleanName in customTools) {
              const args = JSON.parse(tc.function.arguments || '{}')
              onToolCall(cleanName, args)
              result = await customTools[cleanName].execute(args)
            } else if (composioToolNames.has(cleanName.toUpperCase())) {
              onToolCall(cleanName)
              result = await composio.provider.executeToolCall(entityId, { ...tc, function: { ...tc.function, name: cleanName } })
            } else {
              log.warn(`Unknown tool: ${cleanName}`)
              result = `⚠️ Unknown tool: ${cleanName}`
            }
          } catch (err: any) {
            log.warn(`Tool failed: ${cleanName} — ${err.message}`)
            result = `⚠️ Error: ${err.message}`
          }

          const summary = summarizeResult(result)
          log.info(`  Result: ${cleanName} -> ${maskPii(truncate(summary, 100))}`)
          onToolResult(cleanName, summary)
          lastToolResult = summary

          apiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: truncate(typeof result === 'string' ? result : JSON.stringify(result), MAX_TOOL_RESULT_CHARS),
          } as ChatCompletionMessageParam)
        }
        const callNames = (msg.tool_calls || []).map(t => { const tc = t as any; return tc.function?.name || '?' }).join(', ')
        log.info(`Step ${step}/${maxSteps} finished: native_calls=${callNames}`)

      } else if (hasTextCalls) {
        toolCallCount += textCalls.length
        const cleanContent = stripTextToolCalls(msg.content || '')
        apiMessages.push({ role: 'assistant', content: cleanContent || null })

        for (const tc of textCalls) {
          log.info(`  Text call: ${tc.name}(${maskPii(truncate(JSON.stringify(tc.args), 200))})`)

          let result: any
          try {
            if (tc.name in customTools) {
              onToolCall(tc.name, tc.args)
              result = await customTools[tc.name].execute(tc.args)
            } else if (composioToolNames.has(tc.name.toUpperCase())) {
              onToolCall(tc.name, tc.args)
              result = await composio.provider.executeToolCall(entityId, {
                id: `text_${tc.name}_${step}`,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })
            } else {
              log.warn(`Unknown text tool: ${tc.name}`)
              result = `⚠️ Unknown tool: ${tc.name}`
            }
          } catch (err: any) {
            log.warn(`Text tool failed: ${tc.name} — ${err.message}`)
            result = `⚠️ Error: ${err.message}`
          }

          const summary = summarizeResult(result)
          log.info(`  Result: ${tc.name} -> ${maskPii(truncate(summary, 100))}`)
          onToolResult(tc.name, summary)
          lastToolResult = summary

          apiMessages.push({
            role: 'tool',
            tool_call_id: `text_${tc.name}_${step}`,
            content: truncate(typeof result === 'string' ? result : JSON.stringify(result), MAX_TOOL_RESULT_CHARS),
          } as ChatCompletionMessageParam)
        }
        log.info(`Step ${step}/${maxSteps} finished: text_calls=${textCalls.map(t => t.name).join(', ')}`)

      } else {
        log.info(`Step ${step}/${maxSteps} finished: response, finish_reason=${response.choices[0]?.finish_reason}`)
        finalText = msg.content || ''
        clearTimeout(timeoutId)

        apiMessages.push(msg)

        return {
          text: finalText,
          messages: apiMessages.filter(m => m.role !== 'system'),
          composioSessionId: session.sessionId,
          totalSteps: step,
          finishReason: response.choices[0]?.finish_reason || 'stop',
          lastToolResult,
        }
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

  if (timedOut) {
    return {
      text: '⚠️ I took too long to respond. Try again.',
      messages: [],
      composioSessionId: session.sessionId,
      totalSteps: step,
      finishReason: 'timeout',
      lastToolResult,
    }
  }

  const lastMsg = apiMessages[apiMessages.length - 1]
  const content = lastMsg?.role === 'assistant' ? lastMsg.content : null
  return {
    text: typeof content === 'string' ? content : finalText,
    messages: apiMessages.filter(m => m.role !== 'system'),
    composioSessionId: session.sessionId,
    totalSteps: step,
    finishReason: 'max-steps',
    lastToolResult,
  }
}
