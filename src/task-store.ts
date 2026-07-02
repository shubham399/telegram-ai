import { type Database } from 'bun:sqlite'
import { Logger } from './logger'

export interface Task {
  id: number
  jobId: number
  telegramUserId: string
  taskText: string
  status: 'NEW' | 'INPROGRESS' | 'SUCCESS' | 'FAILED'
  retryCount: number
  maxRetries: number
  errorMessage: string | null
  resultText: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export class TaskStore {
  private log: Logger

  constructor(private db: Database) {
    this.log = new Logger('task-store')
    this.log.info('Task table initialized')
  }

  create(jobId: number, userId: string, taskText: string, maxRetries = 3): Task {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO scheduled_tasks (job_id, telegram_user_id, task_text, status, retry_count, max_retries, created_at)
       VALUES (?, ?, ?, 'NEW', 0, ?, ?)`,
      [jobId, userId, taskText, maxRetries, now],
    )
    const id = (this.db.query('SELECT last_insert_rowid() as id').get() as { id: number }).id
    return this.getById(id)!
  }

  getById(id: number): Task | null {
    return (this.db
      .query(`SELECT id, job_id AS jobId, telegram_user_id AS telegramUserId, task_text AS taskText,
                     status, retry_count AS retryCount, max_retries AS maxRetries,
                     error_message AS errorMessage, result_text AS resultText,
                     created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt
              FROM scheduled_tasks WHERE id = ?`)
      .get(id) as Task | undefined) ?? null
  }

  getNew(): Task[] {
    return this.db
      .query(`SELECT id, job_id AS jobId, telegram_user_id AS telegramUserId, task_text AS taskText,
                     status, retry_count AS retryCount, max_retries AS maxRetries,
                     error_message AS errorMessage, result_text AS resultText,
                     created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt
              FROM scheduled_tasks WHERE status = 'NEW'
              ORDER BY created_at`)
      .all() as Task[]
  }

  getByJobId(jobId: number): Task[] {
    return this.db
      .query(`SELECT id, job_id AS jobId, telegram_user_id AS telegramUserId, task_text AS taskText,
                     status, retry_count AS retryCount, max_retries AS maxRetries,
                     error_message AS errorMessage, result_text AS resultText,
                     created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt
              FROM scheduled_tasks WHERE job_id = ? ORDER BY created_at DESC`)
      .all(jobId) as Task[]
  }

  setInProgress(id: number): void {
    const now = new Date().toISOString()
    this.db.run("UPDATE scheduled_tasks SET status = 'INPROGRESS', started_at = ? WHERE id = ?", [now, id])
  }

  setSuccess(id: number, resultText: string): void {
    const now = new Date().toISOString()
    this.db.run(
      "UPDATE scheduled_tasks SET status = 'SUCCESS', result_text = ?, completed_at = ? WHERE id = ?",
      [resultText, now, id],
    )
  }

  setFailed(id: number, errorMessage: string): void {
    const now = new Date().toISOString()
    this.db.run(
      "UPDATE scheduled_tasks SET status = 'FAILED', error_message = ?, completed_at = ? WHERE id = ?",
      [errorMessage, now, id],
    )
  }

  hasActiveForJob(jobId: number): boolean {
    const row = this.db
      .query("SELECT COUNT(*) as c FROM scheduled_tasks WHERE job_id = ? AND status IN ('NEW','INPROGRESS')")
      .get(jobId) as { c: number }
    return row.c > 0
  }

  cleanupDone(): number {
    const result = this.db.run("DELETE FROM scheduled_tasks WHERE status IN ('SUCCESS', 'FAILED')")
    const count = result.changes
    if (count > 0) this.log.info(`Cleanup: removed ${count} done task(s)`)
    return count
  }

  createRetry(id: number): Task | null {
    const original = this.getById(id)
    if (!original) return null
    const nextCount = original.retryCount + 1
    if (nextCount >= original.maxRetries) return null
    return this.create(original.jobId, original.telegramUserId, original.taskText, original.maxRetries)
  }
}
