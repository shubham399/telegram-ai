/**
 * Per-key serial task queue.
 *
 * Why this exists: Telegram delivers updates one at a time and the handler
 * `await`s the whole agent run. While one turn is in flight, no other user can
 * be served and even `/stop` queues behind it. Worse, two turns from the same
 * user would interleave their reads and writes of that user's history.
 *
 * So: enqueue and return. Work for a given key runs in order; different keys run
 * concurrently.
 */

export class KeyedQueue {
  /** key -> tail of the chain currently queued or running for it */
  private tails = new Map<string, Promise<unknown>>()

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()

    // Swallow the predecessor's rejection so one failed turn does not poison the
    // rest of the chain. The caller still sees its own result.
    const run = previous.then(task, task)

    const tracked = run.finally(() => {
      // Identity, not a count: only clear the key if this is still the tail.
      if (this.tails.get(key) === tracked) this.tails.delete(key)
    })

    this.tails.set(key, tracked)
    return run
  }
}

export const userQueue = new KeyedQueue()
