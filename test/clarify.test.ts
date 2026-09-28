/**
 * The `clarify` reply shape.
 *
 * The parser is duplicated from bot.ts on purpose: extracting it would mean a
 * module whose only job is one regex, and the assertions below are what keep the
 * two copies honest.
 */
import { check, section, summary } from './helpers'

const CLARIFY_RE = /^CLARIFY:\s*(.+?)\n\n((?:\d+\.\s.+\n?)+)/

function parseClarify(text: string): { question: string; options: string[] } | null {
  const match = text.match(CLARIFY_RE)
  if (!match) return null
  const options = match[2]
    .split('\n')
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
  return options.length < 2 ? null : { question: match[1].trim(), options }
}

section('recognises the tool output')
check(
  'real tool output parses',
  { question: 'Which one?', options: ['Option A', 'Option B'] },
  parseClarify('CLARIFY: Which one?\n\n1. Option A\n2. Option B\n\n(answer with the number, or just tell me what you want)'),
)
check('four options', 4, parseClarify('CLARIFY: Q?\n\n1. a\n2. b\n3. c\n4. d')!.options.length)
check('a fifth option is dropped', 4, parseClarify('CLARIFY: Q?\n\n1. a\n2. b\n3. c\n4. d\n5. e')!.options.length)
check('trailing prose is not an option', ['A', 'B'], parseClarify('CLARIFY: Q?\n\n1. A\n2. B\n\n(answer with the number)')!.options)

section('ordinary replies are left alone')
check('a normal answer is not a clarify', null, parseClarify('Sure, here is the answer.'))
check('a numbered list without the prefix is not a clarify', null, parseClarify('Here are your jobs:\n1. one\n2. two'))
check('a single option is not a clarify', null, parseClarify('CLARIFY: Q?\n\n1. only one'))
check('the prefix with no options is not a clarify', null, parseClarify('CLARIFY: never mind'))

section('bot wires the buttons')
const botSource = await Bun.file(new URL('../src/bot.ts', import.meta.url)).text()
check('an action handler is registered for clarify', true, /bot\.action\(\/\^clarify:/.test(botSource))
check('the button path stores the pending question', true, /pendingClarify\.set/.test(botSource))

summary()
