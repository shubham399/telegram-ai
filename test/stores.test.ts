/**
 * Notes, todos and the usage ledger.
 *
 * The tenant-isolation assertions are the important ones: a bug that lets one user
 * read another's notes is a data leak, not a wrong answer.
 */
import { freshDb, check, section, summary } from './helpers'
import { NoteStore } from '../src/note-store'
import { TodoStore } from '../src/todo-store'
import { UsageLedger } from '../src/usage-ledger'

const db = freshDb()
const notes = new NoteStore(db)
const todos = new TodoStore(db)
const usage = new UsageLedger(db)

section('notes')
const note = notes.add('user-1', 'the API key rotation is quarterly', 'ops', ['api', 'runbook'])
check('add returns an id', true, note.id > 0)
check('tags round-trip', ['api', 'runbook'], note.tags)
check('newest first', 'ops', notes.list('user-1')[0].title)
check('filter by tag', 1, notes.list('user-1', 20, 'api').length)
check('absent tag yields nothing', 0, notes.list('user-1', 20, 'nope').length)
check('search matches body', 1, notes.search('user-1', 'quarterly').length)
check('update body', 'monthly', notes.update('user-1', note.id, { body: 'monthly' })!.body)
check('update preserves untouched fields', 'ops', notes.update('user-1', note.id, { body: 'x' })!.title)

section('notes tenant isolation')
check('other user sees nothing', 0, notes.list('user-2').length)
check('other user cannot read', null, notes.get('user-2', note.id))
check('other user cannot update', null, notes.update('user-2', note.id, { body: 'hijack' }))
check('other user cannot delete', false, notes.remove('user-2', note.id))
check('original survived the attempt', 'x', notes.get('user-1', note.id)!.body)

section('todos')
const todo = todos.add('user-1', 'buy milk')
check('new todo is open', 'open', todo.status)
check('complete marks done', 'done', todos.complete('user-1', todo.id)!.status)
check('completing again reopens', 'open', todos.complete('user-1', todo.id)!.status)
check('status filter', 1, todos.list('user-1', 'open').length)
check('other user sees nothing', 0, todos.list('user-2').length)
check('other user cannot complete', null, todos.complete('user-2', todo.id))

section('usage ledger')
usage.record({ entityId: 'user-1', agentName: 'default', model: 'gpt-4o-mini', promptTokens: 100, completionTokens: 20, totalTokens: 120, usedFallback: false, attempts: 1 })
usage.record({ entityId: 'user-1', agentName: 'email', model: 'gpt-4o-mini', promptTokens: 50, completionTokens: 10, totalTokens: 60, usedFallback: false, attempts: 1 })
usage.record({ entityId: 'user-2', agentName: 'default', model: 'fallback-x', promptTokens: 200, completionTokens: 30, totalTokens: 230, usedFallback: true, attempts: 3 })
const all = usage.summary(null, 30)
check('every call counted', 3, all.calls)
check('tokens summed', 410, all.totalTokens)
check('prompt and completion tracked separately', [350, 60], [all.promptTokens, all.completionTokens])
check('grouped by model', { 'gpt-4o-mini': { calls: 2, totalTokens: 180 }, 'fallback-x': { calls: 1, totalTokens: 230 } }, all.byModel)
check('per-user window', 180, usage.summary('user-1', 30).totalTokens)
check('ranked by spend', 'user-2', usage.byUser(30, 10)[0].entityId)

db.close()
summary()
