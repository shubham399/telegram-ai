type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'

import { inspect } from 'util'

const LEVEL_NUM: Record<LogLevel, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 }

function parseLevel(s: string): LogLevel {
  if (s === 'ERROR' || s === 'WARN' || s === 'INFO' || s === 'DEBUG') return s
  return 'INFO'
}

export class Logger {
  private levelNum: number
  private label: string

  constructor(label: string, level?: LogLevel) {
    const envLevel = parseLevel(
      (typeof process !== 'undefined' && process.env.LOG_LEVEL) || 'INFO',
    )
    this.levelNum = LEVEL_NUM[level ?? envLevel]
    this.label = label
  }

  child(sub: string): Logger {
    const l = new Logger(`${this.label}:${sub}`)
    l.levelNum = this.levelNum
    return l
  }

  private emit(level: LogLevel, msg: string, ...args: unknown[]) {
    if (LEVEL_NUM[level] > this.levelNum) return
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level}] [${this.label}] ${msg}`
    // Everything is interpolated into a single string before reaching console.
    // Handing user-derived text to console.* as a format string lets a message
    // containing %s swallow the following argument (and %d/%j corrupt the line).
    const out = args.length ? `${line} ${args.map(a => (typeof a === 'string' ? a : inspect(a))).join(' ')}` : line
    if (level === 'ERROR') console.error(out)
    else if (level === 'WARN') console.warn(out)
    else console.log(out)
  }

  error(msg: string, ...args: unknown[]) { this.emit('ERROR', msg, ...args) }
  warn(msg: string, ...args: unknown[]) { this.emit('WARN', msg, ...args) }
  info(msg: string, ...args: unknown[]) { this.emit('INFO', msg, ...args) }
  debug(msg: string, ...args: unknown[]) { this.emit('DEBUG', msg, ...args) }
}
