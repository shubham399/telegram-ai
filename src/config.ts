import { z } from 'zod'

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USERS: z.string().min(1),
  COMPOSIO_API_KEY: z.string().min(1),
  AI_API_KEY: z.string().min(1, 'AI_API_KEY is required'),
  AI_BASE_URL: z.string().optional().default('https://api.openai.com/v1'),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().optional().default(10),
  MAX_TOOL_RESULT_CHARS: z.coerce.number().int().positive().optional().default(16000),
  MODEL: z.string().optional().default('gpt-4o-mini'),
  // Comma-separated. Absent => nobody is an admin and every adminOnly tool is
  // hidden from everyone. Deny-by-default, not open.
  ADMIN_USER_IDS: z.string().optional().default(''),
  FALLBACK_MODEL: z.string().optional(),
  FALLBACK_BASE_URL: z.string().optional(),
  FALLBACK_API_KEY: z.string().optional(),
  PRIMARY_RETRY_COUNT: z.coerce.number().int().min(0).optional().default(2),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
  PROVIDER_HEADERS: z.string().optional(),
  PRIMARY_UA: z.string().optional(),
  FALLBACK_UA: z.string().optional(),
})

export const env = envSchema.parse(process.env)
export const ALLOWED_USER_IDS = env.TELEGRAM_ALLOWED_USERS.split(',').map(s => s.trim())
export const ADMIN_USER_IDS = new Set(
  env.ADMIN_USER_IDS.split(',').map(s => s.trim()).filter(Boolean),
)
export const AGENT_MAX_STEPS = env.AGENT_MAX_STEPS
export const MAX_TOOL_RESULT_CHARS = env.MAX_TOOL_RESULT_CHARS
export const MODEL = env.MODEL
export const AI_API_KEY = env.AI_API_KEY
export const AI_BASE_URL = env.AI_BASE_URL

export const FALLBACK_MODEL = env.FALLBACK_MODEL
export const FALLBACK_BASE_URL = env.FALLBACK_BASE_URL
export const FALLBACK_API_KEY = env.FALLBACK_API_KEY
export const PRIMARY_RETRY_COUNT = env.PRIMARY_RETRY_COUNT
export const MAX_OUTPUT_TOKENS = env.MAX_OUTPUT_TOKENS
export const PROVIDER_HEADERS = env.PROVIDER_HEADERS
export const PRIMARY_UA = env.PRIMARY_UA
export const FALLBACK_UA = env.FALLBACK_UA
