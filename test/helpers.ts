/**
 * Shared test setup.
 *
 * `src/config.ts` validates the environment at import time, so every test file must
 * set the four required variables before importing anything from `src/`.
 */
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.TELEGRAM_ALLOWED_USERS ||= '1'
process.env.COMPOSIO_API_KEY ||= 'test-composio'
process.env.AI_API_KEY ||= 'test-ai'
process.env.LOG_LEVEL ||= 'ERROR'

import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../src/migrate'

/** A migrated throwaway database. */
export function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-ai-test-'))
  const db = new Database(join(dir, 'test.db'))
  runMigrations(db)
  return db
}

let pass = 0
let fail = 0
const failures: string[] = []

export function check(name: string, want: unknown, got: unknown): void {
  if (JSON.stringify(want) === JSON.stringify(got)) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  FAIL ${name}\n         want: ${JSON.stringify(want)}\n         got:  ${JSON.stringify(got)}`)
  }
}

export function section(title: string): void {
  console.log(`\n${title}`)
}

/**
 * Print the tally and exit.
 *
 * The explicit exit matters: a suite that leaves a pending timer alive (the hung-tool
 * test does, on purpose) would otherwise hang instead of reporting, and the runner
 * would read the timeout as a failure.
 */
export function summary(): void {
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) console.log(`failed: ${failures.join(', ')}`)
  process.exit(fail > 0 ? 1 : 0)
}
