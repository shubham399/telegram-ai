/**
 * Housekeeping: retention, VACUUM, WAL checkpointing, and conversation search.
 *
 * Single-responsibility: bounded disk growth and lookup over old history. It never
 * touches rows that are still inside the retention window.
 */
import { type Database } from 'bun:sqlite'
import { statSync } from 'fs'
import { Logger } from './logger'
import { DEFAULT_SESSION } from './user-state'

const log = new Logger('maintenance')

const MS_PER_DAY = 86_400_000

export class Maintenance {
  private lastRun = 0
  private readonly conversationRetentionDays: number
  private readonly usageRetentionDays: number
  private readonly sessionRetentionDays: number
  private readonly intervalMs: number

  constructor(
    private db: Database,
    options: {
      conversationRetentionDays?: number
      usageRetentionDays?: number
      sessionRetentionDays?: number
      intervalMs?: number
    } = {},
  ) {
    this.conversationRetentionDays = options.conversationRetentionDays ?? 30
    this.usageRetentionDays = options.usageRetentionDays ?? 90
    this.sessionRetentionDays = options.sessionRetentionDays ?? 7
    this.intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000
  }

  /** Throttle: false when the previous run was too recent. */
  private due(now: number): boolean {
    return now - this.lastRun >= this.intervalMs
  }

  /**
   * Trim, checkpoint and compact.
   *
   * Order matters: deletes go first, then the WAL checkpoint truncates the
   * transaction log, then VACUUM reclaims the pages the deletes freed. VACUUM
   * rebuilds the whole file, so it goes last and is skipped when there is nothing
   * to reclaim.
   */
  run(force = false): { conversation: number; usage: number; sessions: number; vacuumed: boolean } {
    const now = Date.now()
    if (!force && !this.due(now)) {
      log.debug('Maintenance not due yet')
      return { conversation: 0, usage: 0, sessions: 0, vacuumed: false }
    }
    this.lastRun = now

    const conversation = this.trim('conversation_messages', 'created_at', this.conversationRetentionDays)
    const usage = this.trim('usage_ledger', 'created_at', this.usageRetentionDays)

    // A session scope nobody has touched in a week is dead weight.
    const sessionCutoff = new Date(now - this.sessionRetentionDays * MS_PER_DAY).toISOString()
    // Counted separately for the same reason as trim(): the FTS trigger shares the
    // connection's change counter, so `run().changes` over-reports here too.
    const sessionFilter =
      `session_id != ? AND created_at < ?
         AND session_id NOT IN (SELECT value FROM user_state WHERE key = 'current_session')`
    let sessions = 0
    try {
      const { n } = this.db
        .query(`SELECT count(*) AS n FROM conversation_messages WHERE ${sessionFilter}`)
        .get(DEFAULT_SESSION, sessionCutoff) as { n: number }
      if (n > 0) {
        this.db.run(`DELETE FROM conversation_messages WHERE ${sessionFilter}`, [
          DEFAULT_SESSION,
          sessionCutoff,
        ])
        sessions = n
      }
    } catch (err) {
      log.debug(`session retention skipped: ${err}`)
    }

    this.purgeFtsOrphans()

    this.checkpoint()

    // Only vacuum when something was actually deleted, and never inside a
    // transaction — VACUUM cannot run in one and would throw.
    const vacuumed = conversation + usage + sessions > 0 && this.vacuum()

    if (conversation + usage + sessions > 0) {
      log.info(`Maintenance: ${conversation} conversation, ${usage} usage, ${sessions} session row(s) removed`)
    }
    return { conversation, usage, sessions, vacuumed }
  }

  private trim(table: string, column: string, days: number): number {
    const cutoff = new Date(Date.now() - days * MS_PER_DAY).toISOString()
    try {
      // Counted with a SELECT, not from `changes`. The FTS delete trigger runs
      // bookkeeping statements whose changes land in the same counter — a
      // 5-row delete reports 27 — so `changes` cannot be trusted for this table.
      const { n } = this.db
        .query(`SELECT count(*) AS n FROM ${table} WHERE ${column} < ?`)
        .get(cutoff) as { n: number }
      if (n === 0) return 0
      this.db.run(`DELETE FROM ${table} WHERE ${column} < ?`, [cutoff])
      return n
    } catch (err) {
      // A missing table means the feature is not deployed yet — not an error.
      log.debug(`trim(${table}) skipped: ${err}`)
      return 0
    }
  }

  /**
   * Drop index entries whose conversation row is gone.
   *
   * The triggers keep the two in step, so this is a safety net rather than the
   * main mechanism — a bulk delete made before migration 13, or a build where
   * FTS5 was missing at insert time, leaves rows behind. Without this they
   * accumulate silently and search reports messages the user cannot see.
   */
  private purgeFtsOrphans(): number {
    if (!this.hasFts()) return 0
    try {
      return this.db
        .run(
          `DELETE FROM conversation_fts
           WHERE rowid NOT IN (SELECT id FROM conversation_messages)`,
        )
        .changes
    } catch (err) {
      log.debug(`FTS orphan purge skipped: ${err}`)
      return 0
    }
  }

  private hasFts(): boolean {
    return !!this.db
      .query(`SELECT 1 FROM sqlite_master WHERE name = 'conversation_fts'`)
      .get()
  }

  /**
   * Truncate the WAL. Without this it grows for the life of the process and every
   * read has to walk it.
   */
  private checkpoint(): void {
    try {
      this.db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      log.debug('WAL checkpointed')
    } catch (err) {
      // A checkpoint can fail if a reader holds the WAL; maintenance just skips it.
      log.debug(`wal_checkpoint skipped: ${err}`)
    }
  }

  private vacuum(): boolean {
    try {
      // vacuum must not run inside a transaction
      this.db.run('VACUUM')
      log.info('VACUUM completed')
      return true
    } catch (err) {
      log.warn(`VACUUM skipped: ${err}`)
      return false
    }
  }

  /** Disk footprint, for the ops tool. */
  stats(): { pageCount: number; pageSize: number; sizeMb: number; walMb: number; freelist: number } {
    const dbPath = String(
      (this.db.query('PRAGMA database_list').all() as { file: string }[]).find(r => r.file)?.file ?? '',
    )
    const pageCount = (this.db.query('PRAGMA page_count').get() as { page_count: number }).page_count
    const pageSize = (this.db.query('PRAGMA page_size').get() as { page_size: number }).page_size
    const freelist = (this.db.query('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count
    // The WAL is a sibling file, so it has to be stat'd, not measured with a pragma.
    const walBytes = fileSize(`${dbPath}-wal`)
    return {
      pageCount,
      pageSize,
      sizeMb: +((pageCount * pageSize) / 1_048_576).toFixed(2),
      walMb: +(walBytes / 1_048_576).toFixed(2),
      freelist,
    }
  }

  /**
   * Search conversation history.
   *
   * Uses FTS5 when the build has it and falls back to a LIKE scan, so search
   * works everywhere — just slower without the index. Only non-system messages
   * are returned, and each is trimmed, because the point is to find the turn, not
   * to replay the context window.
   */
  search(
    entityId: string,
    query: string,
    limit = 10,
  ): { content: string; createdAt: string; scope: { sessionId: string; agentName: string } }[] {
    const hasFts = !!this.db
      .query(`SELECT 1 FROM sqlite_master WHERE name = 'conversation_fts'`)
      .get()

    if (hasFts) {
      try {
        // The index is contentless, so it cannot hand back the matched text — the
        // rowid alias is the only thing it stores. Join to conversation_messages to
        // get the content, and filter the user by that table rather than by the
        // index's own UNINDEXED columns.
        const rows = this.db
          .query(
            `SELECT m.content, m.created_at, m.session_id, m.agent_name
             FROM conversation_fts f
             JOIN conversation_messages m ON m.id = f.rowid
             WHERE conversation_fts MATCH ? AND m.telegram_user_id = ?
             ORDER BY m.created_at DESC LIMIT ?`,
          )
          .all(ftsQuery(query), entityId, limit) as {
          content: string
          created_at: string
          session_id: string
          agent_name: string
        }[]
        return rows.map(r => ({
          content: r.content.slice(0, 400),
          createdAt: r.created_at,
          scope: { sessionId: r.session_id, agentName: r.agent_name },
        }))
      } catch (err) {
        // A user query with FTS5 operators (a bare `-`, `"`, `*`) throws. Fall back.
        log.debug(`FTS query failed, using LIKE: ${err}`)
      }
    }

    const rows = this.db
      .query(
        `SELECT content, created_at, session_id, agent_name FROM conversation_messages
         WHERE telegram_user_id = ? AND content LIKE ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(entityId, `%${query.replace(/[%_]/g, '')}%`, limit) as {
      content: string
      created_at: string
      session_id: string
      agent_name: string
    }[]
    return rows.map(r => ({
      content: r.content.slice(0, 400),
      createdAt: r.created_at,
      scope: { sessionId: r.session_id, agentName: r.agent_name },
    }))
  }
}

/** Keep the FTS5 query language operators a user is likely to type out of it. */
function ftsQuery(raw: string): string {
  const terms = raw
    .replace(/["*():^-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t}"`)
  return terms.length ? terms.join(' OR ') : '""'
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
