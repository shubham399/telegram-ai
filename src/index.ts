/**
 * Composition root. Everything is constructed here and injected downward —
 * no module reaches for a global.
 */
import { Logger } from './logger'
import { getDb, closeDb } from './db'
import { SessionStore } from './session-store'
import { MemoryStore } from './memory-store'
import { ConversationStore } from './conversation-store'
import { JobStore } from './job-store'
import { TaskStore } from './task-store'
import { UserState } from './user-state'
import { LoopStore } from './loop-store'
import { resumeActiveLoops } from './loop-resume'
import { NoteStore } from './note-store'
import { TodoStore } from './todo-store'
import { UsageLedger } from './usage-ledger'
import { Maintenance } from './maintenance'
import { createBot } from './bot'
import { startScheduler } from './scheduler'
import { createTaskRunner } from './task-runner'
import { sendTelegram } from './send'


const log = new Logger('main')

const LAUNCH_MAX_RETRIES = 5
const LAUNCH_BASE_DELAY_MS = 2000

const db = getDb()
const sessionStore = new SessionStore(db)
const memoryStore = new MemoryStore(db)
const conversationStore = new ConversationStore(db)
const jobStore = new JobStore(db)
const taskStore = new TaskStore(db)
const userState = new UserState(db)
const loopStore = new LoopStore(db)
const noteStore = new NoteStore(db)
const todoStore = new TodoStore(db)
const usageLedger = new UsageLedger(db)
const maintenance = new Maintenance(db, { conversationRetentionDays: 30, usageRetentionDays: 90 })

const bot = createBot({
  sessionStore,
  conversationStore,
  userState,
  loopStore,
  noteStore,
  todoStore,
  usageLedger,
  maintenance,
  memoryStore,
  jobStore,
})

const scheduler = startScheduler({
  jobStore,
  taskStore,
  send: sendTelegram,
  maintain: () => maintenance.run(false),
  runTask: createTaskRunner({ sessionStore, memoryStore, jobStore, taskStore, noteStore, todoStore, usageLedger, maintenance, send: sendTelegram }),
})

async function startBot() {
  for (let attempt = 1; attempt <= LAUNCH_MAX_RETRIES; attempt++) {
    try {
      log.info('Starting bot in polling mode')
      // ponytail: set Online before launch so it's visible immediately
      await bot.telegram
        .callApi('setMyShortDescription', { short_description: '🟢 Online' })
        .catch(e => log.warn(`setMyShortDescription failed: ${e}`))
      await bot.launch()
      log.info('Bot launched successfully')
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const is409 = msg.includes('409') || msg.includes('Conflict')
      if (is409 && attempt < LAUNCH_MAX_RETRIES) {
        const delay = LAUNCH_BASE_DELAY_MS * 2 ** (attempt - 1)
        log.warn(`409 Conflict on launch (attempt ${attempt}/${LAUNCH_MAX_RETRIES}), retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      log.error(`Failed to launch bot: ${msg}`)
      throw err
    }
  }
}

let shuttingDown = false
function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`Received ${signal}, shutting down`)
  scheduler.stop()
  // Truncate the WAL on the way out so the next boot starts from a small file.
  try {
    maintenance.run(false)
  } catch (err) {
    log.warn(`Shutdown maintenance failed: ${err}`)
  }
  // bot.stop() tears down the long-poll loop; give it a beat before dropping
  // the SQLite connection out from under any in-flight store call.
  try {
    bot.stop(signal)
  } catch (err) {
    log.warn(`bot.stop failed: ${err}`)
  }
  setTimeout(() => {
    closeDb()
    process.exit(0)
  }, 500)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

startBot()
  .then(async () => {
    // Only after the bot is polling, so a resumed reply cannot race a fresh
    // request from the same user.
    const resumed = await resumeActiveLoops({
      loopStore,
      sessionStore,
      memoryStore,
      jobStore,
      send: sendTelegram,
    }).catch(err => {
      // Recovery is best-effort: a failure here must not take the bot down.
      log.error(`Loop recovery failed: ${err instanceof Error ? err.message : err}`)
      return 0
    })
    if (resumed > 0) log.info(`Recovered ${resumed} interrupted run(s)`)
  })
  .catch(err => {
    log.error(`Bot startup failed: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
