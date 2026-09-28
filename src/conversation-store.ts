/**
 * Per-user conversation persistence: the message log plus one rolling summary,
 * partitioned by session and by agent.
 *
 * Single-responsibility: storage and retrieval. The compaction *policy* (when to
 * compact, what counts as a token) lives in the caller; this class only does what
 * it is told.
 */
import { type Database } from 'bun:sqlite'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { Logger } from './logger'
import { DEFAULT_SESSION } from './user-state'

/**
 * Which conversation a message belongs to.
 *
 * `sessionId` is a topic boundary the user controls (`/new`, `/session`).
 * `agentName` is a boundary the system controls. Keeping them separate means
 * handing work to another agent and switching back does not lose either thread.
 */
export interface ConversationScope {
  sessionId: string
  agentName: string
}

export const defaultScope = (agentName = DEFAULT_SESSION): ConversationScope => ({
  sessionId: DEFAULT_SESSION,
  agentName,
})

export class ConversationStore {
  private log: Logger
  /** Best-effort: a build without FTS5 just has no search index. */
  private fts: boolean

  constructor(private db: Database) {
    this.log = new Logger('conversation-store')
    this.fts = !!db.query(`SELECT 1 FROM sqlite_master WHERE name = 'conversation_fts'`).get()
  }

  append(userId: string, scope: ConversationScope, messages: ChatCompletionMessageParam[]): void {
    if (messages.length === 0) return
    const now = new Date().toISOString()
    for (const m of messages) {
      const content = JSON.stringify(m)
      this.db.run(
        `INSERT INTO conversation_messages
           (telegram_user_id, session_id, agent_name, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, scope.sessionId, scope.agentName, m.role, content, now],
      )
      // FTS indexing is the trigger's job (migration 13). It used to be written
      // here too, which is how /clear and retention came to leave orphans behind:
      // nothing linked an index entry back to the row it came from.
    }
  }

  /**
   * Raw stored rows, oldest first. Does not include the summary.
   * Use this when you need to pick a slice to compact.
   */
  list(userId: string, scope: ConversationScope): ChatCompletionMessageParam[] {
    const rows = this.db
      .query(
        `SELECT content FROM conversation_messages
         WHERE telegram_user_id = ? AND session_id = ? AND agent_name = ?
         ORDER BY id`,
      )
      .all(userId, scope.sessionId, scope.agentName) as { content: string }[]
    return rows.map(r => JSON.parse(r.content) as ChatCompletionMessageParam)
  }

  /**
   * What to actually send to the model: the rolling summary (as a synthetic
   * user/assistant pair) followed by the retained tail.
   */
  listWithSummary(userId: string, scope: ConversationScope): ChatCompletionMessageParam[] {
    const summary = this.getSummary(userId, scope)
    const messages = this.list(userId, scope)
    if (!summary) return messages

    return [
      { role: 'user', content: `[Summary of earlier conversation]\n${summary}` },
      { role: 'assistant', content: 'Understood, I have context from our earlier conversation.' },
      ...messages,
    ]
  }

  count(userId: string, scope: ConversationScope): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS c FROM conversation_messages
         WHERE telegram_user_id = ? AND session_id = ? AND agent_name = ?`,
      )
      .get(userId, scope.sessionId, scope.agentName) as { c: number }
    return row.c
  }

  getSummary(userId: string, scope: ConversationScope): string | null {
    const row = this.db
      .query(
        `SELECT summary FROM conversation_summaries
         WHERE telegram_user_id = ? AND session_id = ? AND agent_name = ?`,
      )
      .get(userId, scope.sessionId, scope.agentName) as { summary: string | null } | undefined
    return row?.summary ?? null
  }

  setSummary(userId: string, scope: ConversationScope, summary: string): void {
    this.db.run(
      `INSERT INTO conversation_summaries
         (telegram_user_id, session_id, agent_name, summary, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(telegram_user_id, session_id, agent_name) DO UPDATE SET
         summary = excluded.summary, updated_at = excluded.updated_at`,
      [userId, scope.sessionId, scope.agentName, summary, new Date().toISOString()],
    )
  }

  /**
   * Drop every row except the newest `keepLast`, replacing what was dropped with
   * `summary`.
   *
   * Converges by construction: the row count lands on exactly `keepLast`, so the
   * caller's over-threshold check goes quiet until enough new rows accumulate.
   */
  compact(userId: string, scope: ConversationScope, keepLast: number, summary: string): void {
    const rows = this.db
      .query(
        `SELECT id FROM conversation_messages
         WHERE telegram_user_id = ? AND session_id = ? AND agent_name = ?
         ORDER BY id`,
      )
      .all(userId, scope.sessionId, scope.agentName) as { id: number }[]

    const dropCount = rows.length - keepLast
    if (dropCount <= 0) return

    const doomed = rows.slice(0, dropCount).map(r => r.id)
    const placeholders = doomed.map(() => '?').join(',')
    this.db.run(
      `DELETE FROM conversation_messages WHERE id IN (${placeholders})`,
      doomed as unknown as Array<string | number>,
    )
    this.setSummary(userId, scope, summary)

    this.log.info(`Compacted ${scope.sessionId}/${scope.agentName}: dropped ${dropCount}, kept ${keepLast}`)
  }

  /** Wipe one scope. Used by `/clear` and by `delegate_task`'s sub-run. */
  clear(userId: string, scope: ConversationScope): void {
    this.db.run(
      `DELETE FROM conversation_messages
       WHERE telegram_user_id = ? AND session_id = ? AND agent_name = ?`,
      [userId, scope.sessionId, scope.agentName],
    )
    this.db.run(
      `DELETE FROM conversation_summaries
       WHERE telegram_user_id = ? AND session_id = ? AND agent_name = ?`,
      [userId, scope.sessionId, scope.agentName],
    )
    this.log.info(`Cleared conversation ${scope.sessionId}/${scope.agentName}`)
  }

  /**
   * Wipe every scope for a user, across all sessions and agents.
   *
   * No explicit FTS cleanup: the delete triggers mirror it per row. It also cannot
   * be done by hand here — the index is contentless, so it holds no `entity_id`
   * to filter on.
   */
  clearAll(userId: string): void {
    this.db.run('DELETE FROM conversation_messages WHERE telegram_user_id = ?', [userId])
    this.db.run('DELETE FROM conversation_summaries WHERE telegram_user_id = ?', [userId])
    this.log.info(`Cleared all conversations`)
  }

  /** Drop a session's history but keep the summary, so the topic can resume. */
  forgetSession(userId: string, sessionId: string): void {
    this.db.run(
      'DELETE FROM conversation_messages WHERE telegram_user_id = ? AND session_id = ?',
      [userId, sessionId],
    )
    this.log.info(`Forgot session ${sessionId}`)
  }
}
