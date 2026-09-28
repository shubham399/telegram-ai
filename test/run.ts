/**
 * Test runner. `bun test` is deliberately not used: these suites drive real local
 * HTTP servers and a throwaway SQLite file each, and running them as separate
 * processes keeps one suite's fake provider port from colliding with another's.
 */
import { readdirSync } from 'fs'
import { join } from 'path'

const dir = import.meta.dir
const files = readdirSync(dir)
  .filter(f => f.endsWith('.test.ts'))
  .sort()

if (files.length === 0) {
  console.error('no test files found')
  process.exit(1)
}

let failed = 0
const started = Date.now()

for (const file of files) {
  console.log(`\n${'='.repeat(60)}\n${file}\n${'='.repeat(60)}`)
  const code = await Bun.spawn(['bun', 'run', join(dir, file)], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env },
  }).exited
  if (code !== 0) failed++
}

console.log(`\n${'='.repeat(60)}`)
console.log(
  failed === 0
    ? `all ${files.length} suite(s) passed in ${((Date.now() - started) / 1000).toFixed(1)}s`
    : `${failed} of ${files.length} suite(s) FAILED`,
)
process.exit(failed === 0 ? 0 : 1)
