import { z } from 'zod'
import { agents } from '../agents'
import { Logger } from '../logger'
import type { ToolContext } from '../tool-def'

const log = new Logger('delegate-task')

export const toolName = 'delegate_task'

export const parameters = z.object({
  agent: z.string().min(1).describe('Name of the specialist agent to hand this task to.'),
  task: z.string().min(1).describe('The complete, self-contained task for that agent. It cannot see this conversation.'),
})

export function createTool(ctx: ToolContext) {
  // At the depth cap there is no delegate callback, so the tool cannot work. It is
  // not offered at all rather than offered-and-refused: a tool the model can see
  // but never use is a step spent on a dead end, and the refusal reads like a bug.
  // This is the same least-privilege rule the loader applies to the allow-list.
  if (!ctx.delegate) return undefined

  // Built at call time so the description lists the agents this deployment
  // actually has, instead of a hard-coded list that rots.
  const roster = agents.list()
    .map(a => `- ${a.name}: ${a.description}`)
    .join('\n')

  return {
    description:
      `Hand a self-contained task to a specialist agent and wait for its answer.\n` +
      `Use this when the task is somebody else's specialty, or when it needs many steps of ` +
      `theirs. Do not use it to ask a question you can answer directly.\n` +
      `The task must stand alone: the other agent sees no prior context.\n` +
      `Never delegate to yourself — it cannot make progress.\n\n` +
      `Available agents:\n${roster}`,
    parameters,
    async execute({ agent, task }: z.infer<typeof parameters>) {
      if (!ctx.delegate) return 'delegation is not available in this context'

      const target = agent.trim()
      if (!agents.has(target)) {
        return `unknown agent "${target}". Available: ${agents.names.join(', ')}`
      }
      if (ctx.agentName && target === ctx.agentName) {
        return `cannot delegate to yourself ("${target}"). Do the work directly.`
      }

      log.info(`Delegating to "${target}": ${task.slice(0, 80)}`)
      try {
        const answer = await ctx.delegate(target, task)
        return answer?.trim() || 'the agent returned nothing'
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn(`Delegation to "${target}" failed: ${message}`)
        return `delegation failed: ${message}. Answer directly instead.`
      }
    },
  }
}
