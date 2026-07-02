import { env } from './config'
import { JobStore } from './job-store'
import { Logger } from './logger'

const log = new Logger('scheduler')

interface WorkerMessage {
  type: string
  [key: string]: unknown
}

export function startScheduler(jobStore: JobStore) {
  const SCHED_MAX_RETRIES = 5
  const SCHED_RETRY_DELAY_MS = 5000

  let schedWorker: Worker | null = null
  let aiWorker: Worker | null = null
  let schedRetryCount = 0
  let cleanup = false

  function spawnAiWorker(): void {
    if (cleanup) return
    if (aiWorker) {
      try { aiWorker.terminate() } catch { /* ignore */ }
    }

    aiWorker = new Worker(new URL('./ai-worker.ts', import.meta.url))

    aiWorker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (cleanup) return
      const msg = event.data

      if (msg.type === 'ready') {
        log.info('AI worker ready')
        return
      }

      if (msg.type === 'completed' || msg.type === 'failed') {
        const taskId = (msg as any).taskId as number
        log.info(`AI worker: task #${taskId} ${msg.type}`)
        schedWorker?.postMessage({ type: 'task-complete', taskId })
        return
      }
    }

    aiWorker.onerror = (err: ErrorEvent) => {
      log.error(`AI worker crashed: ${err.message}`)
      if (!cleanup) {
        log.warn('Restarting AI worker in 2s...')
        setTimeout(spawnAiWorker, 2000)
      }
    }

    aiWorker.postMessage({
      type: 'init',
      dbPath: 'data/sessions.db',
      botToken: env.TELEGRAM_BOT_TOKEN,
      logLevel: process.env.LOG_LEVEL || 'INFO',
    })
  }

  function initSchedWorker() {
    if (cleanup) return
    if (schedWorker) {
      try { schedWorker.terminate() } catch { /* ignore */ }
    }

    if (schedRetryCount > 0) {
      log.warn(`Starting scheduler worker — attempt ${schedRetryCount + 1}/${SCHED_MAX_RETRIES + 1}`)
    }
    if (schedRetryCount > SCHED_MAX_RETRIES) {
      log.error(`Scheduler worker failed after ${SCHED_MAX_RETRIES + 1} attempts — giving up`)
      return
    }

    schedWorker = new Worker(new URL('./scheduler-worker.ts', import.meta.url))

    schedWorker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (cleanup) return
      const msg = event.data

      if (msg.type === 'ready') {
        schedRetryCount = 0
        const pending = jobStore.getActiveCount()
        log.info(`Scheduler worker ready (${pending} active jobs)`)
        return
      }

      if (msg.type === 'task-reminder') {
        const task = (msg as any).task
        log.info(`task-reminder: task #${task.id} job #${task.jobId} -> ai-worker`)
        aiWorker?.postMessage({ type: 'process', task })
        return
      }
    }

    schedWorker.onerror = (err: ErrorEvent) => {
      log.error(`Scheduler worker crashed: ${err.message}`)
      schedRetryCount++
      if (!cleanup && schedRetryCount <= SCHED_MAX_RETRIES) {
        log.warn(`Restarting scheduler worker in ${SCHED_RETRY_DELAY_MS}ms (attempt ${schedRetryCount}/${SCHED_MAX_RETRIES})`)
        setTimeout(initSchedWorker, SCHED_RETRY_DELAY_MS)
      } else if (!cleanup) {
        log.error(`Scheduler worker restart limit reached (${SCHED_MAX_RETRIES}) — no more retries`)
      }
    }

    schedWorker.postMessage({
      type: 'init',
      dbPath: 'data/sessions.db',
      botToken: env.TELEGRAM_BOT_TOKEN,
      logLevel: process.env.LOG_LEVEL || 'INFO',
    })
  }

  spawnAiWorker()
  initSchedWorker()

  return () => {
    cleanup = true
    log.info('Stopping workers')
    if (aiWorker) { aiWorker.terminate(); aiWorker = null }
    if (schedWorker) { schedWorker.terminate(); schedWorker = null }
  }
}
