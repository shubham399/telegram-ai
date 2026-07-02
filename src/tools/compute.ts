import { z } from 'zod'
import { Logger } from '../logger'
import type { CustomToolDef } from '../tool-def'

const log = new Logger('tool:compute')

export const toolName = 'compute'

const IST_OFFSET = 5.5 * 3600 * 1000
const nowIST = () => {
  const d = new Date(Date.now() + IST_OFFSET)
  return { h: d.getUTCHours(), m: d.getUTCMinutes() }
}
const fmtIST = (h: number, m: number) =>
  `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`

export function createTool(): CustomToolDef {
  return {
    description: 'Current IST time or time arithmetic. Use for relative time calculations instead of guessing. Supports day wrapping. Defaults to get_time when no action specified.',
    parameters: z.object({
      action: z.enum(['get_time', 'add_time']).optional().describe('get_time (default) returns current IST time. add_time adds minutes to a base time.'),
      time: z.string().optional().describe('For add_time: base time in HH:MM IST.'),
      amount: z.number().optional().describe('For add_time: minutes to add (positive integer).'),
    }),
    execute: async ({ action, time, amount }) => {
      log.info(`tool compute: action=${action ?? '(default get_time)'} time=${time ?? '-'} amount=${amount ?? '-'}`)
      const resolvedAction = action || 'get_time'
      if (resolvedAction === 'get_time') {
        const { h, m } = nowIST()
        const result = `Current IST time: ${fmtIST(h, m)}`
        log.info(`tool compute result: ${result}`)
        return result
      }
      if (resolvedAction === 'add_time') {
        if (!time || amount == null) return 'time and amount required'
        const [h, m] = time.split(':').map(Number)
        if (isNaN(h) || isNaN(m)) return `invalid time "${time}" — use HH:MM`
        const totalMin = h * 60 + m + Math.max(0, Math.floor(amount))
        const wrappedH = Math.floor(totalMin / 60) % 24
        const wrappedM = totalMin % 60
        const days = Math.floor(totalMin / 1440)
        const dayLabel = days === 0 ? '' : days === 1 ? ' (next day)' : ` (${days} days later)`
        const result = `${fmtIST(wrappedH, wrappedM)}${dayLabel}`
        log.info(`tool compute result: ${result}`)
        return result
      }
      return 'invalid action — use get_time or add_time'
    },
  }
}
