import { expect, test } from 'claude-code/testing'

import { dayNumber, dayParts, emptyLog, migrate, record } from './days'

const HOUR = 3600_000
const DAY = 24 * HOUR
const SGT = 8 * HOUR
// Wed 18 Nov 2026, 21:00 in Singapore: the week's reset.
const START = Date.UTC(2026, 10, 18, 13, 0)
const startDay = dayNumber(START, SGT)
const weekdayOf = (i: number) => new Date((startDay + i) * DAY).getUTCDay()

test('a day counts only what rose while Kibbles saw it; the rest is untracked', () => {
  const log = emptyLog(START)
  // Sunday (day 4): seen from 63% to 68%.
  record(log, 4, 63)
  record(log, 4, 66)
  record(log, 4, 68)
  // Kibbles not running Sunday night and Monday; Tuesday (day 6): 84% to 86%.
  record(log, 6, 84)
  record(log, 6, 86)
  expect(dayParts(log, 6, weekdayOf)).toEqual([
    { weekday: null, pct: 63, today: false },
    { weekday: 0, pct: 5, today: false },
    { weekday: null, pct: 16, today: false },
    { weekday: 2, pct: 2, today: true },
  ])
})

test('days line up with the calendar in the configured time zone', () => {
  expect(weekdayOf(0)).toBe(3) // Wednesday
  expect(weekdayOf(4)).toBe(0) // Sunday
  expect(dayNumber(Date.UTC(2026, 10, 24, 1, 36), SGT) - startDay).toBe(6) // Tue 09:36 SGT
})

test('older records carry over instead of starting the week again', () => {
  // As 3.1.x kept them: per 24-hour block from the reset, and per calendar day.
  const bySlot = { periodStart: START, firstSlot: 3, firstPct: 63, marks: [null, null, null, 68, null, null, null] }
  const byDate = { periodStart: START, firstSlot: 6, firstPct: 84, marks: [null, null, null, null, null, null, 86, null] }
  const log = migrate(START, SGT, byDate, bySlot)
  // Block 3 (Sat 21:00 to Sun 21:00) lands on Sunday.
  expect(log.first[4]).toBe(63)
  expect(log.last[4]).toBe(68)
  expect(log.first[6]).toBe(84)
  expect(log.last[6]).toBe(86)
  // A record from another week is ignored.
  expect(migrate(START + 7 * DAY, SGT, byDate, bySlot).first.every(v => v === null)).toBe(true)
})
