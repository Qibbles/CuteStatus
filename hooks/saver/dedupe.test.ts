import { expect, test } from 'claude-code/testing'

import { SAVER_DEFAULTS } from './config'
import { diffOps, toLines, unifiedDiff } from './diff'
import { type Disk, hash, rangeKey, ReadTracker } from './dedupe'
import { bigSource } from './fixtures'

const CFG = SAVER_DEFAULTS.dedupe
const P = '/repo/a.py'

/** A file on a fake disk, and a session that reads it as Claude Code would. */
function world() {
  const t = new ReadTracker()
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let clock = 1000
  const write = (path: string, text: string) => files.set(path, { text, mtimeMs: (clock += 1000) })
  const disk = (path: string): Disk | null => {
    const f = files.get(path)
    return f ? { hash: hash(f.text), mtimeMs: f.mtimeMs, size: f.text.length } : null
  }
  /** One Read: denied, swapped for a diff, or read as is. */
  const read = (path: string, o: { scope?: string; offset?: number; limit?: number } = {}) => {
    const scope = o.scope ?? 'main'
    const rk = rangeKey(o.offset, o.limit)
    const pre = t.pre(scope, path, rk, disk(path))
    if (pre) return { kind: 'denied' as const, text: pre.deny }
    const all = files.get(path)?.text ?? ''
    const lines = all.split('\n')
    const start = (o.offset ?? 1) - 1
    const content = rk === 'full' ? all : lines.slice(start, start + (o.limit ?? lines.length)).join('\n')
    const post = t.post(scope, path, rk, { content, complete: rk === 'full' }, disk(path) as Disk, CFG)
    return post ? { kind: 'diff' as const, text: post.content } : { kind: 'read' as const, text: content }
  }
  return { t, write, read }
}

test('diff: equal → empty, one change → one small hunk with real line numbers', () => {
  const a = bigSource()
  expect(unifiedDiff(a, a)).toBe('')
  const d = unifiedDiff(a, a.replace('return 150\n', 'return 999\n')) ?? ''
  expect(d).toContain('-    return 150')
  expect(d).toContain('+    return 999')
  expect(d).toContain('@@ -450,5 +450,5 @@')
  expect(d.split('\n').length).toBeLessThan(12)
})

test('diff ops rebuild both sides exactly', () => {
  const a = toLines('a\nb\nc\nd\ne\n')
  const b = toLines('a\nx\nc\ne\nf\n')
  const ops = diffOps(a, b) ?? []
  expect(ops.filter(o => o.t !== '+').map(o => o.line)).toEqual(a)
  expect(ops.filter(o => o.t !== '-').map(o => o.line)).toEqual(b)
})

test('diff gives up past its edit budget', () => {
  expect(unifiedDiff('a\n'.repeat(50), 'b\n'.repeat(50), 2, 10)).toBe(null)
})

test('a repeat read of an unchanged file is denied, a second insistence allowed', () => {
  const w = world()
  w.write(P, bigSource())
  expect(w.read(P).kind).toBe('read')
  const r = w.read(P)
  expect(r.kind).toBe('denied')
  expect(r.text).toContain('unchanged since you last read it')
  expect(w.read(P).kind).toBe('read')
  expect(w.read(P).kind).toBe('denied')
})

test('a changed file comes back as a small diff, then counts as read', () => {
  const w = world()
  const text = bigSource()
  w.write(P, text)
  w.read(P)
  w.write(P, text.replace('return 150\n', 'return 999\n'))
  const r = w.read(P)
  expect(r.kind).toBe('diff')
  expect(r.text).toContain('changed since your last read')
  expect(r.text).toContain('+    return 999')
  expect(r.text.length).toBeLessThan(text.length / 5)
  expect(w.read(P).kind).toBe('denied')
})

test('a big change sends the whole file', () => {
  const w = world()
  w.write(P, bigSource())
  w.read(P)
  w.write(P, 'totally different\n'.repeat(500))
  expect(w.read(P).kind).toBe('read')
})

test('an edit makes the next read a full one', () => {
  const w = world()
  w.write(P, bigSource())
  w.read(P)
  w.t.forget('main', P)
  expect(w.read(P).kind).toBe('read')
})

test('ranges are tracked apart, and partial reads never get diffs', () => {
  const w = world()
  const text = bigSource()
  w.write(P, text)
  expect(w.read(P, { offset: 10, limit: 200 }).kind).toBe('read')
  expect(w.read(P, { offset: 10, limit: 200 }).kind).toBe('denied')
  expect(w.read(P, { offset: 300, limit: 200 }).kind).toBe('read')
  expect(w.read(P).kind).toBe('read')
  w.write(P, text.replace('return 1\n', 'return 10\n'))
  expect(w.read(P, { offset: 1, limit: 200 }).kind).toBe('read')
})

test('helpers and the main conversation are tracked apart; compaction resets', () => {
  const w = world()
  w.write(P, bigSource())
  w.read(P)
  expect(w.read(P, { scope: 'agent-1' }).kind).toBe('read')
  expect(w.read(P, { scope: 'agent-1' }).kind).toBe('denied')
  w.t.resetScope('main')
  expect(w.read(P).kind).toBe('read')
})

test('a touched file with the same content is read again; tiny files are never deduped', () => {
  const w = world()
  w.write(P, bigSource())
  w.read(P)
  w.write(P, bigSource())
  expect(w.read(P).kind).toBe('read')
  w.write('/repo/tiny', 'x\n')
  w.read('/repo/tiny')
  expect(w.read('/repo/tiny').kind).toBe('read')
})

test('a cut-short read is not used as a diff baseline', () => {
  const t = new ReadTracker()
  const text = bigSource()
  const d1 = { hash: hash(text), mtimeMs: 1, size: text.length }
  t.post('main', P, 'full', { content: text.slice(0, 500), complete: false }, d1, CFG)
  const text2 = text.replace('return 3\n', 'return 30\n')
  const d2 = { hash: hash(text2), mtimeMs: 2, size: text2.length }
  expect(t.post('main', P, 'full', { content: text2, complete: true }, d2, CFG)).toBe(null)
})
