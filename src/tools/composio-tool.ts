import { z } from 'zod'
import { Logger } from '../logger'
import type { CustomToolDef, ToolContext } from '../tool-def'

const log = new Logger('tool:composio')

export const toolName = 'composio'

export function createTool(ctx: ToolContext): CustomToolDef | null {
  const session = ctx.composioSession
  if (!session) return null

  return {
    description: 'External Connected to multiple services like Gmail, Google Calendar, GitHub, and many more connections. Two actions: search (find available tools + their slugs for a query), execute (run a tool by slug with args). ALWAYS search first to find the right tool slug, then execute it.',
    parameters: z.object({
      action: z.enum(['search', 'execute']).describe('search = find tools matching query, execute = run a tool by slug with args'),
      query: z.string().optional().describe('For search: what kind of tool you need (e.g. "google calendar events", "gmail inbox")'),
      tool: z.string().optional().describe('For execute: the tool slug from search results (e.g. GOOGLECALENDAR_FIND_EVENTS)'),
      args: z.record(z.any()).optional().describe('For execute: tool-specific arguments as JSON object'),
    }),
    execute: async ({ action, query, tool, args }) => {
      if (action === 'search') {
        if (!query) return 'query required for search'
        log.info(`tool composio: search query="${query}"`)
        try {
          const res = await session.search({ query })
          if (!res.success) return `Search error: ${res.error ?? 'unknown error'}`
          if (res.results.length === 0) {
            const connected = res.toolkitConnectionStatuses.filter((t: any) => t.hasActiveConnection)
            if (connected.length > 0) {
              const apps = connected.map((t: any) => t.toolkit).join(', ')
              return `No tools found for "${query}". Connected apps: ${apps}. Try a different query.`
            }
            return `No tools found for "${query}" and no connected apps found. Ask user to connect apps first.`
          }
          const lines: string[] = []
          for (const r of res.results) {
            const slugs = [...r.primaryToolSlugs, ...r.relatedToolSlugs]
            for (const slug of slugs) {
              const schema = res.toolSchemas[slug]
              if (schema) {
                lines.push(`• ${slug}: ${schema.description ?? schema.toolkit}${schema.inputSchema ? ` (needs input)` : ''}`)
              } else {
                lines.push(`• ${slug}`)
              }
            }
            if (r.executionGuidance) lines.push(`  → ${r.executionGuidance}`)
          }
          if (res.nextStepsGuidance?.length) {
            lines.push('')
            lines.push(`💡 ${res.nextStepsGuidance[0]}`)
          }
          lines.push('')
          lines.push('Call composio with action=execute, tool=SLUG, args={...}')
          return lines.join('\n')
        } catch (err: any) {
          log.error(`tool composio: search failed: ${err.message}`)
          return `Search failed: ${err.message}`
        }
      } else if (action === 'execute') {
        if (!tool) return 'tool slug required for execute'
        log.info(`tool composio: execute tool="${tool}" args=${JSON.stringify(args ?? {})}`)
        try {
          const result = await session.execute(tool, args ?? {})
          const data = typeof result === 'object' && result !== null ? (result as any).data ?? result : result
          log.info(`tool composio: execute result received`)
          return typeof data === 'string' ? data : JSON.stringify(data, null, 2)
        } catch (err: any) {
          log.error(`tool composio: execute failed: ${err.message}`)
          return `Execute failed: ${err.message}. Try searching first to find the correct tool slug and parameters.`
        }
      }
      return 'invalid action — use search or execute'
    },
  }
}
