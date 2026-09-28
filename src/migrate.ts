import { type Database } from 'bun:sqlite'
import { Logger } from './logger'

const log = new Logger('migrate')

interface Migration {
  version: number
  name: string
  up: (db: Database) => void
}

/** Numeric-dot version compare, for feature checks against the host SQLite. */
function compareSqliteVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
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
  {
    version: 7,
    name: 'create-conversation-summaries',
    up: (db) => {
      // The rolling summary lives beside the message log rather than inside it,
      // so compaction can delete dropped rows outright instead of rewriting them.
      db.run(`
        CREATE TABLE IF NOT EXISTS conversation_summaries (
          telegram_user_id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
    },
  },
  {
    version: 8,
    name: 'scope-conversations-by-session-and-agent',
    up: (db) => {
      // History is partitioned by (user, session, agent) so switching agents or
      // starting a new topic cannot bleed one context into another. Existing rows
      // stay in session 'default' / agent 'default', so nothing is lost.
      const addColumn = (table: string, name: string, ddl: string) => {
        try {
          db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`)
          log.info(`Added ${table}.${name}`)
        } catch {
          // already present on a partially-migrated schema
        }
      }

      addColumn('conversation_messages', 'session_id', "TEXT NOT NULL DEFAULT 'default'")
      addColumn('conversation_messages', 'agent_name', "TEXT NOT NULL DEFAULT 'default'")
      addColumn('conversation_summaries', 'session_id', "TEXT NOT NULL DEFAULT 'default'")
      addColumn('conversation_summaries', 'agent_name', "TEXT NOT NULL DEFAULT 'default'")

      // The old PK was (telegram_user_id) alone, which can only ever hold one
      // summary per user. Rebuild with the scope columns included.
      db.run('DROP TABLE IF EXISTS conversation_summaries_v2')
      db.run(`
        CREATE TABLE conversation_summaries_v2 (
          telegram_user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          summary TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (telegram_user_id, session_id, agent_name)
        )
      `)
      db.run(`
        INSERT OR REPLACE INTO conversation_summaries_v2
          (telegram_user_id, session_id, agent_name, summary, updated_at)
        SELECT telegram_user_id, session_id, agent_name, summary, updated_at
        FROM conversation_summaries
      `)
      db.run('DROP TABLE conversation_summaries')
      db.run('ALTER TABLE conversation_summaries_v2 RENAME TO conversation_summaries')

      db.run('DROP INDEX IF EXISTS idx_conversation_messages_user')
      db.run(`
        CREATE INDEX idx_conversation_messages_scope
          ON conversation_messages (telegram_user_id, session_id, agent_name, id)
      `)
    },
  },
  {
    version: 9,
    name: 'create-user-state',
    up: (db) => {
      // Small per-user key/value bag: current session, pinned agent, model
      // override. Kept out of the conversations/jobs tables because these are
      // pointers, not history.
      db.run(`
        CREATE TABLE IF NOT EXISTS user_state (
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
    version: 10,
    name: 'create-active-loops-and-step-caches',
    up: (db) => {
      // A long run checkpoints its step state here so a crash resumes instead of
      // restarting from zero.
      db.run(`
        CREATE TABLE IF NOT EXISTS active_loops (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          step INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'running',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.run('CREATE INDEX IF NOT EXISTS idx_active_loops_status ON active_loops (status, created_at)')

      db.run(`
        CREATE TABLE IF NOT EXISTS step_caches (
          loop_id TEXT NOT NULL,
          step INTEGER NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (loop_id, step)
        )
      `)
    },
  },
  {
    version: 11,
    name: 'create-usage-ledger',
    up: (db) => {
      // One row per model call, for the /ops cost view. Kept separate from
      // conversation history: it is append-only telemetry, not context.
      db.run(`
        CREATE TABLE IF NOT EXISTS usage_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_id TEXT NOT NULL,
          agent_name TEXT NOT NULL DEFAULT 'default',
          model TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          used_fallback INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        )
      `)
      db.run('CREATE INDEX IF NOT EXISTS idx_usage_ledger_entity ON usage_ledger (entity_id, created_at)')
    },
  },
  {
    version: 12,
    name: 'create-notes-todos-and-fts',
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.run('CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes (entity_id, updated_at)')

      db.run(`
        CREATE TABLE IF NOT EXISTS todos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_id TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          due_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      db.run("CREATE INDEX IF NOT EXISTS idx_todos_entity ON todos (entity_id, status)")

      // FTS5 gives /search over old conversations without loading them into the
      // model's context. Falls back to a plain LIKE scan where FTS5 is absent, so a
      // build without it degrades instead of failing to migrate.
      const hasFts = !!db
        .query(`SELECT 1 FROM pragma_compile_options WHERE compile_options LIKE '%ENABLE_FTS5%'`)
        .get()
      if (hasFts) {
        db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
            content,
            entity_id UNINDEXED,
            session_id UNINDEXED,
            agent_name UNINDEXED,
            created_at UNINDEXED
          )
        `)
        log.info('FTS5 conversation index available')
      } else {
        log.warn('SQLite built without FTS5 — /search will use a slow LIKE scan')
      }
    },
  },
  {
    version: 13,
    name: 'conversation_fts_triggers',
    up(db) {
      // Migration 12's index was maintained by hand, from append() alone. So a
      // /clear or a retention pass deleted the row but left its index entry, and
      // search kept returning messages the user had erased. The deeper problem is
      // that a plain fts5 table has no way to point at the row it came from, so
      // every delete site has to remember to clean up after it.
      //
      // Rebuild it contentless with `content=''` and a rowid alias on
      // conversation_messages.id. Triggers then own both directions, and the
      // alias is the join key retention needs to purge orphans. contentless
      // because search never selects columns, only matches — the text lives in
      // conversation_messages.
      //
      // contentless_delete=1 (SQLite 3.43+) is what allows a plain DELETE here.
      // Without it SQLite rejects every one of them and the triggers throw.
      const hasFts = !!db
        .query(`SELECT 1 FROM pragma_compile_options WHERE compile_options LIKE '%ENABLE_FTS5%'`)
        .get()
      if (!hasFts) {
        log.warn('SQLite built without FTS5 — skipping the FTS trigger migration')
        return
      }
      // contentless_delete needs 3.43. Bun ships 3.5x, but a foreign runtime might
      // not, and there is no partial option: without it the triggers throw on the
      // first delete. Leave the old table in place so /search still works.
      const version = (db.query('SELECT sqlite_version() AS v').get() as { v: string }).v
      if (compareSqliteVersion(version, '3.43.0') < 0) {
        log.warn(`SQLite ${version} lacks contentless_delete (needs 3.43) — keeping the unlinked FTS index`)
        return
      }

      db.run('DROP TRIGGER IF EXISTS conversation_fts_ai')
      db.run('DROP TRIGGER IF EXISTS conversation_fts_ad')
      db.run('DROP TRIGGER IF EXISTS conversation_fts_au')
      db.run('DROP TABLE IF EXISTS conversation_fts')

      db.run(`
        CREATE VIRTUAL TABLE conversation_fts USING fts5(
          content,
          content='',
          contentless_delete=1,
          content_rowid='id',
          entity_id UNINDEXED,
          session_id UNINDEXED,
          agent_name UNINDEXED,
          created_at UNINDEXED
        )
      `)
      db.run(`
        CREATE TRIGGER conversation_fts_ai AFTER INSERT ON conversation_messages BEGIN
          INSERT INTO conversation_fts(rowid, content, entity_id, session_id, agent_name, created_at)
          VALUES (
            new.id,
            COALESCE(new.content, ''),
            new.telegram_user_id,
            new.session_id,
            new.agent_name,
            new.created_at
          );
        END
      `)
      db.run(`
        CREATE TRIGGER conversation_fts_ad AFTER DELETE ON conversation_messages BEGIN
          DELETE FROM conversation_fts WHERE rowid = old.id;
        END
      `)
      db.run(`
        CREATE TRIGGER conversation_fts_au AFTER UPDATE ON conversation_messages BEGIN
          DELETE FROM conversation_fts WHERE rowid = old.id;
          INSERT INTO conversation_fts(rowid, content, entity_id, session_id, agent_name, created_at)
          VALUES (
            new.id,
            COALESCE(new.content, ''),
            new.telegram_user_id,
            new.session_id,
            new.agent_name,
            new.created_at
          );
        END
      `)

      // Backfill what 12 never indexed, so search isn't blind to history that
      // predates the table.
      db.run(`
        INSERT INTO conversation_fts(rowid, content, entity_id, session_id, agent_name, created_at)
        SELECT m.id, COALESCE(m.content, ''), m.telegram_user_id, m.session_id, m.agent_name, m.created_at
        FROM conversation_messages m
        WHERE m.id NOT IN (SELECT rowid FROM conversation_fts)
      `)
      log.info('FTS5 index rebuilt with delete triggers')
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
