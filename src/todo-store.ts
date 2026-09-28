/**
 * The user's todo list.
 *
 * Separate from `TaskStore`, which is the scheduler's own queue. These are things
 * the user asked to be reminded about in their own words, with no schedule attached.
 */
import { type Database } from 'bun:sqlite'
import { Logger } from './logger'

const log = new Logger('todo-store')

export type TodoStatus = 'open' | 'done'

export interface Todo {
  id: number
  task: string
  status: TodoStatus
  dueAt: string | null
  createdAt: string
  updatedAt: string
}

interface Row {
  id: number
  task: string
  status: string
  due_at: string | null
  created_at: string
  updated_at: string
}

const toTodo = (r: Row): Todo => ({
  id: r.id,
  task: r.task,
  status: r.status as TodoStatus,
  dueAt: r.due_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class TodoStore {
  constructor(private db: Database) {
    log.info('Todo store ready')
  }

  add(entityId: string, task: string, dueAt?: string): Todo {
    const now = new Date().toISOString()
    const result = this.db.run(
      `INSERT INTO todos (entity_id, task, status, due_at, created_at, updated_at)
       VALUES (?, ?, 'open', ?, ?, ?)`,
      [entityId, task, dueAt ?? null, now, now],
    )
    return this.get(entityId, Number(result.lastInsertRowid))!
  }

  get(entityId: string, id: number): Todo | null {
    const row = this.db
      .query('SELECT * FROM todos WHERE entity_id = ? AND id = ?')
      .get(entityId, id) as Row | undefined
    return row ? toTodo(row) : null
  }

  list(entityId: string, status?: TodoStatus): Todo[] {
    const rows = status
      ? (this.db
          .query('SELECT * FROM todos WHERE entity_id = ? AND status = ? ORDER BY id DESC')
          .all(entityId, status) as Row[])
      : (this.db.query('SELECT * FROM todos WHERE entity_id = ? ORDER BY id DESC').all(entityId) as Row[])
    return rows.map(toTodo)
  }

  complete(entityId: string, id: number): Todo | null {
    const current = this.get(entityId, id)
    if (!current) return null
    this.db.run('UPDATE todos SET status = ?, updated_at = ? WHERE entity_id = ? AND id = ?', [
      current.status === 'done' ? 'open' : 'done',
      new Date().toISOString(),
      entityId,
      id,
    ])
    return this.get(entityId, id)
  }

  remove(entityId: string, id: number): boolean {
    return this.db.run('DELETE FROM todos WHERE entity_id = ? AND id = ?', [entityId, id]).changes > 0
  }
}
