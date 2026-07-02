import { type Database } from 'bun:sqlite'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { Logger } from './logger'

export class ConversationStore {
  private log: Logger

  constructor(private db: Database) {
    this.log = new Logger('conversation-store')
  }

  append(userId: string, messages: ChatCompletionMessageParam[]): void {
    const now = new Date().toISOString()
    for (const m of messages) {
      this.db.run(
        'INSERT INTO conversation_messages (telegram_user_id, role, content, created_at) VALUES (?, ?, ?, ?)',
        [userId, m.role, JSON.stringify(m), now],
      )
    }
  }

  list(userId: string): ChatCompletionMessageParam[] {
    const rows = this.db
      .query('SELECT content FROM conversation_messages WHERE telegram_user_id = ? ORDER BY id')
      .all(userId) as { content: string }[]
    return rows.map(r => JSON.parse(r.content) as ChatCompletionMessageParam)
  }

  count(userId: string): number {
    const row = this.db
      .query('SELECT COUNT(*) AS c FROM conversation_messages WHERE telegram_user_id = ?')
      .get(userId) as { c: number }
    return row.c
  }

  compact(userId: string, keepLast: number, summaryText: string): void {
    const rows = this.db
      .query('SELECT id FROM conversation_messages WHERE telegram_user_id = ? ORDER BY id')
      .all(userId) as { id: number }[]
    const excess = rows.slice(0, Math.max(0, rows.length - keepLast))
    if (excess.length < 2) return

    const [first, second, ...rest] = excess
    const now = new Date().toISOString()
    this.db.run('UPDATE conversation_messages SET role = ?, content = ?, created_at = ? WHERE id = ?', [
      'user', JSON.stringify({ role: 'user', content: `[Earlier conversation context: ${summaryText}]` }), now, first.id,
    ])
    this.db.run('UPDATE conversation_messages SET role = ?, content = ?, created_at = ? WHERE id = ?', [
      'assistant', JSON.stringify({ role: 'assistant', content: 'Understood, I have context from our earlier conversation.' }), now, second.id,
    ])
    if (rest.length) {
      const placeholders = rest.map(() => '?').join(',')
      this.db.run(`DELETE FROM conversation_messages WHERE id IN (${placeholders})`, rest.map(r => r.id))
    }
    this.log.info(`Compacted conversation for ${userId}: ${excess.length} rows -> 1 summary pair`)
  }

  clear(userId: string): void {
    this.db.run('DELETE FROM conversation_messages WHERE telegram_user_id = ?', [userId])
    this.log.info(`Conversation cleared for ${userId}`)
  }
}
