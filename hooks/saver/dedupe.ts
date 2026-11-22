// Token saver: re-read dedupe. Remembers what each conversation (the main one
// and each helper, which has its own context) has read of each file.
//
// - An exact repeat of a read of an unchanged file (same hash and mtime) is
//   denied with a short note; the file is never re-read, so Claude Code's own
//   "file was read" record stays valid for Edit. Asked again straight after,
//   the read goes through.
// - A changed file's full read runs (so Edit keeps working), then its content
//   is swapped for a diff against what the conversation last saw, when small.

import type { DedupeConfig } from './config'
import { unifiedDiff } from './diff'
import { estimate } from './filters'

export type Disk = { hash: string; mtimeMs: number; size: number }

type Entry = {
  hash: string
  mtimeMs: number
  /** Range key → estimated tokens of what that read returned. */
  ranges: Map<string, number>
  /** The whole file as the conversation last saw it, when it saw all of it. */
  full: string | null
  denied: Set<string>
}

const diffHeader = (path: string) =>
  `[Kibbles token saver] ${path} changed since your last read. Unified diff against the version you ` +
  'already have (the line numbers at the start of each line in this result belong to the note, not the ' +
  'file; the @@ headers give real file lines):'

const unchangedNote = (path: string, range: string) =>
  `[Kibbles token saver] ${path} (${range}) is unchanged since you last read it in this conversation; ` +
  'use the content you already have. If you truly need it again, repeat the same Read and it will be allowed.'

/** 64-bit FNV-1a over UTF-16 units, as hex: equality checks only. */
export function hash(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x5bd1e995)
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

export function rangeKey(offset: unknown, limit: unknown): string {
  const off = typeof offset === 'number' ? offset : undefined
  const lim = typeof limit === 'number' ? limit : undefined
  if ((off === undefined || off <= 1) && lim === undefined) return 'full'
  return `${off ?? 1}:${lim ?? ''}`
}

const rangeLabel = (rk: string) => {
  if (rk === 'full') return 'whole file'
  const [off, lim] = rk.split(':')
  return `offset ${off}${lim ? `, limit ${lim}` : ''}`
}

export class ReadTracker {
  private scopes = new Map<string, Map<string, Entry>>()

  private scope(id: string): Map<string, Entry> {
    let s = this.scopes.get(id)
    if (!s) this.scopes.set(id, (s = new Map()))
    return s
  }

  /** Before a Read: a deny note and the tokens it saves, or null to let it run. */
  pre(scope: string, path: string, rk: string, disk: Disk | null): { deny: string; saved: number } | null {
    const e = this.scopes.get(scope)?.get(path)
    if (!e || !disk) return null
    const tokens = e.ranges.get(rk)
    if (tokens === undefined || disk.hash !== e.hash || disk.mtimeMs !== e.mtimeMs) return null
    if (e.denied.has(rk)) {
      e.denied.delete(rk) // asked again right after a denial: let it through
      return null
    }
    e.denied.add(rk)
    const deny = unchangedNote(path, rangeLabel(rk))
    return { deny, saved: Math.max(0, tokens - estimate(deny)) }
  }

  /**
   * After a Read: record what the conversation saw. For a changed file read in
   * full, returns the diff to show instead and the tokens that saves.
   */
  post(
    scope: string,
    path: string,
    rk: string,
    read: { content: string; complete: boolean },
    disk: Disk,
    cfg: DedupeConfig,
  ): { content: string; saved: number } | null {
    const s = this.scope(scope)
    const prev = s.get(path)
    const same = prev?.hash === disk.hash
    const est = estimate(read.content)
    let swapped: { content: string; saved: number } | null = null

    if (cfg.diff && read.complete && prev && !same && prev.full !== null) {
      const diff = unifiedDiff(prev.full, read.content)
      if (diff) {
        const content = `${diffHeader(path)}\n${diff}`
        if (content.length < cfg.maxDiffRatio * read.content.length) {
          swapped = { content, saved: est - estimate(content) }
        }
      }
    }

    const ranges = est < cfg.minTokens ? new Map<string, number>() : same && prev ? new Map(prev.ranges) : new Map()
    if (est >= cfg.minTokens) ranges.set(rk, est)
    const full =
      read.complete && read.content.length <= cfg.maxStoreBytes ? read.content : same && prev ? prev.full : null
    const denied = same && prev ? new Set([...prev.denied].filter(d => d !== rk)) : new Set<string>()
    s.set(path, { hash: disk.hash, mtimeMs: disk.mtimeMs, ranges, full, denied })
    return swapped
  }

  /** After an edit: the conversation's next read of the file is a full one. */
  forget(scope: string, path: string): void {
    this.scopes.get(scope)?.delete(path)
  }

  resetScope(scope: string): void {
    this.scopes.delete(scope)
  }

  resetAll(): void {
    this.scopes.clear()
  }
}
