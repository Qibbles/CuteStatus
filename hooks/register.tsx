import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BandData, Step } from '../types'
import { type Activity, mascotSvg, moodFor, textFace } from './mascot'

// ---------------------------------------------------------------------------
// cute-status: a 3-line band above the prompt. Everything is local: it reads
// engine events (rate-limit measurements, model-step usage, tool calls) and a
// JSON config file. It never calls the model.
// ---------------------------------------------------------------------------

const DATA = { plugin: 'cute-status', key: 'data' } as const
const STORE_KEY = 'weekly-estimate'
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
  'cute-status config. weeklyTokenLimit, resetDay, resetTime and utcOffsetHours are used only when your plan does ' +
  'not report its real weekly limit (Claude subscriptions do). taskTokenSoftCap sets how full the Token bar looks.'

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

function bar(pct: number, width: number): [string, string] {
  const fill = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return ['█'.repeat(fill), '░'.repeat(width - fill)]
}

async function loadPngs($: EngineInterface): Promise<void> {
  for (const mood of ['happy', 'neutral', 'worried']) {
    for (const f of ['busy-0', 'busy-1', 'busy-2', 'sleep-0', 'sleep-1', 'sleep-2']) {
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
}

async function configPath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '/root'
  return `${home}/.claude/cute-status.json`
}

async function loadConfig($: EngineInterface): Promise<void> {
  const path = await configPath($)
  try {
    const raw = JSON.parse(String(await $.fs.read(path))) as Partial<Config>
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
      await $.fs.write(path, JSON.stringify({ _note: CONFIG_NOTE, ...DEFAULT_CONFIG }, null, 2) + '\n')
    }
  }
}

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
}

// Throttled redraw: at most one state write per second.
function schedule($: EngineInterface): void {
  if (S.flushTimer) return
  void $.clock.now().then(now => {
    if (S.flushTimer) return
    const wait = Math.max(0, 1000 - (now - S.lastFlush))
    S.flushTimer = $.clock.after(wait, () => void flush($))
  })
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
}

function readRateLimits(list: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): void {
  const w = list.find(r => r.kind === 'seven_day')
  if (!w) return
  const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  S.realWeek = { pct: w.percentUsed, resetsAt: Number.isFinite(t) ? t : undefined }
}

function startTask(): void {
  S.d.taskTokens = 0
  S.d.toolCalls = 0
  S.d.lastTool = ''
  if (S.d.steps.length > 0 && S.d.steps.every(s => s.status === 'completed')) S.d.steps = []
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
  // --- lifecycle ---

  on('session.start', async ($, e, next) => {
    await loadConfig($)
    await loadPngs($)
    const saved = (await $.store.get(STORE_KEY)) as typeof S.estimate | undefined
    if (saved && typeof saved.tokens === 'number') S.estimate = { ...saved }
    const prev = (await $.state.get(DATA)).value
    S.d = prev ? { ...prev, steps: [...prev.steps], isRunning: false, frame: 0 } : freshData(S.cfg)
    try {
      readRateLimits((await $.session.usage()).rateLimits)
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
    schedule($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta) {
      await loadConfig($)
      startTask()
      schedule($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) setRunning($, true)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) setRunning($, false)
    return next(e)
  })

  // Token counts from every model request (main loop and subagents).
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (r?.usage) {
      const n = r.usage.input_tokens + r.usage.output_tokens
      S.d.taskTokens += n
      S.estimate.tokens += n
      S.storeDirty = true
      schedule($)
    }
    return r
  })

  // --- task list tracking ---

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError && ran.result?.task) {
      if (S.d.steps.length > 0 && S.d.steps.every(s => s.status === 'completed')) S.d.steps = []
      S.d.steps = [...S.d.steps, { id: ran.result.task.id, name: e.activeForm ?? e.subject, status: 'pending' }]
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
      S.d.steps = e.todos.map((t, i) => ({
        id: `todo-${i}`,
        name: t.status === 'in_progress' ? t.activeForm : t.content,
        status: t.status,
      }))
      schedule($)
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Fallback progress: every tool call (main loop only).
  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined) {
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
    return next(e)
  }).catch(($, e, next) => next(e))

  // --- drawing ---

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const data = (await $.state.get(DATA)).value
    if (!data) return next(e)

    const cols = e.props.bodyColumns
    const LABEL = 7
    // Bars take a fair share of the band's width so the rows spread across it.
    const W = Math.max(10, Math.min(60, Math.floor((cols - MASCOT_COLS - LABEL) * 0.42)))
    const running = data.isRunning || e.props.isWorking

    // Row 1: weekly
    const wPct = data.weekPct
    const left = data.resetAt > 0 ? countdown(data.resetAt - data.now) : '?'
    // Plain words: how much of the week is used, how much is left, when it resets.
    // "estimate" appears only when the plan's real figure is not available.
    const pctText = (n: number) => `${n.toFixed(n > 0 && n < 10 ? 1 : 0)}%`
    const isEstimate = !data.weekPctReal || !data.resetReal
    const weekExtra = ` used · ${pctText(Math.max(0, 100 - wPct))} left · resets in ${left}${isEstimate ? ' (estimate)' : ''}`

    // Row 2: task progress
    const total = data.steps.length
    const done = data.steps.filter(s => s.status === 'completed').length
    const current =
      data.steps.find(s => s.status === 'in_progress')?.name ??
      data.steps.find(s => s.status === 'pending')?.name ??
      (total > 0 ? 'all done' : data.lastTool || (running ? 'thinking…' : 'idle'))
    const tPct = total > 0 ? (done / total) * 100 : running ? ((data.frame % 5) + 1) * 20 : 0
    const tLabel = total > 0 ? `${done}/${total}` : `${data.toolCalls} calls`
    const tColor = total > 0 ? tone(tPct) : 'suggestion'
    const room = Math.max(8, cols - MASCOT_COLS - LABEL - W - tLabel.length - 5)
    const curText = current.length > room ? current.slice(0, room - 1) + '…' : current

    // Row 3: task tokens
    const kPct = (data.taskTokens / data.taskCap) * 100

    const mood = moodFor(wPct)
    const activity: Activity = running ? 'busy' : 'sleep'
    const frame = running ? data.frame % 3 : 0

    const el = $.ui.resolve(e)
    const { Box, Text } = el

    const png = PNG[`${mood}-${activity}-${frame}`]
    const face = <Text color="claude">{textFace(mood, activity)}</Text>
    const mascot =
      'Svg' in el ? (
        <el.Svg
          source={mascotSvg(mood, activity, true)}
          alt={running ? `The frog is hard at work behind a computer, looking ${mood}` : `The frog is asleep, looking ${mood}`}
          width={58}
          height={58}
          isInteractive
        />
      ) : 'Image' in el && png ? (
        <el.Image key="mascot" source={{ png }} columns={MASCOT_COLS - 1} rows={3} alt={textFace(mood, activity)} />
      ) : (
        face
      )

    const row = (label: string, pct: number, color: string, children: unknown) => (
      <Box flexDirection="row">
        <Box width={LABEL} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Box width={W} flexShrink={0}>
          <Text mono>
            <Text color={color}>{bar(pct, W)[0]}</Text>
            <Text dimColor>{bar(pct, W)[1]}</Text>
          </Text>
        </Box>
        <Box marginLeft={1} flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{children as never}</Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="row" alignItems="center">
        <Box width={MASCOT_COLS} flexShrink={0} marginRight={1} justifyContent="center">
          {mascot}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {row(
            'Week',
            wPct,
            tone(wPct),
            [
              <Text key="a" bold>{` ${pctText(wPct)}`}</Text>,
              <Text key="b" dimColor>{weekExtra}</Text>,
            ],
          )}
          {row(
            'Task',
            tPct,
            tColor,
            [
              <Text key="a" bold>{` ${tLabel} `}</Text>,
              <Text key="b">{curText}</Text>,
            ],
          )}
          {row(
            'Token',
            kPct,
            tone(kPct),
            [
              <Text key="a" bold>{` ${fmt(data.taskTokens)}`}</Text>,
              <Text key="b" dimColor>{' tokens this task'}</Text>,
            ],
          )}
        </Box>
      </Box>
    )
  })
}
