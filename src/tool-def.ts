import { z } from 'zod'
import type { MemoryStore } from './memory-store'
import type { JobStore } from './job-store'

export interface CustomToolDef<Z extends z.ZodType = z.ZodType<any>> {
  description?: string
  parameters: Z
  execute: (args: z.infer<Z>) => Promise<string | any>
}

export interface ToolContext {
  entityId: string
  composioSession?: { sessionId: string; execute: (slug: string, args: any) => Promise<any>; search: (params: { query: string }) => Promise<any> }
  memoryStore?: MemoryStore
  jobStore?: JobStore
}
