type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'

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
    const prefix = args.length > 0 ? `${msg}` : msg
    const rest = args.length > 0 ? args : []
    if (level === 'ERROR') {
      console.error(`[${ts}] [${level}] [${this.label}] ${prefix}`, ...rest)
    } else if (level === 'WARN') {
      console.warn(`[${ts}] [${level}] [${this.label}] ${prefix}`, ...rest)
    } else {
      console.log(`[${ts}] [${level}] [${this.label}] ${prefix}`, ...rest)
    }
  }

  error(msg: string, ...args: unknown[]) { this.emit('ERROR', msg, ...args) }
  warn(msg: string, ...args: unknown[]) { this.emit('WARN', msg, ...args) }
  info(msg: string, ...args: unknown[]) { this.emit('INFO', msg, ...args) }
  debug(msg: string, ...args: unknown[]) { this.emit('DEBUG', msg, ...args) }
}
