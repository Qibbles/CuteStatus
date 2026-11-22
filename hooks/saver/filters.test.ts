import { expect, test } from 'claude-code/testing'

import { SAVER_DEFAULTS } from './config'
import * as F from './filters'
import * as fx from './fixtures'

const CFG = SAVER_DEFAULTS.filter
const ANY = { ...CFG, minSavingsTokens: 0 }

const noLoss = (before: string, after: string) => expect(F.lostProtected(before, after, CFG)).toEqual([])

test('lostProtected detects a dropped error line or JSON value', () => {
  expect(F.lostProtected('ok\nerror: boom\n', 'ok\n', CFG)).toEqual(['error: boom'])
  expect(F.lostProtected('{"a": "fatal x"}', '{"a":"y"}', CFG)).toEqual(['fatal x'])
  expect(F.lostProtected('error: boom', 'x error: boom y', CFG)).toEqual([])
})

test('stripAnsi removes colours and hyperlinks, keeps the text', () => {
  const out = F.stripAnsi(fx.ansiBuild())
  expect(out.includes('\x1b')).toBe(false)
  expect(out).toContain('error[E0308]: mismatched types')
  expect(out).toContain('link done')
  expect(F.stripAnsi('hello\nworld')).toBe('hello\nworld')
})

test('progress bars go, results and warnings stay', () => {
  expect(F.stripProgress('a\r b\r final\nnext', CFG)).toBe(' final\nnext')
  const out = F.stripProgress(fx.progressPip(), CFG)
  expect(out.includes('%')).toBe(false)
  expect(out.includes('\r')).toBe(false)
  expect(out).toContain('Successfully installed numpy-1.0')
  expect(out).toContain('WARNING: pip is out of date')
  expect(out).toContain('Collecting pandas')
})

test('pytest percent lines are not progress bars; a progress line with an error stays', () => {
  const s = 'tests/a.py::t PASSED      [ 50%]\ntests/a.py ....F....  [ 40%]\n'
  expect(F.stripProgress(s, CFG)).toBe(s)
  expect(F.stripProgress('[####......] 40% error: checksum mismatch\n', CFG)).toContain('checksum mismatch')
})

test('exact repeats collapse with a count', () => {
  const out = F.collapseRepeats(['x', 'Retrying...', 'Retrying...', 'Retrying...', 'Retrying...', 'y'], CFG)
  expect(out[0]).toBe('x')
  expect(out[out.length - 1]).toBe('y')
  expect(out.filter(l => l === 'Retrying...').length).toBe(2)
  expect(out.some(l => l.includes('repeated'))).toBe(true)
})

test('log lines differing only in numbers collapse to first, marker, last', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `12:00:${String(i).padStart(2, '0')} INFO tick ${i}`)
  const out = F.collapseRepeats(lines, CFG)
  expect(out.length).toBe(3)
  expect(out[0]).toBe(lines[0])
  expect(out[2]).toBe(lines[49])
  expect(out[1]).toContain('48 similar lines collapsed, not shown')
})

test('numeric data, short runs and distinct error lines are never collapsed', () => {
  const nums = Array.from({ length: 100 }, (_, i) => String(i))
  expect(F.collapseRepeats(nums, CFG)).toEqual(nums)
  const rows = Array.from({ length: 100 }, (_, i) => `${i},ab,${i * 2}`)
  expect(F.collapseRepeats(rows, CFG)).toEqual(rows)
  expect(F.collapseRepeats(['a', 'a', 'b'], CFG)).toEqual(['a', 'a', 'b'])
  const errs = Array.from({ length: 10 }, (_, i) => `error at line ${i}`)
  expect(F.collapseRepeats(errs, CFG)).toEqual(errs)
})

test('the log fixture collapses but keeps its error', () => {
  const out = F.collapseRepeats(fx.repeatedLogs().split('\n'), CFG)
  expect(out.length).toBeLessThan(12)
  expect(out.some(l => l.includes('ERROR worker crashed'))).toBe(true)
})

test('head/tail keeps both ends, protected middle lines and a trimmed count', () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`)
  lines[500] = 'Traceback (most recent call last):'
  const out = F.headTail(lines, CFG)
  expect(out.slice(0, CFG.headLines)).toEqual(lines.slice(0, CFG.headLines))
  expect(out.slice(-CFG.tailLines)).toEqual(lines.slice(-CFG.tailLines))
  expect(out).toContain('Traceback (most recent call last):')
  const trimmed = out.map(l => /^\[(\d+) lines trimmed\]$/.exec(l)).reduce((n, m) => n + (m ? Number(m[1]) : 0), 0)
  expect(trimmed + out.filter(l => !l.endsWith('trimmed]')).length).toBe(1000)
  expect(F.headTail(['a', 'b'], CFG)).toEqual(['a', 'b'])
})

test('long lines are cut in the middle unless protected', () => {
  const [cut] = F.cutLongLines(['x'.repeat(10_000)], CFG)
  expect((cut ?? '').length).toBeLessThan(2200)
  expect(cut).toContain('chars trimmed')
  const err = 'error: ' + 'y'.repeat(5000)
  expect(F.cutLongLines([err], CFG)).toEqual([err])
})

test('JSON: long strings and arrays shrink, protected values stay whole', () => {
  const raw = fx.bigJson()
  const out = F.trimJsonText(raw, CFG) ?? ''
  expect(out.length).toBeLessThan(raw.length / 5)
  const data = JSON.parse(out) as { total_count: number; items: unknown[] }
  expect(data.total_count).toBe(120)
  expect(data.items.some(x => String(x).includes('items trimmed'))).toBe(true)
  expect(out).toContain("TypeError: cannot read property 'x' of undefined")
  expect(out.split('at foo.js:1').length - 1).toBe(80)
  expect(F.trimJsonText('not json {', CFG)).toBe(null)
  expect(F.trimJsonText('123', CFG)).toBe(null)
})

test('small or clean output passes through untouched', () => {
  const clean = fx.shortClean()
  expect(F.filterText(clean, CFG)).toEqual({ text: clean, before: F.estimate(clean), after: F.estimate(clean), changed: false })
  const tiny = '\x1b[32mok\x1b[0m\n'
  expect(F.filterText(tiny, CFG).text).toBe(tiny)
})

test('a step can be turned off', () => {
  expect(F.filterText(fx.ansiBuild(), { ...ANY, stripAnsi: false }).text).toContain('\x1b[')
})

test('every fixture shrinks and loses no protected line', () => {
  for (const [name, make] of Object.entries(fx.ALL)) {
    const raw = make()
    const res = F.filterText(raw, ANY)
    expect([name, res.after < res.before]).toEqual([name, true])
    noLoss(raw, res.text)
  }
})

test('a 900-test pytest log keeps its failure in under a tenth of the tokens', () => {
  const res = F.filterText(fx.longPytest(), CFG)
  expect(res.after).toBeLessThan(res.before * 0.1)
  expect(res.text).toContain('FAILED tests/test_core.py::test_parse - AssertionError: assert 3 == 2')
  expect(res.text).toContain('1 failed, 899 passed')
})
