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
  taskCap: number
  isRunning: boolean
  frame: number
  now: number
}

declare module 'claude-code' {
  interface PluginState {
    'cute-status': { data: BandData | null }
  }
}
