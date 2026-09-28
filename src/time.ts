/**
 * IST wall-clock arithmetic, in one place.
 *
 * Six modules each had their own copy of `5.5 * 3600 * 1000` and its `getUTC*`
 * unpacking, which is how a timezone quietly drifts apart. IST is UTC+05:30 with
 * no DST, so the offset is a constant and no tz database is needed.
 */

export const IST_OFFSET_MS = 5.5 * 3600 * 1000

/** Wall-clock hour and minute in IST, for a timestamp. Defaults to now. */
export function istTimeIn(at: number = Date.now()): { h: number; m: number } {
  const d = new Date(at + IST_OFFSET_MS)
  return { h: d.getUTCHours(), m: d.getUTCMinutes() }
}

/** `HH:MM` in IST. */
export function fmtIST(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
