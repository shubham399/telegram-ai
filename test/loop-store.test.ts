/**
 * Crash-resume checkpoints. The contract is that a loop killed mid-run comes back
 * with its message prefix intact, and that no failure mode throws.
 */
import { freshDb, check, section, summary } from './helpers'
import { LoopStore } from '../src/loop-store'

const db = freshDb()
const loops = new LoopStore(db)
const scope = { sessionId: 'default', agentName: 'email' }

section('checkpointing')
loops.start('user-1', scope, 'loop-1')
check('a fresh loop is resumable', true, loops.findResumable().some(l => l.id === 'loop-1'))
loops.record('loop-1', 1, [{ role: 'user', content: 'a' }])
loops.record('loop-1', 2, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])
check('latest step wins', 2, loops.latest('loop-1')!.step)
check('messages are complete', 2, loops.latest('loop-1')!.messages.length)
check('scope is preserved', scope, loops.findResumable().find(l => l.id === 'loop-1')!.scope)

section('re-checkpointing the same step replaces rather than duplicates')
loops.record('loop-1', 2, [{ role: 'user', content: 'replaced' }])
check('same step overwritten', 'replaced', loops.latest('loop-1')!.messages[0].content)
check('one row per step', 2, (db.query('SELECT COUNT(*) c FROM step_caches WHERE loop_id = ?').get('loop-1') as any).c)
check('earlier step retained', 1, loops.latest('loop-1')!.step === 2 ? (db.query('SELECT COUNT(*) c FROM step_caches WHERE loop_id = ? AND step = 1').get('loop-1') as any).c : 0)

section('finishing removes a loop from the resume set')
loops.finish('loop-1', 'done')
check('done loop is not resumable', false, loops.findResumable().some(l => l.id === 'loop-1'))
check('checkpoint kept for audit', 2, loops.latest('loop-1')!.step)

section('lookup by scope')
loops.start('user-2', scope, 'loop-2')
loops.record('loop-2', 5, [{ role: 'user', content: 'x' }])
check('finds the running loop for this scope', 'loop-2', loops.findForScope('user-2', scope)?.id)
check('wrong agent finds nothing', null, loops.findForScope('user-2', { sessionId: 'default', agentName: 'researcher' }))
check('wrong user finds nothing', null, loops.findForScope('nobody', scope))

section('a corrupt checkpoint degrades to null instead of throwing')
db.run("INSERT INTO step_caches (loop_id, step, payload) VALUES ('loop-2', 9, '{not json')")
check('corrupt newest checkpoint returns null', null, loops.latest('loop-2'))

section('prune removes stale loops and their checkpoints')
db.run("UPDATE active_loops SET updated_at = '2000-01-01T00:00:00Z' WHERE id = 'loop-2'")
check('one loop pruned', 1, loops.prune(7))
check('orphan checkpoints removed with it', 0, (db.query('SELECT COUNT(*) c FROM step_caches WHERE loop_id = ?').get('loop-2') as any).c)
check('a loop outside the window is left alone', 'loop-1', (db.query('SELECT id FROM active_loops WHERE id = ?').get('loop-1') as any)?.id)

db.close()
summary()
