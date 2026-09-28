import { z } from 'zod'
import { Logger } from '../logger'
import { maskPii } from '../pii'
import type { CustomToolDef, ToolContext } from '../tool-def'

const log = new Logger('tool:note')

export const toolName = 'note'
export const needsNotes = true

export function createTool(ctx: ToolContext): CustomToolDef {
  const { entityId, noteStore } = ctx
  return {
    description:
      'Save a durable note the user asked you to keep, or read back their saved notes. ' +
      'Use for things worth remembering but too long for a memory key — excerpts, links, ' +
      'decisions, quotes. Prefer the memory tool for short facts.',
    parameters: z.object({
      action: z.enum(['add', 'list', 'get', 'update', 'delete', 'search']),
      id: z.number().int().optional().describe('Note id. Required for get/update/delete.'),
      title: z.string().optional().describe('Short label. Optional for add.'),
      body: z.string().optional().describe('Note text. Required for add.'),
      tags: z.array(z.string()).optional().describe('Tags for filtering.'),
      query: z.string().optional().describe('Search text, for the search action.'),
      tag: z.string().optional().describe('Filter by this tag, for the list action.'),
    }),
    execute: async ({ action, id, title, body, tags, query, tag }) => {
      const store = noteStore!
      switch (action) {
        case 'add': {
          if (!body) return 'body is required to add a note'
          const note = store.add(entityId, body, title ?? '', tags ?? [])
          log.info(`tool note: added #${note.id} "${maskPii(title || body).slice(0, 60)}"`)
          return `Saved note #${note.id}${note.title ? ` "${note.title}"` : ''}`
        }
        case 'list': {
          const notes = store.list(entityId, 20, tag)
          if (notes.length === 0) return 'no notes saved yet'
          return notes
            .map(n => `#${n.id}${n.title ? ` ${n.title}` : ''}${n.tags.length ? ` [${n.tags.join(',')}]` : ''} — ${n.body.slice(0, 120)}`)
            .join('\n')
        }
        case 'get': {
          if (!id) return 'id is required'
          const note = store.get(entityId, id)
          return note ? `#${note.id} ${note.title}\n${note.body}` : `no note with id ${id}`
        }
        case 'update': {
          if (!id) return 'id is required'
          const note = store.update(entityId, id, { title, body, tags })
          return note ? `Updated note #${id}` : `no note with id ${id}`
        }
        case 'delete': {
          if (!id) return 'id is required'
          return store.remove(entityId, id) ? `Deleted note #${id}` : `no note with id ${id}`
        }
        case 'search': {
          if (!query) return 'query is required'
          const notes = store.search(entityId, query)
          return notes.length === 0 ? `no notes matching "${query}"` : notes.map(n => `#${n.id} ${n.title || n.body.slice(0, 80)}`).join('\n')
        }
      }
    },
  }
}
