import { type Database } from 'bun:sqlite'
import { Logger } from './logger'

export class MemoryStore {
  private log: Logger

  constructor(private db: Database) {
    this.log = new Logger('memory-store')
    this.log.info('User memory table initialized')
  }

  get(userId: string, key: string): string | null {
    const row = this.db
      .query('SELECT value FROM user_memory WHERE telegram_user_id = ? AND key = ?')
      .get(userId, key) as { value: string } | undefined
    return row?.value ?? null
  }

  set(userId: string, key: string, value: string): void {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO user_memory (telegram_user_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      [userId, key, value, now],
    )
    this.log.info(`Memory set for user ${userId}: ${key}`)
  }

  list(userId: string): Record<string, string> {
    const rows = this.db
      .query('SELECT key, value FROM user_memory WHERE telegram_user_id = ?')
      .all(userId) as { key: string; value: string }[]
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  }

  delete(userId: string, key: string): void {
    this.db.run(
      'DELETE FROM user_memory WHERE telegram_user_id = ? AND key = ?',
      [userId, key],
    )
    this.log.info(`Memory deleted for user ${userId}: ${key}`)
  }
}
