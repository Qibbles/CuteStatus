// Weekly usage by day. Claude reports only the week's running total (a
// percentage), so Kibbles notes it as it goes: for each calendar day of the
// week, the first and the last percentage it saw that day.
//
// A day's usage is what it rose *while Kibbles saw that day* (last - first).
// Anything that rose while Kibbles wasn't running (before it first saw this
// week, or between one day's last reading and the next day's first) is
// "untracked": it can't be pinned to a day, so it isn't credited to one.

/** Readings for one week: index = calendar days since the week began (0-7). */
export type DayLog = {
  periodStart: number
  first: (number | null)[]
  last: (number | null)[]
}

/** One piece of the week's bar, in time order. `weekday` null = untracked. */
export type DayPart = { weekday: number | null; pct: number; today: boolean }

const DAY = 24 * 3600_000
const SLOTS = 8

export const emptyLog = (periodStart: number): DayLog => ({
  periodStart,
  first: Array(SLOTS).fill(null),
  last: Array(SLOTS).fill(null),
})

/** Calendar day number of a time, in a zone `offsetMs` ahead of UTC. */
export const dayNumber = (t: number, offsetMs: number) => Math.floor((t + offsetMs) / DAY)

/** Records a reading of the weekly percentage for calendar day `i`. */
export function record(log: DayLog, i: number, pct: number): boolean {
  if (i < 0 || i >= SLOTS || !Number.isFinite(pct)) return false
  let changed = false
  const f = log.first[i]
  const l = log.last[i]
  if (f === null || f === undefined || pct < f) {
    log.first[i] = pct
    changed = true
  }
  if (l === null || l === undefined || pct > l) {
    log.last[i] = pct
    changed = true
  }
  return changed
}

/** The week's bar, in time order: untracked stretches and each day's usage. */
export function dayParts(log: DayLog, today: number, weekdayOf: (i: number) => number): DayPart[] {
  const parts: DayPart[] = []
  let prev = 0
  for (let i = 0; i <= Math.min(today, SLOTS - 1); i++) {
    const f = log.first[i]
    const l = log.last[i]
    if (f === null || f === undefined || l === null || l === undefined) continue
    const gap = f - prev
    if (gap > 0) parts.push({ weekday: null, pct: gap, today: false })
    parts.push({ weekday: weekdayOf(i), pct: Math.max(0, l - f), today: i === today })
    prev = Math.max(prev, l)
  }
  return parts
}

type Legacy = { periodStart?: number; firstSlot?: number; firstPct?: number; marks?: (number | null)[] }

/**
 * Builds this week's log from the records older versions kept, so a new
 * version doesn't throw away the days already seen:
 * - `byDate` ('weekly-by-date'): last % per calendar day, plus the first
 *   % ever seen and its day.
 * - `bySlot` ('weekly-by-day'): the same, per 24-hour block from the reset.
 * A day whose first reading is unknown starts at its last one, so its rise
 * stays untracked rather than guessed.
 */
export function migrate(periodStart: number, offsetMs: number, byDate?: Legacy, bySlot?: Legacy): DayLog {
  const log = emptyLog(periodStart)
  const startDay = dayNumber(periodStart, offsetMs)
  const take = (src: Legacy | undefined, indexOf: (s: number) => number) => {
    if (!src || src.periodStart !== periodStart || !Array.isArray(src.marks)) return
    src.marks.forEach((m, s) => {
      if (typeof m !== 'number') return
      const i = indexOf(s)
      record(log, i, m)
      if (s === src.firstSlot && typeof src.firstPct === 'number') record(log, i, src.firstPct)
    })
  }
  take(bySlot, s => dayNumber(periodStart + s * DAY + DAY / 2, offsetMs) - startDay)
  take(byDate, s => s)
  return log
}
