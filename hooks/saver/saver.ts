// Token saver: works by itself under the hood. It condenses noisy tool output,
// skips unchanged re-reads and keeps Claude's replies terse; the band shows
// what it saved. Everything is local and it never calls the model.
//
// The band owns session.start, prompt.submit, agent.report and the catch-all
// tool.call (one unmatched hook per event per plugin) and calls the functions
// below from them; registerSaver adds the hooks no one else needs.

import type { EngineInterface, On } from 'claude-code'

import { resolveConfig, SAVER_DEFAULTS, type SaverConfig } from './config'
import { type Disk, hash, rangeKey, ReadTracker } from './dedupe'
import { filterText, RAW_HINT } from './filters'

const TERSE_ON =
  'Response style (terse mode): answer directly. No preamble, no restating the question, no closing recap ' +
  'or summary of what you just did, no pleasantries. Prefer short sentences and lists. When showing code ' +
  'changes in a reply, show only the changed lines as a diff or minimal snippet, not whole files. Never ' +
  'shorten code, commands, paths or error messages the user needs verbatim, and keep all information ' +
  'needed to act.'
const TERSE_OFF =
  'Terse mode is now off. Ignore the terse response-style instruction and use your normal style.'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const NOFILTER = /#\s*nofilter\b/

const T = {
  cfg: SAVER_DEFAULTS as SaverConfig,
  cwd: '',
  tracker: new ReadTracker(),
  /**
   * Terse as the system prompt was set when the session's settings were first
   * read (null before that); it never changes mid-session, for the prompt cache.
   */
  terseLatched: null as boolean | null,
  /** Terse as the model last heard it: the system prompt, then any on/off note since. */
  terseKnown: false,
  /** Estimated tokens kept out of this chat. */
  saved: 0,
}

const terseWanted = (c: SaverConfig) => c.enabled && c.terse
const scopeOf = (e: { agentId?: string }) => e.agentId ?? 'main'

/** What the band shows; it reads this on every redraw. */
export const saverSavings = () => ({ chat: T.saved, on: T.cfg.enabled })

/** From the band's session.start, before it reads the settings: a fresh chat. */
export function saverSessionStart(cwd: string): void {
  T.cwd = cwd
  T.tracker.resetAll()
  T.terseLatched = null
  T.saved = 0
}

/**
 * From the band's settings load: `section` is the `tokenSaver` part of
 * ~/.claude/kibbles.json; a project's .claude/kibbles.json overrides it.
 */
export async function saverLoadConfig($: EngineInterface, section: unknown): Promise<void> {
  let project: unknown
  if (T.cwd) {
    try {
      project = (JSON.parse(String(await $.fs.read(`${T.cwd}/.claude/kibbles.json`))) as { tokenSaver?: unknown })
        ?.tokenSaver
    } catch {
      /* no project settings */
    }
  }
  T.cfg = resolveConfig(section, project)
  if (T.terseLatched === null) {
    T.terseLatched = terseWanted(T.cfg)
    T.terseKnown = T.terseLatched
  }
}

/**
 * From the band's prompt.submit, after it reloaded the settings: a one-off note
 * when terse mode was switched in the settings file mid-chat, else null.
 */
export function saverPromptNote(): string | null {
  const want = terseWanted(T.cfg)
  if (want === T.terseKnown) return null
  T.terseKnown = want
  return want ? TERSE_ON : TERSE_OFF
}

/** From the band's agent.report: a finished helper's reads are forgotten. */
export function saverAgentReport(agentId: string): void {
  T.tracker.resetScope(agentId)
}

async function readDisk($: EngineInterface, path: string): Promise<{ real: string; disk: Disk } | null> {
  try {
    const st = await $.fs.stat(path, { resolve: true })
    if (st.kind !== 'file' || st.size > T.cfg.dedupe.maxFileBytes) return null
    const text = String(await $.fs.read(path))
    return { real: st.realPath ?? path, disk: { hash: hash(text), mtimeMs: st.mtimeMs, size: st.size } }
  } catch {
    return null
  }
}

async function realPath($: EngineInterface, path: string): Promise<string> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

const toolMatches = (tool: string) =>
  T.cfg.filter.tools.some(p => {
    try {
      return new RegExp(`^(?:${p})$`).test(tool)
    } catch {
      return false
    }
  })

type Tally = { before: number; after: number; changed: boolean }

/** Condenses a tool result: a string, a list of content blocks, or `{ content: [...] }`. */
function condense(v: unknown, tally: Tally): unknown {
  if (typeof v === 'string') {
    const r = filterText(v, T.cfg.filter)
    tally.before += r.before
    tally.after += r.after
    tally.changed ||= r.changed
    return r.text
  }
  if (Array.isArray(v)) {
    return v.map(b =>
      b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string'
        ? { ...b, text: condense((b as { text: string }).text, tally) }
        : b,
    )
  }
  if (v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content)) {
    return { ...v, content: condense((v as { content: unknown[] }).content, tally) }
  }
  return v
}

/** From the band's catch-all tool.call, after the tool ran: the result Claude should see. */
export async function saverAfterToolCall<R extends { deny?: string; isError?: boolean; result?: unknown }>(
  $: EngineInterface,
  e: { tool: string; agentId?: string },
  ran: R,
): Promise<R> {
  if (!T.cfg.enabled) return ran
  if (EDIT_TOOLS.has(e.tool)) {
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    const p = input.file_path ?? input.notebook_path
    if (typeof p === 'string') T.tracker.forget(scopeOf(e), await realPath($, p))
    return ran
  }
  if (ran.deny !== undefined || !T.cfg.filter.enabled || !toolMatches(e.tool)) return ran
  const tally: Tally = { before: 0, after: 0, changed: false }
  let result: unknown
  if (e.tool === 'Bash') {
    const cmd = (e as unknown as { command?: unknown }).command
    const r = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
    if (typeof cmd === 'string' && NOFILTER.test(cmd)) return ran
    if (!r || typeof r !== 'object' || (typeof r.stdout !== 'string' && typeof r.stderr !== 'string')) return ran
    const out: Record<string, unknown> = { ...r }
    for (const k of ['stdout', 'stderr'] as const) if (typeof r[k] === 'string') out[k] = condense(r[k], tally)
    if (tally.changed) {
      const k = out.stdout ? 'stdout' : 'stderr'
      out[k] = `${String(out[k]).replace(/\n+$/, '')}\n${RAW_HINT}`
    }
    result = out
  } else {
    result = condense(ran.result, tally)
  }
  if (!tally.changed) return ran
  T.saved += tally.before - tally.after
  return { ...ran, result }
}

/** The saver's own hooks: events the band does not hook unmatched. */
export function registerSaver(on: On): void {
  // Terse mode lives in the system prompt, fixed for the whole session so the
  // prompt cache is never invalidated; mid-session changes go as a one-off note.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!T.terseLatched) return r
    return { sections: [...r.sections, { id: 'kibbles:terse', text: TERSE_ON, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // Compaction rebuilds the conversation: what was read is no longer in it.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if ('messages' in r && r.messages) {
      T.tracker.resetScope(scopeOf(e))
      if (e.agentId === undefined) T.terseKnown = T.terseLatched ?? false
    }
    return r
  })

  // Re-reads: deny an unchanged repeat; swap a changed full read for a diff.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const d = T.cfg.dedupe
    if (!T.cfg.enabled || !d.enabled) return next(e)
    const scope = scopeOf(e)
    const rk = rangeKey(e.offset, e.limit)
    const before = await readDisk($, e.file_path)
    const denied = before ? T.tracker.pre(scope, before.real, rk, before.disk) : null
    if (denied) {
      T.saved += denied.saved
      return { deny: denied.deny }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const r = ran.result as
      | { type?: string; file?: { content?: unknown; startLine?: number; numLines?: number; totalLines?: number; truncatedByTokenCap?: boolean } }
      | undefined
    const f = r?.file
    if (r?.type !== 'text' || !f || typeof f.content !== 'string') return ran
    const after = await readDisk($, e.file_path)
    if (!after) return ran
    const complete =
      rk === 'full' && (f.startLine ?? 1) === 1 && (f.numLines ?? 0) >= (f.totalLines ?? 0) && !f.truncatedByTokenCap
    const swap = T.tracker.post(scope, after.real, rk, { content: f.content, complete }, after.disk, d)
    if (!swap) return ran
    T.saved += swap.saved
    const numLines = swap.content.split('\n').length
    return { ...ran, result: { ...r, file: { ...f, content: swap.content, numLines } } } as typeof ran
  }).catch(($, e, next) => next(e))
}
