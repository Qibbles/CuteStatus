// Deterministic tool-output fixtures for the token saver's tests (generated,
// so tests need no file access). Same content as the original Python fixtures.

const E = '\x1b'
const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const pad2 = (n: number) => String(n).padStart(2, '0')

export function ansiBuild(): string {
  const lines = range(40).map(i => `${E}[32m   Compiling${E}[0m crate_${i} v0.${i}.0`)
  lines.push(`${E}[1m${E}[33mwarning${E}[0m: unused variable: \`x\` --> src/lib.rs:12:9`)
  lines.push(`${E}[1m${E}[31merror[E0308]${E}[0m: mismatched types --> src/main.rs:4:5`)
  lines.push(`${E}]8;;https://example.com${E}\\link${E}]8;;${E}\\ done`)
  return lines.join('\n') + '\n'
}

export function progressPip(): string {
  let s = ''
  for (const pkg of ['numpy', 'pandas', 'scipy']) {
    s += `Collecting ${pkg}\n  Downloading ${pkg}-1.0.tar.gz (12.0 MB)\n`
    for (let p = 0; p <= 100; p += 5) {
      const bar = '━'.repeat(p / 5) + ' '.repeat(20 - p / 5)
      s += `\r     ${bar} ${(p * 0.12).toFixed(1)}/12.0 MB ${p}% eta 0:00:0${Math.floor((100 - p) / 20)}`
    }
    s += '\n'
  }
  for (let p = 0; p <= 100; p += 10) s += `[${'#'.repeat(p / 10)}${'.'.repeat(10 - p / 10)}] ${p}%\n`
  s += 'Successfully installed numpy-1.0 pandas-1.0 scipy-1.0\n'
  s += 'WARNING: pip is out of date\n'
  return s
}

export function repeatedLogs(): string {
  const lines: string[] = []
  for (const i of range(300)) {
    lines.push(`2026-11-22T08:${pad2(Math.floor(i / 60))}:${pad2(i % 60)}.123Z INFO worker polled queue, 0 jobs`)
    if (i === 150) lines.push('2026-11-22T08:02:30.500Z ERROR worker crashed: connection refused (db:5432)')
  }
  for (const _ of range(5)) lines.push('Retrying...')
  return lines.join('\n') + '\n'
}

export function longPytest(): string {
  const pct = (i: number) => String(Math.floor((i * 100) / 900)).padStart(3, ' ')
  const row = (i: number) => `tests/test_mod${i % 30}.py::test_case_${i} PASSED${' '.repeat(20)}[${pct(i)}%]`
  const lines = [
    '============================= test session starts =============================',
    'platform linux -- Python 3.13.0, pytest-9.1.1',
    'collected 900 items',
    '',
    ...range(450).map(row),
    'tests/test_core.py::test_parse FAILED                                    [ 50%]',
    ...range(449).map(i => row(i + 451)),
    '',
    '=================================== FAILURES ===================================',
    '_________________________________ test_parse _________________________________',
    'Traceback (most recent call last):',
    '  File "tests/test_core.py", line 42, in test_parse',
    "    assert parse('1+1') == 2",
    'AssertionError: assert 3 == 2',
    '=========================== short test summary info ============================',
    'FAILED tests/test_core.py::test_parse - AssertionError: assert 3 == 2',
    '======================== 1 failed, 899 passed in 12.34s ========================',
  ]
  return lines.join('\n') + '\n'
}

export function bigJson(): string {
  const items = range(120).map(i => ({
    id: i,
    title: `Issue ${i}`,
    state: 'open',
    body: 'Lorem ipsum dolor sit amet. '.repeat(60).trim(),
    labels: [{ name: 'bug', color: 'd73a4a' }],
  }))
  const target = items[70]
  if (target) target.body = "Stack trace: TypeError: cannot read property 'x' of undefined " + 'at foo.js:1 '.repeat(80)
  return JSON.stringify({ total_count: 120, items }, null, 2) + '\n'
}

export const shortClean = () =>
  "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\n"

/** A source file of `n` small functions: about 7 tokens a function. */
export const bigSource = (n = 300) => range(n).map(i => `def func_${i}():\n    return ${i}\n\n`).join('')

export const ALL: Record<string, () => string> = {
  ansiBuild,
  progressPip,
  repeatedLogs,
  longPytest,
  bigJson,
}
