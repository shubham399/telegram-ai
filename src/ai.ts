import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import OpenAI from 'openai'
import type { ChatCompletionTool, ChatCompletionMessageParam, ChatCompletionAssistantMessageParam } from 'openai/resources/chat/completions'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { Composio } from '@composio/core'
import { OpenAIResponsesProvider } from '@composio/openai'
import { Logger } from './logger'
import { env, AGENT_MAX_STEPS, MODEL, AI_API_KEY, AI_BASE_URL } from './config'
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
  provider: new OpenAIResponsesProvider(),
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
}

export async function processUserMessage(
  messages: ChatCompletionMessageParam[],
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

  const ctx: ToolContext = { entityId, composioSession: session, memoryStore, jobStore }
  const customTools = await loadTools(ctx)
  const toolNames = Object.keys(customTools)
  log.info(`Loaded ${toolNames.length} custom tools: ${toolNames.join(', ')}`)

  const customOpenAITools: ChatCompletionTool[] = Object.entries(customTools).map(
    ([name, def]) => customToolToOpenAI(name, def),
  )

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

  const apiMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ]

  let step = 0
  let toolCallCount = 0
  let timedOut = false
  let gotFirstChunk = false
  let accumulatedText = ''

  try {
    for (step = 1; step <= maxSteps; step++) {
      log.info(`Step ${step}/${maxSteps} started`)

      const response = await client.chat.completions.create({
        model: MODEL,
        messages: apiMessages,
        tools: customOpenAITools.length > 0 ? customOpenAITools : undefined,
        max_tokens: 4096,
        stream: true,
      })

      let finishReason = ''
      let responseContent = ''
      let responseToolCalls: any[] = []

      for await (const chunk of response) {
        if (!gotFirstChunk) {
          gotFirstChunk = true
          clearTimeout(firstChunkWarningId)
          log.info(`First chunk received`)
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue

        if (choice.delta?.content) {
          responseContent += choice.delta.content
          accumulatedText += choice.delta.content
        }

        if (choice.delta?.tool_calls) {
          for (const tcDelta of choice.delta.tool_calls) {
            if (tcDelta.id) {
              responseToolCalls.push({
                id: tcDelta.id,
                type: 'function',
                index: tcDelta.index,
                function: { name: tcDelta.function?.name || '', arguments: tcDelta.function?.arguments || '' },
              })
            } else {
              const existing = responseToolCalls.find((tc: any) => tc.index === tcDelta.index)
              if (existing) {
                existing.function.arguments += tcDelta.function?.arguments || ''
              }
            }
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason
        }
      }

      if (responseToolCalls.length > 0) {
        toolCallCount += responseToolCalls.length

        const assistantMsg: ChatCompletionAssistantMessageParam & { function_call?: any } = {
          role: 'assistant',
          content: responseContent || null,
          tool_calls: responseToolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        }
        apiMessages.push(assistantMsg)

        const stepToolNames: string[] = []

        for (const tc of responseToolCalls) {
          const toolName = tc.function.name
          stepToolNames.push(toolName)
          const cleanName = toolName.includes('<|') ? toolName.split('<|')[0] : toolName
          log.info(`  Tool call: ${cleanName}(args=${maskPii(truncate(tc.function.arguments, 200))})`)
          onToolCall(cleanName)

          let result: any
          try {
            if (toolName in customTools) {
              const args = JSON.parse(tc.function.arguments || '{}')
              result = await customTools[toolName].execute(args)
            } else {
              log.warn(`Unknown tool: ${toolName}`)
              result = `⚠️ Unknown tool: ${toolName}`
            }
          } catch (err: any) {
            log.warn(`Tool execution failed: ${toolName} — ${err.message}`)
            result = `⚠️ Error executing ${toolName}: ${err.message}`
          }

          const summary = summarizeResult(result)
          log.info(`  Tool result: ${cleanName} -> ${maskPii(truncate(summary, 100))}`)
          onToolResult(cleanName, summary)

          apiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          } as ChatCompletionMessageParam)
        }

        log.info(`Step ${step}/${maxSteps} finished: tool_calls=${stepToolNames.join(', ')}`)
      } else {
        log.info(`Step ${step}/${maxSteps} finished: response, finish_reason=${finishReason}`)
        clearTimeout(timeoutId)

        return {
          text: responseContent,
          messages: apiMessages.filter(m => m.role !== 'system'),
          composioSessionId: session.sessionId,
          totalSteps: step,
          finishReason: finishReason || 'stop',
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
    clearTimeout(firstChunkWarningId)
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

  const lastMsg = apiMessages[apiMessages.length - 1]
  const finalContent = lastMsg?.role === 'assistant' ? lastMsg.content : null
  const finalText = typeof finalContent === 'string' ? finalContent : accumulatedText || ''

  return {
    text: finalText,
    messages: apiMessages.filter(m => m.role !== 'system'),
    composioSessionId: session.sessionId,
    totalSteps: step,
    finishReason: 'max-steps',
  }
}
