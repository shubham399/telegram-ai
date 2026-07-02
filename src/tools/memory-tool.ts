import { z } from 'zod'
import { Logger } from '../logger'
import { maskPii } from '../pii'
import type { CustomToolDef, ToolContext } from '../tool-def'

const log = new Logger('tool:memory')

export const toolName = 'memory'
export const needsMemory = true

export function createTool(ctx: ToolContext): CustomToolDef {
  const { entityId, memoryStore } = ctx
  return {
    description: 'Remember or retrieve information about the current user. Use for names, preferences, facts, and anything the user should not have to repeat. "list" action returns all stored keys and values.',
    parameters: z.object({
      action: z.enum(['get', 'set', 'delete', 'list']),
      key: z.string().optional().describe('Key to get/set/delete. Required for get/set/delete.'),
      value: z.string().optional().describe('Value to store. Required for set.'),
    }),
    execute: async ({ action, key, value }) => {
      log.info(`tool memory: action=${action} key=${key ?? '-'} value=${value !== undefined ? maskPii(String(value)) : '-'}`)
      switch (action) {
        case 'get': {
          if (!key) return 'key required for get'
          const val = memoryStore!.get(entityId, key)
          return val ?? `no memory for key "${key}"`
        }
        case 'set': {
          if (!key || value === undefined) return 'key and value required for set'
          memoryStore!.set(entityId, key, value)
          return `stored "${key}" = "${value}"`
        }
        case 'delete': {
          if (!key) return 'key required for delete'
          memoryStore!.delete(entityId, key)
          return `deleted "${key}"`
        }
        case 'list': {
          const all = memoryStore!.list(entityId)
          const entries = Object.entries(all)
          if (entries.length === 0) return 'no stored memory'
          return entries.map(([k, v]) => `${k}: ${v}`).join('\n')
        }
      }
    },
  }
}
