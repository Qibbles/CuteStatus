import { expect, test } from 'claude-code/testing'

import { looksBig, looksEasy, modelFamily, parsePlan, planNote, resolveRouterConfig, routerInstruction } from './router'

test('easy helpers are spotted, hard ones are left alone', () => {
  expect(looksEasy('Search the repo for uses of parseDate', 'general-purpose', false)).toBe(true)
  expect(looksEasy('Summarise the changelog', 'general-purpose', false)).toBe(true)
  expect(looksEasy('Find where tokens are counted', 'Explore', false)).toBe(true)
  expect(looksEasy('Anything at all', 'Explore', false)).toBe(true)
  expect(looksEasy('Debug the flaky checkout test', 'general-purpose', false)).toBe(false)
  expect(looksEasy('Design the caching layer', 'general-purpose', false)).toBe(false)
  // Hard words win even for an Explore agent.
  expect(looksEasy('Investigate why login fails', 'Explore', false)).toBe(false)
  // Neither easy nor hard: left alone, unless limits are running low.
  expect(looksEasy('Build site 3', 'general-purpose', false)).toBe(false)
  expect(looksEasy('Build site 3', 'general-purpose', true)).toBe(true)
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

test("the judge's reply is read safely", () => {
  expect(parsePlan('{"split": true, "easy": ["format docs"], "hard": ["design API"]}')).toEqual({
    split: true,
    easy: ['format docs'],
    hard: ['design API'],
  })
  expect(parsePlan('Sure! {"split": true, "easy": ["a"], "hard": []} hope that helps').split).toBe(true)
  expect(parsePlan('{"split": true, "easy": [], "hard": ["x"]}').split).toBe(false)
  expect(parsePlan('not json').split).toBe(false)
  expect(planNote({ split: true, easy: ['a'], hard: ['b'] }, 'haiku')).toContain('model: "haiku"')
})

test('settings default to on, with Haiku', () => {
  expect(resolveRouterConfig(undefined)).toEqual({ enabled: true, cheapModel: 'haiku', maxPreReadsPerChat: 20 })
  expect(resolveRouterConfig({ enabled: false }).enabled).toBe(false)
  expect(resolveRouterConfig({ cheapModel: 'sonnet' }).cheapModel).toBe('sonnet')
  expect(routerInstruction('haiku')).toContain('model: "haiku"')
  expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku')
  expect(modelFamily('claude-opus-5-5')).toBe('opus')
})
