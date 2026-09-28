/**
 * Per-user serial queueing, and admin authorisation.
 *
 * The queue assertions encode the rule that a user's own turns must not interleave
 * while different users proceed in parallel. The admin assertions encode
 * deny-by-default: an empty ADMIN_USER_IDS must grant nothing.
 */
import { check, section, summary } from './helpers'
import { KeyedQueue, userQueue } from '../src/queue'
import { isAdmin } from '../src/admin'
import { ALLOWED_USER_IDS } from '../src/config'

section('same-user turns run in order, never concurrently')
const queue = new KeyedQueue()
const events: string[] = []
let concurrent = 0
let maxConcurrent = 0

const slowTask = (userId: string, label: string, ms: number) => async () => {
  concurrent++
  maxConcurrent = Math.max(maxConcurrent, concurrent)
  events.push(`${label}:start`)
  await new Promise(r => setTimeout(r, ms))
  events.push(`${label}:end`)
  concurrent--
}

await Promise.all([
  queue.enqueue('u1', slowTask('u1', 'a', 40)),
  queue.enqueue('u1', slowTask('u1', 'b', 5)),
  queue.enqueue('u1', slowTask('u1', 'c', 5)),
])
check('never more than one at a time', 1, maxConcurrent)
check('order preserved', ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'], events)

section('different users proceed in parallel')
const wide = new KeyedQueue()
const wideEvents: string[] = []
let wideMax = 0
let wideNow = 0
const block = (label: string) => async () => {
  wideNow++
  wideMax = Math.max(wideMax, wideNow)
  wideEvents.push(`${label}:start`)
  await new Promise(r => setTimeout(r, 30))
  wideEvents.push(`${label}:end`)
  wideNow--
}
await Promise.all([wide.enqueue('u1', block('u1')), wide.enqueue('u2', block('u2')), wide.enqueue('u3', block('u3'))])
check('all three overlapped', 3, wideMax)
check('all six events recorded', 6, wideEvents.length)

section('a failing task does not poison the queue')
const resilient = new KeyedQueue()
const order: string[] = []
await resilient.enqueue('u1', async () => {
  order.push('bad')
  throw new Error('boom')
}).catch(() => order.push('caught'))
await resilient.enqueue('u1', async () => {
  order.push('good')
})
check('the failure was observable', ['bad', 'caught'], order.slice(0, 2))
check('the next task still ran', 'good', order[2])

section('the shared user queue is keyed by user id')
let sharedMax = 0
let sharedNow = 0
const tracked = async () => {
  sharedNow++
  sharedMax = Math.max(sharedMax, sharedNow)
  await new Promise(r => setTimeout(r, 20))
  sharedNow--
}
await Promise.all([userQueue.enqueue('x1', tracked), userQueue.enqueue('x1', tracked), userQueue.enqueue('x2', tracked)])
check('same key serialised, different key overlapped', 2, sharedMax)

section('admin is deny by default')
check('the whitelist is populated', true, ALLOWED_USER_IDS.length > 0)
// An unconfigured ADMIN_USER_IDS is the case worth asserting: the tool loader
// hides adminOnly tools off isAdmin(), so an empty set must grant nobody.
check('nobody is admin when unconfigured', false, isAdmin('anyone-at-all'))
check('not even a plausible owner id', false, isAdmin(ALLOWED_USER_IDS[0]))

summary()
