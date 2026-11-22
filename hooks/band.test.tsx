import { expect, test } from 'claude-code/testing'

const NOW = 1_000_000_000

const data = {
  weekPct: 85, weekPctReal: true, resetAt: NOW + 2 * 86400_000 + 5 * 3600_000 + 13 * 60_000,
  resetReal: true, weekTokens: 1234, weekLimit: 5_000_000,
  steps: [
    { id: '1', name: 'a', status: 'completed' as const },
    { id: '2', name: 'Writing config', status: 'in_progress' as const },
    { id: '3', name: 'c', status: 'pending' as const },
  ],
  toolCalls: 4, lastTool: 'Bash', taskTokens: 12400, taskCap: 50000,
  mainTokens: 12400, helpers: [], chatTokens: 12400, helperSeq: 0,
  isRunning: false, frame: 0, now: NOW,
}

const props = (cols: number, isWorking = false) => ({
  hasSurvey: false, isCollapsed: false, isWorking, maxRows: 10, bodyColumns: cols,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
})

test('the band draws its three rows and the mascot', async ($, on) => {
  on('state.get', () => ({ value: { value: data, version: 1 } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'kibbles', surface, component: 'AbovePrompt', props: props(140) })
    expect((await ui.find({ type: 'Text', text: /85%/ }))?.text).toContain('85% used · resets in 2d 5h 13m')
    expect((await ui.find({ type: 'Text', text: /1\/3/ }))?.text).toContain('Writing config')
    expect((await ui.find({ type: 'Text', text: /12\.4k/ }))?.text).toContain('12.4k this task · 12.4k this chat')
    expect(await ui.find({ type: 'Text', text: /^Token$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Helpers$/ })).toBeFalsy()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  }
})

test('5-hour limit, day chart, task timer and context', async ($, on) => {
  const more = {
    ...data,
    fiveHourPct: 23, fiveHourResetAt: NOW + 100 * 60_000,
    contextPct: 68,
    days: { before: 40, used: [10, 20, 15], weekday: [1, 2, 3] },
    taskStart: NOW - 252_000, taskEnd: 0, isRunning: true,
  }
  on('state.get', () => ({ value: { value: more, version: 1 } }))
  const ui = await $.ui.mount({ plugin: 'kibbles', surface: 'desktop', component: 'AbovePrompt', props: props(200, true) })
  const week = (await ui.find({ type: 'Text', text: /85%/ }))?.text ?? ''
  expect(week).toContain('· 5h 23% (resets 1h 40m)')
  expect(week).toContain('  Mo Tu We')
  expect((await ui.find({ type: 'Text', text: /1\/3/ }))?.text).toContain('1/3 · 4m 12s · Writing config')
  expect((await ui.find({ type: 'Text', text: /12\.4k/ }))?.text).toContain('· context 68%')
  await ui.unmount()
})

test('waiting on you shows in the task row', async ($, on) => {
  on('state.get', () => ({ value: { value: { ...data, waiting: 'allow Bash?', isRunning: true }, version: 1 } }))
  const ui = await $.ui.mount({ plugin: 'kibbles', surface: 'desktop', component: 'AbovePrompt', props: props(160, true) })
  expect((await ui.find({ type: 'Text', text: /1\/3/ }))?.text).toContain('⏸ waiting for you: allow Bash?')
  await ui.unmount()
})

test('helpers join the task row as a colour key, and split the tokens', async ($, on) => {
  const withHelpers = {
    ...data,
    taskTokens: 30_000, mainTokens: 6_000, chatTokens: 250_000, helperSeq: 2,
    steps: [
      ...data.steps,
      { id: 'a1', name: 'Site 1', status: 'completed' as const, owner: 'agent-a' },
      { id: 'a2', name: 'Site 2', status: 'in_progress' as const, owner: 'agent-a' },
    ],
    helpers: [
      { id: 'agent-a', name: 'Build sites 1-5', tokens: 15_000, calls: 9, status: 'running' as const, color: 0 },
      { id: 'agent-b', name: 'Build sites 6-10', tokens: 9_000, calls: 4, status: 'done' as const, color: 1 },
    ],
  }
  on('state.get', () => ({ value: { value: withHelpers, version: 1 } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'kibbles', surface, component: 'AbovePrompt', props: props(220, true) })
    expect((await ui.find({ type: 'Text', text: /30k this task/ }))?.text).toContain('30k this task · 250k this chat')
    // 1 of your 3 items, 1 of helper A's 2, and helper B (no list) finished.
    const task = (await ui.find({ type: 'Text', text: /^ 3\/6/ }))?.text ?? ''
    expect(task).toContain('■ you 1/3 · 6k')
    expect(task).toContain('■ Build sites 1-5 1/2 · 15k')
    expect(task).toContain('■ Build sites 6-10 ✓ · 9k')
    expect(await ui.find({ type: 'Text', text: /^Helpers$/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('long text never spills: rows get terser as the band narrows', async ($, on) => {
  const busy = {
    ...data,
    taskTokens: 30_000, mainTokens: 6_000, chatTokens: 412_000, helperSeq: 2,
    fiveHourPct: 23, fiveHourResetAt: NOW + 100 * 60_000, contextPct: 68,
    days: { before: 40, used: [10, 20, 15, 0, 0], weekday: [1, 2, 3, 4, 5] },
    taskStart: NOW - 252_000, taskEnd: 0,
    steps: [
      { id: '1', name: 'Refactoring /home/someone/projects/very-long-folder-name/src/components/Header.tsx', status: 'in_progress' as const },
      { id: 'a1', name: 'Site 1', status: 'completed' as const, owner: 'agent-a' },
    ],
    helpers: [
      { id: 'agent-a', name: 'Build the first five marketing sites', tokens: 15_000, calls: 9, status: 'running' as const, color: 0 },
      { id: 'agent-b', name: 'Build the other five marketing sites', tokens: 9_000, calls: 4, status: 'done' as const, color: 1 },
      { id: 'agent-c', name: 'Write the copy', tokens: 2_000, calls: 2, status: 'running' as const, color: 2 },
    ],
  }
  let current: object = busy
  on('state.get', () => ({ value: { value: current, version: 1 } }))
  for (const variant of [busy, { ...busy, helpers: [] }, { ...busy, waiting: 'allow mcp__some_server__a_very_long_tool_name?' }]) {
    current = variant
    for (const cols of [50, 70, 100, 140, 220]) {
      for (const surface of ['terminal', 'desktop'] as const) {
        const ui = await $.ui.mount({ plugin: 'kibbles', surface, component: 'AbovePrompt', props: props(cols, true) })
        // Mascot 8 + gap 1 + label 9 + gap 1, then the bar (at least 8 cells).
        const textRoom = cols - 8 - 1 - 9 - 1 - 8
        for (const re of [/% /, /^ \d+\/\d+/, /k task|k this task|^ 30k/]) {
          const t = (await ui.find({ type: 'Text', text: re }))?.text ?? ''
          expect(t.length).toBeLessThanOrEqual(Math.max(8, textRoom))
        }
        await ui.unmount()
      }
    }
  }
})
