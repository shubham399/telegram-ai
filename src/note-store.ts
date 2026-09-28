/**
 * User notes: short durable text the user asked to be kept.
 *
 * Distinct from `MemoryStore`, which is a key/value bag injected into the system
 * prompt. Notes are user-visible, unbounded, and searchable, so they stay out of
 * the prompt until asked for.
 */
import { type Database } from 'bun:sqlite'
import { Logger } from './logger'

const log = new Logger('note-store')

export interface Note {
  id: number
  title: string
  body: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

interface Row {
  id: number
  title: string
  body: string
  tags: string
  created_at: string
  updated_at: string
}

const toNote = (r: Row): Note => ({
  id: r.id,
  title: r.title,
  body: r.body,
  tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class NoteStore {
  constructor(private db: Database) {
    log.info('Note store ready')
  }

  add(entityId: string, body: string, title = '', tags: string[] = []): Note {
    const now = new Date().toISOString()
    const result = this.db.run(
      `INSERT INTO notes (entity_id, title, body, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entityId, title, body, tags.join(','), now, now],
    )
    return this.get(entityId, Number(result.lastInsertRowid))!
  }

  get(entityId: string, id: number): Note | null {
    const row = this.db
      .query('SELECT * FROM notes WHERE entity_id = ? AND id = ?')
      .get(entityId, id) as Row | undefined
    return row ? toNote(row) : null
  }

  list(entityId: string, limit = 20, tag?: string): Note[] {
    const rows = tag
      ? (this.db
          .query(
            `SELECT * FROM notes WHERE entity_id = ? AND ',' || tags || ',' LIKE ?
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(entityId, `%,${tag},%`, limit) as Row[])
      : (this.db
          .query('SELECT * FROM notes WHERE entity_id = ? ORDER BY updated_at DESC LIMIT ?')
          .all(entityId, limit) as Row[])
    return rows.map(toNote)
  }

  update(entityId: string, id: number, patch: { title?: string; body?: string; tags?: string[] }): Note | null {
    const current = this.get(entityId, id)
    if (!current) return null
    this.db.run(
      `UPDATE notes SET title = ?, body = ?, tags = ?, updated_at = ? WHERE entity_id = ? AND id = ?`,
      [
        patch.title ?? current.title,
        patch.body ?? current.body,
        (patch.tags ?? current.tags).join(','),
        new Date().toISOString(),
        entityId,
        id,
      ],
    )
    return this.get(entityId, id)
  }

  remove(entityId: string, id: number): boolean {
    return this.db.run('DELETE FROM notes WHERE entity_id = ? AND id = ?', [entityId, id]).changes > 0
  }

  search(entityId: string, query: string, limit = 10): Note[] {
    const rows = this.db
      .query(
        `SELECT * FROM notes WHERE entity_id = ? AND (title LIKE ? OR body LIKE ?)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(entityId, `%${query}%`, `%${query}%`, limit) as Row[]
    return rows.map(toNote)
  }
}
