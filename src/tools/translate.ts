import { z } from 'zod'
import { Logger } from '../logger'
import { router } from '../model-router'
import { MAX_TOOL_RESULT_CHARS } from '../config'
import type { CustomToolDef, ToolContext } from '../tool-def'

const log = new Logger('tool:translate')

export const toolName = 'translate'

/** Long enough for a page, short enough to stay inside the context budget. */
const MAX_INPUT_CHARS = 8000

export function createTool(_ctx: ToolContext): CustomToolDef {
  return {
    description:
      'Translate text into another language, or answer a question about what a passage means. ' +
      'Prefer this over guessing at a language you are not sure of.',
    parameters: z.object({
      text: z.string().min(1).describe('The text to translate or explain.'),
      target_language: z.string().describe('Language to translate into, e.g. "Hindi", "French".'),
      source_language: z.string().optional().describe('Set if you already know it. Detected otherwise.'),
    }),
    execute: async ({ text, target_language, source_language }) => {
      const input = text.slice(0, MAX_INPUT_CHARS)
      if (text.length > MAX_INPUT_CHARS) {
        log.info(`tool translate: truncated input from ${text.length} to ${MAX_INPUT_CHARS} chars`)
      }

      const { response } = await router.complete({
        messages: [
          {
            role: 'system',
            content:
              'You are a translation engine. Output only the translation — no preamble, no ' +
              'explanation, no quotes around it. Preserve any markdown structure and line breaks.',
          },
          {
            role: 'user',
            content: source_language
              ? `Translate from ${source_language} to ${target_language}:\n\n${input}`
              : `Translate to ${target_language}. Detect the source language and translate it:\n\n${input}`,
          },
        ],
      })

      const out = (response.choices?.[0]?.message?.content ?? '').trim()
      if (!out) return 'the model returned no translation'
      return out.slice(0, MAX_TOOL_RESULT_CHARS)
    },
  }
}
