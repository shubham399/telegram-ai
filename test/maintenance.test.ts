/**
 * Retention, WAL checkpointing, VACUUM and FTS5 conversation search.
 *
 * The search assertions include hostile query text: FTS5's query language throws on
 * stray operators, and a user typing `"` must get results rather than a stack trace.
 */
import { freshDb, check, section, summary } from './helpers'
import { Maintenance } from '../src/maintenance'
import { ConversationStore } from '../src/conversation-store'

const db = freshDb()
const maintenance = new Maintenance(db)
const store = new ConversationStore(db)
const scope = { sessionId: 'default', agentName: 'default' }
const USER = 'user-1'

section('indexed search over conversation history')
store.append(USER, scope, [
  { role: 'user', content: 'remember the deploy key is called banana' },
  { role: 'assistant', content: 'noted' },
])
store.append(USER, scope, [{ role: 'user', content: 'what is the weather' }])
check('finds by content', 1, maintenance.search(USER, 'banana').length)
check('multi-term OR', 2, maintenance.search(USER, 'banana weather').length)
check('finds a later message', true, maintenance.search(USER, 'weather')[0].content.includes('weather'))
check('no match returns empty', 0, maintenance.search(USER, 'zzzznotpresent').length)
check('other user cannot search this history', 0, maintenance.search('user-2', 'banana').length)

section('hostile search input does not throw')
check('bare FTS operators are handled', Array.isArray(maintenance.search(USER, 'banana OR ("')), true)
check('punctuation-only query is handled', Array.isArray(maintenance.search(USER, '***')), true)
check('sql-ish input is parameterised', Array.isArray(maintenance.search(USER, "'; DROP TABLE notes; --")), true)
check('the notes table survived that query', true, !!db.query(`SELECT 1 FROM sqlite_master WHERE name = 'notes'`).get())

section('retention')
db.run(
  `INSERT INTO usage_ledger (entity_id, agent_name, model, prompt_tokens, completion_tokens, total_tokens, used_fallback, attempts, created_at)
   VALUES ('user-1', 'default', 'old', 1, 1, 2, 0, 1, '2001-01-01T00:00:00Z')`,
)
db.run(
  `INSERT INTO conversation_messages (telegram_user_id, session_id, agent_name, role, content, created_at)
   VALUES ('user-1', 'ancient', 'default', 'user', '{}', '2001-01-01T00:00:00Z')`,
)
const result = maintenance.run(true)
check('aged usage row removed', 1, result.usage)
check('aged conversation row removed', 1, result.conversation)
check('recent history retained', 3, store.count(USER, scope))
check('vacuum ran after deletions', true, result.vacuumed)

section('maintenance self-throttles')
const throttled = new Maintenance(db, { intervalMs: 999_999_999 })
throttled.run(true)
check('a second immediate run is skipped', 0, throttled.run().conversation)
check('db stats are readable', true, maintenance.stats().sizeMb > 0)

db.close()
summary()
