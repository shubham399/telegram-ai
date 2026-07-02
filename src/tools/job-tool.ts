import { z } from 'zod'
import { Logger } from '../logger'
import type { CustomToolDef, ToolContext } from '../tool-def'

const log = new Logger('tool:job')

export const toolName = 'createScheduledJob'
export const needsJobStore = true

const IST_OFFSET = 5.5 * 3600 * 1000
const nowIST = () => {
  const d = new Date(Date.now() + IST_OFFSET)
  return { h: d.getUTCHours(), m: d.getUTCMinutes() }
}
const fmtIST = (h: number, m: number) =>
  `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

export function createTool(ctx: ToolContext): CustomToolDef {
  const { entityId, jobStore } = ctx
  let jobCreated = false

  return {
    description: 'Manage scheduled jobs — create, list, or cancel. All times IST (UTC+5:30). Call ONCE per request — tool will reject duplicates.',
    parameters: z.object({
      action: z.enum(['create', 'list', 'cancel']).describe('create = schedule new job, list = show active jobs, cancel = remove by jobId or task text'),
      task: z.string().optional().describe('For create: what to do at scheduled time. For cancel: text to match against existing jobs (supports partial match). Use task OR jobId, not both.'),
      jobId: z.number().int().positive().optional().describe('For cancel: cancel job by ID (e.g. 3). Use task OR jobId, not both.'),
      scheduleType: z.enum(['once', 'daily', 'weekdays', 'weekly']).optional().describe('Required for create. once = single, daily = every day, weekdays = Mon-Fri, weekly = specific day'),
      time: z.string().optional().describe('Required for create unless offset_minutes is set. Time in IST, 24h HH:MM (e.g. "09:00", "18:30").'),
      offset_minutes: z.number().int().positive().optional().describe('Alternative to time: minutes from now. Use for "in 2 min", "in 1 hour", "in 30 min". Tool computes target HH:MM internally. Do not use with time.'),
      dayOfWeek: z.string().optional().describe('Required if scheduleType=weekly. Day name in English (e.g. "monday"). Ignored otherwise.'),
      needsAi: z.boolean().optional().describe('Set true if task needs AI tool execution (e.g. "check email", "summarize", "generate report"). Omit or false for simple text reminders.'),
    }),
    execute: async ({ action, task, jobId, scheduleType, time, offset_minutes, dayOfWeek, needsAi }) => {
      if (action === 'list') {
        log.info(`tool createScheduledJob: action=list`)
        const jobs = jobStore!.listByUser(entityId)
        if (jobs.length === 0) return 'No active scheduled jobs.'
        return jobs.map(j => `#${j.id} — ${j.scheduleType} at ${j.hour.toString().padStart(2, '0')}:${j.minute.toString().padStart(2, '0')} IST — "${j.task}"`).join('\n')
      }
      if (action === 'cancel') {
        if (jobId) {
          log.info(`tool createScheduledJob: action=cancel jobId=${jobId}`)
          const result = jobStore!.cancelById(jobId, entityId)
          return result ?? 'No matching job found.'
        }
        if (!task) return 'Task text or jobId required for cancellation.'
        log.info(`tool createScheduledJob: action=cancel task="${task}"`)
        const result = jobStore!.cancelByTask(entityId, task)
        return result ?? 'No matching job found.'
      }
      if (jobCreated) {
        log.warn(`tool createScheduledJob: duplicate create blocked for entity ${entityId}`)
        return 'Already scheduled. Tell user it\'s done — no more tool calls needed.'
      }
      if (!task || !scheduleType) return 'task, scheduleType required for create.'
      if (!time && offset_minutes == null) return 'time or offset_minutes required for create.'
      let hour: number, minute: number
      if (time) {
        ;[hour, minute] = time.split(':').map(Number)
        log.info(`tool createScheduledJob: action=create task="${task}" type=${scheduleType} time=${time} hour=${hour} min=${minute} needsAi=${needsAi}`)
      } else {
        const { h, m } = nowIST()
        const totalMin = h * 60 + m + Math.max(1, Math.floor(offset_minutes!))
        hour = Math.floor(totalMin / 60) % 24
        minute = totalMin % 60
        log.info(`tool createScheduledJob: action=create task="${task}" type=${scheduleType} offset=${offset_minutes}min -> ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST needsAi=${needsAi}`)
      }
      const dowMap: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
      const dayOfWeekNum = dayOfWeek ? dowMap[dayOfWeek.toLowerCase()] : undefined
      const result = jobStore!.create(entityId, task, scheduleType, hour, minute, dayOfWeekNum, needsAi)
      log.info(`tool createScheduledJob result: ${result}`)
      jobCreated = true
      return result
    },
  }
}
