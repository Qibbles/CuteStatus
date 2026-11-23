import { expect, test } from 'claude-code/testing'

import {
  looksBig,
  modelFamily,
  parsePlan,
  planNote,
  rankOf,
  resolveRouterConfig,
  routerInstruction,
  tierModel,
  tierOf,
} from './router'

test('jobs are sorted into tiers', () => {
  expect(tierOf('Search the repo for uses of parseDate', 'general-purpose', false)).toBe('easy')
  expect(tierOf('Summarise the changelog', 'general-purpose', false)).toBe('easy')
  expect(tierOf('Anything at all', 'Explore', false)).toBe('easy')
  expect(tierOf('Write tests for the cart module', 'general-purpose', false)).toBe('medium')
  expect(tierOf('Build the landing page for client 3', 'general-purpose', false)).toBe('medium')
  expect(tierOf('Debug the flaky checkout test', 'general-purpose', false)).toBe('hard')
  expect(tierOf('Design the caching layer', 'general-purpose', false)).toBe('hard')
  // Hard words win, even for an Explore agent.
  expect(tierOf('Investigate why login fails', 'Explore', false)).toBe('hard')
  // Nothing to go on: left alone.
  expect(tierOf('Site 3', 'general-purpose', false)).toBe(null)
})

test('running low on limits shifts everything not hard down a tier', () => {
  expect(tierOf('Write tests for the cart module', 'general-purpose', true)).toBe('easy')
  expect(tierOf('Site 3', 'general-purpose', true)).toBe('medium')
  expect(tierOf('Debug the flaky checkout test', 'general-purpose', true)).toBe('hard')
})

test('work only ever moves to a cheaper model', () => {
  const cfg = resolveRouterConfig(undefined)
  // On Opus: easy → Haiku, medium → Sonnet, hard stays.
  expect(tierModel('easy', 'claude-opus-5-5', cfg)).toBe('haiku')
  expect(tierModel('medium', 'claude-opus-5-5', cfg)).toBe('sonnet')
  expect(tierModel('hard', 'claude-opus-5-5', cfg)).toBe(null)
  // On Sonnet: medium is not cheaper, so it stays.
  expect(tierModel('easy', 'claude-sonnet-5-5', cfg)).toBe('haiku')
  expect(tierModel('medium', 'claude-sonnet-5-5', cfg)).toBe(null)
  // On Haiku: nothing is cheaper.
  expect(tierModel('easy', 'claude-haiku-5-5', cfg)).toBe(null)
  // A model family Kibbles doesn't know yet counts as the most capable.
  expect(tierModel('medium', 'claude-somethingnew-7', cfg)).toBe('sonnet')
  expect(tierModel('medium', undefined, cfg)).toBe('sonnet')
})

test('model families and ranks', () => {
  expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku')
  expect(modelFamily('claude-opus-5-5')).toBe('opus')
  expect(modelFamily('claude-fable-5-2')).toBe('fable')
  expect(rankOf('haiku')).toBeLessThan(rankOf('sonnet'))
  expect(rankOf('sonnet')).toBeLessThan(rankOf('opus'))
  expect(rankOf('opus')).toBeLessThan(rankOf('claude-fable-5-2'))
  expect(rankOf('claude-somethingnew-7')).toBeGreaterThan(rankOf('claude-fable-5-2'))
})

test('only big multi-part requests get a pre-read', () => {
  expect(looksBig('fix the typo in the README', false)).toBe(false)
  expect(looksBig('yes, go ahead', false)).toBe(false)
  expect(looksBig('build these 10 sites for my clients', false)).toBe(true)
  expect(looksBig('Please:\n- add a login page\n- write tests\n- update the docs', false)).toBe(true)
  expect(looksBig('Please:\n- add a login page\n- write tests', false)).toBe(false)
  expect(looksBig('Please:\n- add a login page\n- write tests', true)).toBe(true)
  expect(looksBig('x'.repeat(900), false)).toBe(true)
})

test("the judge's reply is read safely and turned into a suggestion", () => {
  const plan = parsePlan('{"split": true, "easy": ["format docs"], "medium": ["write tests"], "hard": ["design API"]}')
  expect(plan).toEqual({ split: true, easy: ['format docs'], medium: ['write tests'], hard: ['design API'] })
  expect(parsePlan('Sure! {"split": true, "medium": ["a"]} hope that helps').split).toBe(true)
  expect(parsePlan('{"split": true, "easy": [], "medium": [], "hard": ["x"]}').split).toBe(false)
  expect(parsePlan('not json').split).toBe(false)
  const note = planNote(plan, { easy: 'haiku', medium: 'sonnet' }, 'haiku')
  expect(note).toContain('model: "haiku"')
  expect(note).toContain('model: "sonnet"')
  // A tier with no cheaper model stays with Claude.
  const onSonnet = planNote(plan, { easy: 'haiku', medium: null }, 'haiku')
  expect(onSonnet).not.toContain('model: "sonnet"')
  expect(onSonnet).toContain('- write tests')
})

test('settings: tiers on by default, each can be changed or switched off', () => {
  expect(resolveRouterConfig(undefined)).toEqual({ enabled: true, tiers: { easy: 'haiku', medium: 'sonnet' }, maxPreReadsPerChat: 20 })
  expect(resolveRouterConfig({ enabled: false }).enabled).toBe(false)
  expect(resolveRouterConfig({ tiers: { medium: null } }).tiers).toEqual({ easy: 'haiku', medium: null })
  // The older single setting still works.
  expect(resolveRouterConfig({ cheapModel: 'sonnet' }).tiers.easy).toBe('sonnet')
  const both = routerInstruction(resolveRouterConfig(undefined)) ?? ''
  expect(both).toContain('model: "haiku"')
  expect(both).toContain('model: "sonnet"')
  // Routine-coding helpers' work is checked before Claude replies.
  expect(both).toContain('read its diff')
  expect(routerInstruction(resolveRouterConfig({ tiers: { medium: null } })) ?? '').not.toContain('read its diff')
  expect(routerInstruction(resolveRouterConfig({ tiers: { easy: null, medium: null } }))).toBe(null)
})
