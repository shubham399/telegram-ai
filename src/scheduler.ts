/**
 * In-process scheduler: one 30s tick that fans due jobs out to task execution.
 *
 * Replaces the previous scheduler-worker + ai-worker Web Worker pair. Same
 * behaviour, one process, one SQLite handle — which removes the SQLITE_BUSY
 * multi-writer contention and makes crash recovery a single table update.
 *
 * Single-responsibility: decide *what* is due and *when* to run it. It does not
 * know how a task is executed (`runTask`) or how Telegram delivery works (`send`).
 */
import { Logger } from './logger'
import type { JobStore } from './job-store'
import type { TaskStore, Task } from './task-store'
import { IST_OFFSET_MS } from './time'

const log = new Logger('scheduler')

const POLL_INTERVAL_MS = 30_000
/** A task still INPROGRESS after this is assumed dead and gets requeued. */
const STALE_INPROGRESS_MS = 5 * 60 * 1000

export interface SchedulerDeps {
  jobStore: JobStore
  taskStore: TaskStore
  /** Executes one task and resolves once it has been recorded + delivered. */
  runTask: (task: Task) => Promise<void>
  /** Delivers a plain (no-AI) reminder. Resolves to whether Telegram accepted it. */
  send: (userId: string, text: string) => Promise<boolean>
  /** Optional: trims old rows, checkpoints the WAL, vacuums. Self-throttling. */
  maintain?: () => void
}

export interface Scheduler {
  /** Ends the poll loop. In-flight tasks are left to finish. */
  stop(): void
  /**
   * Runs one poll immediately. Exposed so the loop can be tested and driven
   * deliberately; the interval calls this too. Never overlaps itself.
   */
  tick(): Promise<void>
  /** Requeues tasks abandoned by a previous process. Safe to call more than once. */
  recover(): void
}

export function startScheduler(deps: SchedulerDeps): Scheduler {
  const { jobStore, taskStore, runTask, send, maintain } = deps

  let stopped = false
  let tickInFlight = false
  let tickCount = 0
  let lastCleanupDate = ''
  /** Tasks this process has dispatched and not yet seen finish. */
  const inFlight = new Map<number, number>()

  /**
   * A task can only be INPROGRESS if the process holding it is alive. On boot any
   * such row is from a previous process, so requeue it. This is what makes the
   * scheduler crash-safe without a heartbeat column.
   */
  function recoverInterruptedTasks(): void {
    const requeued = taskStore.requeueInProgress()
    if (requeued > 0) {
      log.warn(`Recovered ${requeued} interrupted task(s) from a previous run`)
    }
  }

  /** Requeue INPROGRESS tasks that have been running longer than any task should. */
  function requeueStaleTasks(now: number): void {
    for (const [taskId, startedAt] of inFlight) {
      if (now - startedAt > STALE_INPROGRESS_MS) {
        log.warn(`task #${taskId} still in-progress after ${now - startedAt}ms — requeueing`)
        inFlight.delete(taskId)
        taskStore.requeueInProgressFor(taskId)
      }
    }
  }

  function maybeRunDailyCleanup(now: number): void {
    const ist = new Date(now + IST_OFFSET_MS)
    const date = ist.toISOString().slice(0, 10)
    if (date === lastCleanupDate) return
    if (ist.getUTCHours() !== 0 || ist.getUTCMinutes() > 1) return

    lastCleanupDate = date
    const tasks = taskStore.cleanupDone()
    const jobs = jobStore.cleanupInactive()
    log.info(`daily cleanup: ${tasks} task(s), ${jobs} job(s) removed`)

    // Retention + VACUUM rides the same once-a-day trigger. It throttles itself
    // too, so a forced run from the ops tool does not cause a second one here.
    try {
      maintain?.()
    } catch (err) {
      log.warn(`maintenance failed: ${err}`)
    }
  }

  /**
   * Deliver a reminder that needs no model, then advance the schedule.
   *
   * The job is advanced even when delivery fails: leaving `next_run_at` in the
   * past would re-fire the same reminder on every tick.
   */
  async function deliverPlainReminder(jobId: number, userId: string, taskText: string): Promise<void> {
    try {
      const ok = await send(userId, `⏰ ${taskText}`)
      if (!ok) log.warn(`task #${jobId}: plain reminder not delivered`)
    } catch (err) {
      log.warn(`task #${jobId}: plain reminder threw: ${err}`)
    } finally {
      jobStore.afterRun(jobId)
    }
  }

  function dispatch(task: Task): void {
    inFlight.set(task.id, Date.now())
    log.info(`dispatching task #${task.id} (job #${task.jobId}, retry ${task.retryCount})`)

    runTask(task)
      .catch(err => log.error(`task #${task.id}: unhandled runner error: ${err}`))
      .finally(() => {
        inFlight.delete(task.id)
      })
  }

  async function tick(): Promise<void> {
    // stop() must be final: a tick already queued on the event loop, or one a
    // caller invokes afterwards, would otherwise keep the database churning.
    if (stopped) {
      log.debug('scheduler stopped — tick ignored')
      return
    }
    if (tickInFlight) {
      log.debug('previous tick still running — skipping')
      return
    }
    tickInFlight = true
    tickCount++

    const now = Date.now()
    try {
      const pending = jobStore.getActiveCount()
      log.debug(`[tick #${tickCount}] pending=${pending} inFlight=${inFlight.size}`)

      maybeRunDailyCleanup(now)
      requeueStaleTasks(now)

      const due = jobStore.getDue()
      for (const job of due) {
        if (job.needsAi) {
          if (!taskStore.hasActiveForJob(job.id)) {
            taskStore.create(job.id, job.telegramUserId, job.task)
            log.debug(`[tick #${tickCount}] task created for job #${job.id}`)
          }
        } else {
          // needs_ai = 0 means "just print this at the scheduled time". Running it
          // through the agent loop would burn a full LLM round-trip per reminder.
          log.info(`[tick #${tickCount}] job #${job.id} is due — delivering directly (no LLM)`)
          void deliverPlainReminder(job.id, job.telegramUserId, job.task)
        }
      }

      // Dispatch concurrently: one slow task must not hold up every other job.
      const ready = taskStore.getNew().filter(task => !inFlight.has(task.id))
      if (ready.length > 0) {
        log.info(`[tick #${tickCount}] dispatching ${ready.length} task(s): #${ready.map(t => t.id).join(' #')}`)
        for (const task of ready) dispatch(task)
      }
    } catch (err) {
      log.error(`[tick #${tickCount}] failed: ${err}`)
    } finally {
      tickInFlight = false
    }
  }

  recoverInterruptedTasks()
  log.info(`Scheduler starting — ${jobStore.getActiveCount()} active job(s), polling every ${POLL_INTERVAL_MS / 1000}s`)
  void tick()

  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS)

  return {
    tick,
    recover: recoverInterruptedTasks,
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      log.info(`Scheduler stopped (${inFlight.size} task(s) still in flight)`)
    },
  }
}
