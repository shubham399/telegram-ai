/**
 * Agent definitions: what specialists exist, and which one a message is for.
 *
 * Single-responsibility: the catalogue and the choice. It knows nothing about how
 * an agent runs — that is `ai.ts` — and nothing about Telegram.
 *
 * A built-in `default` agent always exists, so the bot works with an empty
 * `agents/` directory. Adding `agents/<name>/agent.json` adds a specialist.
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { Logger } from './logger'

const log = new Logger('agents')

const AGENTS_DIR = 'agents'

/** Characters of a message treated as "the part where intent is stated". */
const LEAD_CHARS = 40

export interface AgentDef {
  name: string
  /** One line, used in the orchestrator's routing prompt. */
  description: string
  /** Appended to the base system prompt. */
  soul: string
  /**
   * Tool allow-list. `['*']` means every tool. A missing entry means the default
   * agent's list, not "everything".
   */
  tools: string[]
  /** Lowercase substrings that route to this agent without an LLM call. */
  keywords: string[]
}

const BUILTIN: AgentDef = {
  name: 'default',
  description: 'General-purpose assistant. Handles anything without a specialist.',
  soul: '',
  tools: ['*'],
  keywords: [],
}

function readSoul(agentDir: string): string {
  for (const file of ['SOUL.md', 'AGENTS.md']) {
    const path = join(agentDir, file)
    if (existsSync(path)) return readFileSync(path, 'utf-8').trim()
  }
  return ''
}

function normalize(raw: unknown, dir: string, fallbackName: string): AgentDef | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : fallbackName
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    log.warn(`Agent dir ${dir}: invalid name "${name}" — skipped`)
    return null
  }

  const tools = Array.isArray(obj.tools) ? obj.tools.filter((t): t is string => typeof t === 'string') : ['*']
  const keywords = Array.isArray(obj.keywords)
    ? obj.keywords.filter((k): k is string => typeof k === 'string').map(k => k.toLowerCase())
    : []

  return {
    name,
    description: typeof obj.description === 'string' ? obj.description : '',
    soul: readSoul(dir),
    tools: tools.length ? tools : ['*'],
    keywords,
  }
}

interface Match {
  agent: AgentDef
  weight: number
  hits: number
  at: number
  length: number
}

/** Position of a keyword match on word boundaries, or -1.
 *
 * Word boundaries matter: a naive `includes` makes the `mail` keyword match
 * inside "email", so any mention of email double-counts and out-routes the agent
 * that actually owns the message.
 */
function matchIndex(haystack: string, keyword: string): number {
  if (!keyword) return -1
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i').exec(haystack)
  return found ? found.index : -1
}

/** Strict weak ordering over matches. Ties fall through to the name, never to disk order. */
function outranks(a: Match, b: Match): boolean {
  if (a.weight !== b.weight) return a.weight > b.weight
  if (a.hits !== b.hits) return a.hits > b.hits
  if (a.at !== b.at) return a.at < b.at
  if (a.length !== b.length) return a.length > b.length
  return a.agent.name < b.agent.name
}

export class AgentRegistry {
  private agents = new Map<string, AgentDef>()

  constructor() {
    this.agents.set(BUILTIN.name, BUILTIN)
    this.loadFromDisk()
  }

  private loadFromDisk(): void {
    if (!existsSync(AGENTS_DIR)) {
      log.info(`No ${AGENTS_DIR}/ directory — running with the built-in default agent only`)
      return
    }

    const dirs = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)

    if (dirs.length === 0) {
      log.info(`${AGENTS_DIR}/ is empty — running with the built-in default agent only`)
      return
    }

    for (const dirName of dirs) {
      const dir = join(AGENTS_DIR, dirName)
      const configPath = join(dir, 'agent.json')
      if (!existsSync(configPath)) {
        log.warn(`Agent dir ${dir} has no agent.json — skipped`)
        continue
      }
      try {
        const agent = normalize(JSON.parse(readFileSync(configPath, 'utf-8')), dir, dirName)
        if (!agent) continue
        if (this.agents.has(agent.name)) {
          log.warn(`Duplicate agent name "${agent.name}" in ${dir} — skipped`)
          continue
        }
        this.agents.set(agent.name, agent)
        log.info(`Loaded agent "${agent.name}" (${agent.tools.includes('*') ? 'all tools' : agent.tools.length + ' tool(s)'})`)
      } catch (err) {
        log.warn(`Agent dir ${dir}: could not load agent.json — ${err}`)
      }
    }
  }

  get(name: string): AgentDef {
    return this.agents.get(name) ?? this.agents.get(BUILTIN.name)!
  }

  has(name: string): boolean {
    return this.agents.has(name)
  }

  list(): AgentDef[] {
    return [...this.agents.values()]
  }

  get names(): string[] {
    return [...this.agents.keys()]
  }

  /**
   * Deterministic keyword match. Returns null when nothing matches, so the caller
   * can fall back to the default agent.
   *
   * Ranking, in order:
   *   1. total weight — a keyword in the first 40 characters counts double, since
   *      that is where people state their intent ("hey, check my email")
   *   2. number of distinct keywords matched — "email and calendar" is a stronger
   *      signal than one incidental word
   *   3. earliest match position — "research this: my email…" is research, not email
   *   4. longest keyword — the more specific term wins
   *   5. name, so the outcome never depends on directory iteration order
   */
  select(text: string): AgentDef | null {
    const haystack = text.toLowerCase()

    let best: Match | null = null

    for (const agent of this.agents.values()) {
      let weight = 0
      let hits = 0
      let at = Number.MAX_SAFE_INTEGER
      let length = 0

      for (const keyword of agent.keywords) {
        if (!keyword) continue
        const index = matchIndex(haystack, keyword)
        if (index === -1) continue
        hits++
        at = Math.min(at, index)
        length += keyword.length
        // Intent is usually stated up front, so a lead mention is the stronger signal.
        weight += index < LEAD_CHARS ? 2 : 1
      }

      if (hits === 0) continue
      const candidate: Match = { agent, weight, hits, at, length }
      if (!best || outranks(candidate, best)) best = candidate
    }

    return best?.agent ?? null
  }

  /** Does `tool` appear in this agent's allow-list? */
  allows(agentName: string, tool: string): boolean {
    const tools = this.get(agentName).tools
    return tools.includes('*') || tools.includes(tool)
  }

  /**
   * The whole Composio catalogue is granted by the single token `composio`, so an
   * agent definition can say "email + composio" without enumerating 200 slugs.
   */
  allowsComposio(agentName: string): boolean {
    const tools = this.get(agentName).tools
    return tools.includes('*') || tools.includes('composio')
  }
}

export const agents = new AgentRegistry()
