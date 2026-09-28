import { z } from 'zod'
import type { MemoryStore } from './memory-store'
import type { JobStore } from './job-store'
import type { NoteStore } from './note-store'
import type { TodoStore } from './todo-store'
import type { Maintenance } from './maintenance'
import type { UsageLedger } from './usage-ledger'

export interface CustomToolDef<Z extends z.ZodType = z.ZodType<any>> {
  description?: string
  parameters: Z
  execute: (args: z.infer<Z>) => Promise<string | any>
}

export interface ToolContext {
  entityId: string
  /** Which agent is running, for tool-side decisions. */
  agentName?: string
  composioSession?: { sessionId: string; execute: (slug: string, args: any) => Promise<any>; search: (params: { query: string }) => Promise<any> }
  memoryStore?: MemoryStore
  jobStore?: JobStore
  noteStore?: NoteStore
  todoStore?: TodoStore
  maintenance?: Maintenance
  usageLedger?: UsageLedger
  /**
   * Runs a named agent to completion and returns its final text.
   *
   * Injected by the runner (DIP): the tool layer has no idea how agents execute, so
   * `delegate_task` can exist without a tool -> ai.ts import cycle.
   */
  delegate?: (agentName: string, task: string) => Promise<string>
}
