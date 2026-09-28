/**
 * Conversation-history hygiene: token estimates, provider-safe replay, summarisation.
 *
 * Single-responsibility. Nothing here touches the database — the store owns
 * persistence, this module owns the rules.
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { router } from './model-router'
import { Logger } from './logger'

const log = new Logger('history')

// ── Token estimation ──────────────────────────────────────────────────────────

/** ~4 chars per token. Crude but monotonic, which is all a budget needs. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function messageTokens(m: ChatCompletionMessageParam): number {
  const raw = m as unknown as Record<string, unknown>
  const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
  return 4 + estimateTokens(content) + estimateTokens(JSON.stringify(raw.tool_calls ?? ''))
}

export function messagesTokens(messages: ChatCompletionMessageParam[]): number {
  let total = 0
  for (const m of messages) total += messageTokens(m)
  return total
}

// ── Provider-safe replay ──────────────────────────────────────────────────────
//
// Two separate problems, both of which surface as 400s or empty responses when
// history is replayed to a provider that did not produce it:
//
// 1. Vendor-specific fields (`reasoning_content`, `refusal`, `logprobs`,
//    `service_tier`, `token_ids`, …) are echoed back by some OpenAI-compatible
//    endpoints and rejected by others. cleanMessage keeps standard fields only,
//    so history is provider-agnostic.
//
// 2. Compaction and trimming can orphan half a tool-call pair. An assistant
//    `tool_calls` entry with no matching `tool` result (or vice versa) makes the
//    provider reject the whole request. sanitizeHistory drops unpaired halves.

/**
 * `ChatCompletionMessageParam` is a discriminated union whose members have no
 * index signature, so reading an optional field off it is not type-safe even
 * though it is well-defined at runtime. Sanitisation is inherently shape-driven,
 * so work on the loose form internally and re-assert the public type at the edge.
 */
type Loose = Record<string, any>

const asLoose = (m: ChatCompletionMessageParam): Loose => m as unknown as Loose
const asMessage = (m: Loose): ChatCompletionMessageParam => m as ChatCompletionMessageParam

const KEEP_FIELDS = ['content', 'name', 'tool_call_id'] as const

export function cleanMessage(m: ChatCompletionMessageParam): ChatCompletionMessageParam {
  const raw = asLoose(m)
  const out: Loose = { role: raw.role }

  for (const field of KEEP_FIELDS) {
    if (raw[field] !== undefined) out[field] = raw[field]
  }

  if (raw.tool_calls?.length) {
    out.tool_calls = raw.tool_calls.map((tc: Loose) => ({
      id: tc.id,
      type: tc.type ?? 'function',
      function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' },
    }))
  }

  return asMessage(out)
}

export function sanitizeHistory(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []

  for (let i = 0; i < messages.length; i++) {
    const raw = asLoose(messages[i])

    // A leading tool result has no call — drop it.
    if (raw.role === 'tool') continue

    if (raw.role === 'assistant' && raw.tool_calls?.length) {
      // Consume the contiguous run of results that answer this call batch.
      const results: ChatCompletionMessageParam[] = []
      let j = i + 1
      while (j < messages.length && asLoose(messages[j]).role === 'tool') {
        results.push(messages[j])
        j++
      }

      const answered = new Set(results.map(r => asLoose(r).tool_call_id))
      const allAnswered = raw.tool_calls.every((tc: Loose) => answered.has(tc.id))

      if (allAnswered) {
        out.push(cleanMessage(messages[i]), ...results.map(cleanMessage))
      } else if (typeof raw.content === 'string' && raw.content.trim()) {
        // Partial pairing: keep whatever the assistant said, lose the calls.
        out.push({ role: 'assistant', content: raw.content })
      } else {
        log.debug('Dropped assistant message with unanswerable tool_calls and no text')
      }

      i = j - 1
      continue
    }

    out.push(cleanMessage(messages[i]))
  }

  return out
}

// ── Summarisation ─────────────────────────────────────────────────────────────

const SUMMARY_INSTRUCTIONS =
  'You are a conversation summarizer. Output a concise factual summary (max 150 words): ' +
  'topics discussed, tasks completed, decisions made, user facts learned. Plain text only.'

function toTranscript(messages: ChatCompletionMessageParam[]): string {
  return messages
    .map(m => {
      const raw = typeof m.content === 'string' ? m.content : ''
      if (!raw.trim()) return null
      const who = m.role === 'user' ? 'User' : 'Assistant'
      return `${who}: ${raw.slice(0, 600)}`
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Fold `messages` into a running summary.
 *
 * `existingSummary` is fed back in so repeated compaction converges instead of
 * re-summarising a fixed pair of rows on every message.
 */
export async function summarizeConversation(
  messages: ChatCompletionMessageParam[],
  existingSummary?: string,
): Promise<string> {
  const transcript = toTranscript(messages)
  if (!transcript) return existingSummary ?? ''

  const prior = existingSummary ? `Prior summary:\n${existingSummary}\n\n` : ''

  // Routed like any other completion: compaction must not fail just because the
  // primary model is the thing that broke.
  const { response } = await router.complete({
    messages: [
      { role: 'system', content: SUMMARY_INSTRUCTIONS },
      { role: 'user', content: `${prior}Conversation to summarize:\n${transcript}` },
    ],
  })

  return response.choices[0]?.message?.content?.trim() || existingSummary || ''
}
