import { z } from 'zod'
import { Logger } from '../logger'
import { maskUserId } from '../pii'
import type { CustomToolDef, ToolContext } from '../tool-def'

const log = new Logger('tool:clarify')

export const toolName = 'clarify'

export const MAX_OPTIONS = 4

export function createTool(ctx: ToolContext): CustomToolDef {
  return {
    description:
      'Ask the user one question when the request is genuinely ambiguous, and you would give a ' +
      'materially different answer depending on the answer. Give 2-4 concrete options. ' +
      'Do NOT use this to confirm something you can check yourself, and do not use it for a ' +
      'routine decision — pick a sensible default and say so.',
    parameters: z.object({
      question: z.string().min(3).describe('The question, in one sentence.'),
      options: z
        .array(z.string().min(1))
        .min(2)
        .max(MAX_OPTIONS)
        .describe(`2-${MAX_OPTIONS} short, mutually exclusive options.`),
    }),
    execute: async ({ question, options }) => {
      // Surface the question as the turn's text. Inline buttons are the nicer path and
      // are wired where a Context exists; a delegated or scheduled run has none, so the
      // numbered form is the one that always works.
      const body = options
        .map((o: string, i: number) => `${i + 1}. ${o}`)
        .join('\n')
      log.info(`tool clarify for ${maskUserId(ctx.entityId)}: "${question.slice(0, 80)}"`)
      return `CLARIFY: ${question}\n\n${body}\n\n(answer with the number, or just tell me what you want)`
    },
  }
}
