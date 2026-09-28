/**
 * Choosing which model answers, and surviving when it stops.
 *
 * Single-responsibility: transport selection and failure classification. The
 * agent loop calls `complete()` and never learns which model replied.
 *
 * Why it exists: a single 500 or a revoked key on the only configured provider
 * takes the whole bot offline. With a fallback configured, a bad primary costs one
 * failed request instead of an outage.
 */
import OpenAI from 'openai'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import { Logger } from './logger'
import {
  AI_API_KEY,
  AI_BASE_URL,
  MODEL,
  FALLBACK_MODEL,
  FALLBACK_API_KEY,
  FALLBACK_BASE_URL,
  PRIMARY_RETRY_COUNT,
  MAX_OUTPUT_TOKENS,
  PROVIDER_HEADERS,
  PRIMARY_UA,
  FALLBACK_UA,
} from './config'

const log = new Logger('model-router')

/** Persisted so a provider outage that outlasts a deploy does not reset on boot. */
const FALLBACK_FLAG = 'data/.fallback-active'

export interface ModelConfig {
  name: string
  baseURL: string
  apiKey: string
  userAgent?: string
  headers?: Record<string, string>
  /** Retries on this model before switching. */
  retries: number
}

/**
 * PROVIDER_HEADERS is keyed by base-URL substring, so different providers in the
 * same deployment get different headers:
 *
 *   PROVIDER_HEADERS='{"api.anthropic.com":{"anthropic-version":"2023-06-01"}}'
 */
function parseHeaders(raw: string | undefined, baseURL: string): Record<string, string> | undefined {
  if (!raw) return undefined
  let parsed: Record<string, string>
  try {
    const decoded = JSON.parse(raw) as unknown
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('expected a JSON object keyed by base-URL substring')
    }
    parsed = decoded as Record<string, string>
  } catch (err) {
    // Never take the process down over a malformed optional header blob.
    log.warn(`PROVIDER_HEADERS is not valid JSON, ignoring: ${err}`)
    return undefined
  }

  const matched: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!baseURL.includes(key)) continue
    if (value && typeof value === 'object') Object.assign(matched, value)
    else matched[key] = String(value)
  }
  return Object.keys(matched).length ? matched : undefined
}

function makeClient(cfg: ModelConfig): OpenAI {
  const defaultHeaders: Record<string, string> = { ...cfg.headers }
  if (cfg.userAgent) defaultHeaders['User-Agent'] = cfg.userAgent
  return new OpenAI({
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    // The SDK retries 5xx and connection errors twice by default. Left on, it
    // silently multiplies the router's own retry budget (3 calls x 3 attempts)
    // and its backoff, so PRIMARY_RETRY_COUNT would not mean what it says.
    // Retry policy belongs to exactly one layer.
    maxRetries: 0,
    ...(Object.keys(defaultHeaders).length ? { defaultHeaders } : {}),
  })
}

export type FailureKind =
  /** Worth retrying the same model: transient server or transport problem. */
  | 'transient'
  /** Do not retry the primary — the credentials or quota are the problem. */
  | 'switch-now'
  /** The request itself is malformed; another model will not help. */
  | 'fatal'

export function classifyFailure(err: unknown): FailureKind {
  const status = (err as { status?: number })?.status
  const message = err instanceof Error ? err.message : String(err)

  if (status === 400 || status === 404 || status === 422) return 'fatal'
  if (status === 401 || status === 402 || status === 403 || status === 429) return 'switch-now'
  if (status && status >= 500) return 'transient'
  if (status) return 'fatal'

  // No HTTP status: transport-level. Retry, because these usually clear.
  if (/abort/i.test(message)) return 'fatal'
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket|network|fetch failed/i.test(message)) {
    return 'transient'
  }
  return 'fatal'
}

export interface CompleteOptions {
  messages: ChatCompletionMessageParam[]
  tools?: ChatCompletionTool[]
  signal?: AbortSignal
  /**
   * Serve this call with a different model, for per-agent or per-user overrides.
   * It still goes through the router, so retries, output caps and the signal
   * apply — unlike passing it to the OpenAI client directly.
   */
  modelOverride?: string
  /** Attribution for the usage ledger. The router records, the caller labels. */
  onUsage?: (usage: {
    model: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    usedFallback: boolean
    attempts: number
  }) => void
}

export interface CompleteResult {
  model: string
  usedFallback: boolean
  /**
   * Total provider requests this completion cost, summed across every model it
   * touched. A 401 that switches to the fallback reports 2: one rejected call on
   * the primary plus one on the fallback.
   */
  attempts: number
  response: OpenAI.Chat.Completions.ChatCompletion
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * A failed call plus how many provider requests it actually cost. The retry loop
 * is the only place that knows this, and guessing it from `retries` over-reports
 * badly: a first-attempt 401 cost 1 call, not the whole budget.
 */
class RetryFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly calls: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

export class ModelRouter {
  private primary: ModelConfig
  private fallback: ModelConfig | null = null
  private primaryClient: OpenAI
  private fallbackClient: OpenAI | null = null
  private fallbackActive = false

  constructor() {
    this.primary = {
      name: MODEL,
      baseURL: AI_BASE_URL,
      apiKey: AI_API_KEY,
      userAgent: PRIMARY_UA,
      headers: parseHeaders(PROVIDER_HEADERS, AI_BASE_URL),
      retries: PRIMARY_RETRY_COUNT,
    }
    this.primaryClient = makeClient(this.primary)

    if (FALLBACK_MODEL) {
      this.fallback = {
        name: FALLBACK_MODEL,
        baseURL: FALLBACK_BASE_URL || AI_BASE_URL,
        apiKey: FALLBACK_API_KEY || AI_API_KEY,
        userAgent: FALLBACK_UA,
        headers: parseHeaders(PROVIDER_HEADERS, FALLBACK_BASE_URL || AI_BASE_URL),
        retries: 1,
      }
      this.fallbackClient = makeClient(this.fallback)
      log.info(`Fallback configured: ${this.fallback.name} @ ${this.fallback.baseURL}`)
    }

    this.fallbackActive = readFallbackFlag()
    if (this.fallbackActive) {
      log.warn('Starting on the FALLBACK model (a previous run switched)')
    }
  }

  get activeModel(): string {
    return this.fallbackActive && this.fallback ? this.fallback.name : this.primary.name
  }

  get usingFallback(): boolean {
    return this.fallbackActive && this.fallback !== null
  }

  /** Clear the persisted fallback so the next boot prefers the primary again. */
  resetFallbackState(): void {
    this.fallbackActive = false
    writeFallbackFlag(false)
    log.info('Fallback state cleared; primary model preferred')
  }

  private config(): ModelConfig {
    return this.usingFallback ? (this.fallback as ModelConfig) : this.primary
  }

  /**
   * The config and client for this call, decided together.
   *
   * They must be returned as a pair. Resolving them separately and then matching a
   * config back to its client by object identity silently sends every
   * `modelOverride` call to the fallback provider, because an override config is a
   * fresh object that is never `===` the primary.
   *
   * A caller-supplied model rides the active provider's client and key.
   * Cross-provider overrides are deliberately unsupported: a per-agent model is a
   * preference, not a routing decision.
   */
  private active(modelOverride?: string): { cfg: ModelConfig; client: OpenAI } {
    if (this.usingFallback) {
      const cfg = this.fallback as ModelConfig
      return modelOverride ? { cfg: { ...cfg, name: modelOverride }, client: this.fallbackClient as OpenAI } : { cfg, client: this.fallbackClient as OpenAI }
    }
    return modelOverride
      ? { cfg: { ...this.primary, name: modelOverride }, client: this.primaryClient }
      : { cfg: this.primary, client: this.primaryClient }
  }

  private activateFallback(reason: string): boolean {
    if (!this.fallback) return false
    if (this.usingFallback) return true
    this.fallbackActive = true
    writeFallbackFlag(true)
    log.warn(`Switched to FALLBACK model ${this.fallback.name}: ${reason}`)
    return true
  }

  /**
   * Call one model, retrying only failures that are worth retrying.
   *
   * Retrying a 401/402/429 on the same credentials is pure waste, and a 400 means
   * the request is malformed, so neither belongs in a retry loop. Both are
   * re-thrown for the caller to classify.
   */
  private async callWithRetries(
    cfg: ModelConfig,
    client: OpenAI,
    options: CompleteOptions,
  ): Promise<{ response: OpenAI.Chat.Completions.ChatCompletion; calls: number }> {
    let calls = 0
    for (let i = 0; i <= cfg.retries; i++) {
      // eslint-disable-next-line no-unmodified-loop-condition
      if (i > 0) {
        const backoff = 500 * 2 ** (i - 1)
        log.warn(`${cfg.name} transient failure, retrying in ${backoff}ms [${i}/${cfg.retries}]`)
        await sleep(backoff)
      }
      calls++
      try {
        const response = await client.chat.completions.create(
          {
            model: cfg.name,
            messages: options.messages,
            ...(options.tools?.length ? { tools: options.tools } : {}),
            ...(MAX_OUTPUT_TOKENS ? { max_tokens: MAX_OUTPUT_TOKENS } : {}),
            stream: false,
          },
          options.signal ? { signal: options.signal } : undefined,
        )
        return { response, calls }
      } catch (err) {
        const kind = classifyFailure(err)
        if (kind !== 'transient') throw new RetryFailure(err, calls)
        if (i === cfg.retries) throw new RetryFailure(err, calls)
      }
    }
    /* c8 ignore next */
    throw new Error('unreachable: retry loop exhausted without returning or throwing')
  }

  /**
   * One logical completion. Tries the active model, switches to the fallback on a
   * failure worth switching for, and retries once more on an empty-but-successful
   * response (some providers return `finish_reason: stop` with no content).
   */
  async complete(options: CompleteOptions): Promise<CompleteResult> {
    const MAX_EMPTY_RETRIES = 2
    let emptyRetries = 0
    let attempts = 0

    for (;;) {
      const { cfg, client } = this.active(options.modelOverride)

      let response: OpenAI.Chat.Completions.ChatCompletion
      try {
        const result = await this.callWithRetries(cfg, client, options)
        response = result.response
        attempts += result.calls
      } catch (wrapper) {
        const err = wrapper instanceof RetryFailure ? wrapper.cause : wrapper
        attempts += wrapper instanceof RetryFailure ? wrapper.calls : 1
        const kind = classifyFailure(err)
        const status = (err as { status?: number })?.status ?? 'no-status'
        const detail = err instanceof Error ? err.message : String(err)

        if (kind === 'fatal') {
          log.error(`${cfg.name} rejected the request (${status}): ${detail}`)
          throw err
        }
        if (this.activateFallback(`${status} from ${cfg.name}`)) continue
        log.error(`${cfg.name} failed (${status}) and no fallback is configured`)
        throw err
      }

      const message = response.choices?.[0]?.message
      const isEmpty = !message?.tool_calls?.length && !message?.content?.trim()
      const truncated = response.choices?.[0]?.finish_reason === 'length'

      if (isEmpty && !truncated && emptyRetries < MAX_EMPTY_RETRIES) {
        emptyRetries++
        attempts++
        log.warn(`${cfg.name} returned an empty completion (retry ${emptyRetries}/${MAX_EMPTY_RETRIES})`)
        continue
      }

      const usage = response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      const record = {
        model: cfg.name,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        usedFallback: this.usingFallback,
        attempts,
      }
      try {
        options.onUsage?.(record)
      } catch (err) {
        // Telemetry must never fail a completed request.
        log.debug(`usage hook failed: ${err}`)
      }

      return { model: cfg.name, usedFallback: record.usedFallback, attempts, response }
    }
  }
}

function readFallbackFlag(): boolean {
  try {
    return existsSync(FALLBACK_FLAG)
  } catch {
    return false
  }
}

function writeFallbackFlag(active: boolean): void {
  try {
    if (active) {
      mkdirSync(dirname(FALLBACK_FLAG), { recursive: true })
      writeFileSync(FALLBACK_FLAG, new Date().toISOString())
    } else if (existsSync(FALLBACK_FLAG)) {
      unlinkSync(FALLBACK_FLAG)
    }
  } catch (err) {
    log.warn(`Could not persist fallback flag: ${err}`)
  }
}

export const router = new ModelRouter()
