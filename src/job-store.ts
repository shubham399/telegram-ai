import { type Database } from 'bun:sqlite'
import { Logger } from './logger'
import { computeNextRunUTC } from './schedule-math'

export interface Job {
  id: number
  telegramUserId: string
  task: string
  scheduleType: 'once' | 'daily' | 'weekdays' | 'weekly'
  hour: number
  minute: number
  dayOfWeek: number | null
  timezone: string
  needsAi: number
  nextRunAt: string | null
  lastRunAt: string | null
  active: number
  createdAt: string
}

export class JobStore {
  private log: Logger

  constructor(private db: Database) {
    this.log = new Logger('job-store')
    this.log.info('Scheduled jobs table initialized')
  }

  create(
    telegramUserId: string,
    task: string,
    scheduleType: 'once' | 'daily' | 'weekdays' | 'weekly',
    hour: number,
    minute: number,
    dayOfWeek?: number,
    needsAi?: boolean,
  ): string {
    const now = new Date().toISOString()
    const nextRun = computeNextRunUTC(scheduleType, hour, minute, dayOfWeek)
    const nextRunStr = nextRun?.toISOString() ?? null

    this.db.run(
      `INSERT INTO scheduled_jobs
         (telegram_user_id, task, schedule_type, hour, minute, day_of_week, timezone, needs_ai, next_run_at, last_run_at, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Asia/Kolkata', ?, ?, NULL, 1, ?)`,
      [telegramUserId, task, scheduleType, hour, minute, dayOfWeek ?? null, needsAi ? 1 : 0, nextRunStr, now],
    )
    const id = (this.db.query('SELECT last_insert_rowid() as id').get() as { id: number }).id
    this.log.info(`Job #${id} created for user ${telegramUserId}: ${scheduleType} at ${hour}:${minute} IST, nextRun=${nextRunStr}, needsAi=${needsAi ? 1 : 0}`)
    return `Scheduled: ${scheduleType} at ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} IST`
  }

  getDue(): Job[] {
    const now = new Date().toISOString()
    const rows = this.db
      .query(`SELECT id, telegram_user_id AS telegramUserId, task, schedule_type AS scheduleType,
                     hour, minute, day_of_week AS dayOfWeek, timezone, needs_ai AS needsAi,
                     next_run_at AS nextRunAt, last_run_at AS lastRunAt, active, created_at AS createdAt
              FROM scheduled_jobs WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
              ORDER BY next_run_at`)
      .all(now) as Job[]
    return rows
  }

  afterRun(jobId: number): void {
    const row = this.db
      .query(`SELECT id, schedule_type AS scheduleType, hour, minute, day_of_week AS dayOfWeek
              FROM scheduled_jobs WHERE id = ?`)
      .get(jobId) as Pick<Job, 'id' | 'scheduleType' | 'hour' | 'minute' | 'dayOfWeek'> | undefined
    if (!row) return

    const now = new Date().toISOString()

    if (row.scheduleType === 'once') {
      this.db.run('UPDATE scheduled_jobs SET last_run_at = ?, active = 0, next_run_at = NULL WHERE id = ?', [now, jobId])
      this.log.info(`Job #${jobId} deactivated (one-time)`)
    } else {
      const nextRun = computeNextRunUTC(
        row.scheduleType as any,
        row.hour,
        row.minute,
        row.dayOfWeek ?? undefined,
      )
      const nextRunStr = nextRun?.toISOString() ?? null
      this.db.run(
        'UPDATE scheduled_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?',
        [now, nextRunStr, jobId],
      )
      this.log.info(`Job #${jobId} next run set to ${nextRunStr}`)
    }
  }

  listByUser(telegramUserId: string): Job[] {
    return this.db
      .query(`SELECT id, telegram_user_id AS telegramUserId, task, schedule_type AS scheduleType,
                     hour, minute, day_of_week AS dayOfWeek, timezone, needs_ai AS needsAi,
                     next_run_at AS nextRunAt, last_run_at AS lastRunAt, active, created_at AS createdAt
              FROM scheduled_jobs WHERE telegram_user_id = ? AND active = 1
              ORDER BY next_run_at`)
      .all(telegramUserId) as Job[]
  }

  cancelById(jobId: number, telegramUserId?: string): string | null {
    const rows = telegramUserId
      ? this.db.query('SELECT id, task FROM scheduled_jobs WHERE id = ? AND telegram_user_id = ? AND active = 1').all(jobId, telegramUserId) as { id: number; task: string }[]
      : this.db.query('SELECT id, task FROM scheduled_jobs WHERE id = ? AND active = 1').all(jobId) as { id: number; task: string }[]
    if (rows.length === 0) return null
    this.db.run('UPDATE scheduled_jobs SET active = 0, next_run_at = NULL WHERE id = ?', [jobId])
    this.log.info(`Cancelled job #${jobId} by id: "${rows[0].task}"`)
    return `Cancelled job #${jobId}: "${rows[0].task}"`
  }

  cancelByTask(telegramUserId: string, task: string): string | null {
    if (!task || !task.trim()) return null
    const rows = this.db
      .query(`SELECT id, task FROM scheduled_jobs
              WHERE telegram_user_id = ? AND active = 1 AND LOWER(task) LIKE LOWER(?)`)
      .all(telegramUserId, `%${task.trim()}%`) as { id: number; task: string }[]
    if (rows.length === 0) return null
    const ids = rows.map(r => r.id)
    this.db.run(`UPDATE scheduled_jobs SET active = 0, next_run_at = NULL WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    const tasks = rows.map(r => `"${r.task}"`).join(', ')
    this.log.info(`Cancelled jobs #${ids.join(', #')} for user ${telegramUserId}: ${tasks}`)
    return `Cancelled: ${tasks}`
  }

  cleanupInactive(): number {
    const result = this.db.run('DELETE FROM scheduled_jobs WHERE active = 0')
    const count = result.changes
    if (count > 0) this.log.info(`Cleanup: removed ${count} inactive job(s)`)
    return count
  }

  getActiveCount(): number {
    const row = this.db
      .query('SELECT COUNT(*) as count FROM scheduled_jobs WHERE active = 1')
      .get() as { count: number }
    return row.count
  }

}
