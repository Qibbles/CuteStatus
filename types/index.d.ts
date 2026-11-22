export type Step = { id: string; name: string; status: 'pending' | 'in_progress' | 'completed' }

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
