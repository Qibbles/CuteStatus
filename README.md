# CuteStatus 🐸

A Claude Code plugin that displays a tiny, live status band that sits just above the prompt bar. At a glance it shows how much of your usage limits are gone, how far along the current task is, and how many tokens it has used. It also tells you when Claude is waiting on you. Kibbles, a little frog, keeps you company while you work.

![The CuteStatus band: working, waiting for you, and idle](docs/band.png)

## What it shows

The band is three lines tall:

| Row | What it means |
|---|---|
| **Week** | How much of your weekly limit you've used and when it resets, then your **5-hour limit** (`5h 23%`) and when that resets. At the end are the **days of the week so far**, each name in the colour of its part of the bar (`Mo Tu We Th`). Today is in bold. |
| **Task** | How far along the current task is, from Claude's to-do list, and **how long it has taken**: `3/6 · 4m 12s · Writing the README`. If there's no to-do list, it counts the steps Claude has taken and names the last one. When Claude is **waiting on you**, it says so: `⏸ waiting for you: allow Bash?`. |
| **Token** | Tokens used by this task (including any helpers), by the whole chat so far, and how full Claude's **context window** is: `12.4k this task · 412k this chat · context 68%`. When the context gets near full, Claude summarises the chat to make room and can lose detail, so a high number is a hint to start a fresh chat for a new topic. |

The bars:

- **Week:** split into days, each day in its own colour, matching the coloured day names in the text. You can see which days used the most. Grey is usage from before CuteStatus started counting this week.
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

## Install

You need [Claude Code](https://claude.com/claude-code). In a Claude Code session, type:

```
/plugin install cute-status --marketplace Qibbles/CuteStatus
```

Answer `y` to add the marketplace, then press Enter to install it for your user. The band appears right away.

Or from a shell:

```bash
claude plugin install cute-status --marketplace Qibbles/CuteStatus
```

In the Claude desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `Qibbles/CuteStatus`, then **Add plugin**.

## Turn it off or remove it

- **Hide it for a moment:** press `ctrl+x` then `ctrl+a`, or click the `[-]` beside the band. Do the same to bring it back.
- **Turn it off or remove it:** type `/plugin`, choose **cute-status** from your installed plugins, then **Disable** or **Uninstall**. From a shell:

```bash
claude plugin uninstall cute-status
```

## Settings

On first run it creates `~/.claude/cute-status.json`. Edit it any time; changes apply on your next message.

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

## Where the numbers come from

- **Week:** comes straight from your Claude plan's real weekly limit, which Claude subscriptions report. If your plan doesn't report one (for example, API-key billing), CuteStatus estimates it from the tokens it has counted and the settings above, and adds **(est.)** to the row.
- **5-hour limit and context:** reported by Claude Code itself, so they're real figures. They appear once the first reply of a chat has come back.
- **Days:** CuteStatus notes your weekly percentage as the days go by, so it can only split days it was running for. Usage from before it started counting shows as grey.
- **Task:** read from Claude's own to-do list as it updates.
- **Token:** the new input and output tokens of every request in the task, including every helper's. "This chat" counts from when CuteStatus started running in that chat. Tokens served from Claude's prompt cache aren't counted, so this is "new work done", not everything the model read.

## Costs and privacy

- **Free to run:** it never calls the model, so it uses **zero tokens**.
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

The band lives in `hooks/register.tsx` and Kibbles in `hooks/mascot.ts`. The frames in `assets/` are the terminal's pictures of Kibbles.

## License

[MIT](LICENSE) © Qibbles
