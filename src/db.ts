/**
 * Owns the single SQLite connection.
 *
 * Single-responsibility: connection lifecycle + pragmas + migrations, nothing else.
 * Everything else takes a `Database` by constructor injection.
 *
 * ponytail: one process, one handle. SQLite is a whole-database lock, so two
 * handles writing at once is the SQLITE_BUSY bug. If we ever need multi-process,
 * upgrade to Postgres (or one writer actor) rather than reopening the handle here.
 */
import { Database } from 'bun:sqlite'
import { Logger } from './logger'
import { runMigrations } from './migrate'

const log = new Logger('db')

let handle: Database | null = null

export function getDb(): Database {
  if (handle) return handle

  const path = 'data/sessions.db'
  const db = new Database(path)
  // WAL: readers don't block the writer.
  db.run('PRAGMA journal_mode=WAL')
  // Without this, a write that lands while the scheduler tick holds the lock
  // throws SQLITE_BUSY immediately instead of waiting.
  db.run('PRAGMA busy_timeout=10000')
  // NORMAL is the standard WAL pairing: durable across app crash, may lose the
  // last commits on OS crash. Fine here, the DB is a cache of upstream state.
  db.run('PRAGMA synchronous=NORMAL')

  runMigrations(db)

  handle = db
  log.info(`Database ready at ${path}`)
  return db
}

export function closeDb(): void {
  if (!handle) return
  // Truncate the WAL on the way out so the file doesn't grow unbounded across restarts.
  try {
    handle.run('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (err) {
    log.warn(`WAL checkpoint on close failed: ${err}`)
  }
  try {
    handle.close()
  } catch (err) {
    log.warn(`DB close failed: ${err}`)
  }
  handle = null
  log.info('Database closed')
}
