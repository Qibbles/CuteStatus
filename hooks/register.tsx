import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BandData, Helper, Step } from '../types'
import { type Activity, mascotSvg, moodFor, textFace } from './mascot'
import {
  registerSaver,
  saverAfterToolCall,
  saverAgentReport,
  saverLoadConfig,
  saverPromptNote,
  saverSavings,
  saverSessionStart,
} from './saver/saver'
import { modelFamily, routerLoadConfig, routerPlan, routerSessionStart, routerSpawnModel } from './router/router'

// ---------------------------------------------------------------------------
// Kibbles: a 3-line band above the prompt. Everything is local: it reads
// engine events (rate-limit measurements, model-step usage, tool calls) and a
// JSON config file. It never calls a model itself; the model router (router/)
// makes one small Haiku call to plan a big, multi-part request.
// ---------------------------------------------------------------------------

const DATA = { plugin: 'kibbles', key: 'data' } as const
const STORE_KEY = 'weekly-estimate'
// Calendar days (in the configured time zone) since the week began.
const DAILY_KEY = 'weekly-by-date'
const DAY = 24 * 3600_000
const WEEK = 7 * 24 * 3600_000
const MASCOT_COLS = 8
const PNG: Record<string, string> = {}
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

type Config = {
  weeklyTokenLimit: number
  resetDay: string
  resetTime: string
  taskTokenSoftCap: number
  /** Hours ahead of UTC for resetDay/resetTime (e.g. 8 for Singapore, -5 for New York). */
  utcOffsetHours: number
}

const DEFAULT_CONFIG: Config = {
  weeklyTokenLimit: 5_000_000,
  resetDay: 'mon',
  resetTime: '09:00',
  taskTokenSoftCap: 50_000,
  // This machine's own offset from UTC, so the default reset time is local.
  utcOffsetHours: -new Date().getTimezoneOffset() / 60,
}

const CONFIG_NOTE =
  'Kibbles config. weeklyTokenLimit, resetDay, resetTime and utcOffsetHours are used only when your plan does ' +
  'not report its real weekly limit (Claude subscriptions do). taskTokenSoftCap sets how full the Token bar looks. ' +
  'tokenSaver holds the token saver settings (see the README).'

// --- helpers ---------------------------------------------------------------

function nextReset(now: number, cfg: Config): number {
  const day = Math.max(0, DAYS.indexOf(cfg.resetDay.slice(0, 3).toLowerCase()))
  const [hh = 9, mm = 0] = cfg.resetTime.split(':').map(n => Number(n) || 0)
  const offset = cfg.utcOffsetHours * 3600_000
  const local = new Date(now + offset)
  const ahead = (day - local.getUTCDay() + 7) % 7
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + ahead, hh, mm)
  if (t <= now + offset) t += WEEK
  return t - offset
}

function countdown(ms: number): string {
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d > 0 ? `${d}d ${h}h ${m % 60}m` : h > 0 ? `${h}h ${m % 60}m` : `${m % 60}m`
}

function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}

function tone(pct: number): 'success' | 'warning' | 'error' {
  return pct < 50 ? 'success' : pct < 80 ? 'warning' : 'error'
}

// Colours that tell the main conversation ("you") and each helper apart in
// the Task and Token bars; mid-tones that read on light and dark themes.
// One colour per weekday for the Week bar and the day names; grey for usage
// from before the band started counting this week.
const DAY_COLORS = ['#d4609a', '#4f86c6', '#2fb5a3', '#e0a020', '#e07a5f', '#b07cd8', '#7aa63c']
const dayColor = (weekday: number) => DAY_COLORS[weekday % 7] ?? '#8a8f98'
const EARLIER_COLOR = '#8a8f98'
const DAY_LETTERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

/** 4m 12s, 1h 3m, 45s. */
function duration(ms: number): string {
  const sec = Math.floor(ms / 1000)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec % 60}s` : `${sec}s`
}

const YOU_COLOR = '#4f86c6'
const HELPER_COLORS = ['#e07a5f', '#2fb5a3', '#b07cd8', '#e0a020', '#d4609a', '#7aa63c']
const helperColor = (h: Helper, i: number) => HELPER_COLORS[(h.color ?? i) % HELPER_COLORS.length] ?? YOU_COLOR

/** A piece of a row's text and how it is drawn. */
type Part = { t: string; bold?: boolean; dim?: boolean; color?: string }

const partsLen = (parts: Part[]) => parts.reduce((n, p) => n + p.t.length, 0)

/** Cuts text to `max` characters with an ellipsis: in the middle for paths. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return '…'
  if (text.includes('/') && max >= 9) {
    const head = Math.ceil((max - 1) / 2)
    return text.slice(0, head) + '…' + text.slice(text.length - (max - 1 - head))
  }
  return text.slice(0, max - 1) + '…'
}

/**
 * The longest wording that fits `room`: each row offers its wordings from
 * fullest to tersest, and the tersest is clipped if even it does not fit.
 */
function fit(variants: Part[][], room: number): Part[] {
  for (const v of variants) if (partsLen(v) <= room) return v
  const last = variants[variants.length - 1] ?? []
  const out: Part[] = []
  let left = room
  for (const p of last) {
    if (left <= 0) break
    const t = clip(p.t, left)
    out.push({ ...p, t })
    left -= t.length
  }
  return out
}

/** "3d 7h 51m" → "3d 7h": the two largest units. */
const shortSpan = (span: string) => span.split(' ').slice(0, 2).join(' ')

/** A run of bar cells: solid, or `shade` for the light part of a lane. */
type Seg = { len: number; color: string; shade?: boolean }

/** Splits `cells` among the weights by largest remainder; same order back. */
function allot(weights: number[], cells: number): number[] {
  const sum = weights.reduce((n, w) => n + Math.max(0, w), 0)
  if (sum <= 0 || cells <= 0) return weights.map(() => 0)
  const exact = weights.map(w => (Math.max(0, w) / sum) * cells)
  const out = exact.map(x => Math.floor(x))
  let left = cells - out.reduce((n, x) => n + x, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    out[i] = (out[i] ?? 0) + 1
    left -= 1
  }
  return out
}

/** Splits `cells` filled cells among the parts by weight. */
function segments(parts: { weight: number; color: string }[], cells: number): Seg[] {
  const lens = allot(parts.map(p => p.weight), cells)
  return parts.map((p, i) => ({ len: lens[i] ?? 0, color: p.color })).filter(x => x.len > 0)
}

/**
 * One lane per worker across the whole bar, as wide as its share of the to-do
 * items: the finished part solid in its colour, the rest a light shade of it.
 */
function lanes(parts: { done: number; total: number; color: string }[], cells: number): Seg[] {
  const live = parts.filter(p => p.total > 0)
  const widths = allot(live.map(p => p.total), cells)
  return live.flatMap((p, i) => {
    const width = widths[i] ?? 0
    const solid = Math.min(width, Math.round((p.done / p.total) * width))
    return [
      { len: solid, color: p.color },
      { len: width - solid, color: p.color, shade: true },
    ].filter(x => x.len > 0)
  })
}


async function loadPngs($: EngineInterface): Promise<void> {
  for (const mood of ['happy', 'neutral', 'worried']) {
    for (const f of ['busy-0', 'busy-1', 'busy-2', 'sleep-0', 'sleep-1', 'sleep-2', 'wait-0', 'wait-1', 'wait-2']) {
      try {
        const r = await $.fs.read(`${$.plugin.root}/assets/${mood}-${f}.png`, { as: 'bytes' })
        PNG[`${mood}-${f}`] = r.base64
      } catch {
        /* text face instead */
      }
    }
  }
}

function freshData(cfg: Config): BandData {
  return {
    weekPct: 0,
    weekPctReal: false,
    resetAt: 0,
    resetReal: false,
    weekTokens: 0,
    weekLimit: cfg.weeklyTokenLimit,
    steps: [],
    toolCalls: 0,
    lastTool: '',
    taskTokens: 0,
    mainTokens: 0,
    helpers: [],
    chatTokens: 0,
    helperSeq: 0,
    taskCap: cfg.taskTokenSoftCap,
    isRunning: false,
    frame: 0,
    now: 0,
  }
}

// --- the mod ---------------------------------------------------------------

const S = {
  cfg: DEFAULT_CONFIG as Config,
  d: freshData(DEFAULT_CONFIG),
  realWeek: null as { pct: number; resetsAt?: number } | null,
  estimate: { periodStart: 0, tokens: 0 },
  lastFlush: 0,
  flushTimer: null as Timer | null,
  animTimer: null as Timer | null,
  minuteTimer: null as Timer | null,
  storeDirty: false,
  realFiveHour: null as { pct: number; resetsAt?: number } | null,
  /** The weekly % last seen in each day of the week, to work out usage per day. */
  daily: { periodStart: 0, firstSlot: -1, firstPct: 0, marks: [] as (number | null)[] },
  dailyDirty: false,
}

async function configPath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '/root'
  return `${home}/.claude/kibbles.json`
}

async function loadConfig($: EngineInterface): Promise<void> {
  const path = await configPath($)
  let saverSection: unknown
  let routerSection: unknown
  try {
    const raw = JSON.parse(String(await $.fs.read(path))) as Partial<Config> & { tokenSaver?: unknown; router?: unknown }
    saverSection = raw.tokenSaver
    routerSection = raw.router
    S.cfg = {
      weeklyTokenLimit: Number(raw.weeklyTokenLimit) > 0 ? Number(raw.weeklyTokenLimit) : DEFAULT_CONFIG.weeklyTokenLimit,
      resetDay: typeof raw.resetDay === 'string' ? raw.resetDay : DEFAULT_CONFIG.resetDay,
      resetTime: typeof raw.resetTime === 'string' ? raw.resetTime : DEFAULT_CONFIG.resetTime,
      taskTokenSoftCap: Number(raw.taskTokenSoftCap) > 0 ? Number(raw.taskTokenSoftCap) : DEFAULT_CONFIG.taskTokenSoftCap,
      utcOffsetHours: Number.isFinite(Number(raw.utcOffsetHours)) && raw.utcOffsetHours !== undefined ? Number(raw.utcOffsetHours) : DEFAULT_CONFIG.utcOffsetHours,
    }
  } catch {
    S.cfg = DEFAULT_CONFIG
    try {
      await $.fs.stat(path)
    } catch {
      await $.fs.write(
        path,
        JSON.stringify({ _note: CONFIG_NOTE, ...DEFAULT_CONFIG, tokenSaver: { enabled: true, terse: true } }, null, 2) + '\n',
      )
    }
  }
  // The token saver's settings are the tokenSaver section of the same file.
  await saverLoadConfig($, saverSection)
  routerLoadConfig(routerSection)
}

/** Running low: the 5-hour or weekly limit is past 80%. */
const underPressure = () => (S.d.fiveHourPct ?? 0) >= 80 || S.d.weekPct >= 80

// Recompute the weekly figures from what is known: real window first.
function recompute(now: number): void {
  const resetAt =
    S.realWeek?.resetsAt !== undefined && S.realWeek.resetsAt > now ? S.realWeek.resetsAt : nextReset(now, S.cfg)
  const periodStart = resetAt - WEEK
  if (S.estimate.periodStart !== periodStart) {
    // A new week (or the window moved): start the local count over.
    if (S.estimate.periodStart !== 0 && Math.abs(S.estimate.periodStart - periodStart) > 3600_000) S.estimate.tokens = 0
    S.estimate.periodStart = periodStart
    S.storeDirty = true
  }
  S.d.resetAt = resetAt
  S.d.resetReal = S.realWeek?.resetsAt !== undefined && S.realWeek.resetsAt > now
  S.d.weekTokens = S.estimate.tokens
  S.d.weekLimit = S.cfg.weeklyTokenLimit
  S.d.taskCap = S.cfg.taskTokenSoftCap
  if (S.realWeek) {
    S.d.weekPct = S.realWeek.pct
    S.d.weekPctReal = true
  } else {
    S.d.weekPct = Math.min(100, (S.estimate.tokens / S.cfg.weeklyTokenLimit) * 100)
    S.d.weekPctReal = false
  }
  S.d.now = now
  const saved = saverSavings()
  S.d.savedChat = saved.chat
  S.d.saverOn = saved.on

  // Usage per day: remember the weekly % last seen on each calendar day of
  // the week (in the configured time zone); a day's usage is how much it rose
  // since the previous day we saw. A week can touch 8 calendar days.
  const offset = S.cfg.utcOffsetHours * 3600_000
  const dayOf = (t: number) => Math.floor((t + offset) / DAY)
  const slot = Math.max(0, Math.min(7, dayOf(now) - dayOf(periodStart)))
  const pct = S.d.weekPct
  if (S.daily.periodStart !== periodStart || S.daily.marks.length !== 8) {
    S.daily = { periodStart, firstSlot: slot, firstPct: pct, marks: [null, null, null, null, null, null, null, null] }
    S.dailyDirty = true
  }
  if ((S.daily.marks[slot] ?? -1) < pct) {
    S.daily.marks[slot] = pct
    S.dailyDirty = true
  }
  const used: number[] = []
  const weekday: number[] = []
  let last = S.daily.firstPct
  for (let i = 0; i <= slot; i++) {
    const mark = S.daily.marks[i]
    const fromHere = i >= S.daily.firstSlot && mark !== null && mark !== undefined
    used.push(fromHere ? Math.max(0, mark - last) : 0)
    if (fromHere) last = mark
    weekday.push(new Date((dayOf(periodStart) + i) * DAY).getUTCDay())
  }
  S.d.days = { before: S.daily.firstPct, used, weekday }
  if (S.realFiveHour) {
    S.d.fiveHourPct = S.realFiveHour.pct
    S.d.fiveHourResetAt = S.realFiveHour.resetsAt
  }
}

// Throttled redraw: at most one state write per second.
function schedule($: EngineInterface): void {
  if (S.flushTimer) return
  void $.clock.now().then(now => {
    if (S.flushTimer) return
    const wait = Math.max(0, 1000 - (now - S.lastFlush))
    S.flushTimer = $.clock.after(wait, () => void flush($))
  }).catch(() => undefined)
}

async function flush($: EngineInterface): Promise<void> {
  S.flushTimer = null
  const now = await $.clock.now()
  S.lastFlush = now
  recompute(now)
  await $.state.set(DATA, { ...S.d, steps: S.d.steps.map(s => ({ ...s })) })
  if (S.storeDirty) {
    S.storeDirty = false
    await $.store.set(STORE_KEY, S.estimate)
  }
  if (S.dailyDirty) {
    S.dailyDirty = false
    await $.store.set(DAILY_KEY, S.daily)
  }
}

function readRateLimits(list: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): void {
  const read = (kind: string) => {
    const w = list.find(r => r.kind === kind)
    if (!w) return null
    const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    return { pct: w.percentUsed, resetsAt: Number.isFinite(t) ? t : undefined }
  }
  S.realWeek = read('seven_day') ?? S.realWeek
  S.realFiveHour = read('five_hour') ?? S.realFiveHour
}

function readContext(context: { percent?: number } | undefined): void {
  if (context?.percent !== undefined) S.d.contextPct = context.percent
}

function startTask(now: number): void {
  S.d.routeNote = undefined
  S.d.taskStart = now
  S.d.taskEnd = 0
  S.d.waiting = undefined
  S.d.taskTokens = 0
  S.d.mainTokens = 0
  // Helpers still running carry on into the new task, counted afresh.
  S.d.helpers = S.d.helpers.filter(h => h.status === 'running').map(h => ({ ...h, tokens: 0, calls: 0 }))
  S.d.toolCalls = 0
  S.d.lastTool = ''
  if (S.d.steps.length > 0 && S.d.steps.every(s => s.status === 'completed')) S.d.steps = []
}

function helperFor(id: string): Helper {
  let h = S.d.helpers.find(x => x.id === id)
  if (!h) {
    h = { id, name: 'helper', tokens: 0, calls: 0, status: 'running', color: S.d.helperSeq ?? 0 }
    S.d.helperSeq = (S.d.helperSeq ?? 0) + 1
    S.d.helpers = [...S.d.helpers, h]
  }
  return h
}

function setRunning($: EngineInterface, running: boolean): void {
  S.d.isRunning = running
  if (running && !S.animTimer) {
    S.animTimer = $.clock.every(1000, () => {
      S.d.frame = (S.d.frame + 1) % 1000
      schedule($)
    })
  } else if (!running && S.animTimer) {
    S.animTimer.cancel()
    S.animTimer = null
    S.d.frame = 0
  }
  schedule($)
}


export const register: Register = on => {
  // --- token saver: works under the hood; the Token row shows what it saved ---
  registerSaver(on)

  // --- lifecycle ---

  on('session.start', async ($, e, next) => {
    saverSessionStart(e.cwd)
    routerSessionStart()
    await loadConfig($)
    await loadPngs($)
    const saved = (await $.store.get(STORE_KEY)) as typeof S.estimate | undefined
    if (saved && typeof saved.tokens === 'number') S.estimate = { ...saved }
    const daily = (await $.store.get(DAILY_KEY)) as typeof S.daily | undefined
    if (daily && Array.isArray(daily.marks)) S.daily = { ...daily, marks: [...daily.marks] }
    const prev = (await $.state.get(DATA)).value
    S.d = prev
      ? { ...freshData(S.cfg), ...prev, steps: [...prev.steps], helpers: [...(prev.helpers ?? [])], isRunning: false, frame: 0 }
      : freshData(S.cfg)
    try {
      const usage = await $.session.usage()
      readRateLimits(usage.rateLimits)
      readContext(usage.context)
    } catch {
      /* no reading yet */
    }
    // The countdown is minute-grained; a local tick redraws it. No data is polled.
    S.minuteTimer?.cancel()
    S.minuteTimer = $.clock.every(60_000, () => schedule($))
    schedule($)
    return next(e)
  })

  // Real weekly usage is pushed here by the engine whenever a window moves.
  on('session.measure', ($, e, next) => {
    readRateLimits(e.rateLimits)
    readContext(e.context)
    schedule($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) {
      await loadConfig($)
      startTask(await $.clock.now())
      schedule($)
    }
    if (e.isMeta || e.command) return next(e)
    const context: string[] = []
    // Terse mode switched in the settings file mid-chat: tell Claude once.
    const note = saverPromptNote()
    if (note) context.push(note)
    // The model router: for a big multi-part request, a quick pre-read on the
    // cheap model suggests which parts to hand to cheaper helpers.
    const route = await routerPlan($, e.text, underPressure(), S.d.mainModel)
    if (route.tokens > 0) {
      S.d.taskTokens += route.tokens
      S.d.mainTokens += route.tokens
      S.d.chatTokens = (S.d.chatTokens ?? 0) + route.tokens
      S.estimate.tokens += route.tokens
    }
    if (route.note) S.d.routeNote = route.note
    context.push(...route.context)
    schedule($)
    return context.length > 0 ? next({ ...e, context: [...(e.context ?? []), ...context] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) setRunning($, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      S.d.taskEnd = await $.clock.now()
      S.d.waiting = undefined
      setRunning($, false)
    }
    return next(e)
  })

  // --- waiting on you: a permission prompt or a question ---

  on('classic.PermissionRequest', ($, e, next) => {
    S.d.waiting = `allow ${e.tool_name}?`
    schedule($)
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      S.d.waiting = 'answer a question'
      schedule($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Token counts from every model request (main loop and subagents).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) S.d.mainModel = modelFamily(e.model) || S.d.mainModel
    const r = yield* next(e)
    if (r?.usage) {
      const n = r.usage.input_tokens + r.usage.output_tokens
      S.d.taskTokens += n
      S.d.chatTokens = (S.d.chatTokens ?? 0) + n
      if (e.agentId === undefined) S.d.mainTokens += n
      else helperFor(e.agentId).tokens += n
      S.estimate.tokens += n
      S.storeDirty = true
      schedule($)
    }
    return r
  })

  // --- helpers (subagents) ---

  on('agent.spawn', async ($, e, next) => {
    // The router's safety net: an easy helper with no model chosen runs on
    // the cheaper model.
    const routed = routerSpawnModel(e, underPressure(), S.d.mainModel)
    const r = await next(routed ? { ...e, model: routed } : e)
    if (r.deny === undefined && r.agentId) {
      const h = helperFor(r.agentId)
      h.name = e.description || e.subagentType
      h.model = modelFamily(r.model) || undefined
      h.routed = routed !== null
      schedule($)
    }
    return r
  }).catch(($, e, next) => next(e))

  on('agent.report', ($, e, next) => {
    saverAgentReport(e.agentId)
    const h = S.d.helpers.find(x => x.id === e.agentId)
    if (h) {
      h.status = e.status === 'completed' ? 'done' : 'failed'
      schedule($)
    }
    return next(e)
  })

  // --- task list tracking ---

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && ran.result?.task) {
      if (S.d.steps.length > 0 && S.d.steps.every(s => s.status === 'completed')) S.d.steps = []
      S.d.steps = [...S.d.steps, { id: ran.result.task.id, name: e.activeForm ?? e.subject, status: 'pending', owner: e.agentId }]
      schedule($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      if (e.status === 'deleted') {
        S.d.steps = S.d.steps.filter(s => s.id !== e.taskId)
      } else {
        S.d.steps = S.d.steps.map(s =>
          s.id === e.taskId
            ? { ...s, status: (e.status ?? s.status) as Step['status'], name: e.activeForm ?? e.subject ?? s.name }
            : s,
        )
      }
      schedule($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      // A to-do list replaces only its own owner's items.
      const owner = e.agentId
      S.d.steps = [
        ...S.d.steps.filter(s => s.owner !== owner),
        ...e.todos.map((t, i) => ({
          id: `todo-${owner ?? 'main'}-${i}`,
          name: t.status === 'in_progress' ? t.activeForm : t.content,
          status: t.status,
          owner,
        })),
      ]
      schedule($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Fallback progress: every tool call (main loop only).
  on('tool.call', ($, e, next) => {
    if (e.agentId !== undefined) {
      helperFor(e.agentId).calls += 1
      schedule($)
    } else {
      S.d.toolCalls += 1
      const input = e as unknown as Record<string, unknown>
      const hint = ['description', 'command', 'file_path', 'pattern', 'url', 'query']
        .map(k => input[k])
        .find(v => typeof v === 'string') as string | undefined
      const text = hint ?? ''
      const short = (input.file_path === text ? text.split('/').pop() : text.split('\n')[0]) ?? text
      S.d.lastTool = hint ? `${e.tool}: ${short.replace(/\s+/g, ' ').slice(0, 60)}` : e.tool
      schedule($)
    }
    // Once a call has been allowed (or answered) and run, Claude is no longer
    // waiting on you.
    return next(e).then(r => {
      if (S.d.waiting !== undefined) {
        S.d.waiting = undefined
        schedule($)
      }
      // The token saver condenses the output and forgets edited files.
      schedule($)
      return saverAfterToolCall($, e, r).catch(() => r)
    })
  }).catch(($, e, next) => next(e))

  // --- drawing ---

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const data = (await $.state.get(DATA)).value
    if (!data) return next(e)

    const cols = e.props.bodyColumns
    const LABEL = 9
    // Bars take a fair share of the band's width so the rows spread across it,
    // but always leave the text at least ~28 cells; narrow bands get short bars.
    const avail = Math.max(0, cols - MASCOT_COLS - 1 - LABEL - 1)
    const W = Math.max(8, Math.min(48, Math.floor(avail * 0.36), avail - 28))
    // The text's room, with a margin for proportional fonts (desktop, mobile)
    // whose letters can run wider than a terminal cell.
    const proportional = e.surface !== 'terminal'
    const room = Math.max(8, Math.floor((avail - W) * (proportional ? 0.88 : 1)) - 1)
    const running = data.isRunning || e.props.isWorking

    const pctText = (n: number) => `${n.toFixed(n > 0 && n < 10 ? 1 : 0)}%`
    const span = (ms: number) => (ms > 0 ? countdown(ms) : 'now')

    // --- Row 1: Week -----------------------------------------------------
    // The bar is this week's usage split into days, one colour per weekday;
    // the text adds the 5-hour limit and the day names in the same colours. "(estimate)" appears only when the plan's real figure is not
    // available.
    const wPct = data.weekPct
    const left = data.resetAt > 0 ? countdown(data.resetAt - data.now) : '?'
    const isEstimate = !data.weekPctReal || !data.resetReal
    const days = data.days
    const wCells = Math.round((Math.min(100, wPct) / 100) * W)
    const wSegs: Seg[] =
      days && days.used.some(u => u > 0)
        ? segments(
            [
              { weight: days.before, color: EARLIER_COLOR },
              ...days.used.map((u, i) => ({ weight: u, color: dayColor(days.weekday[i] ?? 0) })),
            ],
            wCells,
          )
        : [{ len: wCells, color: tone(wPct) }]
    const fivePct = data.fiveHourPct
    const fiveLeft = data.fiveHourResetAt ? span(data.fiveHourResetAt - data.now) : ''
    const five = (long: boolean): Part[] =>
      fivePct === undefined
        ? []
        : [
            { t: ' · 5h ', dim: true },
            { t: pctText(fivePct), bold: true, color: tone(fivePct) },
            ...(long && fiveLeft ? [{ t: ` (resets ${shortSpan(fiveLeft)})`, dim: true }] : []),
          ]
    // The day key: only days with measured usage, each name in its colour
    // matching its part of the bar (today in bold), plus "earlier" for the
    // grey part: usage from before Kibbles started counting this week.
    const chart = (withPct: boolean): Part[] => {
      if (!days || !days.used.some(u => u > 0)) return []
      const pctOf = (n: number) => (withPct ? ` ${pctText(n)}` : '')
      const parts: Part[] = [{ t: ' ·', dim: true }]
      if (days.before > 0) parts.push({ t: ` earlier${pctOf(days.before)}`, color: EARLIER_COLOR })
      days.used.forEach((u, i) => {
        if (u <= 0) return
        parts.push({
          t: ` ${DAY_LETTERS[days.weekday[i] ?? 0]}${pctOf(u)}`,
          color: dayColor(days.weekday[i] ?? 0),
          bold: i === days.used.length - 1,
        })
      })
      return parts
    }
    const pctBold: Part = { t: ` ${pctText(wPct)}`, bold: true }
    const est = isEstimate ? ' (est.)' : ''
    const weekText = fit(
      [
        [pctBold, { t: ` used · resets in ${left}${est}`, dim: true }, ...five(true), ...chart(true)],
        [pctBold, { t: ` used · resets in ${left}${est}`, dim: true }, ...five(false), ...chart(true)],
        [pctBold, { t: ` · resets ${shortSpan(left)}${est}`, dim: true }, ...five(false), ...chart(true)],
        [pctBold, { t: ` · resets ${shortSpan(left)}${est}`, dim: true }, ...five(false), ...chart(false)],
        [pctBold, { t: ` · resets ${shortSpan(left)}${est}`, dim: true }, ...five(false)],
        [pctBold, ...five(false)],
        [pctBold],
      ],
      room,
    )

    // --- Row 2: Task -----------------------------------------------------
    const total = data.steps.length
    const done = data.steps.filter(s => s.status === 'completed').length
    const current =
      data.steps.find(s => s.status === 'in_progress' && !s.owner)?.name ??
      data.steps.find(s => s.status === 'in_progress')?.name ??
      data.steps.find(s => s.status === 'pending')?.name ??
      (total > 0 ? 'all done' : data.lastTool || (running ? 'thinking…' : 'idle'))
    const tPct = total > 0 ? (done / total) * 100 : running ? ((data.frame % 5) + 1) * 20 : 0
    const tLabel = total > 0 ? `${done}/${total}` : `${data.toolCalls} calls`

    // Helpers (subagents) on this task, each with its own colour.
    const helpers = data.helpers ?? []
    const hasHelpers = helpers.length > 0
    const mainTokens = data.mainTokens ?? data.taskTokens
    const helperIds = new Set(helpers.map(h => h.id))
    const isMine = (s: Step) => !s.owner || !helperIds.has(s.owner)

    // Each worker's share: you (blue) and each helper. A helper with no to-do
    // list counts as one item, done when it finishes.
    const workers = hasHelpers
      ? [
          {
            done: data.steps.filter(s => s.status === 'completed' && isMine(s)).length,
            total: data.steps.filter(isMine).length,
            color: YOU_COLOR,
          },
          ...helpers.map((h, i) => {
            const own = data.steps.filter(s => s.owner === h.id)
            return own.length > 0
              ? { done: own.filter(s => s.status === 'completed').length, total: own.length, color: helperColor(h, i) }
              : { done: h.status === 'running' ? 0 : 1, total: 1, color: helperColor(h, i) }
          }),
        ]
      : []
    const doneAll = workers.reduce((n, w) => n + w.done, 0)
    const totalAll = workers.reduce((n, w) => n + w.total, 0)
    const taskLabel = hasHelpers && totalAll > 0 ? `${doneAll}/${totalAll}` : tLabel

    // Alone, the bar fills green to red. With helpers it has one lane per
    // worker, as wide as its share of the to-do items: solid for what it has
    // finished, a light shade of its colour for what it still has to do.
    const tSegs: Seg[] =
      hasHelpers && totalAll > 0
        ? lanes(workers, W)
        : [{ len: Math.round((Math.min(100, tPct) / 100) * W), color: total > 0 ? tone(tPct) : 'suggestion' }]

    // How long the task has taken: live while it runs, final once it ends.
    const elapsed = data.taskStart ? (data.taskEnd || data.now) - data.taskStart : 0
    const timer: Part[] = elapsed >= 1000 ? [{ t: ` · ${duration(elapsed)}`, dim: true }] : []
    // What the model router split off: "⑂ 2 → haiku · 1 → sonnet".
    const routes = data.routeNote?.routes ?? []
    const routed: Part[] =
      routes.length > 0
        ? [{ t: ' · ', dim: true }, { t: `⑂ ${routes.map(r => `${r.count} → ${r.model}`).join(' · ')}`, color: 'success' }]
        : []
    const head: Part = { t: ` ${taskLabel}`, bold: true }

    // With helpers, the text is the colour key: ■ you, then each helper with
    // its progress and tokens. It gets terser step by step when short of room.
    const entries = hasHelpers
      ? [
          {
            key: 'you',
            color: YOU_COLOR,
            name: 'you',
            mark: '',
            model: '',
            progress: data.steps.some(isMine)
              ? `${data.steps.filter(s => s.status === 'completed' && isMine(s)).length}/${data.steps.filter(isMine).length}`
              : '',
            tokens: fmt(mainTokens),
          },
          ...helpers.map((h, i) => {
            const own = data.steps.filter(s => s.owner === h.id)
            const progress = own.length > 0
              ? `${own.filter(s => s.status === 'completed').length}/${own.length}`
              : h.status === 'running' ? `${h.calls} steps` : ''
            const state = h.status === 'done' ? '✓' : h.status === 'failed' ? '✗' : ''
            return { key: h.id, color: helperColor(h, i), name: h.name, mark: state, model: h.model && h.model !== data.mainModel ? h.model : '', progress, tokens: fmt(h.tokens) }
          }),
        ]
      : []
    const entryParts = (nameMax: number, withTokens: boolean) =>
      entries.flatMap(x => {
        // "you" is always named, so the blue in the bars is never a mystery.
        const name = x.key === 'you' ? 'you' : nameMax > 0 ? clip(x.name, Math.max(nameMax, 3)) : ''
        // The helper's model shows when it is not the main one's: "· haiku".
        const label = [name, x.model ? `· ${x.model}` : '', x.mark, x.progress].filter(Boolean).join(' ')
        const text = withTokens ? (label ? `${label} · ${x.tokens}` : x.tokens) : label || x.tokens
        return [
          { t: '  ■', color: x.color },
          { t: ` ${text}`, dim: true },
        ] as Part[]
      })

    let taskText: Part[]
    if (data.waiting) {
      // Claude is waiting on you: say so plainly, in the warning colour.
      taskText = fit(
        [
          [head, ...timer, { t: ' · ', dim: true }, { t: `⏸ waiting for you: ${data.waiting}`, color: 'warning', bold: true }],
          [head, { t: ' ', dim: true }, { t: `⏸ waiting: ${data.waiting}`, color: 'warning', bold: true }],
          [head, { t: ' ⏸ waiting for you', color: 'warning', bold: true }],
        ],
        room,
      )
    } else if (hasHelpers) {
      const tiers: Part[][] = [
        [head, ...timer, ...routed, ...entryParts(24, true)],
        [head, ...timer, ...entryParts(24, true)],
        [head, ...timer, ...entryParts(12, true)],
        [head, ...entryParts(12, true)],
        [head, ...entryParts(8, true)],
        [head, ...entryParts(8, false)],
        [head, ...entryParts(0, true)],
        [head, ...entryParts(0, false)],
      ]
      taskText = tiers.find(v => partsLen(v) <= room) ?? []
      if (taskText.length === 0) {
        // Even the tersest is too long: as many entries as fit, then +N more.
        const terse = entryParts(0, false)
        taskText = [head]
        for (let i = 0; i + 1 < terse.length; i += 2) {
          const pair = [terse[i], terse[i + 1]].filter((p): p is Part => p !== undefined)
          if (partsLen(taskText) + partsLen(pair) + 8 > room) {
            taskText.push({ t: ` +${(terse.length - i) / 2} more`, dim: true })
            break
          }
          taskText.push(...pair)
        }
        taskText = fit([taskText], room)
      }
    } else {
      taskText = fit(
        [
          [head, ...timer, ...routed, { t: ' · ', dim: true }, { t: current }],
          [head, ...timer, { t: ' · ', dim: true }, { t: current }],
          [head, { t: ` ${current}` }],
        ],
        room,
      )
    }

    // --- Row 3: Token ----------------------------------------------------
    // Alone: this task's tokens against the soft cap. With helpers: the whole
    // bar is this task's tokens, split by who used what share. The text adds
    // the whole chat's tokens and how full the context window is.
    const kPct = (data.taskTokens / data.taskCap) * 100
    const kSegs: Seg[] = hasHelpers
      ? segments(
          [
            { weight: mainTokens, color: YOU_COLOR },
            ...helpers.map((h, i) => ({ weight: h.tokens, color: helperColor(h, i) })),
          ],
          data.taskTokens > 0 ? W : 0,
        )
      : [{ len: Math.round((Math.min(100, kPct) / 100) * W), color: tone(kPct) }]
    const taskTok: Part = { t: ` ${fmt(data.taskTokens)}`, bold: true }
    const chatTok: Part = { t: fmt(data.chatTokens ?? data.taskTokens), bold: true }
    const ctx = data.contextPct
    const ctxParts = (word: string): Part[] =>
      ctx === undefined ? [] : [{ t: ` · ${word} `, dim: true }, { t: `${ctx}%`, bold: true, color: tone(ctx) }]
    // What the token saver kept out of the context this chat.
    const saved = data.saverOn !== false ? (data.savedChat ?? 0) : 0
    const savedParts = (word: string): Part[] =>
      saved > 0 ? [{ t: ` · ${word} `, dim: true }, { t: fmt(saved), bold: true, color: 'success' }] : []
    const tokenText = fit(
      [
        [taskTok, { t: ' this task · ', dim: true }, chatTok, { t: ' this chat', dim: true }, ...savedParts('saved'), ...ctxParts('context')],
        [taskTok, { t: ' task · ', dim: true }, chatTok, { t: ' chat', dim: true }, ...savedParts('saved'), ...ctxParts('context')],
        [taskTok, { t: ' task · ', dim: true }, chatTok, { t: ' chat', dim: true }, ...ctxParts('context')],
        [taskTok, { t: ' task', dim: true }, ...savedParts('saved'), ...ctxParts('context')],
        [taskTok, { t: ' task', dim: true }, ...ctxParts('context')],
        [taskTok, ...ctxParts('context')],
        [taskTok],
      ],
      room,
    )

    const mood = moodFor(wPct)
    const activity: Activity = data.waiting ? 'wait' : running ? 'busy' : 'sleep'
    const frame = running ? data.frame % 3 : 0

    const el = $.ui.resolve(e)
    const { Box, Text } = el

    const png = PNG[`${mood}-${activity}-${frame}`]
    const face = <Text color="claude">{textFace(mood, activity)}</Text>
    const mascot =
      'Svg' in el ? (
        <el.Svg
          source={mascotSvg(mood, activity, true)}
          alt={
            activity === 'wait'
              ? 'Kibbles the frog is waving: Claude is waiting for you'
              : activity === 'busy'
                ? `Kibbles the frog is hard at work behind a computer, looking ${mood}`
                : `Kibbles the frog is asleep, looking ${mood}`
          }
          width={58}
          height={58}
          isInteractive
        />
      ) : 'Image' in el && png ? (
        <el.Image key="mascot" source={{ png }} columns={MASCOT_COLS - 1} rows={3} alt={textFace(mood, activity)} />
      ) : (
        face
      )

    const row = (label: string, segs: Seg[], parts: Part[]) => (
      <Box flexDirection="row">
        <Box width={LABEL} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box width={W} flexShrink={0}>
          <Text mono>
            {segs.map((g, i) => (
              <Text key={`s${i}`} color={g.color}>
                {(g.shade ? '░' : '█').repeat(g.len)}
              </Text>
            ))}
            <Text dimColor>{'░'.repeat(Math.max(0, W - segs.reduce((n, g) => n + g.len, 0)))}</Text>
          </Text>
        </Box>
        <Box marginLeft={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text wrap="truncate-end">
            {parts.map((p, i) => (
              <Text key={`p${i}`} bold={p.bold} dimColor={p.dim} color={p.color}>
                {p.t}
              </Text>
            ))}
          </Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="row" alignItems="center">
        <Box width={MASCOT_COLS} flexShrink={0} marginRight={1} justifyContent="center">
          {mascot}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {row('Week', wSegs, weekText)}
          {row('Task', tSegs, taskText)}
          {row('Token', kSegs, tokenText)}
        </Box>
      </Box>
    )
  })
}
