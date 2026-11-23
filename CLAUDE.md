# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Kibbles is a Claude Code plugin (a "mod": a hooks module, no build step) with three parts that share one module:

- **Usage HUD**: a three-row band above the prompt (Week, Task, Token) plus an animated frog mascot.
- **Token saver** (`hooks/saver/`): condenses noisy Bash/MCP output, dedupes unchanged `Read`s (or swaps in a diff), and adds a terse-reply instruction.
- **Model router** (`hooks/router/`): routes helper (subagent) work by tier: easy → Haiku, routine coding → Sonnet, hard → stays on the chat's model.

The plugin name is `kibbles` (`.claude-plugin/plugin.json`, with `displayName` "Kibbles - Usage HUD & Token Saver"). The repo is its own marketplace (`.claude-plugin/marketplace.json`, `source: "./"`).

## Commands

```bash
claude plugin validate .   # manifest + module: type errors, refused hooks, $.state keys vs the contract
claude plugin test .       # runs every *.test.ts / *.test.tsx under the folder (no per-test filter)
```

Run a local copy in Claude Code with `claude --plugin-dir .`. `tsc -p .` works only after Claude Code has loaded the plugin once, because `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which the engine writes (and `.gitignore` excludes).

The API reference is the engine-written `.claude-plugin/types/claude-code/index.d.ts`. Grep it for event names (`'tool.call'`, `'agent.spawn'`), `$` methods and element props.

## Architecture

**One hook per event per plugin.** The engine allows a single unmatched hook per event per plugin, so `hooks/register.tsx` owns `session.start`, `prompt.submit`, `turn.*`, `agent.spawn`, `agent.report`, the catch-all `tool.call` and `ui.render (AbovePrompt)`. The saver and router expose plain functions that `register.tsx` calls from those hooks: `saverAfterToolCall`, `saverPromptNote`, `routerPlan`, `routerSpawnModel` and so on. `saver.ts`'s `registerSaver` adds only the hooks nobody else uses: `prompt.compose`, `session.compact` and `tool.call {tool: 'Read'}`. That single `prompt.compose` hook also appends the router's system-prompt section via `routerSystemSection()`. When adding a feature, call it from the existing hook rather than registering a second one.

**System-prompt text is latched per chat.** Anything added through `prompt.compose` (terse mode, the router instruction) is computed once and never changes mid-chat, so the prompt cache isn't invalidated. Mid-chat changes are delivered once as `context` on `prompt.submit` instead (`saverPromptNote`, the router's pressure note and pre-read plan).

**State and redraws.** All band data is one `$.state` value, `kibbles.data`, typed as `BandData` in `types/index.d.ts`; `validate` checks state keys against that contract. Hooks mutate the module-level `S.d`, then call `schedule($)`. That throttles `flush()` to at most one `$.state.set` per second, and `flush()` recomputes the weekly and daily figures first. The render hook only reads state. Values that must survive across sessions go to `$.store`: the weekly token estimate (`weekly-estimate`) and per-calendar-day marks (`weekly-by-date`). Module variables reset on every hot reload, while `$.state` persists, so `session.start` merges the previous state over `freshData()`. Any new `BandData` field must be optional, or defaulted there.

**Where the numbers come from.** Real weekly and 5-hour limits plus context % arrive via `session.measure` (`rateLimits` `seven_day` / `five_hour`, `context.percent`). Without a real weekly window, the band estimates from locally counted tokens and the config. Token counts come from `turn.step` results (input + output, not cache), attributed to the main chat or to a helper by `e.agentId`. Helpers are registered in `agent.spawn` (the description becomes the name, the resolved model is recorded) and finished in `agent.report`.

**Rendering.** `ui.render` builds three rows with `row(label, segs, parts)`. Bars are `Seg[]` runs, built by `segments()` (split by weight), `lanes()` (one lane per worker: solid for done, shaded for to-do) or a single tone run (green, amber, red at 50%/80%). Text never spills: each row passes wordings from fullest to tersest to `fit(variants, room)`, and `clip()` ellipsizes paths in the middle. `room` reserves a margin on proportional-font surfaces. A test asserts no overflow at widths 50–220, so keep new text inside `fit()` tiers. Desktop, IDE and mobile draw the mascot with `el.Svg` (SMIL-animated); the terminal uses `el.Image` with PNG frames from `assets/`, falling back to `textFace()`.

**Mascot.** `hooks/mascot.ts` generates the SVG for `mood` (from weekly %: happy <50, neutral 50–80, worried >80) × `activity` (`busy` | `wait` | `sleep`). The terminal frames `assets/{mood}-{activity}-{0..2}.png` and the README images in `docs/` are rendered from `mascotSvg(..., animated=false, frame)` with Playwright. There is no render script in the repo, so after changing `mascot.ts`, the PNGs and GIFs have to be regenerated by hand.

**Token saver invariants** (`hooks/saver/filters.ts`). Lines matching `protectPattern` (error, fail, warn, traceback, exception, panic, fatal, assert) are never dropped or shortened. Output is only replaced when it saves at least `minSavingsTokens`. A command containing `# nofilter` is passed through untouched. Every condensed Bash result gets `RAW_HINT` appended. Dedupe tracks reads per conversation scope (main vs each `agentId`), forgets a file after an edit, and resets a scope on compaction or `agent.report`.

**Router rules** (`hooks/router/router.ts`). Work only ever moves to a cheaper model: `tierModel` compares `rankOf(tier model)` with the caller's model (`e.parentModel`, else the main model). `FAMILY_RANK` orders known families, and unknown families rank as most capable. Models are named by family alias (`haiku`, `sonnet`), so new versions are picked up automatically; a new family needs a `FAMILY_RANK` entry. The safety net only touches helpers spawned with no model, never forks or teammates. The Haiku pre-read (`$.model.complete`) runs only for requests that pass `looksBig`, capped by `maxPreReadsPerChat`. Its tokens are added to the band's counts. Above 80% of either limit (`underPressure`), tiers shift down.

## Settings

User settings live in `~/.claude/kibbles.json`, created with defaults on first run and re-read on every prompt. A project's `.claude/kibbles.json` can override the `tokenSaver` section. The top-level keys (`weeklyTokenLimit`, `resetDay`, `resetTime`, `utcOffsetHours`) are only used when the plan reports no real weekly window. `taskTokenSoftCap` scales the Token bar when there are no helpers. The `tokenSaver` and `router` sections are documented in the README's settings tables; defaults live in `hooks/saver/config.ts` and `ROUTER_DEFAULTS`.

## Releasing

Bump `version` in `.claude-plugin/plugin.json`. The README's account-install link points at `releases/latest/download/kibbles.plugin`, so each GitHub release needs a `kibbles.plugin` asset: a zip of the plugin folder's contents, with `.claude-plugin/` at the top, excluding `.git`, `.claude-plugin/types/` and `docs/`. `*.plugin` is gitignored.
