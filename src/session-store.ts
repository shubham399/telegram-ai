import { type Database } from 'bun:sqlite'
import { Logger } from './logger'
import { maskUserId, maskSessionId } from './pii'
import { getDb } from './db'
export interface SessionRow {
  telegramUserId: string
  composioSessionId: string
  createdAt: string
  lastActivityAt: string
}

export class SessionStore {
  db: Database
  private log: Logger

  constructor(db?: Database) {
    this.log = new Logger('session-store')
    this.db = db ?? getDb()
  }

  get(userId: string, timeoutMs: number): SessionRow | null {
    const row = this.db
      .query('SELECT * FROM sessions WHERE telegram_user_id = ?')
      .get(userId) as Record<string, string> | undefined
    if (!row) {
      this.log.debug(`No session for user ${maskUserId(userId)}`)
      return null
    }

    const elapsed = Date.now() - new Date(row.last_activity_at).getTime()
    if (elapsed > timeoutMs) {
      this.log.warn(`Session expired for user ${maskUserId(userId)} (${elapsed}ms > ${timeoutMs}ms)`)
      this.delete(userId)
      return null
    }
    this.log.debug(`Session found for user ${maskUserId(userId)}: ${maskSessionId(row.composio_session_id)}`)
    return {
      telegramUserId: row.telegram_user_id,
      composioSessionId: row.composio_session_id,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
    }
  }

  upsert(userId: string, sessionId: string): void {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO sessions (telegram_user_id, composio_session_id, created_at, last_activity_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET
         composio_session_id = excluded.composio_session_id,
         last_activity_at = excluded.last_activity_at`,
      [userId, sessionId, now, now],
    )
    this.log.info(`Session upserted for user ${maskUserId(userId)}: ${maskSessionId(sessionId)}`)
  }

  updateActivity(userId: string): void {
    const now = new Date().toISOString()
    this.db.run(
      'UPDATE sessions SET last_activity_at = ? WHERE telegram_user_id = ?',
      [now, userId],
    )
    this.log.debug(`Activity updated for user ${maskUserId(userId)}`)
  }

  delete(userId: string): void {
    this.db.run('DELETE FROM sessions WHERE telegram_user_id = ?', [userId])
    this.log.info(`Session deleted for user ${maskUserId(userId)}`)
  }
}
