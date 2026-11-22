export type Step = {
  id: string
  name: string
  status: 'pending' | 'in_progress' | 'completed'
  /** The subagent that owns this to-do item; absent for the main conversation. */
  owner?: string
}

/** A subagent ("helper") working on the current task. */
export type Helper = {
  id: string
  /** The short description the Agent call gave it. */
  name: string
  /** Input + output tokens its own requests used. */
  tokens: number
  /** Tool calls it has made, for progress when it keeps no to-do list. */
  calls: number
  status: 'running' | 'done' | 'failed'
  /** Its colour slot in the band, kept for the helper's whole life. */
  color?: number
}

/** This week's usage, split by day. */
export type WeekDays = {
  /** Percent used before the band first saw this week. */
  before: number
  /** Percent used each day, from the week's first day to today. */
  used: number[]
  /** The weekday of each entry, 0 = Sunday. */
  weekday: number[]
}

export type BandData = {
  /** Weekly percent used, 0-100. */
  weekPct: number
  /** True when weekPct comes from the account's real seven_day rate-limit window. */
  weekPctReal: boolean
  /** Epoch ms of the next weekly reset. */
  resetAt: number
  /** True when resetAt comes from the real rate-limit window. */
  resetReal: boolean
  /** Tokens counted locally this week (input + output), an estimate. */
  weekTokens: number
  weekLimit: number
  steps: Step[]
  toolCalls: number
  lastTool: string
  taskTokens: number
  /** The main conversation's share of taskTokens; the rest is the helpers'. */
  mainTokens: number
  helpers: Helper[]
  /** Input + output tokens of the whole chat since the band started counting. */
  chatTokens: number
  /** How many helpers have been given a colour so far. */
  helperSeq: number
  taskCap: number
  /** The 5-hour limit: percent used and when it resets (epoch ms), when the plan reports it. */
  fiveHourPct?: number
  fiveHourResetAt?: number
  /** How full the context window is, 0-100, when known. */
  contextPct?: number
  /** Tokens the token saver kept out of the context this task (estimate). */
  savedTask?: number
  /** Tokens the token saver kept out of the context this chat (estimate). */
  savedChat?: number
  /** False when the token saver is turned off. */
  saverOn?: boolean
  /** This week's usage by day: what was used before the band started counting, then one entry per day so far. */
  days?: WeekDays
  /** What Claude is waiting on you for (a permission, a question); absent when it isn't. */
  waiting?: string
  /** When the current task started and, once it ended, when it ended (epoch ms; 0 when unknown/still running). */
  taskStart?: number
  taskEnd?: number
  isRunning: boolean
  frame: number
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'cute-status': { data: BandData | null }
  }
}
