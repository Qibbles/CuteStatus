import { expect, test } from 'claude-code/testing'

const data = {
  weekPct: 85, weekPctReal: true, resetAt: 1_000_000_000 + 2 * 86400_000 + 5 * 3600_000 + 13 * 60_000,
  resetReal: true, weekTokens: 1234, weekLimit: 5_000_000,
  steps: [
    { id: '1', name: 'a', status: 'completed' as const },
    { id: '2', name: 'Writing config', status: 'in_progress' as const },
    { id: '3', name: 'c', status: 'pending' as const },
  ],
  toolCalls: 4, lastTool: 'Bash', taskTokens: 12400, taskCap: 50000,
  isRunning: false, frame: 0, now: 1_000_000_000,
}

test('the band draws three aligned rows and the mascot', async ($, on) => {
  on('state.get', () => ({ value: { value: data, version: 1 } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cute-status', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 140,
        scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /85%/ }))?.text).toContain('85% used · 15% left · resets in 2d 5h 13m')
    expect((await ui.find({ type: 'Text', text: /1\/3/ }))?.text).toContain('Writing config')
    expect((await ui.find({ type: 'Text', text: /12\.4k/ }))?.text).toContain('12.4k this task · 12.4k this chat')
    expect(await ui.find({ type: 'Text', text: /^Token$/ })).toBeTruthy()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  }
})

test('helpers get their own row and a token split', async ($, on) => {
  const withHelpers = {
    ...data,
    taskTokens: 30_000,
    mainTokens: 6_000,
    chatTokens: 250_000,
    helperSeq: 2,
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
    const ui = await $.ui.mount({
      plugin: 'cute-status', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 200,
        scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /30k this task/ }))?.text).toContain('30k this task · 250k this chat')
    // 1 of your 3 items, 1 of helper A's 2, and helper B (no list) finished.
    expect(await ui.find({ type: 'Text', text: /^ 3\/6$/ })).toBeTruthy()
    const helpers = (await ui.find({ type: 'Text', text: /1\/2 done/ }))?.text ?? ''
    expect(helpers).toContain('■ you 1/3 · 6k')
    expect(helpers).toContain('■ Build sites 1-5 1/2 · 15k')
    expect(helpers).toContain('■ Build sites 6-10 ✓ · 9k')
    await ui.unmount()
  }
})

test('no helpers, no helpers row', async ($, on) => {
  on('state.get', () => ({ value: { value: { ...data, helpers: [], mainTokens: 12400 }, version: 1 } }))
  const ui = await $.ui.mount({
    plugin: 'cute-status', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /Helpers/ })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /12\.4k/ }))?.text).not.toContain('you')
  await ui.unmount()
})

test('long text never spills: rows get terser as the band narrows', async ($, on) => {
  const busy = {
    ...data,
    taskTokens: 30_000, mainTokens: 6_000, chatTokens: 412_000, helperSeq: 2,
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
  on('state.get', () => ({ value: { value: busy, version: 1 } }))
  for (const cols of [50, 70, 100, 140, 220]) {
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'cute-status', surface, component: 'AbovePrompt',
        props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: cols,
          scroll: { offset: 0, bodyRows: 10 }, view: {} },
      })
      // Mascot 8 + gap 1 + label 9 + gap 1, then the bar (at least 8 cells).
      const textRoom = cols - 8 - 1 - 9 - 1 - 8
      for (const re of [/% /, /^ \d+\/\d+ /, /done/, /k task|k this task|^ 30k$/]) {
        const t = (await ui.find({ type: 'Text', text: re }))?.text ?? ''
        expect(t.length).toBeLessThanOrEqual(Math.max(8, textRoom))
      }
      await ui.unmount()
    }
  }
})
