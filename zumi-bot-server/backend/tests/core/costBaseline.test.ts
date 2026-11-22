import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createCostBaseline, lastCostState, minusBaseline } from '../../src/core/usage/costBaseline'

const costState = (cr: number, cw: number, out: number, usd: number) =>
  JSON.stringify({
    type: 'cost-state',
    sessionId: 'S',
    totalCostUSD: usd,
    modelUsage: {
      'claude-opus-5-5': { inputTokens: 2, outputTokens: out, cacheReadInputTokens: cr, cacheCreationInputTokens: cw, costUSD: usd }
    }
  })

const tmp = () => mkdtempSync(join(tmpdir(), 'cb-cost-'))

test('lastCostState reads the newest cost-state line, even one far from the end', async () => {
  const dir = tmp()
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(5000) } })
  const lines = [costState(10, 20, 3, 0.5), filler, costState(100, 200, 30, 1.5), ...Array(40).fill(filler)]
  writeFileSync(join(dir, 'S.jsonl'), lines.join('\n') + '\n')
  expect(await lastCostState(join(dir, 'S.jsonl'))).toEqual({
    'claude-opus-5-5': { input: 2, output: 30, cacheRead: 100, cacheWrite: 200, costUsd: 1.5 }
  })
})

test('lastCostState is null without a cost-state line or a file', async () => {
  const dir = tmp()
  writeFileSync(join(dir, 'S.jsonl'), JSON.stringify({ type: 'user' }) + '\n')
  expect(await lastCostState(join(dir, 'S.jsonl'))).toBeNull()
  expect(await lastCostState(join(dir, 'missing.jsonl'))).toBeNull()
})

test('createCostBaseline finds the session in any project folder', async () => {
  const projects = tmp()
  mkdirSync(join(projects, '-some-other'))
  mkdirSync(join(projects, '-home-me-repo'))
  writeFileSync(join(projects, '-home-me-repo', 'S.jsonl'), costState(7, 8, 9, 0.25) + '\n')
  const baseline = createCostBaseline(projects)
  expect(await baseline('S')).toEqual({ 'claude-opus-5-5': { input: 2, output: 9, cacheRead: 7, cacheWrite: 8, costUsd: 0.25 } })
  expect(await baseline('nope')).toBeNull()
})

test('minusBaseline leaves only what this run added, model by model', () => {
  const run = {
    totalUsd: 2.25,
    models: {
      'claude-opus-5-5': { input: 6, output: 40, cacheRead: 150, cacheWrite: 260, costUsd: 2 },
      'claude-haiku-5-5': { input: 1, output: 1, cacheRead: 5, cacheWrite: 5, costUsd: 0.25 }
    }
  }
  const base = { 'claude-opus-5-5': { input: 2, output: 30, cacheRead: 100, cacheWrite: 200, costUsd: 1.5 } }
  expect(minusBaseline(run, base)).toEqual({
    totalUsd: 0.75,
    models: {
      'claude-opus-5-5': { input: 4, output: 10, cacheRead: 50, cacheWrite: 60, costUsd: 0.5 },
      'claude-haiku-5-5': { input: 1, output: 1, cacheRead: 5, cacheWrite: 5, costUsd: 0.25 }
    }
  })
})

test('minusBaseline drops a model the run did not use again and never goes below zero', () => {
  const run = { totalUsd: 1, models: { m: { input: 2, output: 30, cacheRead: 100, cacheWrite: 200, costUsd: 1 } } }
  expect(minusBaseline(run, { m: { input: 2, output: 30, cacheRead: 100, cacheWrite: 200, costUsd: 1 } })).toEqual({
    totalUsd: 0,
    models: {}
  })
  expect(minusBaseline(run, { m: { input: 9, output: 99, cacheRead: 999, cacheWrite: 999, costUsd: 9 } })).toEqual({
    totalUsd: 0,
    models: {}
  })
  expect(minusBaseline(run, null)).toBe(run)
})
