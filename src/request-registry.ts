/**
 * Tracks the in-flight agent run per user so `/stop` can abort it.
 *
 * A `Map` and not a table: these entries live for the length of one run, are
 * useless after it, and writing them to SQLite would mean a row per turn for no
 * query benefit. A cancelled run is still a run until it unwinds, hence
 * `markFinished`.
 */

interface Entry {
  id: string
  userId: string
  cancelled: boolean
}

const active = new Map<string, Entry>()

/** Register a new run. One active run per user — the queue guarantees that. */
export function createRequest(userId: string): { id: string } {
  const entry: Entry = { id: crypto.randomUUID(), userId, cancelled: false }
  active.set(userId, entry)
  return { id: entry.id }
}

export function markFinished(userId: string, id: string): void {
  const entry = active.get(userId)
  if (entry && entry.id === id) active.delete(userId)
}

/** Cancel the user's current run. Returns false when nothing was running. */
export function cancelFor(userId: string): boolean {
  const entry = active.get(userId)
  if (!entry) return false
  entry.cancelled = true
  return true
}

export function isCancelled(id: string): boolean {
  for (const entry of active.values()) {
    if (entry.id === id) return entry.cancelled
  }
  return false
}
