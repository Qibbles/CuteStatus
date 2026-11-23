// Model router: works by itself. It sorts the parts of a task into tiers and
// sends each to the cheapest model that can do it well, so your usage limits
// last longer:
//
//   easy   (search, read, summarise, format, docs...)  -> Haiku
//   medium (routine coding: write, add, build, test...) -> Sonnet
//   hard   (design, debug, fix, refactor, review...)    -> stays on Claude's
//                                                          own model
//
// It only ever routes *down*: a tier whose model is no cheaper than the one
// the chat runs on is left alone, and the main conversation's model is never
// changed. Models are named by family alias ("haiku", "sonnet"), which Claude
// Code resolves to the newest version, so new versions are picked up by
// themselves; a new family is ranked in FAMILY_RANK below (unknown families
// rank as the most capable, so routing still works around them).
//
// Three layers, chosen automatically:
// 1. A standing instruction (in the system prompt, fixed for the chat so the
//    prompt cache holds): split mixed requests across the tiers.
// 2. A safety net: a helper Claude starts with no model chosen gets its
//    tier's model, judged from its job description.
// 3. A quick pre-read on the easy model, only for big multi-part requests:
//    it lists the parts by tier, and Claude gets that as a suggestion.
//
// When the 5-hour or weekly limit passes 80%, everything shifts down a tier.
// The band owns prompt.submit and agent.spawn and calls the functions below;
// the token saver's prompt.compose adds routerSystemSection().

import type { EngineInterface } from 'claude-code'

export type Tier = 'easy' | 'medium' | 'hard'

export type RouterConfig = {
  /** Off switch; on by default. */
  enabled: boolean
  /** The model each tier goes to; null keeps that tier on Claude's own model. */
  tiers: { easy: string | null; medium: string | null }
  /** At most this many pre-reads per chat. */
  maxPreReadsPerChat: number
}

export const ROUTER_DEFAULTS: RouterConfig = {
  enabled: true,
  tiers: { easy: 'haiku', medium: 'sonnet' },
  maxPreReadsPerChat: 20,
}

/** What the router split off the current task, for the band. */
export type RouteNote = { routes: { model: string; count: number }[] }

/**
 * How capable (and costly) each model family is, cheapest first. A family not
 * listed ranks above all of these, as the newest models usually do.
 */
export const FAMILY_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 }

const R = {
  cfg: ROUTER_DEFAULTS as RouterConfig,
  preReads: 0,
  /** The standing instruction as fixed for this chat (null until composed). */
  latched: null as string | null | undefined,
  /** Whether Claude has been told limits are running low, this chat. */
  pressureTold: false,
}

const modelOrNull = (v: unknown, fallback: string | null): string | null =>
  v === null ? null : typeof v === 'string' && v.trim() ? v.trim() : fallback

export function resolveRouterConfig(section: unknown): RouterConfig {
  const s = (section && typeof section === 'object' ? section : {}) as Record<string, unknown>
  const t = (s.tiers && typeof s.tiers === 'object' ? s.tiers : {}) as Record<string, unknown>
  // `cheapModel` was the easy tier's setting before there were tiers.
  const easyDefault = modelOrNull(s.cheapModel, ROUTER_DEFAULTS.tiers.easy)
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : ROUTER_DEFAULTS.enabled,
    tiers: {
      easy: modelOrNull(t.easy, easyDefault),
      medium: modelOrNull(t.medium, ROUTER_DEFAULTS.tiers.medium),
    },
    maxPreReadsPerChat:
      Number(s.maxPreReadsPerChat) >= 0 ? Math.floor(Number(s.maxPreReadsPerChat)) : ROUTER_DEFAULTS.maxPreReadsPerChat,
  }
}

export function routerLoadConfig(section: unknown): void {
  R.cfg = resolveRouterConfig(section)
}

export function routerSessionStart(): void {
  R.preReads = 0
  R.latched = undefined
  R.pressureTold = false
}

/** "claude-haiku-4-5" → "haiku": the family name the band shows. */
export function modelFamily(model: string | undefined): string {
  const m = (model ?? '').toLowerCase()
  for (const f of Object.keys(FAMILY_RANK)) if (m.includes(f)) return f
  return ''
}

/** A model's rank; unknown (or not yet known) models rank as the most capable. */
export function rankOf(model: string | undefined): number {
  const f = modelFamily(model)
  return f ? (FAMILY_RANK[f] ?? 99) : 99
}

/**
 * The model a tier's work should run on, or null to leave it on the chat's
 * own model: when the tier has none, or its model is no cheaper than `main`.
 */
export function tierModel(tier: Tier, main: string | undefined, cfg: RouterConfig = R.cfg): string | null {
  if (tier === 'hard') return null
  const model = cfg.tiers[tier]
  if (!model) return null
  return rankOf(model) < rankOf(main) ? model : null
}

// --- 1. the standing instruction ------------------------------------------

export function routerInstruction(cfg: RouterConfig = R.cfg): string | null {
  const { easy, medium } = cfg.tiers
  if (!easy && !medium) return null
  const lines = [
    'Model routing (Kibbles): when a request has clearly separable parts of different difficulty, give each ' +
      'self-contained part to a subagent (Agent tool) on the cheapest model that can do it well, and do the hard ' +
      'parts yourself.',
  ]
  if (easy) {
    lines.push(
      `- Easy parts (searching or reading code, collecting facts, summarising, renaming, formatting, docs, ` +
        `boilerplate, simple mechanical edits): model: "${easy}".`,
    )
  }
  if (medium) {
    lines.push(
      `- Routine coding (writing straightforward code, tests or pages from a clear spec, small features, ` +
        `conversions): model: "${medium}".`,
    )
  }
  lines.push(
    '- Hard parts (design, debugging, tricky changes, anything needing careful reasoning): do them yourself.',
    'Only use a model that is cheaper than the one you are running on. Give each subagent a complete, ' +
      'self-contained brief. Do not delegate when the task is small, when splitting would mean re-explaining a ' +
      "lot of context, or when the parts depend tightly on each other. If a subagent's result looks wrong or " +
      'incomplete, redo that part yourself.',
  )
  return lines.join('\n')
}

/** The system-prompt section, fixed once per chat so the prompt cache holds. */
export function routerSystemSection(): string | null {
  if (R.latched === undefined) R.latched = R.cfg.enabled ? routerInstruction() : null
  return R.latched
}

// --- 2. the safety net -----------------------------------------------------

const EASY =
  /\b(search|find|locate|look ?up|list|grep|scan|read|explore|collect|gather|summari[sz]e|summary|format|rename|lint|typos?|docs?|documentation|changelog|boilerplate|inventory|count|check links|catalog(ue)?)\b/i
const MEDIUM =
  /\b(write|add|build|create|implement|test|tests|update|convert|port|translate|generate|scaffold|style|page|component|endpoint|script|copy)\b/i
const HARD =
  /\b(design|architect\w*|debug\w*|fix\w*|refactor\w*|security|review\w*|investigat\w*|plan\w*|algorithm\w*|optimi[sz]\w*|migrat\w*|prove|reason\w*|diagnos\w*)\b/i

/**
 * Sorts a helper's job into a tier from its description and type. Running low
 * on limits shifts everything that isn't clearly hard down a tier.
 */
export function tierOf(description: string, subagentType: string, pressure: boolean): Tier | null {
  if (HARD.test(description)) return 'hard'
  const easy = subagentType === 'Explore' || EASY.test(description)
  if (easy) return 'easy'
  if (MEDIUM.test(description)) return pressure ? 'easy' : 'medium'
  // Nothing to go on: left alone, unless limits are running low.
  return pressure ? 'medium' : null
}

/** Kept for callers that only ask "is this easy?". */
export function looksEasy(description: string, subagentType: string, pressure: boolean): boolean {
  return tierOf(description, subagentType, pressure) === 'easy'
}

/**
 * From the band's agent.spawn hook: the model to run this helper on, or null
 * to leave Claude's choice alone. Only helpers with no model chosen are
 * touched; forks and teammates always keep theirs.
 */
export function routerSpawnModel(
  e: { model?: string; fork: boolean; isTeammate?: true; description: string; subagentType: string; parentModel?: string },
  pressure: boolean,
  mainModel?: string,
): string | null {
  if (!R.cfg.enabled || e.fork || e.isTeammate || e.model !== undefined) return null
  const tier = tierOf(e.description, e.subagentType, pressure)
  return tier ? tierModel(tier, e.parentModel || mainModel) : null
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
  'You triage coding requests for cost. Split the request into its parts and sort each into one tier: "easy" ' +
  '(self-contained and mechanical: searching, reading, collecting facts, summarising, formatting, renaming, ' +
  'docs, boilerplate), "medium" (routine coding from a clear spec: straightforward code, tests, pages, small ' +
  'features, conversions) or "hard" (needs judgement, design, debugging or careful reasoning). Only split when ' +
  'the request clearly has separable parts of different difficulty. Reply with JSON only: ' +
  '{"split": true|false, "easy": ["short part description", ...], "medium": [...], "hard": [...]}'

export type Plan = { split: boolean; easy: string[]; medium: string[]; hard: string[] }

/** Reads the judge's reply; anything malformed counts as "don't split". */
export function parsePlan(text: string): Plan {
  const m = text.match(/\{[\s\S]*\}/)
  try {
    const j = JSON.parse(m ? m[0] : text) as Partial<Record<keyof Plan, unknown>>
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim().slice(0, 200)) : []
    const easy = list(j.easy)
    const medium = list(j.medium)
    const hard = list(j.hard)
    return { split: j.split === true && easy.length + medium.length > 0, easy, medium, hard }
  } catch {
    return { split: false, easy: [], medium: [], hard: [] }
  }
}

/** The suggestion Claude gets, with only the tiers that route somewhere cheaper. */
export function planNote(plan: Plan, models: { easy: string | null; medium: string | null }, judge: string): string {
  const bullets = (xs: string[]) => xs.map(x => `- ${x}`).join('\n')
  const keep = [...plan.hard]
  const parts: string[] = []
  for (const tier of ['easy', 'medium'] as const) {
    const model = models[tier]
    if (plan[tier].length === 0) continue
    if (model) parts.push(`With the Agent tool and model: "${model}", each with a self-contained brief:\n${bullets(plan[tier])}`)
    else keep.push(...plan[tier])
  }
  return (
    `Kibbles router (a quick ${judge} pre-read of this request) suggests a split. Delegate:\n${parts.join('\n')}\n` +
    (keep.length ? `Keep these yourself:\n${bullets(keep)}\n` : '') +
    'This is only a suggestion from a smaller model that has not seen the code: follow it where it fits what you ' +
    'know, and ignore it where it does not.'
  )
}

const PRESSURE_NOTE =
  "The user's usage limits are above 80%. Lean towards delegating self-contained parts to the cheaper models " +
  'from your routing instructions, one tier lower than usual, to make the remaining limit last longer.'

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
 * needs a pre-read, runs it on the easy tier's model when it does, and returns
 * the notes to attach for Claude.
 */
export async function routerPlan(
  $: EngineInterface,
  text: string,
  pressure: boolean,
  mainModel?: string,
): Promise<RouteResult> {
  const out: RouteResult = { context: [], note: null, tokens: 0 }
  if (!R.cfg.enabled) return out
  const models = { easy: tierModel('easy', mainModel), medium: tierModel('medium', mainModel) }
  if (!models.easy && !models.medium) return out
  if (pressure && !R.pressureTold) {
    R.pressureTold = true
    out.context.push(PRESSURE_NOTE)
  }
  if (R.preReads >= R.cfg.maxPreReadsPerChat || !looksBig(text, pressure)) return out
  const judge = models.easy ?? models.medium ?? 'haiku'
  R.preReads += 1
  try {
    const r = await $.model.complete({
      model: judge,
      system: JUDGE_SYSTEM,
      prompt: text.slice(0, 8000),
      maxTokens: 600,
      effort: 'low',
      timeoutMs: 10_000,
    })
    out.tokens = r.usage.input_tokens + r.usage.output_tokens
    if (!r.isAnswered) return out
    const plan = parsePlan(r.text)
    if (!plan.split) return out
    out.context.push(planNote(plan, models, judge))
    const routes = (['easy', 'medium'] as const)
      .filter(t => models[t] && plan[t].length > 0)
      .map(t => ({ model: modelFamily(models[t] ?? '') || (models[t] ?? ''), count: plan[t].length }))
    if (routes.length > 0) out.note = { routes }
  } catch {
    /* no pre-read: Claude still has the standing instruction */
  }
  return out
}
