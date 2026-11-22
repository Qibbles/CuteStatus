# Kibbles - Usage HUD & Token Saver 🐸

A Claude Code plugin (formerly CuteStatus) that displays a tiny, live status band that sits just above the prompt bar. At a glance it shows how much of your usage limits are gone, how far along the current task is, and how many tokens it has used. It also tells you when Claude is waiting on you. Kibbles, a little frog, keeps you company while you work.

Under the hood, its **token saver** cuts what Claude has to read: it condenses noisy tool output, skips re-reading files that haven't changed, and keeps replies short. The band shows how much it saved.

![The Kibbles band: working, waiting for you, and idle](docs/band.png)

## What it shows

The band is three lines tall:

| Row | What it means |
|---|---|
| **Week** | How much of your weekly limit you've used and when it resets, then your **5-hour limit** (`5h 23%`) and when that resets. At the end are the **days of the week so far**, each name in the colour of its part of the bar (`Mo Tu We Th`). Today is in bold. |
| **Task** | How far along the current task is, from Claude's to-do list, and **how long it has taken**: `3/6 · 4m 12s · Writing the README`. If there's no to-do list, it counts the steps Claude has taken and names the last one. When Claude is **waiting on you**, it says so: `⏸ waiting for you: allow Bash?`. |
| **Token** | Tokens used by this task (including any helpers), by the whole chat so far, what the **token saver** kept out of the chat, and how full Claude's **context window** is: `12.4k this task · 412k this chat · saved 38k · context 68%`. When the context gets near full, Claude summarises the chat to make room and can lose detail, so a high number is a hint to start a fresh chat for a new topic. |

The bars:

- **Week:** split into days, each day in its own colour, matching the coloured day names in the text. You can see which days used the most. Grey is usage from before Kibbles started counting this week.
- **Task and Token:** turn from **green** to **amber** to **red** as they fill. The 5-hour limit and the context window use the same colours in their text.

## Helpers (subagents)

When Claude hands parts of a task to helpers, the band shows who's doing what, with one colour per worker: blue for you (the main conversation) and a different colour for each helper.

![The band with two helpers at work](docs/helpers.png)

- **Task bar:** one lane per worker, as wide as its share of the to-do items. The solid part of a lane is what that worker has finished; the light, dotted part in the same colour is what it still has to do. A helper at `2/5` is two-fifths solid, and a finished helper's lane is solid all the way.
- **Task text:** becomes the colour key: `■ you 1/2 · 6k`, then each helper's job, its own progress and its tokens. `✓` means that helper has finished, `✗` that it failed. A helper with no to-do list shows how many steps it has taken instead.
- **Token bar:** the whole bar is this task's tokens, split by who used what share. With no helpers, it instead fills against `taskTokenSoftCap`.

**An example:** you ask Claude to build 10 sites, and it hands sites 1–5 to one helper and 6–10 to another. The Task bar shows each helper's lane filling up, so you can see at a glance who's done and who still has work left. The key shows each helper's own `2/5` or `✓ 5/5`. The Token bar shows that the coral helper used half of the task's tokens.

## Meet Kibbles

Kibbles is a little frog who shows what Claude is doing.

**Working:** while Claude is on a task, Kibbles sits behind a big computer, typing away, with its spiral eyes spinning and sweat dripping down.

![Kibbles working behind the computer](docs/busy.gif)

**Waiting for you:** when Claude needs your permission or an answer, Kibbles stands up and waves at you, with a "!" bubble.

![Kibbles waving for your attention](docs/wait.gif)

**Napping:** when nothing is running, Kibbles naps, breathing slowly, with its mouth opening into a little "o", a snore bubble and floating z's.

![Kibbles asleep](docs/sleep.gif)

Kibbles' mood follows your weekly usage:

| Weekly usage | Working | Napping |
|---|---|---|
| Under 50% | 1 sweat drop, relaxed spin | smiling |
| 50–80% | 2 sweat drops, faster spin | straight face |
| Over 80% | 3 sweat drops, eyes spinning backwards | worried, with a sweat drop |

## Token saver

It works by itself, runs locally and never calls the model. It works in four ways.

**1. Noisy output is condensed.** Before Claude sees the output of a shell command or an MCP tool, the saver:

- strips colour codes and progress bars;
- collapses runs of repeated log lines (`[998 similar lines collapsed, not shown]`);
- keeps the start and end of very long output (`[840 lines trimmed]`);
- shortens huge JSON values and lists.

Lines containing **error, fail, warn, traceback, exception, panic, fatal or assert are never removed**. Number-only data, such as `seq` output or a numeric CSV, is never collapsed. Claude is told that the hidden lines were not shown and must not be guessed, and that adding the comment `# nofilter` to a command gets the full output.

**2. Unchanged files aren't read twice.** If Claude reads a file again and nothing has changed, it gets a one-line note to use what it already has.

- If it asks again straight away, the read goes through.
- If the file has changed, Claude gets just the diff, provided the diff is small. Edits still work afterwards.
- The main chat and each helper are tracked separately.
- After an edit or a compaction, the next read is a full one.

**3. Terse replies.** A short style instruction asks for no preamble, no restating the question, no closing recap, and code changes shown as diffs. It never shortens code, commands or error messages. It's set once at the start of a chat, in the system prompt, so it doesn't break Claude's prompt cache. If you switch it in the settings mid-chat, Claude gets one note instead.

**4. Savings in the band.** The Token row shows how many tokens the saver kept out of the chat: `· saved 38k`. There's nothing to run: it works by itself, and you can tune or turn it off in the settings below.

**Measured savings** (estimated at ~4 characters a token; no error lines lost in any case):

| Output | Before | After | Saved |
|---|---:|---:|---:|
| A pytest run of 900 tests with 1 failure | 15,373 | 314 | 98% |
| 300 log lines with 1 error | 4,384 | 106 | 98% |
| pip install with progress bars | 965 | 65 | 93% |
| A 120-item GitHub API response | 56,102 | 4,180 | 93% |
| A coloured cargo build | 428 | 50 | 88% |
| A 16-step coding session (output + re-reads) | 92,201 | 11,122 | 88% |
| Output that was already short | – | – | 0% |

How much you save depends on how noisy your tools are: test runners, builds, logs, API JSON and re-reads save the most.

## Install

You need [Claude Code](https://claude.com/claude-code). In a Claude Code session, type:

```
/plugin install kibbles --marketplace Qibbles/CuteStatus
```

Answer `y` to add the marketplace, then press Enter to install it for your user. The band appears right away.

Or from a shell:

```bash
claude plugin install kibbles --marketplace Qibbles/CuteStatus
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `Qibbles/CuteStatus`, then **Add plugin**.

## Turn it off or remove it

- **Hide it for a moment:** press `ctrl+x` then `ctrl+a`, or click the `[-]` beside the band. Do the same to bring it back.
- **Turn it off or remove it:** type `/plugin`, choose **kibbles** from your installed plugins, then **Disable** or **Uninstall**. From a shell:

```bash
claude plugin uninstall kibbles
```

## Upgrading from CuteStatus

This plugin used to be called **cute-status**. If you installed it under that name, remove the old one and install the new one:

```bash
claude plugin uninstall cute-status
```

```bash
claude plugin install kibbles --marketplace Qibbles/CuteStatus
```

Your settings carry over: on first run, Kibbles copies `~/.claude/cute-status.json` to `~/.claude/kibbles.json`. A project's `.claude/cute-status.json` keeps working too.

## Settings

On first run it creates `~/.claude/kibbles.json`. Edit it any time; changes apply on your next message.

```json
{
  "weeklyTokenLimit": 5000000,
  "resetDay": "mon",
  "resetTime": "09:00",
  "utcOffsetHours": 8,
  "taskTokenSoftCap": 50000
}
```

| Setting | What it does |
|---|---|
| `taskTokenSoftCap` | How many tokens fill the Token bar (default 50,000). It's only a scale for the bar, not a limit. |
| `weeklyTokenLimit` | Only used if your plan doesn't report its weekly limit (see below). Your weekly allowance in tokens, as a guess. |
| `resetDay`, `resetTime` | Only used in the same case. When your week resets, e.g. `"mon"` and `"09:00"`. |
| `utcOffsetHours` | The timezone for `resetDay` and `resetTime`, in hours from UTC (8 for Singapore, 0 for London in winter, -5 for New York in winter). It defaults to your computer's timezone. |
| `tokenSaver` | The token saver's settings (below). |

### Token saver settings

They go in a `"tokenSaver"` section. Put it in `~/.claude/kibbles.json` for all projects, or in `.claude/kibbles.json` inside a project for that project only; the project's file wins. Changes apply on your next message. To turn the token saver off, set `"enabled": false`.

```json
{ "tokenSaver": { "enabled": true, "terse": true, "filter": { "maxLines": 400 } } }
```

| Setting | Default | What it does |
|---|---|---|
| `enabled` | `true` | The whole token saver |
| `terse` | `true` | Terse replies |
| `filter.enabled` | `true` | Condensing tool output |
| `filter.tools` | `["Bash", "mcp__.*"]` | Which tools' output is condensed (patterns matched against the tool name) |
| `filter.maxLines` | `200` | Longer output keeps only its start and end… |
| `filter.headLines`, `filter.tailLines` | `60`, `60` | …this many lines of each |
| `filter.maxLineChars` | `2000` | A longer single line is cut in the middle |
| `filter.minRepeat` | `3` | How many repeated lines it takes to collapse them (runs of 4 or more actually shrink) |
| `filter.jsonMaxString`, `filter.jsonMaxArray` | `400`, `30` | JSON values and lists longer than this are shortened |
| `filter.minSavingsTokens` | `30` | Output is left untouched unless it saves at least this many tokens |
| `filter.protectPattern` | `error\|fail\|warn\|…` | Lines matching this are never removed |
| `filter.stripAnsi`, `filter.stripProgress`, `filter.collapseRepeats` | `true` | Each step on its own |
| `dedupe.enabled` | `true` | Skipping unchanged re-reads |
| `dedupe.diff` | `true` | Sending a diff for a changed file |
| `dedupe.maxDiffRatio` | `0.5` | Only when the diff is smaller than this share of the file |
| `dedupe.minTokens` | `150` | Smaller reads are never skipped |

## Where the numbers come from

- **Week:** comes straight from your Claude plan's real weekly limit, which Claude subscriptions report. If your plan doesn't report one (for example, API-key billing), Kibbles estimates it from the tokens it has counted and the settings above, and adds **(est.)** to the row.
- **5-hour limit and context:** reported by Claude Code itself, so they're real figures. They appear once the first reply of a chat has come back.
- **Days:** Kibbles notes your weekly percentage as the days go by, so it can only split days it was running for. Usage from before it started counting shows as grey.
- **Task:** read from Claude's own to-do list as it updates.
- **Token:** the new input and output tokens of every request in the task, including every helper's. "This chat" counts from when Kibbles started running in that chat. Tokens served from Claude's prompt cache aren't counted, so this is "new work done", not everything the model read.

## Costs and privacy

- **Free to run:** it never calls the model, so it uses **zero tokens**, and the token saver cuts the tokens Claude reads.
- **Updates on events:** it updates when something happens (a message, a tool call, a usage change). It never polls, and redraws at most once a second.
- **Stays on your computer:** everything runs locally. Nothing is sent anywhere, and the only file it writes is its own settings file.

## Where it works

The band fits any width. On a narrow window each row switches to shorter wording (`85% used · resets in 2d 5h 13m` becomes `85% · resets 2d 5h`, then just `85%`). Long names are trimmed with `…`; file paths are trimmed in the middle so you still see the file name. If there are more helpers than fit, the last entry reads `+N more`.

- **Claude Code desktop app and IDE extensions:** Kibbles is an animated drawing.
- **Terminal:** Kibbles is drawn as small pictures where your terminal supports images. Otherwise it's a tiny text face, `(@ω@)` when working or `(-‿-) z` when napping.

## For developers

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The band lives in `hooks/register.tsx` and Kibbles in `hooks/mascot.ts`. The token saver is in `hooks/saver/`: `filters.ts` (output condensing), `dedupe.ts` and `diff.ts` (re-reads), `saver.ts` (its hooks), each with a `*.test.ts` file. Every filter has fixture-based tests, including checks that no error line is ever lost. The frames in `assets/` are the terminal's pictures of Kibbles.

## License

[MIT](LICENSE) © Qibbles
