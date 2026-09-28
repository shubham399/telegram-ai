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
import { Logger } from './logger'

const log = new Logger('queue')

export class KeyedQueue {
  /** key -> tail of the chain currently queued or running for it */
  private tails = new Map<string, Promise<unknown>>()

  get pendingKeys(): number {
    return this.tails.size
  }

  depthFor(key: string): number {
    return this.depths.get(key) ?? 0
  }

  private depths = new Map<string, number>()

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()

    // Swallow the predecessor's rejection so one failed turn does not poison the
    // rest of the chain. The caller still sees its own result.
    const run = previous.then(task, task)

    const tracked = run.finally(() => {
      const left = (this.depths.get(key) ?? 1) - 1
      if (left <= 0) {
        this.depths.delete(key)
        this.tails.delete(key)
      } else {
        this.depths.set(key, left)
      }
    })

    this.tails.set(key, tracked)
    this.depths.set(key, (this.depths.get(key) ?? 0) + 1)
    return run
  }
}

export const userQueue = new KeyedQueue()
