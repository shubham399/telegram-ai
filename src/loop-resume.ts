/**
 * Boot-time recovery of agent runs that were mid-flight when the process stopped.
 *
 * Single-responsibility: find interrupted loops, finish them, tell the user.
 * Reuses the scheduler's chunked sender, so delivery needs no Telegram Context and
 * an interrupted run still answers the user after a restart.
 */
import { Logger } from './logger'
import { maskUserId } from './pii'
import { processUserMessage, type CheckpointHooks } from './ai'
import type { LoopStore } from './loop-store'
import type { SessionStore } from './session-store'
import type { MemoryStore } from './memory-store'
import type { JobStore } from './job-store'
import { agents } from './agents'

const log = new Logger('loop-resume')

/** A run older than this is not worth resuming — the user has moved on. */
const MAX_AGE_HOURS = 6

export interface ResumeDeps {
  loopStore: LoopStore
  sessionStore: SessionStore
  memoryStore?: MemoryStore
  jobStore?: JobStore
  send: (userId: string, text: string) => Promise<boolean>
}

export async function resumeActiveLoops(deps: ResumeDeps): Promise<number> {
  const { loopStore, sessionStore, memoryStore, jobStore, send } = deps

  const stale = loopStore.findResumable().filter(loop => {
    const ageHours = (Date.now() - new Date(loop.updatedAt).getTime()) / 3_600_000
    if (ageHours > MAX_AGE_HOURS) {
      log.info(`Loop ${loop.id} is ${ageHours.toFixed(1)}h old — abandoning rather than resuming`)
      loopStore.finish(loop.id, 'abandoned')
      return false
    }
    return true
  })

  if (stale.length === 0) {
    log.info('No interrupted runs to resume')
    loopStore.prune()
    return 0
  }

  log.warn(`Resuming ${stale.length} interrupted run(s)`)

  for (const loop of stale) {
    const checkpoint = loopStore.latest(loop.id)
    if (!checkpoint || checkpoint.step === 0) {
      log.warn(`Loop ${loop.id} has no usable checkpoint — marking failed`)
      loopStore.finish(loop.id, 'failed')
      continue
    }

    try {
      const sessionRow = sessionStore.get(loop.entityId, 10 * 60 * 1000)
      const hooks: CheckpointHooks = {
        resume: checkpoint,
        // Still checkpoint: this resume can crash too.
        onStep: (step, messages) => loopStore.record(loop.id, step, messages),
      }

      const result = await processUserMessage({
        messages: checkpoint.messages,
        entityId: loop.entityId,
        existingSessionId: sessionRow?.composioSessionId ?? null,
        agentName: agents.has(loop.scope.agentName) ? loop.scope.agentName : 'default',
        memoryStore,
        jobStore,
        checkpoint: hooks,
        onToolCall: () => {},
        onToolResult: () => {},
      })

      if (result.text) {
        await send(loop.entityId, `Resumed after a restart:\n\n${result.text}`)
      }
      sessionStore.upsert(loop.entityId, result.composioSessionId)
      loopStore.finish(loop.id, 'done')
      log.info(`Loop ${loop.id} for ${maskUserId(loop.entityId)} resumed and delivered`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Loop ${loop.id} resume failed: ${message}`)
      loopStore.finish(loop.id, 'failed')
    }
  }

  loopStore.prune()
  return stale.length
}
