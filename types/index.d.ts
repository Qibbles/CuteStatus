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
  /** The model family it runs on (haiku, sonnet, opus), when known. */
  model?: string
  /** True when Kibbles' router chose that model. */
  routed?: boolean
  /** Its colour slot in the band, kept for the helper's whole life. */
  color?: number
}

/** This week's usage, split by day: in time order, each calendar day Kibbles
 * saw (weekday 0 = Sunday) and, with weekday null, untracked stretches. */
export type WeekDays = {
  parts: { weekday: number | null; pct: number; today: boolean }[]
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
  /** Tokens the token saver kept out of the context this chat (estimate). */
  savedChat?: number
  /** False when the token saver is turned off. */
  saverOn?: boolean
  /** This week's usage by day: what was used before the band started counting, then one entry per day so far. */
  days?: WeekDays
  /** What the model router split off this task: easy parts sent to a cheaper model. */
  routeNote?: { routes: { model: string; count: number }[] }
  /** The main conversation's model family (haiku, sonnet, opus). */
  mainModel?: string
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
    kibbles: { data: BandData | null }
  }
}
