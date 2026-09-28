/**
 * Conversation history is partitioned by (user, session, agent). Every one of
 * these assertions exists because leaking one scope's history into another is the
 * failure mode that makes the bot feel broken.
 */
import { freshDb, check, section, summary } from './helpers'
import { ConversationStore, type ConversationScope } from '../src/conversation-store'
import { UserState, KEY_SESSION, KEY_AGENT, DEFAULT_SESSION } from '../src/user-state'

const db = freshDb()
const store = new ConversationStore(db)
const state = new UserState(db)
const USER = 'user-1'
const OTHER = 'user-2'
const def: ConversationScope = { sessionId: 'default', agentName: 'default' }

section('scope isolation: same user, different agents')
store.append(USER, def, [{ role: 'user', content: 'A' }])
store.append(USER, { sessionId: 'default', agentName: 'email' }, [{ role: 'user', content: 'E' }])
check('default sees only its own', ['A'], store.list(USER, def).map(m => m.content))
check('email sees only its own', ['E'], store.list(USER, { sessionId: 'default', agentName: 'email' }).map(m => m.content))

section('scope isolation: same user, different sessions')
store.append(USER, { sessionId: 'work', agentName: 'default' }, [{ role: 'user', content: 'W' }])
check('work session isolated', ['W'], store.list(USER, { sessionId: 'work', agentName: 'default' }).map(m => m.content))
check('default session unchanged', 1, store.count(USER, def))

section('tenants are isolated')
check('other user sees nothing', 0, store.count(OTHER, def))

section('summaries are per-scope')
store.setSummary(USER, def, 'sum-default')
store.setSummary(USER, { sessionId: 'default', agentName: 'email' }, 'sum-email')
store.setSummary(USER, { sessionId: 'work', agentName: 'default' }, 'sum-work')
check('three summaries coexist', 3, (db.query('SELECT COUNT(*) c FROM conversation_summaries').get() as any).c)
check('email summary intact', 'sum-email', store.getSummary(USER, { sessionId: 'default', agentName: 'email' }))
check('work summary intact', 'sum-work', store.getSummary(USER, { sessionId: 'work', agentName: 'default' }))
check(
  'listWithSummary injects only this scope summary',
  true,
  store.listWithSummary(USER, { sessionId: 'work', agentName: 'default' })[0].content?.toString().includes('sum-work'),
)

section('compaction converges and stays in scope')
const c1: ConversationScope = { sessionId: 'c1', agentName: 'default' }
for (let i = 0; i < 30; i++) store.append(USER, c1, [{ role: 'user', content: `m${i}` }])
store.append(USER, { sessionId: 'neighbour', agentName: 'default' }, [{ role: 'user', content: 'safe' }])
store.compact(USER, c1, 10, 'c1-summary')
check('compacted scope holds exactly keepLast', 10, store.count(USER, c1))
check('newest messages retained', 'm29', store.list(USER, c1).at(-1)!.content)
check('neighbour scope untouched', 1, store.count(USER, { sessionId: 'neighbour', agentName: 'default' }))
check('summary written by compaction', 'c1-summary', store.getSummary(USER, c1))

section('compact below keepLast is a no-op')
store.compact(USER, c1, 50, 'should-not-apply')
check('rows unchanged', 10, store.count(USER, c1))
check('summary unchanged', 'c1-summary', store.getSummary(USER, c1))

section('clear vs clearAll')
store.clear(USER, c1)
check('cleared scope empty', 0, store.count(USER, c1))
check('neighbour survives clear', 1, store.count(USER, { sessionId: 'neighbour', agentName: 'default' }))
store.clearAll(USER)
check('clearAll empties all scopes', 0, (db.query('SELECT COUNT(*) c FROM conversation_messages').get() as any).c)

section('user_state')
check('unset session falls back', DEFAULT_SESSION, state.get(USER, KEY_SESSION) ?? DEFAULT_SESSION)
state.set(USER, KEY_SESSION, 'work-2024')
check('set then get', 'work-2024', state.get(USER, KEY_SESSION))
state.set(USER, KEY_SESSION, 'work-2025')
check('overwrite', 'work-2025', state.get(USER, KEY_SESSION))
state.set(USER, KEY_AGENT, 'email')
check('keys are independent', 'email', state.get(USER, KEY_AGENT))
state.delete(USER, KEY_SESSION)
check('delete one key', null, state.get(USER, KEY_SESSION))
check('other key survives', 'email', state.get(USER, KEY_AGENT))

db.close()
summary()
