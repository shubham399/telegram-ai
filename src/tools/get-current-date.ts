import { z } from 'zod'
import type { CustomToolDef, ToolContext } from '../tool-def'

export const toolName = 'get_current_date'

/**
 * The deployment's reference timezone. IST is what the existing prompt and
 * scheduling regexes assume, so this stays consistent with them rather than
 * following the server's clock.
 */
const TZ = 'Asia/Kolkata'
const TZ_OFFSET_MS = 5.5 * 3600 * 1000

export function createTool(_ctx: ToolContext): CustomToolDef {
  return {
    description: `Get the current date and time in ${TZ}. Use this whenever a date is relative — "today", "tomorrow", "next Friday" — instead of guessing.`,
    parameters: z.object({
      format: z.enum(['iso', 'readable', 'parts']).optional().describe('Output shape. Defaults to readable.'),
    }),
    execute: async ({ format }) => {
      const now = new Date(Date.now() + TZ_OFFSET_MS)
      const iso = now.toISOString()
      if (format === 'iso') return iso
      if (format === 'parts') {
        return JSON.stringify({
          date: iso.slice(0, 10),
          time: `${iso.slice(11, 16)}`,
          weekday: now.toUTCString().slice(0, 3),
          timezone: TZ,
          timestampMs: Date.now(),
        })
      }
      return `${now.toUTCString().slice(0, 16)} ${TZ} (${iso})`
    },
  }
}
