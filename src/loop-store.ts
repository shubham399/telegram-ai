/**
 * Crash-resume checkpoints for long agent runs.
 *
 * Single-responsibility: store and retrieve "we were on step N with these
 * messages". Deciding when to checkpoint and when to resume is the runner's job.
 *
 * Why this exists: a run that is 18 tool calls deep when the process dies used to
 * be lost entirely. Step state is small next to conversation history, so it is
 * kept verbatim and the newest step wins.
 */
import { type Database } from 'bun:sqlite'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { Logger } from './logger'
import type { ConversationScope } from './conversation-store'

const log = new Logger('loop-store')

export type LoopStatus = 'running' | 'done' | 'failed' | 'abandoned'

export interface LoopRow {
  id: string
  entityId: string
  scope: ConversationScope
  step: number
  status: LoopStatus
  createdAt: string
  updatedAt: string
}

export interface Checkpoint {
  step: number
  messages: ChatCompletionMessageParam[]
}

export class LoopStore {
  constructor(private db: Database) {
    log.info('Loop store ready')
  }

  start(entityId: string, scope: ConversationScope, id: string): string {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO active_loops
         (id, entity_id, session_id, agent_name, step, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 'running', ?, ?)`,
      [id, entityId, scope.sessionId, scope.agentName, now, now],
    )
    log.info(`Loop ${id} started for ${entityId}/${scope.sessionId}`)
    return id
  }

  /**
   * Record the messages produced through `step`. Replaces any earlier checkpoint
   * for the same step so a retry loop cannot leave two divergent histories.
   */
  record(loopId: string, step: number, messages: ChatCompletionMessageParam[]): void {
    this.db.run(
      `INSERT INTO step_caches (loop_id, step, payload) VALUES (?, ?, ?)
       ON CONFLICT(loop_id, step) DO UPDATE SET payload = excluded.payload`,
      [loopId, step, JSON.stringify(messages)],
    )
    this.db.run('UPDATE active_loops SET step = ?, updated_at = ? WHERE id = ?', [
      step,
      new Date().toISOString(),
      loopId,
    ])
  }

  /** Newest checkpoint, or null when the loop died before finishing a step. */
  latest(loopId: string): Checkpoint | null {
    const row = this.db
      .query('SELECT step, payload FROM step_caches WHERE loop_id = ? ORDER BY step DESC LIMIT 1')
      .get(loopId) as { step: number; payload: string } | undefined
    if (!row) return null
    try {
      return { step: row.step, messages: JSON.parse(row.payload) as ChatCompletionMessageParam[] }
    } catch (err) {
      log.warn(`Loop ${loopId} checkpoint ${row.step} is corrupt: ${err}`)
      return null
    }
  }

  finish(loopId: string, status: LoopStatus): void {
    this.db.run('UPDATE active_loops SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      new Date().toISOString(),
      loopId,
    ])
  }
  /** Loops that were mid-flight when the process stopped. */
  findResumable(): LoopRow[] {
    const rows = this.db
      .query(`SELECT * FROM active_loops WHERE status = 'running' ORDER BY created_at`)
      .all() as Record<string, string | number>[]
    return rows.map(row => ({
      id: String(row.id),
      entityId: String(row.entity_id),
      scope: { sessionId: String(row.session_id), agentName: String(row.agent_name) },
      step: Number(row.step),
      status: 'running' as LoopStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }))
  }

  /** Drop loops that finished long ago. Checkpoint rows go with them. */
  prune(olderThanDays = 7): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString()
    const stale = this.db
      .query(`SELECT id FROM active_loops WHERE updated_at < ?`)
      .all(cutoff) as { id: string }[]
    if (stale.length === 0) return 0
    const ids = stale.map(r => r.id)
    const holes = ids.map(() => '?').join(',')
    this.db.run(`DELETE FROM step_caches WHERE loop_id IN (${holes})`, ids as unknown as string[])
    this.db.run(`DELETE FROM active_loops WHERE id IN (${holes})`, ids as unknown as string[])
    log.info(`Pruned ${ids.length} loop(s) older than ${olderThanDays}d`)
    return ids.length
  }
}
