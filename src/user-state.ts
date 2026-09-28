/**
 * Small per-user key/value state: current session, pinned agent, model override.
 *
 * Single-responsibility: pointers, not content. Anything that grows without bound
 * belongs in a real table.
 */
import { type Database } from 'bun:sqlite'
import { Logger } from './logger'

const log = new Logger('user-state')

export class UserState {
  constructor(private db: Database) {
    log.info('User state ready')
  }

  get(userId: string, key: string): string | null {
    const row = this.db
      .query('SELECT value FROM user_state WHERE telegram_user_id = ? AND key = ?')
      .get(userId, key) as { value: string } | undefined
    return row?.value ?? null
  }

  set(userId: string, key: string, value: string): void {
    this.db.run(
      `INSERT INTO user_state (telegram_user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [userId, key, value, new Date().toISOString()],
    )
  }

  delete(userId: string, key: string): void {
    this.db.run('DELETE FROM user_state WHERE telegram_user_id = ? AND key = ?', [userId, key])
  }
}

export const KEY_SESSION = 'current_session'
export const KEY_AGENT = 'pinned_agent'
export const KEY_MODEL = 'model_override'

export const DEFAULT_SESSION = 'default'
