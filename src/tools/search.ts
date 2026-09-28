import { z } from 'zod'
import { Logger } from '../logger'
import type { CustomToolDef, ToolContext } from '../tool-def'

const log = new Logger('tool:search')

export const toolName = 'search'
export const needsMaintenance = true

export function createTool(ctx: ToolContext): CustomToolDef {
  return {
    description:
      'Search the user\'s own past conversation history for something they said earlier. ' +
      'Use this when they refer to something "we said earlier" or "that thing you told me". ' +
      'For searching the live web, use the web_search composio action instead.',
    parameters: z.object({
      query: z.string().min(2).describe('Words to look for in past messages.'),
      limit: z.number().int().min(1).max(25).optional().describe('Max results. Defaults to 5.'),
    }),
    execute: async ({ query, limit }) => {
      const hits = ctx.maintenance!.search(ctx.entityId, query, limit ?? 5)
      log.info(`tool search: "${query}" -> ${hits.length} hit(s)`)
      if (hits.length === 0) return `no past messages matching "${query}"`
      return hits
        .map((h, i) => {
          let content: string
          try {
            const parsed = JSON.parse(h.content)
            content = typeof parsed?.content === 'string' ? parsed.content : h.content
          } catch {
            content = h.content
          }
          const where = h.scope.agentName !== 'default' ? ` [${h.scope.agentName}]` : ''
          return `${i + 1}. ${h.createdAt.slice(0, 16)}${where}: ${content.replace(/\s+/g, ' ').slice(0, 200)}`
        })
        .join('\n')
    },
  }
}
