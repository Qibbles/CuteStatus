// Token saver: the hooks. It condenses noisy tool output, dedupes re-reads,
// keeps Claude's replies terse, and reports what it saved to the band.
// Everything is local and it never calls the model.

import type { EngineInterface, On } from 'claude-code'

import { isKnownKey, resolveConfig, SAVER_DEFAULTS, type SaverConfig, setDotted } from './config'
import { type Disk, hash, rangeKey, ReadTracker } from './dedupe'
import { filterText, RAW_HINT } from './filters'

export const TERSE_ON =
  'Response style (terse mode): answer directly. No preamble, no restating the question, no closing recap ' +
  'or summary of what you just did, no pleasantries. Prefer short sentences and lists. When showing code ' +
  'changes in a reply, show only the changed lines as a diff or minimal snippet, not whole files. Never ' +
  'shorten code, commands, paths or error messages the user needs verbatim, and keep all information ' +
  'needed to act.'
export const TERSE_OFF =
  'Terse mode is now off. Ignore the terse response-style instruction and use your normal style.'

export type Savings = { task: number; chat: number; on: boolean }
type Kind = 'filter' | 'dedupe'

const STORE_KEY = 'tokens-saved'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const NOFILTER = /#\s*nofilter\b/

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))

const T = {
  cfg: SAVER_DEFAULTS as SaverConfig,
  cwd: '',
  home: '/root',
  tracker: new ReadTracker(),
  /** Terse as the system prompt was set at session start; it never changes mid-session (cache). */
  terseLatched: false,
  /** Terse as the model last heard it (system prompt, then any on/off note since). */
  terseKnown: false,
  task: 0,
  chat: { filter: 0, dedupe: 0, rewrites: 0 },
  allTime: { total: 0, filter: 0, dedupe: 0 },
}

const terseWanted = (c: SaverConfig) => c.enabled && c.terse
const scopeOf = (e: { agentId?: string }) => e.agentId ?? 'main'
const userPath = () => `${T.home}/.claude/cute-status.json`
const projectPath = () => `${T.cwd}/.claude/cute-status.json`

async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown>> {
  try {
    const v: unknown = JSON.parse(String(await $.fs.read(path)))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function loadConfig($: EngineInterface): Promise<void> {
  const user = await readJson($, userPath())
  const project: Record<string, unknown> = T.cwd ? await readJson($, projectPath()) : {}
  T.cfg = resolveConfig(user.tokenSaver, project.tokenSaver)
}

/** Writes one setting into the tokenSaver section of the user or project file. */
async function saveSetting($: EngineInterface, scope: 'user' | 'project', key: string, value: unknown): Promise<string> {
  const path = scope === 'user' ? userPath() : projectPath()
  const file = await readJson($, path)
  const section = (file.tokenSaver && typeof file.tokenSaver === 'object' ? file.tokenSaver : {}) as Record<string, unknown>
  file.tokenSaver = setDotted(section, key, value)
  await $.fs.write(path, JSON.stringify(file, null, 2) + '\n')
  await loadConfig($)
  return path
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

/** Filters an MCP result: a string, a list of content blocks, or `{ content: [...] }`. */
function filterMcp(v: unknown, tally: { before: number; after: number; changed: boolean }): unknown {
  const run = (s: string) => {
    const r = filterText(s, T.cfg.filter)
    tally.before += r.before
    tally.after += r.after
    tally.changed ||= r.changed
    return r.text
  }
  if (typeof v === 'string') return run(v)
  if (Array.isArray(v)) {
    return v.map(b =>
      b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string'
        ? { ...b, text: run((b as { text: string }).text) }
        : b,
    )
  }
  if (v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content)) {
    return { ...v, content: filterMcp((v as { content: unknown[] }).content, tally) }
  }
  return v
}

export function savingsReport(): string {
  const c = T.cfg
  const chat = T.chat.filter + T.chat.dedupe
  if (!c.enabled) return 'Token saver: off. Turn it on with /tokensaver on.'
  return [
    `Token saver (on, terse ${terseWanted(c) ? 'on' : 'off'}): estimated tokens saved`,
    `  This task:  ${fmt(T.task)}`,
    `  This chat:  ${fmt(chat)}  (output filter ${fmt(T.chat.filter)} · re-reads ${fmt(T.chat.dedupe)} · ${T.chat.rewrites} rewrites)`,
    `  All time:   ${fmt(T.allTime.total)}`,
    '  Estimates at ~4 characters a token. Shorter replies from terse mode are not counted.',
  ].join('\n')
}

/** The totals the band shows; it reads them on every redraw. */
export const saverSavings = (): Savings => ({ task: T.task, chat: T.chat.filter + T.chat.dedupe, on: T.cfg.enabled })

function record($: EngineInterface, kind: Kind, n: number): void {
  if (n <= 0) return
  T.task += n
  T.chat[kind] += n
  T.chat.rewrites += 1
  T.allTime.total += n
  T.allTime[kind] += n
  $.store.set(STORE_KEY, { ...T.allTime }).catch(() => undefined)
}

// The band owns session.start, prompt.submit, agent.report and the catch-all
// tool.call (one unmatched hook per event per plugin); it calls these from them.

/** From the band's session.start. */
export async function saverSessionStart($: EngineInterface, cwd: string): Promise<void> {
  T.cwd = cwd
  T.home = (await $.env.get('HOME')) ?? '/root'
  await loadConfig($)
  T.tracker.resetAll()
  T.terseLatched = terseWanted(T.cfg)
  T.terseKnown = T.terseLatched
  T.task = 0
  T.chat = { filter: 0, dedupe: 0, rewrites: 0 }
  const saved = (await $.store.get(STORE_KEY)) as typeof T.allTime | undefined
  if (saved && typeof saved.total === 'number') T.allTime = { ...T.allTime, ...saved }
  for (const c of [
    { name: 'savings', description: 'Tokens saved by the token saver: this task, this chat, all time' },
    { name: 'terse', description: 'Terse replies: on, off or status (--project for this project only)', argumentHint: '[on|off|status] [--project]' },
    {
      name: 'tokensaver',
      description: 'Token saver on or off for this project (--global for all), status, or set <key> <value>',
      argumentHint: '[on|off|status|set <key> <value>] [--global]',
    },
  ]) {
    await $.command.register({ ...c, immediate: true })
  }
}

/**
 * From the band's prompt.submit, for a prompt the person typed (not a command):
 * a new task starts; returns a one-off terse on/off note to attach, if any.
 */
export async function saverPromptSubmit($: EngineInterface): Promise<string | null> {
  await loadConfig($)
  T.task = 0
  const want = terseWanted(T.cfg)
  if (want === T.terseKnown) return null
  T.terseKnown = want
  return want ? TERSE_ON : TERSE_OFF
}

/** From the band's agent.report: a finished helper's reads are forgotten. */
export function saverAgentReport(agentId: string): void {
  T.tracker.resetScope(agentId)
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
  const tally = { before: 0, after: 0, changed: false }
  let result: unknown
  if (e.tool === 'Bash') {
    const cmd = (e as unknown as { command?: unknown }).command
    const r = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
    if (typeof cmd === 'string' && NOFILTER.test(cmd)) return ran
    if (!r || typeof r !== 'object' || (typeof r.stdout !== 'string' && typeof r.stderr !== 'string')) return ran
    const out: Record<string, unknown> = { ...r }
    for (const k of ['stdout', 'stderr'] as const) {
      const v = r[k]
      if (typeof v === 'string') out[k] = filterMcp(v, tally)
    }
    if (tally.changed) {
      const k = out.stdout ? 'stdout' : 'stderr'
      out[k] = `${String(out[k]).replace(/\n+$/, '')}\n${RAW_HINT}`
    }
    result = out
  } else {
    result = filterMcp(ran.result, tally)
  }
  if (!tally.changed) return ran
  record($, 'filter', tally.before - tally.after)
  return { ...ran, result }
}

/** Registers the saver's own hooks: events the band does not hook unmatched. */
export function registerSaver(on: On): void {
  // Terse mode lives in the system prompt, fixed for the whole session so the
  // prompt cache is never invalidated; mid-session changes go as a one-off note.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!T.terseLatched) return r
    return { sections: [...r.sections, { id: 'cute-status:terse', text: TERSE_ON, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // Compaction rebuilds the conversation: what was read is no longer in it.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if ('messages' in r && r.messages) {
      T.tracker.resetScope(scopeOf(e))
      if (e.agentId === undefined) T.terseKnown = T.terseLatched
    }
    return r
  })

  // --- re-read dedupe ---

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const d = T.cfg.dedupe
    if (!T.cfg.enabled || !d.enabled) return next(e)
    const scope = scopeOf(e)
    const rk = rangeKey(e.offset, e.limit)
    const before = await readDisk($, e.file_path)
    const denied = before ? T.tracker.pre(scope, before.real, rk, before.disk) : null
    if (denied) {
      record($, 'dedupe', denied.saved)
      return { deny: denied.deny }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const r = ran.result as { type?: string; file?: { content?: unknown; startLine?: number; numLines?: number; totalLines?: number; truncatedByTokenCap?: boolean } } | undefined
    const f = r?.file
    if (r?.type !== 'text' || !f || typeof f.content !== 'string') return ran
    const after = await readDisk($, e.file_path)
    if (!after) return ran
    const complete =
      rk === 'full' && (f.startLine ?? 1) === 1 && (f.numLines ?? 0) >= (f.totalLines ?? 0) && !f.truncatedByTokenCap
    const swap = T.tracker.post(scope, after.real, rk, { content: f.content, complete }, after.disk, d)
    if (!swap) return ran
    record($, 'dedupe', swap.saved)
    const numLines = swap.content.split('\n').length
    return { ...ran, result: { ...r, file: { ...f, content: swap.content, numLines } } } as typeof ran
  }).catch(($, e, next) => next(e))

  // --- commands: answered here, no model turn ---

  on('command.run', { command: 'savings' }, () => ({ text: savingsReport(), isTextDisplayOnly: true }))

  on('command.run', { command: 'terse' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const action = words.find(w => !w.startsWith('--')) ?? 'toggle'
    if (action === 'status') return { text: `Terse mode: ${terseWanted(T.cfg) ? 'on' : 'off'}`, isTextDisplayOnly: true }
    if (!['toggle', 'on', 'off'].includes(action)) return { text: 'Usage: /terse [on|off|status] [--project]', isTextDisplayOnly: true }
    const value = action === 'toggle' ? !T.cfg.terse : action === 'on'
    const path = await saveSetting($, words.includes('--project') ? 'project' : 'user', 'terse', value)
    return { text: `Terse mode: ${value ? 'on' : 'off'} (saved to ${path})`, isTextDisplayOnly: true, ...noteIfChanged() }
  })

  on('command.run', { command: 'tokensaver' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const scope = words.includes('--global') ? 'user' : 'project'
    const [action = 'status', ...rest] = words.filter(w => w !== '--global')
    if (action === 'on' || action === 'off') {
      const path = await saveSetting($, scope, 'enabled', action === 'on')
      const where = scope === 'user' ? 'all projects' : 'this project'
      return { text: `Token saver: ${action} for ${where} (saved to ${path})`, isTextDisplayOnly: true, ...noteIfChanged() }
    }
    if (action === 'set') {
      const [key = '', raw = ''] = rest
      if (!isKnownKey(key)) return { text: `Unknown setting: ${key || '(none)'}. /tokensaver status lists them.`, isTextDisplayOnly: true }
      let value: unknown = raw
      try {
        value = JSON.parse(raw)
      } catch {
        /* a bare string */
      }
      const path = await saveSetting($, scope, key, value)
      return { text: `Token saver: ${key} = ${JSON.stringify(value)} (saved to ${path})`, isTextDisplayOnly: true, ...noteIfChanged() }
    }
    if (action === 'status') {
      return {
        text: [
          `Token saver: ${T.cfg.enabled ? 'on' : 'off'} · terse ${terseWanted(T.cfg) ? 'on' : 'off'}`,
          `User settings:    ${userPath()} ("tokenSaver")`,
          `Project settings: ${projectPath()} ("tokenSaver")`,
          JSON.stringify(T.cfg, null, 2),
        ].join('\n'),
        isTextDisplayOnly: true,
      }
    }
    return { text: 'Usage: /tokensaver [on|off|status|set <key> <value>] [--global]', isTextDisplayOnly: true }
  })
}

/** When a command changed whether terse mode is wanted, tell the model now (once). */
function noteIfChanged(): { context?: string[] } {
  const want = terseWanted(T.cfg)
  if (want === T.terseKnown) return {}
  T.terseKnown = want
  return { context: [want ? TERSE_ON : TERSE_OFF] }
}

/** For tests: the module's state between sessions. */
export const _saverState = T
