// A small Myers line diff with unified output (no difflib in this runtime).

type Op = { t: ' ' | '-' | '+'; line: string }

/** Lines of `text`, a final newline not counting as an empty last line. */
export function toLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The edit script from `a` to `b`, or null when they differ by more than `maxD` lines. */
export function diffOps(a: string[], b: string[], maxD = 2000): Op[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, maxD)
  const off = max + 1
  let v: Int32Array = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0)) ? (v[off + k + 1] ?? 0) : (v[off + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return null
  // Walk back through the saved frontiers.
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    v = trace[d] as Int32Array
    const k = x - y
    const prevK = k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0)) ? k + 1 : k - 1
    const prevX = v[off + prevK] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) ops.push({ t: ' ', line: a[--x] ?? '' }), y--
    if (x === prevX) ops.push({ t: '+', line: b[--y] ?? '' })
    else ops.push({ t: '-', line: a[--x] ?? '' })
  }
  while (x > 0 && y > 0) ops.push({ t: ' ', line: a[--x] ?? '' }), y--
  return ops.reverse()
}

/** A unified diff of `before` → `after` with `context` lines; '' when equal, null when too different. */
export function unifiedDiff(before: string, after: string, context = 2, maxD = 2000): string | null {
  const a = toLines(before)
  const b = toLines(after)
  const ops = diffOps(a, b, maxD)
  if (!ops) return null
  if (ops.every(o => o.t === ' ')) return ''
  const out = ['--- before', '+++ after']
  // Positions of each op in a and b (1-based line numbers).
  const pos: { ai: number; bi: number }[] = []
  let ai = 1
  let bi = 1
  for (const o of ops) {
    pos.push({ ai, bi })
    if (o.t !== '+') ai++
    if (o.t !== '-') bi++
  }
  let i = 0
  while (i < ops.length) {
    if (ops[i]?.t === ' ') {
      i++
      continue
    }
    // A hunk: from `context` lines before this change to `context` after the last change near it.
    const start = Math.max(0, i - context)
    let end = i
    let lastChange = i
    while (end < ops.length) {
      if (ops[end]?.t !== ' ') lastChange = end
      else if (end - lastChange > 2 * context) break
      end++
    }
    end = Math.min(ops.length, lastChange + context + 1)
    const hunk = ops.slice(start, end)
    const p = pos[start] ?? { ai: 1, bi: 1 }
    const aLen = hunk.filter(o => o.t !== '+').length
    const bLen = hunk.filter(o => o.t !== '-').length
    out.push(`@@ -${aLen ? p.ai : p.ai - 1},${aLen} +${bLen ? p.bi : p.bi - 1},${bLen} @@`)
    for (const o of hunk) out.push(o.t + o.line)
    i = end
  }
  return out.join('\n') + '\n'
}
