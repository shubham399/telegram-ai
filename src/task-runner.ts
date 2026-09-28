/**
 * Runs one scheduled task end to end: agent loop → persist → deliver.
 *
 * Single-responsibility: this is the only place that knows the sequence
 * "mark in-progress, call the model, record the outcome, notify the user".
 * The scheduler decides *when*; this module decides *how*.
 */
import { Logger } from './logger'
import { maskUserId } from './pii'
import { processUserMessage } from './ai'
import type { ConversationScope } from './conversation-store'
import type { SessionStore } from './session-store'
import type { MemoryStore } from './memory-store'
import type { JobStore } from './job-store'
import type { TaskStore, Task } from './task-store'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type { NoteStore } from './note-store'
import type { TodoStore } from './todo-store'
import type { UsageLedger } from './usage-ledger'
import type { Maintenance } from './maintenance'

const log = new Logger('task-runner')

export interface TaskRunnerDeps {
  sessionStore: SessionStore
  memoryStore: MemoryStore
  jobStore: JobStore
  taskStore: TaskStore
  noteStore: NoteStore
  todoStore: TodoStore
  usageLedger: UsageLedger
  maintenance: Maintenance
  send: (userId: string, text: string) => Promise<boolean>
}

export function createTaskRunner(deps: TaskRunnerDeps) {
  const { sessionStore, memoryStore, jobStore, taskStore, noteStore, todoStore, usageLedger, maintenance, send } = deps

  async function processTask(task: Task): Promise<void> {
    let current = task

    for (;;) {
      taskStore.setInProgress(current.id)
      const attempt = current.retryCount + 1
      log.info(`task #${current.id}: attempt ${attempt}/${current.maxRetries}`)

      let deliveryText: string
      try {
        const existingSessionId =
          sessionStore.get(current.telegramUserId, Infinity)?.composioSessionId ?? null

        const messages: ChatCompletionMessageParam[] = [
          {
            role: 'user',
            content: `[SCHEDULED TASK — execute this now, do not create a new schedule]\n${current.taskText}`,
          },
        ]

        // Scheduled runs use the default agent and their own session scope, so a
        // background job never reads or corrupts an interactive conversation.
        const scope: ConversationScope = {
          sessionId: `task-${current.id}`,
          agentName: 'default',
        }
        const result = await processUserMessage({
          messages,
          entityId: current.telegramUserId,
          existingSessionId,
          onToolCall: () => {},
          onToolResult: () => {},
          memoryStore,
          jobStore,
          noteStore,
          todoStore,
          usageLedger,
          maintenance,
        })
        deliveryText = result.text || 'Done.'
        log.info(`task #${current.id}: agent done in ${result.totalSteps} steps (finish=${result.finishReason})`)

        taskStore.setSuccess(current.id, deliveryText)
        sessionStore.upsert(current.telegramUserId, result.composioSessionId)
        jobStore.afterRun(current.jobId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error(`task #${current.id}: attempt ${attempt} failed: ${message}`)
        taskStore.setFailed(current.id, message)

        const retry = taskStore.createRetry(current.id)
        if (retry) {
          log.warn(`task #${current.id}: retry ${retry.retryCount + 1}/${current.maxRetries - 1} queued as #${retry.id}`)
          current = retry
          continue
        }

        log.error(`task #${current.id}: retries exhausted`)
        // Don't leave a recurring job wedged in a "due" state forever.
        jobStore.afterRun(current.jobId)
        await send(
          current.telegramUserId,
          `⚠️ Scheduled task failed after ${current.maxRetries} attempts: ${message}`,
        )
        return
      }

      // Delivery is best-effort: the AI already ran, so a Telegram outage must
      // not burn a retry (and therefore money) re-running the whole task.
      await send(
        current.telegramUserId,
        `⏰ Scheduled: ${current.taskText}\n\n${deliveryText}`,
      )
      log.info(`task #${current.id}: complete`)
      return
    }
  }

  return processTask
}
