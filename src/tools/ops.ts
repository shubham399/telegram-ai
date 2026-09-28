import { z } from 'zod'
import { maskUserId } from '../pii'
import { router } from '../model-router'
import type { CustomToolDef, ToolContext } from '../tool-def'

export const toolName = 'ops'
export const adminOnly = true
export const needsUsageLedger = true

export function createTool(ctx: ToolContext): CustomToolDef {
  const { usageLedger, maintenance } = ctx

  return {
    description:
      'Operational health: database size, token spend per model and per user, fallback usage, ' +
      'and the active model. Admin only.',
    parameters: z.object({
      action: z.enum(['summary', 'users', 'db', 'model', 'maintenance']),
      days: z.number().int().min(1).max(365).optional().describe('Window in days. Defaults to 30.'),
    }),
    execute: async ({ action, days }) => {
      const window = days ?? 30

      switch (action) {
        case 'model':
          return `Active model: ${router.activeModel}${router.usingFallback ? ' (FALLBACK)' : ''}`

        case 'db': {
          if (!maintenance) return 'maintenance is not available'
          const s = maintenance.stats()
          return [
            `Database: ${s.sizeMb} MB (${s.pageCount} pages @ ${s.pageSize} B)`,
            `WAL: ${s.walMb} MB`,
            `Free pages: ${s.freelist}`,
          ].join('\n')
        }

        case 'maintenance': {
          if (!maintenance) return 'maintenance is not available'
          // Forced: the admin asked.
          const r = maintenance.run(true)
          return [
            `Removed ${r.conversation} conversation, ${r.usage} usage, ${r.sessions} session row(s)`,
            `VACUUM: ${r.vacuumed ? 'ran' : 'skipped'}`,
          ].join('\n')
        }

        case 'users': {
          const rows = usageLedger!.byUser(window, 20)
          if (rows.length === 0) return `no usage in the last ${window} day(s)`
          return rows
            .map(r => `${maskUserId(r.entityId)} — ${r.calls} call(s), ${r.totalTokens} tokens`)
            .join('\n')
        }

        case 'summary':
        default: {
          const s = usageLedger!.summary(null, window)
          const mine = usageLedger!.summary(ctx.entityId, window)
          const models = Object.entries(s.byModel)
            .map(([m, v]) => `  ${m}: ${v.calls} call(s), ${v.totalTokens} tokens`)
            .join('\n')
          return [
            `Last ${window} day(s) — all users`,
            `  calls: ${s.calls}`,
            `  prompt tokens: ${s.promptTokens}`,
            `  completion tokens: ${s.completionTokens}`,
            `  total tokens: ${s.totalTokens}`,
            models || '  (no calls)',
            '',
            `You: ${mine.calls} call(s), ${mine.totalTokens} tokens`,
            `Active model: ${router.activeModel}${router.usingFallback ? ' (FALLBACK)' : ''}`,
          ].join('\n')
        }
      }
    },
  }
}
