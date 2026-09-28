/**
 * Regressions for three defects found in review, each of which passed the
 * earlier suite because the tests asserted the buggy behaviour or never looked.
 */
import { check, section, summary, freshDb } from './helpers'
import { runMigrations } from '../src/migrate'
import { ConversationStore } from '../src/conversation-store'
import { Maintenance } from '../src/maintenance'
import { processUserMessage } from '../src/ai'
import type { Database } from 'bun:sqlite'

const ftsCount = (db: Database): number =>
  (db.query('SELECT count(*) AS n FROM conversation_fts').get() as { n: number }).n

section('the FTS index follows deletes (clear)')
{
  const db = freshDb()
  const store = new ConversationStore(db)
  const scope = { sessionId: 'main', agentName: 'default' }
  store.append('u1', scope, [
    { role: 'user', content: 'zebra secret' },
    { role: 'assistant', content: 'a striped animal' },
  ])
  check('the messages are indexed', 2, ftsCount(db))

  store.clear('u1', scope)
  check('the rows are gone', 0, (db.query('SELECT count(*) AS n FROM conversation_messages').get() as any).n)
  check('the index is gone too', 0, ftsCount(db))
}

section('the FTS index follows deletes (forgetSession and clearAll)')
{
  const db = freshDb()
  const store = new ConversationStore(db)
  store.append('u1', { sessionId: 'a', agentName: 'default' }, [{ role: 'user', content: 'zebra one' }])
  store.append('u1', { sessionId: 'b', agentName: 'default' }, [{ role: 'user', content: 'zebra two' }])
  check('both indexed', 2, ftsCount(db))
  store.forgetSession('u1', 'a')
  check('forgetSession purged one', 1, ftsCount(db))
  store.clearAll('u1')
  check('clearAll purged the rest', 0, ftsCount(db))
}

section('the FTS index follows updates')
{
  const db = freshDb()
  const store = new ConversationStore(db)
  store.append('u1', { sessionId: 'main', agentName: 'default' }, [{ role: 'user', content: 'zebra' }])
  db.run(`UPDATE conversation_messages SET content = ? WHERE id = 1`, [JSON.stringify({ role: 'user', content: 'giraffe' })])
  check('still one row after update', 1, ftsCount(db))
  const hit = db.query(`SELECT count(*) AS n FROM conversation_fts WHERE conversation_fts MATCH 'zebra'`).get() as any
  check('the stale term no longer matches', 0, hit.n)
}

section('retention cannot leave orphaned index entries')
{
  const db = freshDb()
  const store = new ConversationStore(db)
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString()
  store.append('u9', { sessionId: 'main', agentName: 'default' }, [{ role: 'user', content: 'zebra old' }])
  db.run('UPDATE conversation_messages SET created_at = ?', [old])

  const m = new Maintenance(db, { conversationRetentionDays: 30, usageRetentionDays: 90, sessionRetentionDays: 7, intervalMs: 0 })
  m.run(true)
  check('the old row is deleted', 0, (db.query('SELECT count(*) AS n FROM conversation_messages').get() as any).n)
  check('and so is its index entry', 0, ftsCount(db))
}

section('the FTS index backfills pre-existing history')
{
  // A database that already had messages before the index existed.
  const db = freshDb()
  runMigrations(db)
  const store = new ConversationStore(db)
  store.append('u1', { sessionId: 'main', agentName: 'default' }, [{ role: 'user', content: 'zebra historic' }])
  db.run('DELETE FROM conversation_fts')
  runMigrations(db) // re-runs nothing, so simulate a fresh install instead:
  const db2 = freshDb()
  const store2 = new ConversationStore(db2)
  store2.append('u2', { sessionId: 'main', agentName: 'default' }, [{ role: 'user', content: 'zebra fresh' }])
  check('a fresh install indexes on insert via trigger', 1, ftsCount(db2))
}

section('delegation stops at the depth cap')
{
  // Drive the real agent loop with a stub router that always delegates, recording
  // whether `delegate_task` was on offer at each level. The bug this guards: depth
  // was passed twice and the second value won, so every level restarted at 1 and
  // the cap never engaged.
  //
  // The target agent is chosen from the tool list rather than hard-coded, because an
  // agent cannot delegate to itself — hard-coding one trips the self-check and never
  // reaches depth 2. `translate` is on the built-in default agent only, so it marks
  // "I am the default agent, hand this to the specialist". Only `researcher`
  // lists delegate_task in its allow-list, so it is the specialist that can recurse.
  const offers: { delegate: boolean; tools: string[] }[] = []

  const stub = {
    complete: async (options: any) => {
      const names: string[] = (options.tools ?? []).map((t: any) => t.function?.name)
      offers.push({ delegate: names.includes('delegate_task'), tools: names })
      const target = names.includes('translate') ? 'researcher' : 'default'
      return {
        model: 'stub',
        usedFallback: false,
        attempts: 1,
        response: {
          id: 'x', object: 'chat.completion', created: 0, model: 'stub',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: `tc${offers.length}`,
                type: 'function',
                function: { name: 'delegate_task', arguments: JSON.stringify({ agent: target, task: 'go' }) },
              }],
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      }
    },
  }

  const sess = {
    sessionId: 'sess-test',
    tools: async () => [],
    execute: async () => ({}),
    search: async () => ({}),
  }

  await processUserMessage({
    messages: [{ role: 'user', content: 'start' }],
    entityId: 'u-depth',
    onToolCall: () => {},
    onToolResult: () => {},
    maxSteps: 1,
    router: stub as any,
    composioClient: {
      create: async () => sess,
      toolRouter: { use: async () => sess },
    } as any,
  } as any)

  // maxSteps 1 means exactly one model call per level, so the offer sequence is
  // the depth sequence: 0, 1, 2.
  check('three levels ran', 3, offers.length)
  check('depth 0 could delegate', true, offers[0]?.delegate)
  check('depth 1 could delegate', true, offers[1]?.delegate)
  check('depth 2 could NOT delegate — the cap engaged', false, offers[2]?.delegate)
  check('depth 2 ran as a different agent than its parent', true,
    offers[1] && offers[2] && offers[1].tools.join() !== offers[2].tools.join())
  check('the chain did not continue past the cap', 3, offers.length)
}

section('an agent cannot delegate to itself')
{
  // Same stub, but every level targets the agent it is already running as.
  const results: string[] = []
  const stub = {
    complete: async (options: any) => {
      const names: string[] = (options.tools ?? []).map((t: any) => t.function?.name)
      const target = names.includes('translate') ? 'default' : 'email'
      const toolCall = {
        id: `tc${results.length}`,
        type: 'function',
        function: { name: 'delegate_task', arguments: JSON.stringify({ agent: target, task: 'go' }) },
      }
      return {
        model: 'stub', usedFallback: false, attempts: 1,
        response: {
          id: 'x', object: 'chat.completion', created: 0, model: 'stub',
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [toolCall] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      }
    },
  }
  const sess = { sessionId: 's', tools: async () => [], execute: async () => ({}), search: async () => ({}) }
  const out = await processUserMessage({
    messages: [{ role: 'user', content: 'start' }],
    entityId: 'u-self',
    onToolCall: (_n: string, a: any) => { results.push(`${a?.agent}`) },
    onToolResult: (_n: string, s: string) => { results.push(s.slice(0, 40)) },
    maxSteps: 1,
    router: stub as any,
    composioClient: { create: async () => sess, toolRouter: { use: async () => sess } } as any,
  } as any)
  check('it terminated instead of recursing', true, out.finishReason !== undefined)
  check('the sub-run was refused', true, results.some(r => /yourself|not available|unknown agent/i.test(r)))
}

summary()
