import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parseRunCost } from '../../src/core/usage/runCost'

const fixtures = fileURLToPath(new URL('../fixtures/stream/', import.meta.url))
const resultOf = (n: string) =>
  JSON.parse(
    readFileSync(`${fixtures}${n}.jsonl`, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"type":"result"'))[0]
  )

test('parseRunCost reads modelUsage per model', () => {
  expect(parseRunCost(resultOf('tool-ok'))).toEqual({
    totalUsd: 0.00502881,
    models: { 'claude-haiku-5-5': { input: 4, output: 189, cacheRead: 69991, cacheWrite: 21170, costUsd: 0.00502881 } }
  })
})

test('parseRunCost falls back to usage when modelUsage is empty', () => {
  const root = {
    total_cost_usd: 0.5,
    usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    modelUsage: {}
  }
  expect(parseRunCost(root)).toEqual({
    totalUsd: 0.5,
    models: { unknown: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.5 } }
  })
})

test('parseRunCost returns null for an empty run', () => {
  expect(parseRunCost(resultOf('missing-session'))).toBeNull()
  expect(parseRunCost({ usage: { input_tokens: 1 }, modelUsage: {} })).toBeNull()
  expect(parseRunCost({ total_cost_usd: NaN, usage: { input_tokens: 1 } })).toBeNull()
  expect(parseRunCost(null)).toBeNull()
})
