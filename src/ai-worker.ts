import { Logger } from './logger'
import { processUserMessage } from './ai'
import { SessionStore } from './session-store'
import { MemoryStore } from './memory-store'
import { JobStore } from './job-store'
import { TaskStore, type Task } from './task-store'
import type { ModelMessage } from 'ai'

const level = (typeof process !== 'undefined' && process.env.LOG_LEVEL) || 'INFO'
const log = new Logger('ai-worker', level as any)

let botToken: string
let sessionStore: SessionStore
let memoryStore: MemoryStore
let jobStore: JobStore
let taskStore: TaskStore

const MAX_TG_MSG = 4096

async function sendTelegramChunk(chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    log.warn(`Telegram API ${res.status}: ${body}`)
  }
}

async function sendTelegram(chatId: string, text: string): Promise<void> {
  if (text.length <= MAX_TG_MSG) {
    return sendTelegramChunk(chatId, text)
  }
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= MAX_TG_MSG) {
      await sendTelegramChunk(chatId, remaining)
      break
    }
    const slice = remaining.slice(0, MAX_TG_MSG)
    const lastNl = slice.lastIndexOf('\n', MAX_TG_MSG - 1)
    const cutAt = lastNl > MAX_TG_MSG - 300 ? lastNl + 1 : MAX_TG_MSG
    await sendTelegramChunk(chatId, remaining.slice(0, cutAt))
    remaining = remaining.slice(cutAt)
  }
}

async function processTask(task: Task): Promise<void> {
  let current = task

  while (true) {
    taskStore.setInProgress(current.id)
    log.info(`task #${current.id}: attempt ${current.retryCount + 1}/${current.maxRetries} — INPROGRESS`)

    let deliveryText: string
    try {
      const existingRow = sessionStore.get(current.telegramUserId, Infinity)
      const existingSessionId = existingRow?.composioSessionId ?? null
      log.info(`task #${current.id}: session=${existingSessionId ?? 'new'}`)

      const messages: ModelMessage[] = [{ role: 'user', content: `[SCHEDULED TASK — execute this now, do not create a new schedule]\n${current.taskText}` }]
      const result = await processUserMessage(
        messages, current.telegramUserId, existingSessionId,
        () => {}, () => {},
        undefined, memoryStore, undefined,
      )
      deliveryText = result.text || 'Done.'
      log.info(`task #${current.id}: AI done ${result.totalSteps} steps finish=${result.finishReason}`)

      taskStore.setSuccess(current.id, deliveryText)
      sessionStore.upsert(current.telegramUserId, result.composioSessionId)
      jobStore.afterRun(current.jobId)
    } catch (err) {
      log.error(`task #${current.id}: attempt ${current.retryCount + 1} failed: ${err}`)
      taskStore.setFailed(current.id, String(err))

      const nextCount = current.retryCount + 1
      if (nextCount < current.maxRetries) {
        current = taskStore.createRetry(current.id)!
        log.warn(`task #${current.id}: retry #${nextCount}/${current.maxRetries - 1} created as task #${current.id}`)
        continue
      } else {
        log.error(`task #${current.id}: all ${current.maxRetries} attempts exhausted`)
        jobStore.afterRun(current.jobId)
        await sendTelegram(
          current.telegramUserId,
          `⚠️ Scheduled task failed after ${current.maxRetries} attempts: ${err instanceof Error ? err.message : 'Unknown error'}`,
        )
        self.postMessage({ type: 'failed', taskId: task.id })
        return
      }
    }

    // AI succeeded — Telegram delivery is best-effort, errors here don't re-run AI
    await sendTelegram(current.telegramUserId, `⏰ Scheduled: ${current.taskText}\n\n${deliveryText}`)
    log.info(`task #${current.id}: Telegram sent OK`)
    self.postMessage({ type: 'completed', taskId: task.id })
    log.info(`task #${current.id}: complete`)
    return
  }
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data

  if (msg.type === 'init') {
    const dbPath = (msg as any).dbPath
    botToken = (msg as any).botToken
    sessionStore = new SessionStore(dbPath)
    memoryStore = new MemoryStore(sessionStore.db)
    jobStore = new JobStore(sessionStore.db)
    taskStore = new TaskStore(sessionStore.db)
    const activeCount = jobStore.getActiveCount()
    log.info(`AI worker initialized (${activeCount} active jobs)`)
    self.postMessage({ type: 'ready' })
    return
  }

  if (msg.type === 'process') {
    const task = (msg as any).task
    log.info(`process: task #${task.id} job #${task.jobId} user=${task.telegramUserId} attempt=${task.retryCount + 1} task="${task.taskText}"`)
    await processTask(task)
    return
  }
}
