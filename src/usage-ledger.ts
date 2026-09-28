/**
 * Per-call token accounting.
 *
 * Single-responsibility: append-only telemetry. It is written by the router after
 * every completion and read by the ops tool; nothing in the agent loop depends on
 * it, so losing a row is never fatal.
 */
import { type Database } from 'bun:sqlite'
import { Logger } from './logger'

const log = new Logger('usage-ledger')

export interface UsageEntry {
  entityId: string
  agentName: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  usedFallback: boolean
  attempts: number
}

export interface UsageSummary {
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  byModel: Record<string, { calls: number; totalTokens: number }>
}

export class UsageLedger {
  constructor(private db: Database) {
    log.info('Usage ledger ready')
  }

  record(entry: UsageEntry): void {
    try {
      this.db.run(
        `INSERT INTO usage_ledger
           (entity_id, agent_name, model, prompt_tokens, completion_tokens, total_tokens,
            used_fallback, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.entityId,
          entry.agentName,
          entry.model,
          entry.promptTokens,
          entry.completionTokens,
          entry.totalTokens,
          entry.usedFallback ? 1 : 0,
          entry.attempts,
          new Date().toISOString(),
        ],
      )
    } catch (err) {
      // Telemetry must never break a turn.
      log.debug(`usage record failed: ${err}`)
    }
  }

  /** Per-user totals over a window. `entityId` null means every user. */
  summary(entityId: string | null, days = 30): UsageSummary {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    const rows = (entityId
      ? this.db
          .query(
            `SELECT model, prompt_tokens, completion_tokens, total_tokens, used_fallback
             FROM usage_ledger WHERE entity_id = ? AND created_at >= ?`,
          )
          .all(entityId, cutoff)
      : this.db
          .query(
            `SELECT model, prompt_tokens, completion_tokens, total_tokens, used_fallback
             FROM usage_ledger WHERE created_at >= ?`,
          )
          .all(cutoff)) as {
      model: string
      prompt_tokens: number
      completion_tokens: number
      total_tokens: number
      used_fallback: number
    }[]

    const summary: UsageSummary = {
      calls: rows.length,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      byModel: {},
    }
    for (const row of rows) {
      summary.promptTokens += row.prompt_tokens ?? 0
      summary.completionTokens += row.completion_tokens ?? 0
      summary.totalTokens += row.total_tokens ?? 0
      const bucket = (summary.byModel[row.model] ??= { calls: 0, totalTokens: 0 })
      bucket.calls++
      bucket.totalTokens += row.total_tokens ?? 0
    }
    return summary
  }

  /** Per-user totals for the ops view. */
  byUser(days = 30, limit = 20): { entityId: string; calls: number; totalTokens: number }[] {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
    return (
      this.db
        .query(
          `SELECT entity_id, COUNT(*) AS calls, SUM(total_tokens) AS total
           FROM usage_ledger WHERE created_at >= ?
           GROUP BY entity_id ORDER BY total DESC LIMIT ?`,
        )
        .all(cutoff, limit) as { entity_id: string; calls: number; total: number }[]
    ).map(r => ({ entityId: r.entity_id, calls: r.calls, totalTokens: r.total ?? 0 }))
  }
}
