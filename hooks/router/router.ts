// Model router: works by itself. It sends the easy parts of a task to a
// cheaper model (Haiku) and keeps the hard parts on Claude's own model, so
// your usage limits last longer. Three layers, chosen automatically:
//
// 1. A standing instruction (in the system prompt, fixed for the chat so the
//    prompt cache holds): split mixed requests, give self-contained easy
//    parts to Haiku helpers, keep the hard parts.
// 2. A safety net: a helper Claude starts for an easy job (searching,
//    reading, summarising, formatting...) with no model chosen runs on Haiku.
// 3. A quick Haiku pre-read, only for big multi-part requests: it lists the
//    easy and hard parts, and Claude gets that as a suggestion.
//
// When the 5-hour or weekly limit passes 80%, it leans harder on Haiku.
// The band owns prompt.submit and agent.spawn and calls the functions below;
// the token saver's prompt.compose adds routerSystemSection().

import type { EngineInterface } from 'claude-code'

export type RouterConfig = {
  /** Off switch; on by default. */
  enabled: boolean
  /** The cheaper model easy work goes to. */
  cheapModel: string
  /** At most this many pre-reads per chat. */
  maxPreReadsPerChat: number
}

export const ROUTER_DEFAULTS: RouterConfig = { enabled: true, cheapModel: 'haiku', maxPreReadsPerChat: 20 }

/** What the router did for the current task, for the band. */
export type RouteNote = { easy: number; hard: number; model: string }

const R = {
  cfg: ROUTER_DEFAULTS as RouterConfig,
  preReads: 0,
  /** The standing instruction as fixed for this chat (null until composed). */
  latched: null as boolean | null,
  /** Whether Claude has been told limits are running low, this chat. */
  pressureTold: false,
}

export function resolveRouterConfig(section: unknown): RouterConfig {
  const s = (section && typeof section === 'object' ? section : {}) as Partial<RouterConfig>
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : ROUTER_DEFAULTS.enabled,
    cheapModel: typeof s.cheapModel === 'string' && s.cheapModel.trim() ? s.cheapModel.trim() : ROUTER_DEFAULTS.cheapModel,
    maxPreReadsPerChat:
      Number(s.maxPreReadsPerChat) >= 0 ? Math.floor(Number(s.maxPreReadsPerChat)) : ROUTER_DEFAULTS.maxPreReadsPerChat,
  }
}

export function routerLoadConfig(section: unknown): void {
  R.cfg = resolveRouterConfig(section)
}

export function routerSessionStart(): void {
  R.preReads = 0
  R.latched = null
  R.pressureTold = false
}

// --- 1. the standing instruction ------------------------------------------

export const routerInstruction = (model: string) =>
  'Model routing (Kibbles): when a request has clearly separable parts of different difficulty, do the hard ' +
  'parts yourself and delegate self-contained easy parts to subagents through the Agent tool with ' +
  `model: "${model}". Easy parts are things like searching or reading code, collecting facts, summarising, ` +
  'renaming, formatting, boilerplate and simple mechanical edits. Give each such subagent a complete, ' +
  'self-contained brief. Do not delegate when the task is small, when splitting would mean re-explaining a ' +
  'lot of context, or when the parts depend tightly on each other. Keep anything needing judgement, design, ' +
  `debugging or careful reasoning on your own model. If a ${model} subagent's result looks wrong or ` +
  'incomplete, redo that part yourself.'

/** The system-prompt section, fixed once per chat so the prompt cache holds. */
export function routerSystemSection(): string | null {
  if (R.latched === null) R.latched = R.cfg.enabled
  return R.latched ? routerInstruction(R.cfg.cheapModel) : null
}

// --- 2. the safety net -----------------------------------------------------

const EASY =
  /\b(search|find|locate|look ?up|list|grep|scan|read|explore|collect|gather|summari[sz]e|summary|format|rename|lint|typos?|docs?|documentation|changelog|boilerplate|inventory|count|check links|catalog(ue)?)\b/i
const HARD =
  /\b(design|architect\w*|debug\w*|fix\w*|refactor\w*|security|review\w*|investigat\w*|plan\w*|implement\w*|algorithm\w*|optimi[sz]\w*|migrat\w*|prove|reason)\b/i

/** Whether a helper's job reads as easy work, from its description and type. */
export function looksEasy(description: string, subagentType: string, pressure: boolean): boolean {
  if (HARD.test(description)) return false
  if (subagentType === 'Explore') return true
  if (EASY.test(description)) return true
  // Running low on limits: anything not clearly hard goes cheap.
  return pressure
}

/**
 * From the band's agent.spawn hook: the model to run this helper on, or null
 * to leave Claude's choice alone. Only helpers with no model chosen are
 * touched; forks and teammates always keep theirs.
 */
export function routerSpawnModel(
  e: { model?: string; fork: boolean; isTeammate?: true; description: string; subagentType: string },
  pressure: boolean,
): string | null {
  if (!R.cfg.enabled || e.fork || e.isTeammate || e.model !== undefined) return null
  return looksEasy(e.description, e.subagentType, pressure) ? R.cfg.cheapModel : null
}

/** "claude-haiku-4-5" → "haiku": the family name the band shows. */
export function modelFamily(model: string | undefined): string {
  const m = (model ?? '').toLowerCase()
  for (const f of ['haiku', 'sonnet', 'opus', 'fable']) if (m.includes(f)) return f
  return ''
}

// --- 3. the pre-read for big requests ---------------------------------------

/** Whether a request looks big and multi-part enough to be worth a pre-read. */
export function looksBig(text: string, pressure: boolean): boolean {
  const items = text.split('\n').filter(l => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length
  const counted =
    /\b(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|several|multiple|all (the|of the))\s+(sites?|files?|pages?|bugs?|tasks?|tests?|components?|endpoints?|issues?|features?|screens?|modules?|services?|scripts?|reports?)\b/i.test(
      text,
    )
  const long = text.length >= (pressure ? 400 : 800)
  return items >= (pressure ? 2 : 3) || counted || long
}

const JUDGE_SYSTEM =
  'You triage coding requests for cost. Split the request into its parts and sort them: "easy" parts are ' +
  'self-contained and mechanical (searching, reading, collecting facts, summarising, formatting, renaming, ' +
  'boilerplate, simple edits); "hard" parts need judgement, design, debugging or careful reasoning. Only ' +
  'split when the request clearly has separable parts of different difficulty. Reply with JSON only: ' +
  '{"split": true|false, "easy": ["short part description", ...], "hard": ["...", ...]}'

export type Plan = { split: boolean; easy: string[]; hard: string[] }

/** Reads the judge's reply; anything malformed counts as "don't split". */
export function parsePlan(text: string): Plan {
  const m = text.match(/\{[\s\S]*\}/)
  try {
    const j = JSON.parse(m ? m[0] : text) as Partial<Plan>
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim().slice(0, 200)) : []
    const easy = list(j.easy)
    const hard = list(j.hard)
    return { split: j.split === true && easy.length > 0, easy, hard }
  } catch {
    return { split: false, easy: [], hard: [] }
  }
}

export function planNote(plan: Plan, model: string): string {
  const bullets = (xs: string[]) => xs.map(x => `- ${x}`).join('\n')
  return (
    `Kibbles router (a quick ${model} pre-read of this request) suggests a split. Delegate these easy parts to ` +
    `subagents with the Agent tool and model: "${model}", each with a self-contained brief:\n${bullets(plan.easy)}\n` +
    (plan.hard.length ? `Keep these yourself:\n${bullets(plan.hard)}\n` : '') +
    'This is only a suggestion from a smaller model that has not seen the code: follow it where it fits what you ' +
    'know, and ignore it where it does not.'
  )
}

const PRESSURE_NOTE = (model: string) =>
  `The user's usage limits are above 80%. Lean towards delegating easy, self-contained parts to ${model} ` +
  'subagents to make the remaining limit last longer.'

export type RouteResult = {
  /** Notes for Claude, attached beside this message only. */
  context: string[]
  /** What happened, for the band; null when nothing was routed. */
  note: RouteNote | null
  /** The pre-read's own tokens (input + output), when one ran. */
  tokens: number
}

/**
 * From the band's prompt.submit: decides, by itself, whether this request
 * needs a pre-read, runs it on the cheap model when it does, and returns the
 * notes to attach for Claude.
 */
export async function routerPlan($: EngineInterface, text: string, pressure: boolean): Promise<RouteResult> {
  const out: RouteResult = { context: [], note: null, tokens: 0 }
  if (!R.cfg.enabled) return out
  const model = R.cfg.cheapModel
  if (pressure && !R.pressureTold) {
    R.pressureTold = true
    out.context.push(PRESSURE_NOTE(model))
  }
  if (R.preReads >= R.cfg.maxPreReadsPerChat || !looksBig(text, pressure)) return out
  R.preReads += 1
  try {
    const r = await $.model.complete({
      model,
      system: JUDGE_SYSTEM,
      prompt: text.slice(0, 8000),
      maxTokens: 500,
      effort: 'low',
      timeoutMs: 10_000,
    })
    out.tokens = r.usage.input_tokens + r.usage.output_tokens
    if (!r.isAnswered) return out
    const plan = parsePlan(r.text)
    if (!plan.split) return out
    out.context.push(planNote(plan, model))
    out.note = { easy: plan.easy.length, hard: plan.hard.length, model: modelFamily(model) || model }
  } catch {
    /* no pre-read: Claude still has the standing instruction */
  }
  return out
}
