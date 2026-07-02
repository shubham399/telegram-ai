import { Database } from 'bun:sqlite'
import { Logger } from './logger'
import { TaskStore } from './task-store'
import { JobStore } from './job-store'
import { runMigrations } from './migrate'

interface DueJob {
  id: number
  telegramUserId: string
  task: string
  scheduleType: string
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

const IST_OFFSET_MS = 5.5 * 3600 * 1000

let db: Database
let log: Logger
let taskStore: TaskStore
let jobStore: JobStore
let tickCount = 0
let lastCleanupDate = ''
const inProgressTasks = new Map<number, number>() // taskId -> timestamp
const INPROGRESS_TIMEOUT_MS = 300_000 // 5 min

function getDue(): DueJob[] {
  const now = new Date().toISOString()
  const rows = db
    .query(`SELECT id, telegram_user_id AS telegramUserId, task, schedule_type AS scheduleType,
                   hour, minute, day_of_week AS dayOfWeek, timezone, needs_ai AS needsAi,
                   next_run_at AS nextRunAt, last_run_at AS lastRunAt, active, created_at AS createdAt
            FROM scheduled_jobs WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
            ORDER BY next_run_at`)
    .all(now) as DueJob[]
  return rows
}

function tick(): void {
  tickCount++
  const queryTime = new Date().toISOString()
  const pendingRow = db.query('SELECT COUNT(*) as c FROM scheduled_jobs WHERE active = 1').get() as { c: number } | undefined
  const pending = pendingRow?.c ?? 0
  log.info(`[tick #${tickCount}] queryTime=${queryTime} pending=${pending}`)

  // ponytail: daily cleanup at 00:00 IST, date-tracked to run once
  const istDate = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10)
  if (istDate !== lastCleanupDate) {
    const istHour = new Date(Date.now() + IST_OFFSET_MS).getUTCHours()
    const istMin = new Date(Date.now() + IST_OFFSET_MS).getUTCMinutes()
    if (istHour === 0 && istMin < 1) {
      lastCleanupDate = istDate
      const taskCount = taskStore.cleanupDone()
      const jobCount = jobStore.cleanupInactive()
      log.info(`[tick #${tickCount}] daily cleanup: ${taskCount} tasks, ${jobCount} jobs removed`)
    }
  }

  try {
    // 1. Create tasks for due jobs (if no active task exists)
    const due = getDue()
    let tasksCreated = 0
    for (const job of due) {
      if (!taskStore.hasActiveForJob(job.id)) {
        taskStore.create(job.id, job.telegramUserId, job.task)
        tasksCreated++
      }
    }
    if (tasksCreated > 0) {
      log.info(`[tick #${tickCount}] created ${tasksCreated} task(s) from due jobs`)
    }

    // 2. Prune stale in-progress entries (AI worker crashed)
    const now = Date.now()
    for (const [taskId, ts] of inProgressTasks) {
      if (now - ts > INPROGRESS_TIMEOUT_MS) {
        log.warn(`[tick #${tickCount}] task #${taskId} in-progress stale (${now - ts}ms) — removing`)
        inProgressTasks.delete(taskId)
      }
    }

    // 3. Dispatch NEW tasks to AI worker
    const newTasks = taskStore.getNew()
    if (newTasks.length > 0) {
      log.info(`[tick #${tickCount}] ${newTasks.length} new task(s): #${newTasks.map(t => t.id).join(', #')}`)
    }

    for (const task of newTasks) {
      if (inProgressTasks.has(task.id)) {
        log.info(`[tick #${tickCount}] task #${task.id} already dispatched — skip`)
        continue
      }
      log.info(`[tick #${tickCount}] dispatching task #${task.id}: job=${task.jobId} user=${task.telegramUserId} retry=${task.retryCount} task="${task.taskText}"`)
      inProgressTasks.set(task.id, Date.now())
      self.postMessage({ type: 'task-reminder', task })
    }
  } catch (err) {
    log.error(`[tick #${tickCount}] failed: ${err}`)
  }
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data
  if (msg.type === 'init') {
    const logLevel = (msg as any).logLevel || 'INFO'
    log = new Logger('scheduler', logLevel as any)
    db = new Database((msg as any).dbPath)
    db.run('PRAGMA journal_mode=WAL')
    runMigrations(db)
    taskStore = new TaskStore(db)
    jobStore = new JobStore(db)

    const activeCount = db.query('SELECT COUNT(*) as c FROM scheduled_jobs WHERE active = 1').get() as { c: number } | undefined
    log.info(`Scheduler worker initialized — active jobs: ${activeCount?.c ?? '?'}`)
    self.postMessage({ type: 'ready' })
    log.info('Starting 30s polling loop')
    setInterval(tick, 30_000)
    tick()
  } else if (msg.type === 'task-complete') {
    const taskId = (msg as any).taskId as number
    const removed = inProgressTasks.delete(taskId)
    if (removed) log.info(`task-complete: task #${taskId} removed from in-progress`)
    else log.warn(`task-complete: task #${taskId} not in in-progress`)
  }
}
