import { z } from 'zod'
import { Logger } from '../logger'
import { router } from '../model-router'
import { MAX_TOOL_RESULT_CHARS } from '../config'
import type { CustomToolDef, ToolContext } from '../tool-def'

const log = new Logger('tool:web')

const MAX_HTML_CHARS = 200_000
const MAX_TEXT_CHARS = 12_000
const FETCH_TIMEOUT_MS = 15_000

/**
 * Reduce a page to the text a model can read. Script and style bodies are dropped
 * wholesale; without that a single page ships megabytes of JavaScript as "content".
 */
function toReadableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS)
}

export function createTool(_ctx: ToolContext): CustomToolDef {
  return {
    description:
      'Fetch a web page and answer a question about it, or summarise it. Use when the user ' +
      'gives a URL. For open-ended discovery, use the web_search composio action instead.',
    parameters: z.object({
      url: z.string().url().describe('Absolute http(s) URL to read.'),
      question: z.string().optional().describe('What to find on the page. Defaults to a summary.'),
    }),
    execute: async ({ url, question }) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      let page: string
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'User-Agent': 'telegram-ai/1.0 (+agent)' },
        })
        clearTimeout(timer)
        if (!res.ok) return `fetch failed: ${res.status} ${res.statusText}`
        const type = res.headers.get('content-type') ?? ''
        if (!type.includes('html') && !type.includes('text')) {
          return `unsupported content type "${type}" — only HTML and text pages are readable`
        }
        page = await res.text()
      } catch (err) {
        clearTimeout(timer)
        if (err instanceof Error && err.name === 'AbortError') return `fetch timed out after ${FETCH_TIMEOUT_MS}ms`
        return `fetch failed: ${err instanceof Error ? err.message : String(err)}`
      }

      if (page.length > MAX_HTML_CHARS) {
        log.info(`tool web: ${url} is ${page.length} chars, truncating to ${MAX_HTML_CHARS}`)
        page = page.slice(0, MAX_HTML_CHARS)
      }
      const text = toReadableText(page)
      if (!text) return 'the page had no readable text'

      const { response } = await router.complete({
        messages: [
          {
            role: 'system',
            content:
              'Answer from the page content only. If the answer is not on the page, say so plainly. ' +
              'Be concise and do not invent facts or citations.',
          },
          { role: 'user', content: `${question ? `Question: ${question}\n\n` : 'Summarise this page.\n\n'}URL: ${url}\n\n${text}` },
        ],
      })

      const out = (response.choices?.[0]?.message?.content ?? '').trim()
      return out ? out.slice(0, MAX_TOOL_RESULT_CHARS) : 'the model returned nothing for that page'
    },
  }
}
