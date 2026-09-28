import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { Composio, OpenAIProvider } from '@composio/core'
import { Logger } from './logger'
import { env, AGENT_MAX_STEPS } from './config'
import { router, type ModelRouter } from './model-router'
import { sanitizeHistory } from './history'
import { runTool, toToolMessage, normalizeToolName, type ToolExecDeps } from './tool-exec'
import { maskUserId, maskSessionId } from './pii'
import { isAdmin } from './admin'
import { agents } from './agents'
import { isCancelled } from './request-registry'
import type { MemoryStore } from './memory-store'
import type { JobStore } from './job-store'
import type { CustomToolDef, ToolContext } from './tool-def'
import type { UsageLedger } from './usage-ledger'
import type { NoteStore } from './note-store'
import type { TodoStore } from './todo-store'
import type { Maintenance } from './maintenance'
import { IST_OFFSET_MS } from './time'

const log = new Logger('ai')

export const composio = new Composio({
  apiKey: env.COMPOSIO_API_KEY,
  provider: new OpenAIProvider(),
})

const SYSTEM_PROMPT = readFileSync(join(import.meta.dir, '..', 'prompts', 'system.txt'), 'utf-8').trim()
log.info(`System prompt loaded (${SYSTEM_PROMPT.length} chars)`)

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

// Not openai's zodFunction(): that builds a *strict* schema, which rejects
// `.optional()` fields outright, and every tool here has some. Nullable would be a
// different contract (explicit null vs absent), so the permissive shim stays.
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

/**
 * Tool file names, resolved once.
 *
 * ponytail: the set only changes when someone adds a file, and the bot restarts
 * to pick that up anyway — so this is a permanent cache, not a TTL cache.
 */
const TOOL_FILES: string[] = readdirSync(join(import.meta.dir, 'tools'))
  .filter(f => f.endsWith('.ts') && !f.startsWith('_') && f !== 'index.ts')
log.info(`Discovered ${TOOL_FILES.length} tool file(s)`)

async function loadTools(ctx: ToolContext, agentName: string): Promise<Record<string, CustomToolDef>> {
  const toolDir = join(import.meta.dir, 'tools')
  const tools: Record<string, CustomToolDef> = {}

  for (const file of TOOL_FILES) {
    try {
      const mod = await import(join(toolDir, file))
      if (!mod.createTool) continue

      const name = mod.toolName ?? file.replace('.ts', '')
      if (mod.adminOnly && !isAdmin(ctx.entityId)) continue
      if (mod.needsMemory && !ctx.memoryStore) continue
      if (mod.needsJobStore && !ctx.jobStore) continue
      if (mod.needsNotes && !ctx.noteStore) continue
      if (mod.needsTodos && !ctx.todoStore) continue
      if (mod.needsMaintenance && !ctx.maintenance) continue
      if (mod.needsUsageLedger && !ctx.usageLedger) continue
      // Least privilege: an agent cannot call a tool its definition does not list.
      if (!agents.allows(agentName, name)) {
        log.debug(`Tool "${name}" not in agent "${agentName}" allow-list — hidden`)
        continue
      }

      const tool = mod.createTool(ctx)
      if (tool) {
        tools[name] = tool
        log.debug(`Loaded tool: ${name} (from ${file})`)
      }
    } catch (err) {
      log.warn(`Failed to load tool ${file}: ${err}`)
    }
  }

  return tools
}

export interface ProcessResult {
  text: string
  messages: ChatCompletionMessageParam[]
  composioSessionId: string
  totalSteps: number
  finishReason: string
  lastToolResult?: string
}

/** Delegation is capped: a sub-agent may delegate once more, then must stop. */
const MAX_DELEGATION_DEPTH = 2

export interface ProcessOptions {
  messages: ChatCompletionMessageParam[]
  entityId: string
  existingSessionId: string | null
  onToolCall: (toolName: string, args?: Record<string, unknown>) => void
  onToolResult: (toolName: string, summary: string) => void
  agentName?: string
  maxSteps?: number
  memoryStore?: MemoryStore
  jobStore?: JobStore
  depth?: number
  model?: string
  usageLedger?: UsageLedger
  noteStore?: NoteStore
  todoStore?: TodoStore
  maintenance?: Maintenance
  /** Polled between steps so `/stop` can end a run without killing the process. */
  requestId?: string
  /**
   * Crash-resume hooks. Injected, not imported: the agent loop does not know that
   * checkpoints are stored in SQLite.
   */
  checkpoint?: CheckpointHooks
  /**
   * Model access. Injected so a test can drive the loop, and so the agent loop is
   * not welded to the process-wide router. Defaults to the shared instance; there
   * is no reason to pass one in production.
   */
  router?: Pick<ModelRouter, 'complete'>
  /**
   * Composio session factory. Injected for the same reason as the router — without
   * it the loop cannot run without live credentials. Defaults to the shared
   * instance.
   */
  composioClient?: ComposioClient
}

/** A Composio tool-router session: one per user, reused across turns. */
export interface ComposioSession {
  sessionId: string
  tools(): Promise<unknown>
  execute: (slug: string, args: any) => Promise<any>
  search: (params: { query: string }) => Promise<any>
}

/** The slice of the Composio SDK used to mint and reuse a session. */
export interface ComposioClient {
  create(entityId: string, opts?: unknown): Promise<ComposioSession>
  toolRouter: { use(sessionId: string): Promise<ComposioSession>
  }
}

export interface CheckpointHooks {
  /** Called after each step with everything produced so far. */
  onStep?: (step: number, messages: ChatCompletionMessageParam[]) => void
  /** When set, the loop restarts from this step instead of step 1. */
  resume?: { step: number; messages: ChatCompletionMessageParam[] }
}

export async function processUserMessage(opts: ProcessOptions): Promise<ProcessResult> {
  const {
    messages,
    entityId,
    existingSessionId,
    onToolCall,
    onToolResult,
    agentName = 'default',
    maxSteps = AGENT_MAX_STEPS,
    memoryStore,
    jobStore,
    depth = 0,
    model,
    usageLedger,
    noteStore,
    todoStore,
    maintenance,
    requestId,
    checkpoint,
    composioClient = composio,
  } = opts

  const agent = agents.get(agentName)
  let session: ComposioSession
  if (existingSessionId) {
    // Reusing a session saves a round trip, but Composio expires them server-side.
    // A rejected `use()` must not fail the whole request — fall through and mint a
    // fresh one, which is always valid.
    try {
      log.info(`Reusing composio session ${maskSessionId(existingSessionId)} for entity ${maskUserId(entityId)}`)
      session = await composioClient.toolRouter.use(existingSessionId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`Stored composio session was rejected (${message}); creating a new one`)
      session = await composioClient.create(entityId, { manageConnections: { enable: true, waitForConnections: true } })
      log.info(`Composio session created: ${maskSessionId(session.sessionId)}`)
    }
  } else {
    log.info(`Creating new composio session for entity ${maskUserId(entityId)}`)
    session = await composioClient.create(entityId, { manageConnections: { enable: true, waitForConnections: true } })
    log.info(`Composio session created: ${maskSessionId(session.sessionId)}`)
  }

  const istNow = new Date(Date.now() + IST_OFFSET_MS)
  const istTimeStr = `${String(istNow.getUTCHours()).padStart(2, '0')}:${String(istNow.getUTCMinutes()).padStart(2, '0')}`
  let systemPrompt = `Current IST time: ${istTimeStr}\n${SYSTEM_PROMPT}`
  if (agent.soul) {
    // Identity comes after the base rules, so a specialist's persona cannot
    // override them.
    systemPrompt += `\n\n# You are now acting as the "${agent.name}" agent\n\n${agent.soul}`
  }
  if (memoryStore) {
    const memory = memoryStore.list(entityId)
    const entries = Object.entries(memory)
    if (entries.length > 0) {
      systemPrompt += `\n\n## User Memory\n${entries.map(([k, v]) => `${k}: ${v}`).join('\n')}`
      log.info(`Injected ${entries.length} memory entries for ${maskUserId(entityId)}`)
    }
  }

  const ctx: ToolContext = {
    entityId,
    agentName,
    composioSession: session,
    memoryStore,
    jobStore,
    noteStore,
    todoStore,
    maintenance,
    usageLedger,
    delegate:
      depth < MAX_DELEGATION_DEPTH
        ? createDelegate({ ...opts, depth })
        : undefined,
  }
  const customTools = await loadTools(ctx, agentName)

  // Composio injects its own management tools (COMPOSIO_MANAGE_CONNECTIONS,
  // COMPOSIO_MULTI_EXECUTE, …). They are not part of the system prompt's tool
  // contract, so advertising them makes the model call them and then have no idea
  // what to do with the result. A failed load is survivable: the run just has no
  // Composio tools.
  const nameOf = (t: ChatCompletionTool): string =>
    (t as { function?: { name?: string } }).function?.name ?? ''
  let composioOpenAITools: ChatCompletionTool[] = []
  try {
    const raw = (await session.tools()) as ChatCompletionTool[]
    if (Array.isArray(raw)) {
      const filtered = raw.filter(t => !/^COMPOSIO_/i.test(nameOf(t)))
      composioOpenAITools = agents.allowsComposio(agentName) ? filtered : []
      const dropped = raw.length - composioOpenAITools.length
      if (dropped > 0) log.debug(`Filtered ${dropped} COMPOSIO_* meta-tool(s)`)
    }
  } catch (err: any) {
    log.warn(`Failed to load composio tools: ${err.message}`)
  }
  const composioToolNames = new Set(composioOpenAITools.map(nameOf).map(n => n.toUpperCase()))

  const toolNames = Object.keys(customTools)
  log.info(`Loaded ${toolNames.length} custom tool(s) + ${composioOpenAITools.length} composio tool(s)`)

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
    log.warn(`AI agent timeout after ${AI_TIMEOUT_MS}ms for entity ${maskUserId(entityId)}`)
    abortController.abort()
  }, AI_TIMEOUT_MS)

  log.info(`Starting agent loop (max ${maxSteps} steps), timeout ${AI_TIMEOUT_MS}ms`)

  const rawMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ]
  // History may have been produced by a different provider (or truncated by an
  // earlier compaction). Strip vendor fields and unpaired tool-call halves
  // before it goes back on the wire.
  const apiMessages: ChatCompletionMessageParam[] = sanitizeHistory(rawMessages)
  const dropped = rawMessages.length - apiMessages.length
  if (dropped > 0) log.info(`History sanitization dropped ${dropped} message(s) before request`)

  // A resumed run continues from the recorded step; the messages are the exact
  // prefix the crashed run had built.
  let step = checkpoint?.resume?.step ?? 0
  if (checkpoint?.resume) {
    log.info(`Resuming from checkpoint at step ${step} (${checkpoint.resume.messages.length} messages)`)
    apiMessages.length = 0
    apiMessages.push(...checkpoint.resume.messages)
  }

  let finalText = ''
  let timedOut = false
  let lastToolResult = ''

  // Four exits (cancelled, timed out, max-steps, done) all return the same shape.
  const done = (
    text: string,
    finishReason: ProcessResult['finishReason'],
    messages = apiMessages.filter(m => m.role !== 'system'),
  ): ProcessResult => ({
    text,
    messages,
    composioSessionId: session.sessionId,
    totalSteps: step,
    finishReason,
    lastToolResult,
  })

  const execDeps: ToolExecDeps = {
    customTools,
    composio,
    entityId,
    composioToolNames,
    onToolCall,
    onToolResult,
  }

  try {
    for (step = 1; step <= maxSteps; step++) {
      // Checked at the step boundary: the cheapest place that still leaves the run
      // in a consistent state (no half-written tool result).
      if (requestId && isCancelled(requestId)) {
        log.warn('Run cancelled by user between steps')
        finalText = 'Cancelled.'
        clearTimeout(timeoutId)
        return done(finalText, 'cancelled')
      }

      log.info(`Step ${step}/${maxSteps} started`)

      const completed = await (opts.router ?? router).complete({
        messages: apiMessages,
        tools: allTools,
        ...(model ? { modelOverride: model } : {}),
        ...(usageLedger
          ? {
              onUsage: (u: { model: string; promptTokens: number; completionTokens: number; totalTokens: number; usedFallback: boolean; attempts: number }) =>
                usageLedger.record({ entityId, agentName, ...u }),
            }
          : {}),
        signal: abortController.signal,
      })
      const response = completed.response
      if (completed.usedFallback) {
        log.info(`Served by fallback model ${completed.model} after ${completed.attempts} attempt(s)`)
      }

      const msg = response.choices?.[0]?.message
      if (!msg) break

      const hasNativeCalls = !!(msg.tool_calls && msg.tool_calls.length > 0)
      const textCalls = parseTextToolCalls(msg.content || '', customTools, composioToolNames)
      const hasTextCalls = textCalls.length > 0

      if (hasNativeCalls) {
        // A model can emit a native call *and* a leftover `TOOL:` line. Drop the
        // text form so it is not persisted into history as assistant prose.
        const stripped = stripTextToolCalls(msg.content || '')
        apiMessages.push({ ...msg, content: stripped || null } as ChatCompletionMessageParam)

        for (const tcRaw of msg.tool_calls!) {
          const tc = tcRaw as any
          if (!tc.function) continue
          const name = normalizeToolName(tc.function.name)

          let args: Record<string, unknown>
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
          } catch {
            args = {}
          }

          const outcome = await runTool(
            { name, args, toolCallId: tc.id, raw: { ...tc, function: { ...tc.function, name } } },
            execDeps,
          )
          apiMessages.push(toToolMessage(outcome))
          lastToolResult = outcome.summary
        }
        const callNames = (msg.tool_calls || []).map((t: any) => normalizeToolName(t?.function?.name || '?')).join(', ')
        log.info(`Step ${step}/${maxSteps} finished: native_calls=${callNames}`)
        checkpoint?.onStep?.(step, [...apiMessages])

      } else if (hasTextCalls) {
        const cleanContent = stripTextToolCalls(msg.content || '')
        apiMessages.push({ role: 'assistant', content: cleanContent || null })

        for (const tc of textCalls) {
          const toolCallId = `text_${tc.name}_${step}`
          const outcome = await runTool(
            {
              name: tc.name,
              args: tc.args,
              toolCallId,
              raw: {
                id: toolCallId,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              },
            },
            execDeps,
          )
          apiMessages.push(toToolMessage(outcome))
          lastToolResult = outcome.summary
        }
        log.info(`Step ${step}/${maxSteps} finished: text_calls=${textCalls.map(t => t.name).join(', ')}`)
        checkpoint?.onStep?.(step, [...apiMessages])

      } else {
        log.info(`Step ${step}/${maxSteps} finished: response, finish_reason=${response.choices[0]?.finish_reason}`)
        finalText = msg.content || ''
        clearTimeout(timeoutId)

        apiMessages.push(msg)

        return done(finalText, response.choices[0]?.finish_reason || 'stop')
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      timedOut = true
      log.warn(`Agent loop aborted for entity ${maskUserId(entityId)}: timeout`)
    } else {
      log.error(`Agent loop error for entity ${maskUserId(entityId)}: ${err}`)
      throw err
    }
  } finally {
    clearTimeout(timeoutId)
  }

  if (timedOut) {
    // Nothing partial to replay: the abort left apiMessages mid-tool-call.
    return done('⚠️ I took too long to respond. Try again.', 'timeout', [])
  }

  const lastMsg = apiMessages[apiMessages.length - 1]
  const content = lastMsg?.role === 'assistant' ? lastMsg.content : null
  return done(typeof content === 'string' ? content : finalText, 'max-steps')
}

/**
 * Build the `delegate_task` callback for one agent run.
 *
 * ponytail: a delegated run is ephemeral — its intermediate steps are not written
 * to the conversation store, only its final text comes back. That keeps a
 * 10-step sub-run from silently eating the parent's context budget. Upgrade path:
 * persist sub-runs under `scope.agentName` when cross-agent memory is actually
 * wanted, and pay the token cost then.
 */
export function createDelegate(base: ProcessOptions): (agentName: string, task: string) => Promise<string> {
  // The depth comes from `base`, not from a second parameter. A separate parameter
  // is spread before it and so silently wins, which resets every nested sub-run to
  // depth 1 and turns the cap into no cap at all.
  const depth = (base.depth ?? 0) + 1
  return async (agentName: string, task: string): Promise<string> => {
    const result = await processUserMessage({
      ...base,
      agentName,
      depth,
      // A sub-run must not emit Telegram progress for a turn the user is not
      // watching, and it gets fewer steps: the point of delegating is to hand the
      // work off, not to double the budget.
      onToolCall: () => {},
      onToolResult: () => {},
      maxSteps: Math.min(base.maxSteps ?? AGENT_MAX_STEPS, 8),
      messages: [{ role: 'user', content: task }],
    })
    return result.text
  }
}
