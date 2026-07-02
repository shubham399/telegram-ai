const EMAIL_RE = /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g
const PHONE_RE = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g
const CC_RE = /\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/g
const API_KEY_RE = /\b(?:sk-|pk-|api[-_]?key|token|secret)[-_]?[a-zA-Z0-9]{8,}/gi

export function maskUserId(id: string): string {
  if (id.length <= 4) return '***'
  return '***' + id.slice(-4)
}

export function maskSessionId(id: string): string {
  if (id.length <= 8) return '****'
  return id.slice(0, 4) + '****' + id.slice(-4)
}

export function maskPii(text: string): string {
  return text
    .replace(EMAIL_RE, (_, local, domain) => {
      const maskedLocal = local.length <= 2 ? local[0] + '***' : local[0] + '***' + local.slice(-1)
      return `${maskedLocal}@${domain}`
    })
    .replace(PHONE_RE, (match) => {
      if (match.length <= 4) return match
      return match.slice(0, -4).replace(/\d/g, '*') + match.slice(-4)
    })
    .replace(IP_RE, '***.***.***.***')
    .replace(CC_RE, (match) => {
      const digits = match.replace(/\D/g, '')
      if (digits.length !== 16) return match
      return '****-****-****-' + digits.slice(-4)
    })
    .replace(API_KEY_RE, (match) => {
      if (match.length <= 8) return match
      return match.slice(0, 4) + '****' + match.slice(-4)
    })
}
