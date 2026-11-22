// Token saver settings: the `tokenSaver` section of ~/.claude/cute-status.json,
// overridden per project by the same section of <project>/.claude/cute-status.json.

export type FilterConfig = {
  enabled: boolean
  /** Regexes matched against the whole tool name. */
  tools: string[]
  stripAnsi: boolean
  stripProgress: boolean
  collapseRepeats: boolean
  minRepeat: number
  maxLines: number
  headLines: number
  tailLines: number
  maxLineChars: number
  jsonMaxString: number
  jsonMaxArray: number
  minSavingsTokens: number
  protectPattern: string
}

export type DedupeConfig = {
  enabled: boolean
  diff: boolean
  maxDiffRatio: number
  minTokens: number
  maxStoreBytes: number
  maxFileBytes: number
}

export type SaverConfig = {
  enabled: boolean
  terse: boolean
  filter: FilterConfig
  dedupe: DedupeConfig
}

export const SAVER_DEFAULTS: SaverConfig = {
  enabled: true,
  terse: true,
  filter: {
    enabled: true,
    tools: ['Bash', 'mcp__.*'],
    stripAnsi: true,
    stripProgress: true,
    collapseRepeats: true,
    minRepeat: 3,
    maxLines: 200,
    headLines: 60,
    tailLines: 60,
    maxLineChars: 2000,
    jsonMaxString: 400,
    jsonMaxArray: 30,
    minSavingsTokens: 30,
    protectPattern: 'error|fail|warn|traceback|exception|panic|fatal|assert',
  },
  dedupe: {
    enabled: true,
    diff: true,
    maxDiffRatio: 0.5,
    minTokens: 150,
    maxStoreBytes: 262_144,
    maxFileBytes: 5_000_000,
  },
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Merge `over` into `base`, keeping only known keys whose value has the default's type. */
function mergeKnown<T>(base: T, over: unknown): T {
  if (!isObj(over) || !isObj(base)) return base
  const out: Record<string, unknown> = { ...base }
  for (const [k, def] of Object.entries(base)) {
    const v = over[k]
    if (v === undefined) continue
    if (isObj(def)) out[k] = mergeKnown(def, v)
    else if (Array.isArray(def)) out[k] = Array.isArray(v) && v.every(x => typeof x === 'string') ? [...v] : def
    else if (typeof v === typeof def && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v
  }
  return out as T
}

export function resolveConfig(user: unknown, project: unknown): SaverConfig {
  return mergeKnown(mergeKnown(SAVER_DEFAULTS, user), project)
}

/** True when `key` (dotted, e.g. `filter.maxLines`) names a setting. */
export function isKnownKey(key: string): boolean {
  let node: unknown = SAVER_DEFAULTS
  for (const part of key.split('.')) {
    if (!isObj(node) || !(part in node)) return false
    node = node[part]
  }
  return !isObj(node)
}

/** A copy of `obj` with the dotted `key` set to `value`. */
export function setDotted(obj: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const parts = key.split('.')
  const out = { ...obj }
  let node: Record<string, unknown> = out
  for (const p of parts.slice(0, -1)) {
    node[p] = isObj(node[p]) ? { ...(node[p] as Record<string, unknown>) } : {}
    node = node[p] as Record<string, unknown>
  }
  node[parts[parts.length - 1] as string] = value
  return out
}
