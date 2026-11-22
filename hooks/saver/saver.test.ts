import { expect, test } from 'claude-code/testing'

import { bigJson, bigSource, longPytest } from './fixtures'
import { RAW_HINT } from './filters'

const bash = (stdout: string) => ({ result: { stdout, stderr: '', interrupted: false } })

test('Bash output is condensed before Claude sees it, failures kept', async ($, on) => {
  on('tool.call', () => bash(longPytest()))
  const r = await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  const out = (r.result as { stdout: string }).stdout
  expect(out.length).toBeLessThan(longPytest().length / 10)
  expect(out).toContain('FAILED tests/test_core.py::test_parse - AssertionError: assert 3 == 2')
  expect(out).toContain('1 failed, 899 passed')
  expect(out).toContain(RAW_HINT)
})

test('# nofilter, small output and other tools pass through untouched', async ($, on) => {
  on('tool.call', () => bash(longPytest()))
  const raw = await $.tool.call({ tool: 'Bash', command: 'pytest -q  # nofilter' })
  expect((raw.result as { stdout: string }).stdout).toBe(longPytest())
})

test('small Bash output is left alone', async ($, on) => {
  on('tool.call', () => bash('hi\n'))
  const r = await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect((r.result as { stdout: string }).stdout).toBe('hi\n')
})

test('MCP text blocks are condensed, other blocks kept', async ($, on) => {
  on('tool.call', () => ({ result: [{ type: 'text', text: bigJson() }, { type: 'image', data: 'abc' }] }))
  const r = await $.tool.call({ tool: 'mcp__github__list_issues' } as never)
  const blocks = r.result as { type: string; text?: string; data?: string }[]
  expect((blocks[0]?.text ?? '').length).toBeLessThan(bigJson().length / 5)
  expect(blocks[1]).toEqual({ type: 'image', data: 'abc' })
})

test('a repeat Read of an unchanged file is denied; a changed one comes back as a diff', async ($, on) => {
  let text = bigSource()
  let mtimeMs = 1
  on('fs.stat', () => ({ value: { kind: 'file', size: text.length, mtimeMs, isLink: false, realPath: '/repo/a.py' } }))
  on('fs.read', () => ({ value: text }))
  const readResult = () => {
    const n = text.split('\n').length
    return { result: { type: 'text', file: { filePath: '/repo/a.py', content: text, numLines: n, startLine: 1, totalLines: n } } }
  }
  on('tool.call', () => readResult())

  const first = await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
  expect((first.result as { file: { content: string } }).file.content).toBe(text)

  const again = await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
  expect(again.deny ?? '').toContain('unchanged since you last read it')

  text = text.replace('return 150\n', 'return 999\n')
  mtimeMs = 2
  const changed = await $.tool.call({ tool: 'Read', file_path: '/repo/a.py' })
  const content = (changed.result as { file: { content: string } }).file.content
  expect(content).toContain('changed since your last read')
  expect(content).toContain('+    return 999')
})

const NOW = 1_000_000_000
const band = {
  weekPct: 10, weekPctReal: true, resetAt: NOW + 86400_000, resetReal: true, weekTokens: 0, weekLimit: 5_000_000,
  steps: [], toolCalls: 2, lastTool: 'Bash', taskTokens: 12_400, taskCap: 50_000, mainTokens: 12_400,
  helpers: [], chatTokens: 412_000, helperSeq: 0, isRunning: false, frame: 0, now: NOW, contextPct: 68,
}
const props = (cols: number) => ({
  hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: cols,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
})

test('the Token row shows what the saver kept out, only when it saved something', async ($, on) => {
  let data: object = { ...band, savedChat: 38_200, saverOn: true }
  on('state.get', () => ({ value: { value: data, version: 1 } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cute-status', surface, component: 'AbovePrompt', props: props(160) })
    expect((await ui.find({ type: 'Text', text: /12\.4k/ }))?.text).toContain('12.4k this task · 412k this chat · saved 38.2k · context 68%')
    await ui.unmount()
  }
  for (const quiet of [{ ...band, savedChat: 0 }, { ...band, savedChat: 500, saverOn: false }]) {
    data = quiet
    const ui = await $.ui.mount({ plugin: 'cute-status', surface: 'terminal', component: 'AbovePrompt', props: props(160) })
    expect((await ui.find({ type: 'Text', text: /12\.4k/ }))?.text ?? '').not.toContain('saved')
    await ui.unmount()
  }
})
