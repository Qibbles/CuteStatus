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
      props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100,
        scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /85%/ }))?.text).toContain('85% used · 15% left · resets in 2d 5h 13m')
    expect((await ui.find({ type: 'Text', text: /1\/3/ }))?.text).toContain('Writing config')
    expect((await ui.find({ type: 'Text', text: /12\.4k/ }))?.text).toContain('12.4k tokens this task')
    expect(await ui.find({ type: 'Text', text: /^Token$/ })).toBeTruthy()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    await ui.unmount()
  }
})
