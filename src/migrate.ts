import { type Database } from 'bun:sqlite'
import { Logger } from './logger'

const log = new Logger('migrate')

interface Migration {
  version: number
  name: string
  up: (db: Database) => void
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'create-sessions',
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          telegram_user_id TEXT PRIMARY KEY,
          composio_session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL
        )
      `)
    },
  },
  {
    version: 2,
    name: 'create-user-memory',
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS user_memory (
          telegram_user_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (telegram_user_id, key)
        )
      `)
    },
  },
  {
    version: 3,
    name: 'create-scheduled-jobs',
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS scheduled_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          telegram_user_id TEXT NOT NULL,
          task TEXT NOT NULL,
          schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once','daily','weekdays','weekly')),
          hour INTEGER NOT NULL,
          minute INTEGER NOT NULL,
          day_of_week INTEGER,
          timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
          needs_ai INTEGER DEFAULT 0,
          next_run_at TEXT,
          last_run_at TEXT,
          active INTEGER DEFAULT 1,
          created_at TEXT NOT NULL
        )
      `)
    },
  },
  {
    version: 4,
    name: 'add-needs-ai',
    up: (db) => {
      try {
        db.run('ALTER TABLE scheduled_jobs ADD COLUMN needs_ai INTEGER DEFAULT 0')
        log.info('Added needs_ai column')
      } catch {
        // Column already exists on older schema — ignore
      }
    },
  },
  {
    version: 5,
    name: 'create-scheduled-tasks',
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL,
          telegram_user_id TEXT NOT NULL,
          task_text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','INPROGRESS','SUCCESS','FAILED')),
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 3,
          error_message TEXT,
          result_text TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        )
      `)
    },
  },
  {
    version: 6,
    name: 'create-conversation-messages',
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS conversation_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          telegram_user_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `)
      db.run('CREATE INDEX IF NOT EXISTS idx_conversation_messages_user ON conversation_messages (telegram_user_id, id)')
    },
  },
]

export function runMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `)

  const applied = new Set(
    (db.query('SELECT version FROM _migrations').all() as { version: number }[]).map(r => r.version),
  )

  for (const m of migrations) {
    if (applied.has(m.version)) continue
    log.info(`Running migration ${m.version}: ${m.name}`)
    m.up(db)
    const now = new Date().toISOString()
    db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, now])
    log.info(`Migration ${m.version} applied`)
  }
}
