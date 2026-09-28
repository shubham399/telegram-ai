/**
 * Agent selection and the tool allow-list.
 *
 * Routing bugs are silent: the wrong agent simply answers, and nothing errors.
 * The assertions below pin the tie-breaking rules, because a tie broken by
 * directory iteration order changes behaviour when someone adds a folder.
 */
import { check, section, summary } from './helpers'
import { agents } from '../src/agents'

const route = (text: string): string => agents.select(text)?.name ?? 'default'

section('registry')
check('built-in default always exists', true, agents.has('default'))
check('default has every tool', true, agents.allows('default', 'anything-at-all'))
check('default may use composio', true, agents.allowsComposio('default'))
check('unknown agent resolves to default', 'default', agents.get('does-not-exist').name)

section('keyword routing')
check('mail routes to email', 'email', route('check my mail please'))
check('inbox routes to email', 'email', route('what is in my inbox?'))
check('gmail routes to email', 'email', route('find that gmail from yesterday'))
check('research routes to researcher', 'researcher', route('research the Fermi paradox'))
check('unrelated text uses default', 'default', route('what is the capital of France'))
check('routing is case-insensitive', 'email', route('CHECK MY MAIL'))
check('punctuation does not block a match', 'researcher', route('hey!! research... the thing'))

section('word boundaries, not substrings')
check('"mail" inside "email" is not a separate hit', 'researcher', route('research this: my email is about X'))
check('"mail" alone still matches', 'email', route('is there mail today'))

section('tie-breaking is deterministic')
check('lead intent wins over trailing mention', 'researcher', route('research this: my email is about X'))
check('trailing mention wins when it leads', 'email', route('email is about X — research this'))
check('two keywords beat one', 'researcher', route('research the martian calendar and compare it to ours'))

section('tool allow-list is least privilege')
check('email allows composio', true, agents.allowsComposio('email'))
check('email allows note', true, agents.allows('email', 'note'))
check('email blocks web', false, agents.allows('email', 'web'))
check('email blocks delegate_task', false, agents.allows('email', 'delegate_task'))
check('researcher allows web', true, agents.allows('researcher', 'web'))
check('researcher allows delegate_task', true, agents.allows('researcher', 'delegate_task'))
check('researcher blocks note', false, agents.allows('researcher', 'note'))
check('unknown agent gets default permissions', true, agents.allows('ghost-agent', 'web'))

summary()
