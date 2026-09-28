/**
 * Tool execution: timeouts, result truncation, name normalisation, and the fact
 * that a failing tool returns a message instead of throwing.
 *
 * A hung tool used to hold the agent loop open for the full 180s budget, so the
 * timeout assertions are the important ones here.
 */
import { check, section, summary } from './helpers'
import { runTool, toToolMessage, normalizeToolName } from '../src/tool-exec'
import { MAX_TOOL_RESULT_CHARS } from '../src/config'

const composioStub = { toolRouter: { use: async () => ({}) } } as any
const deps = (customTools: Record<string, any>, extra: Record<string, unknown> = {}) =>
  ({
    customTools,
    composio: composioStub,
    entityId: 'user-1',
    composioToolNames: new Set<string>(),
    onToolCall: () => {},
    onToolResult: () => {},
    ...extra,
  }) as any

const call = (name: string, args: Record<string, unknown> = {}, toolCallId = 'tc1', extra = {}) => ({
  name,
  args,
  toolCallId,
  raw: { id: toolCallId, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ...extra,
})

section('name normalisation')
// Providers occasionally append a routing marker to a function name. The prefix
// that selects the dispatch path is stripped separately, in ai.ts.
check('a routing suffix is removed', 'GMAIL_SEND', normalizeToolName('GMAIL_SEND<|channel=1|>'))
check('a plain name is untouched', 'memory', normalizeToolName('memory'))
check('casing is preserved', 'Gmail', normalizeToolName('Gmail'))
check('an empty name is left alone', '', normalizeToolName(''))

section('a local tool runs and its result is returned')
const local = {
  echo: { description: 'echo', parameters: {}, execute: async (a: any) => `echoed ${a.value}` },
}
check('result text', 'echoed hi', (await runTool(call('echo', { value: 'hi' }), deps(local))).summary)
check('not reported as failed', false, (await runTool(call('echo', { value: 'hi' }), deps(local))).failed)

section('a throwing tool does not throw out of runTool')
const boom = { boom: { parameters: {}, execute: async () => { throw new Error('kaboom') } } }
const failed = await runTool(call('boom'), deps(boom))
check('flagged as failed', true, failed.failed)
check('the error text is captured', true, failed.summary.includes('kaboom'))

section('an unknown tool is reported, not attempted')
const unknown = await runTool(call('does_not_exist'), deps(local))
check('flagged as failed', true, unknown.failed)
check('it says the tool is unknown', true, unknown.summary.toLowerCase().includes('unknown') || unknown.summary.toLowerCase().includes('not'))

section('a hung tool is cut off by the timeout')
const slow = {
  hang: { parameters: {}, execute: () => new Promise<string>(r => setTimeout(() => r('eventually'), 60_000)) },
}
const started = Date.now()
const timedOut = await runTool(call('hang'), deps(slow), 800)
const elapsed = Date.now() - started
check('it returned before the hang finished', true, elapsed < 5_000)
check('it took roughly the configured budget', true, elapsed >= 700 && elapsed < 3_000)
check('the timeout is reported', true, timedOut.summary.toLowerCase().includes('timeout') || timedOut.summary.toLowerCase().includes('timed out'))

section('an oversize result is truncated')
const huge = { big: { parameters: {}, execute: async () => 'z'.repeat(MAX_TOOL_RESULT_CHARS * 3) } }
const truncated = await runTool(call('big'), deps(huge))
check('the result is capped', true, truncated.summary.length <= MAX_TOOL_RESULT_CHARS + 200)
check('the truncation is announced', true, /truncat|…|\.\.\./i.test(truncated.summary))

section('the tool message is well formed for the provider')
const message = toToolMessage(await runTool(call('echo', { value: 'hi' }), deps(local)))
check('role is tool', 'tool', message.role)
check('it carries the call id', 'tc1', (message as any).tool_call_id)
check('content is a string', 'string', typeof message.content)

section('the tool-call callback fires')
let announced = ''
await runTool(call('echo', { value: 'hi' }), deps(local, { onToolCall: (n: string) => { announced = n } }))
check('the hook was called with the tool name', 'echo', announced)

summary()
