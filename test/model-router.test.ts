/**
 * Primary/fallback routing, driven against a real local HTTP server.
 *
 * A fake provider is used rather than a stubbed client so the assertions cover the
 * things that actually broke during development: the OpenAI SDK retrying underneath
 * the router, and attempts being counted from the retry budget instead of the
 * calls that really happened.
 */
import { check, section, summary } from './helpers'
import { existsSync, rmSync } from 'fs'

const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const FLAG = 'data/.fallback-active'

process.env.AI_BASE_URL = `${BASE}/primary`
process.env.MODEL = 'primary-model'
process.env.FALLBACK_MODEL = 'fallback-model'
process.env.FALLBACK_BASE_URL = `${BASE}/fallback`
process.env.PRIMARY_RETRY_COUNT = '2'

let primaryHits = 0
let fallbackHits = 0
/** 'ok' | '500' | '401' | 'empty' */
let primaryMode: 'ok' | '500' | '401' | 'empty' = 'ok'

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as { messages?: unknown[] }
    const isFallback = req.url.includes('fallback')
    if (isFallback) {
      fallbackHits++
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'from fallback' }, finish_reason: 'stop' }] })
    }
    primaryHits++
    if (primaryMode === '500') return new Response('boom', { status: 500 })
    if (primaryMode === '401') return Response.json({ error: 'bad key' }, { status: 401 })
    if (primaryMode === 'empty') {
      return Response.json({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] })
    }
    return Response.json({
      choices: [{ message: { role: 'assistant', content: `from primary (${body.messages?.length ?? 0} msgs)` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    })
  },
})

const { router, classifyFailure } = await import('../src/model-router')
const ask = (text = 'hi') => router.complete({ messages: [{ role: 'user', content: text }] })

section('failure classification')
for (const [status, expected] of [[400, 'fatal'], [404, 'fatal'], [422, 'fatal'], [401, 'switch-now'], [402, 'switch-now'], [403, 'switch-now'], [429, 'switch-now'], [500, 'transient'], [503, 'transient']] as const) {
  check(`${status} is ${expected}`, expected, classifyFailure({ status }))
}
check('ECONNRESET is transient', 'transient', classifyFailure(new Error('read ECONNRESET')))
check('an abort is fatal', 'fatal', classifyFailure(new Error('The operation was aborted')))

section('happy path')
primaryMode = 'ok'
primaryHits = 0
const happy = await ask()
check('served by the primary', 'primary-model', happy.model)
check('one provider call', 1, primaryHits)
check('attempts reported accurately', 1, happy.attempts)
check('content returned', true, happy.response.choices[0].message.content!.includes('from primary'))
check('usage surfaced for the ledger', 10, happy.response.usage?.total_tokens)
check('not on fallback', false, happy.usedFallback)

section('an auth failure switches immediately, without a retry storm')
primaryMode = '401'
primaryHits = 0
fallbackHits = 0
const authFail = await ask()
check('exactly one attempt on the bad key', 1, primaryHits)
check('served by the fallback', 'fallback-model', authFail.model)
check('attempts counts both models, not the retry budget', 2, authFail.attempts)
check('the fallback was actually used', 1, fallbackHits)

section('fallback is sticky and does not steal traffic back')
primaryHits = 0
await ask()
check('primary untouched while the fallback is healthy', 0, primaryHits)
check('router reports fallback', true, router.usingFallback)
check('active model is the fallback', 'fallback-model', router.activeModel)

section('the switch survives a restart')
check('state is persisted to disk', true, existsSync(FLAG))
router.resetFallbackState()
check('reset returns to the primary', 'primary-model', router.activeModel)
check('reset clears the flag', false, existsSync(FLAG))

section('a transient failure retries, then switches')
primaryMode = '500'
primaryHits = 0
fallbackHits = 0
const transient = await ask()
check('retried exactly PRIMARY_RETRY_COUNT times', 3, primaryHits)
check('total attempts equal the calls made', 4, transient.attempts)
check('then served by the fallback', 'fallback-model', transient.model)
check('one fallback call', 1, fallbackHits)
router.resetFallbackState()

section('an empty-but-successful response is retried')
primaryMode = 'empty'
primaryHits = 0
const empty = await ask()
check('primary retried past the first attempt', true, primaryHits > 1)
check('eventually returned', true, !!empty.response.choices[0].message)

section('per-call model override')
primaryMode = 'ok'
primaryHits = 0
const override = await router.complete({
  messages: [{ role: 'user', content: 'hi' }],
  modelOverride: 'specialist-model',
})
check('the override name is what gets sent', 'specialist-model', override.model)
check('the override still goes through the router', 1, primaryHits)

section('usage hook')
let seen: { totalTokens: number; attempts: number } | null = null
await router.complete({
  messages: [{ role: 'user', content: 'hi' }],
  onUsage: u => {
    seen = u
  },
})
check('usage hook fired', 10, seen?.totalTokens)
check('usage hook reports attempts', 1, seen?.attempts)

server.stop(true)
if (existsSync(FLAG)) rmSync(FLAG)
summary()
