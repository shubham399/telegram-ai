import { z } from 'zod'
import { Logger } from '../logger'
import { maskPii } from '../pii'
import type { CustomToolDef, ToolContext } from '../tool-def'

const log = new Logger('tool:todo')

export const toolName = 'todo'
export const needsTodos = true

export function createTool(ctx: ToolContext): CustomToolDef {
  const { entityId, todoStore } = ctx
  return {
    description:
      "Track the user's own to-do list: add items, list them, tick them off, or delete them. " +
      'This is a plain list, not a schedule — to get reminded at a time, create a scheduled job instead.',
    parameters: z.object({
      action: z.enum(['add', 'list', 'complete', 'delete']),
      id: z.number().int().optional().describe('Todo id. Required for complete/delete.'),
      task: z.string().optional().describe('What needs doing. Required for add.'),
      due: z.string().optional().describe('Optional ISO-8601 due date for add.'),
      status: z.enum(['open', 'done', 'all']).optional().describe('Filter for list. Defaults to all.'),
    }),
    execute: async ({ action, id, task, due, status }) => {
      const store = todoStore!
      switch (action) {
        case 'add': {
          if (!task) return 'task is required to add a todo'
          const todo = store.add(entityId, task, due)
          log.info(`tool todo: added #${todo.id} "${maskPii(task).slice(0, 60)}"`)
          return `Added to-do #${todo.id}: ${task}`
        }
        case 'list': {
          const todos = store.list(entityId, status === 'all' ? undefined : status)
          if (todos.length === 0) return 'the to-do list is empty'
          return todos
            .map(t => `#${t.id} [${t.status}] ${t.task}${t.dueAt ? ` (due ${t.dueAt})` : ''}`)
            .join('\n')
        }
        case 'complete': {
          if (!id) return 'id is required'
          const todo = store.complete(entityId, id)
          if (!todo) return `no to-do with id ${id}`
          return todo.status === 'done' ? `Completed #${id}: ${todo.task}` : `Reopened #${id}: ${todo.task}`
        }
        case 'delete': {
          if (!id) return 'id is required'
          return store.remove(entityId, id) ? `Deleted to-do #${id}` : `no to-do with id ${id}`
        }
      }
    },
  }
}
