import { Logger } from './logger'
import { SessionStore } from './session-store'
import { MemoryStore } from './memory-store'
import { ConversationStore } from './conversation-store'
import { JobStore } from './job-store'
import { createBot } from './bot'

const log = new Logger('main')

const sessionStore = new SessionStore('data/sessions.db')
const memoryStore = new MemoryStore(sessionStore.db)
const conversationStore = new ConversationStore(sessionStore.db)
const jobStore = new JobStore(sessionStore.db)
const bot = createBot(sessionStore, conversationStore, memoryStore, jobStore)

const LAUNCH_MAX_RETRIES = 5
const LAUNCH_BASE_DELAY_MS = 2000

async function startBot() {
  for (let attempt = 1; attempt <= LAUNCH_MAX_RETRIES; attempt++) {
    try {
      log.info('Starting bot in polling mode')
      // ponytail: set Online before launch so it's visible immediately
      await bot.telegram.callApi('setMyShortDescription', { short_description: '🟢 Online' })
        .catch(e => log.warn(`setMyShortDescription failed: ${e}`))
      await bot.launch()
      log.info('Bot launched successfully')
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const is409 = msg.includes('409') || msg.includes('Conflict')
      if (is409 && attempt < LAUNCH_MAX_RETRIES) {
        const delay = LAUNCH_BASE_DELAY_MS * Math.pow(2, attempt - 1)
        log.warn(`409 Conflict on launch (attempt ${attempt}/${LAUNCH_MAX_RETRIES}), retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      log.error(`Failed to launch bot: ${msg}`)
      throw err
    }
  }
}

startBot().catch(err => {
  log.error(`Bot startup failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})

function shutdown(signal: string) {
  log.info(`Received ${signal}, stopping bot`)
  bot.stop(signal)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
