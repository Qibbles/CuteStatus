// Token saver: lossy-but-safe text filters for tool output.
//
// Invariant: a line matching the protect pattern (error/fail/warn/...) is never
// dropped or shortened. Exact duplicates of a protected line may be collapsed
// into one copy plus a count, which loses no information.

import type { FilterConfig } from './config'

export const estimate = (text: string): number => (text ? Math.ceil(text.length / 4) : 0)

export const RAW_HINT =
  '[cute-status token saver: output condensed. Omitted lines were not shown to you; never reconstruct ' +
  "or guess them. If you need them, re-run the command with the comment '# nofilter'.]"

export type FilterResult = { text: string; before: number; after: number; changed: boolean }

const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
const PCT_RE = /\d{1,3}(?:\.\d+)?\s?%/
const UNICODE_BAR_RE = /[█▉▊▋▌▍▎▏━░▒▓■]/
const ASCII_BAR_RE = /\[[#=>.\- ]{5,}\]|[#=]{3,}>?/
const RATE_RE = /\beta\b|\d\s?[kKmMgG]?i?[bB]\/s|it\/s|s\/it/i
const SPINNER_RE = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/
const NEVER = /(?!x)x/

const protectCache = new Map<string, RegExp>()
export function protectRe(cfg: Pick<FilterConfig, 'protectPattern'>): RegExp {
  const pat = cfg.protectPattern || NEVER.source
  let re = protectCache.get(pat)
  if (!re) {
    try {
      re = new RegExp(pat, 'i')
    } catch {
      re = /error|fail|warn|traceback|exception|panic|fatal|assert/i
    }
    protectCache.set(pat, re)
  }
  return re
}

export const stripAnsi = (text: string): string => text.replace(ANSI_RE, '')

function isProgress(line: string): boolean {
  if (SPINNER_RE.test(line)) return true
  if (!PCT_RE.test(line)) return false
  return UNICODE_BAR_RE.test(line) || ASCII_BAR_RE.test(line) || RATE_RE.test(line)
}

/** Resolve carriage-return overwrites, then drop progress-bar lines. */
export function stripProgress(text: string, cfg: Pick<FilterConfig, 'protectPattern'>): string {
  const protect = protectRe(cfg)
  const out: string[] = []
  for (let line of text.split('\n')) {
    if (line.includes('\r')) {
      const segs = line.split('\r').filter(s => s.trim())
      line = segs[segs.length - 1] ?? ''
    }
    if (isProgress(line) && !protect.test(line)) continue
    out.push(line)
  }
  return out.join('\n')
}

const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length

/**
 * Collapse runs of identical lines, or text-heavy lines differing only in
 * numbers (timestamps, counters): first, a marker, last. Number-only data
 * (seq output, numeric CSV) and protected lines only collapse when identical.
 */
export function collapseRepeats(lines: string[], cfg: FilterConfig): string[] {
  const protect = protectRe(cfg)
  const minRun = Math.max(cfg.minRepeat, 4)
  const key = (l: string): string => {
    const s = l.trimEnd()
    if (protect.test(s)) return `=${s}`
    const norm = s.replace(/\d+/g, '#')
    if (norm !== s && letters(norm) < 6) return `=${s}`
    return `~${norm}`
  }
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const k = key(lines[i] ?? '')
    let j = i + 1
    while (j < lines.length && key(lines[j] ?? '') === k) j++
    const run = j - i
    if (run >= minRun && (lines[i] ?? '').trim()) {
      const identical = lines.slice(i, j).every(l => l === lines[i])
      out.push(lines[i] ?? '')
      out.push(identical ? `[line repeated ${run - 2} more times]` : `[${run - 2} similar lines collapsed, not shown]`)
      out.push(lines[j - 1] ?? '')
    } else {
      out.push(...lines.slice(i, j))
    }
    i = j
  }
  return out
}

export function cutLongLines(lines: string[], cfg: FilterConfig): string[] {
  const limit = cfg.maxLineChars
  const protect = protectRe(cfg)
  const half = Math.floor(limit / 2)
  return lines.map(l =>
    l.length > limit && !protect.test(l)
      ? `${l.slice(0, half)} …[${l.length - 2 * half} chars trimmed]… ${l.slice(l.length - half)}`
      : l,
  )
}

export function headTail(lines: string[], cfg: FilterConfig): string[] {
  const n = lines.length
  if (n <= cfg.maxLines) return lines
  const protect = protectRe(cfg)
  const out: string[] = []
  let gap = 0
  lines.forEach((l, i) => {
    if (i < cfg.headLines || i >= n - cfg.tailLines || protect.test(l)) {
      if (gap) out.push(`[${gap} lines trimmed]`)
      gap = 0
      out.push(l)
    } else {
      gap++
    }
  })
  if (gap) out.push(`[${gap} lines trimmed]`)
  return out
}

function trimJson(v: unknown, cfg: FilterConfig, protect: RegExp): unknown {
  if (typeof v === 'string') {
    return v.length > cfg.jsonMaxString && !protect.test(v)
      ? `${v.slice(0, cfg.jsonMaxString)}…[${v.length - cfg.jsonMaxString} chars trimmed]`
      : v
  }
  if (Array.isArray(v)) {
    if (v.length <= cfg.jsonMaxArray) return v.map(x => trimJson(x, cfg, protect))
    const k = Math.max(Math.floor(cfg.jsonMaxArray / 2), 1)
    const middle = v.slice(k, v.length - k)
    const keptMid = middle.filter(x => protect.test(JSON.stringify(x)))
    const items = [...v.slice(0, k), ...keptMid, ...v.slice(v.length - k)].map(x => trimJson(x, cfg, protect))
    items.splice(k, 0, `[${middle.length - keptMid.length} items trimmed]`)
    return items
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimJson(x, cfg, protect)]))
  }
  return v
}

/** Compact, trimmed JSON, or null when the text is not a JSON object/array. */
export function trimJsonText(text: string, cfg: FilterConfig): string | null {
  const s = text.trim()
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null
  let obj: unknown
  try {
    obj = JSON.parse(s)
  } catch {
    return null
  }
  return JSON.stringify(trimJson(obj, cfg, protectRe(cfg)))
}

/** Protected lines (or protected JSON string values) of `before` missing from `after`. */
export function lostProtected(before: string, after: string, cfg: FilterConfig): string[] {
  const protect = protectRe(cfg)
  const s = before.trim()
  if (s[0] === '{' || s[0] === '[') {
    try {
      const leaves: string[] = []
      const walk = (o: unknown): void => {
        if (typeof o === 'string') {
          if (protect.test(o)) leaves.push(o)
        } else if (Array.isArray(o)) o.forEach(walk)
        else if (o && typeof o === 'object') Object.values(o).forEach(walk)
      }
      walk(JSON.parse(s))
      return leaves.filter(v => !after.includes(JSON.stringify(v).slice(1, -1)))
    } catch {
      /* not JSON: fall through to lines */
    }
  }
  const seen: string[] = []
  for (const raw of stripAnsi(before).replace(/\r/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line && protect.test(line) && !after.includes(line) && !seen.includes(line)) seen.push(line)
  }
  return seen
}

/** The full pipeline. Returns the original text when the saving is too small. */
export function filterText(text: string, cfg: FilterConfig): FilterResult {
  const before = estimate(text)
  if (!text) return { text, before, after: before, changed: false }
  let t = cfg.stripAnsi ? stripAnsi(text) : text
  let out = trimJsonText(t, cfg)
  if (out === null) {
    if (cfg.stripProgress) t = stripProgress(t, cfg)
    const trailing = t.endsWith('\n')
    let lines = (trailing ? t.slice(0, -1) : t).split('\n')
    if (cfg.collapseRepeats) lines = collapseRepeats(lines, cfg)
    lines = cutLongLines(lines, cfg)
    lines = headTail(lines, cfg)
    out = lines.join('\n') + (trailing ? '\n' : '')
  }
  const after = estimate(out)
  if (before - after < cfg.minSavingsTokens || after >= before) return { text, before, after: before, changed: false }
  return { text: out, before, after, changed: true }
}
