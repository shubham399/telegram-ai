export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

export function nowIST(): Date {
  return new Date(Date.now() + IST_OFFSET_MS)
}

export function computeNextRunUTC(
  scheduleType: 'once' | 'daily' | 'weekdays' | 'weekly',
  hour: number,
  minute: number,
  dayOfWeek?: number,
): Date | null {
  const now = Date.now()

  const targetAtDay = (daysFromNow: number): Date => {
    const ist = new Date(now + IST_OFFSET_MS + daysFromNow * 86400000)
    ist.setUTCHours(hour, minute, 0, 0)
    return new Date(ist.getTime() - IST_OFFSET_MS)
  }

  if (scheduleType === 'once') {
    const today = targetAtDay(0)
    if (today.getTime() > now) return today
    const tomorrow = targetAtDay(1)
    return tomorrow
  }

  for (let day = 0; day < 7; day++) {
    const target = targetAtDay(day)
    if (day === 0 && target.getTime() <= now) continue
    if (scheduleType === 'daily') return target
    const dow = new Date(target.getTime() + IST_OFFSET_MS).getUTCDay()
    if (scheduleType === 'weekdays' && dow >= 1 && dow <= 5) return target
    if (scheduleType === 'weekly' && dayOfWeek !== undefined && dow === dayOfWeek) return target
  }

  return targetAtDay(7)
}
