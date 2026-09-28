/**
 * Running exactly one tool call.
 *
 * Single-responsibility: given a name and arguments, work out whether it belongs
 * to a local tool or to Composio, execute it under a timeout, and hand back a
 * ready-to-append `role: 'tool'` message.
 *
 * Extracted because the native function-calling path and the legacy text-based
 * path were doing the same four things twice.
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { Logger } from './logger'
import { maskPii } from './pii'
import { MAX_TOOL_RESULT_CHARS } from './config'
import type { CustomToolDef } from './tool-def'

const log = new Logger('tool-exec')

/** Most tool calls are sub-second. Past this, something is wedged. */
const DEFAULT_TIMEOUT_MS = 30_000

export interface ToolExecDeps {
  customTools: Record<string, CustomToolDef>
  /** Narrowed to the one call made. The SDK type is far wider than this. */
  composio: { provider: { executeToolCall(entityId: string, toolCall: unknown): Promise<any> } }
  entityId: string
  composioToolNames: Set<string>
  onToolCall: (name: string, args?: Record<string, unknown>) => void
  onToolResult: (name: string, summary: string) => void
}

export interface ToolRequest {
  /** Tool name as the model spelled it. */
  name: string
  args: Record<string, unknown>
  /** Must match the assistant's `tool_calls[].id` or the provider rejects the turn. */
  toolCallId: string
  /**
   * The original `tool_call` object. Composio needs the full envelope (id, type,
   * function) — reconstructing it loses fields on some providers.
   */
  raw?: unknown
}

export interface ToolOutcome {
  toolCallId: string
  content: string
  summary: string
  failed: boolean
}

/** Race a promise against a deadline. The loser is abandoned, not cancelled. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise

  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    )
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

function summarize(value: unknown): string {
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value
  try {
    const json = JSON.stringify(value)
    return json.length > 300 ? json.slice(0, 300) + '…' : json
  } catch {
    return String(value)
  }
}

/** Some providers append a routing suffix to the name; take the part before it. */
export function normalizeToolName(name: string): string {
  const bracket = name.indexOf('<|')
  return bracket === -1 ? name : name.slice(0, bracket)
}

export async function runTool(
  request: ToolRequest,
  deps: ToolExecDeps,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ToolOutcome> {
  const { name, args, toolCallId, raw } = request
  const { customTools, entityId, composioToolNames, onToolCall, onToolResult } = deps

  log.info(`call ${name}(${maskPii(JSON.stringify(args).slice(0, 200))})`)
  onToolCall(name, args)

  let result: unknown
  let failed = false

  try {
    if (name in customTools) {
      result = await withTimeout(
        Promise.resolve(customTools[name].execute(args)),
        timeoutMs,
        name,
      )
    } else if (composioToolNames.has(name.toUpperCase())) {
      result = await withTimeout(
        deps.composio.provider.executeToolCall(entityId, raw as never),
        timeoutMs,
        name,
      )
    } else {
      failed = true
      result = `⚠️ Unknown tool: ${name}. Available tools are listed in the system prompt.`
    }
  } catch (err) {
    failed = true
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`tool ${name} failed: ${message}`)
    result = `⚠️ Error: ${message}`
  }

  const serialized = typeof result === 'string' ? result : JSON.stringify(result ?? null)
  const content = serialized.length > MAX_TOOL_RESULT_CHARS
    ? `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[truncated — ${serialized.length} chars total]`
    : serialized

  const summary = summarize(result)
  onToolResult(name, summary)

  return {
    toolCallId,
    content,
    summary,
    failed,
  }
}

export function toToolMessage(outcome: ToolOutcome): ChatCompletionMessageParam {
  return {
    role: 'tool',
    tool_call_id: outcome.toolCallId,
    content: outcome.content,
  } as ChatCompletionMessageParam
}
