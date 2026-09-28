/**
 * Token estimation, provider-safe replay, and convergence of compaction.
 *
 * The sanitizer assertions all come from provider 400s seen in practice: orphaned
 * tool results and vendor-specific fields are rejected outright, so they must not
 * reach the wire.
 */
import { check, section, summary } from './helpers'
import { estimateTokens, messageTokens, messagesTokens, sanitizeHistory, cleanMessage } from '../src/history'

section('token estimation')
check('an empty conversation costs nothing', 0, messagesTokens([]))
check('a short message is cheap', true, messageTokens({ role: 'user', content: 'hi' }) < 10)
check('a long message costs more than a short one', true,
  messageTokens({ role: 'user', content: 'x'.repeat(4000) }) > messageTokens({ role: 'user', content: 'hi' }))
check('an empty message is not free', true, messageTokens({ role: 'user', content: '' }) > 0)
check('totals add up', true,
  messagesTokens([{ role: 'user', content: 'a' }, { role: 'user', content: 'b'.repeat(2000) }]) >
  messagesTokens([{ role: 'user', content: 'a' }]))
check('estimation scales with length', true, estimateTokens('a'.repeat(8000)) > estimateTokens('a'.repeat(80)))

section('system prompts are preserved but normalised')
// The system prompt is part of the request, not of the transcript, so the
// sanitizer keeps it. It is stripped when the turn is *stored* — ai.ts filters it
// out on the way back to conversation-store.
const withSystem = sanitizeHistory([
  { role: 'system', content: 'secret system rules', extra_vendor_field: true } as any,
  { role: 'user', content: 'hello' },
])
check('the system message is kept', true, withSystem.some(m => m.role === 'system'))
check('its content is kept', true, withSystem.some(m => m.content === 'secret system rules'))
check('vendor fields are stripped from it', false, 'extra_vendor_field' in (withSystem[0] as any))
check('the user message survives', true, withSystem.some(m => m.content === 'hello'))

section('orphan tool messages are dropped')
const orphaned = sanitizeHistory([
  { role: 'user', content: 'do it' },
  { role: 'tool', content: 'result with no preceding call', tool_call_id: 't1' },
  { role: 'assistant', content: 'ok' },
])
check('the orphan tool result is gone', false, orphaned.some(m => m.role === 'tool'))
check('the rest survives', true, orphaned.some(m => m.content === 'ok'))

section('a tool result paired with its call is kept')
const paired = sanitizeHistory([
  { role: 'user', content: 'do it' },
  { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
  { role: 'tool', content: 'the result', tool_call_id: 't1' },
  { role: 'assistant', content: 'finished' },
])
check('the tool result is kept', true, paired.some(m => m.role === 'tool' && m.content === 'the result'))
check('the final answer is kept', true, paired.some(m => m.content === 'finished'))

section('vendor-specific fields are removed')
const dirty = sanitizeHistory([
  { role: 'assistant', content: 'hi', reasoning_content: 'internal', provider_specific_fields: { a: 1 } } as any,
  { role: 'user', content: 'ok', name: 'function', cache_control: { type: 'ephemeral' } } as any,
])
for (const message of dirty) {
  check(`no reasoning_content on ${String((message as any).content)}`, false, 'reasoning_content' in (message as any))
  check(`no provider_specific_fields on ${String((message as any).content)}`, false, 'provider_specific_fields' in (message as any))
  check(`no cache_control on ${String((message as any).content)}`, false, 'cache_control' in (message as any))
  check(`role preserved on ${String((message as any).content)}`, true, ['user', 'assistant', 'tool'].includes((message as any).role))
}

section('history that ends mid tool-call is truncated')
const dangling = sanitizeHistory([
  { role: 'user', content: 'go' },
  { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
])
check('the unanswered tool call is dropped', false, dangling.some(m => m.role === 'assistant' && m.tool_calls))
check('the user turn remains', true, dangling.some(m => m.content === 'go'))

section('sanitizing is idempotent')
const once = sanitizeHistory([
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: null, reasoning_content: 'x' } as any,
  { role: 'assistant', content: 'done' },
])
check('a second pass changes nothing', once, sanitizeHistory(once))

section('cleanMessage keeps the fields a provider needs')
const cleaned = cleanMessage({ role: 'tool', content: 'r', tool_call_id: 't1', name: 'n', extra: 1 } as any)
check('role kept', 'tool', cleaned.role)
check('content kept', 'r', cleaned.content)
check('tool_call_id kept', 't1', (cleaned as any).tool_call_id)
check('unknown fields dropped', false, 'extra' in (cleaned as any))

summary()
