import { z } from 'zod'

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USERS: z.string().min(1),
  COMPOSIO_API_KEY: z.string().min(1),
  AI_API_KEY: z.string().min(1, 'AI_API_KEY is required'),
  AI_BASE_URL: z.string().optional().default('https://api.openai.com/v1'),
  LOG_LEVEL: z.string().optional().default('INFO'),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().optional().default(10),
  MAX_TOOL_RESULT_CHARS: z.coerce.number().int().positive().optional().default(16000),
  MODEL: z.string().optional().default('gpt-4o-mini'),
})

export const env = envSchema.parse(process.env)
export const ALLOWED_USER_IDS = env.TELEGRAM_ALLOWED_USERS.split(',').map(s => s.trim())
export const LOG_LEVEL = env.LOG_LEVEL
export const AGENT_MAX_STEPS = env.AGENT_MAX_STEPS
export const MAX_TOOL_RESULT_CHARS = env.MAX_TOOL_RESULT_CHARS
export const MODEL = env.MODEL
export const AI_API_KEY = env.AI_API_KEY
export const AI_BASE_URL = env.AI_BASE_URL
