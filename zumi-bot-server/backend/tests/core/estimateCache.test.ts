import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ESTIMATE_VERSION, EstimateCache } from '../../src/core/usage/estimateCache'
import type { LogMessage } from '../../src/core/usage/sessionLogs'

const msg = (id: string, output: number): LogMessage => ({
  id,
  at: 1,
  model: 'claude-opus-5-5',
  costUsd: 0.1,
  tokens: { input: 1, output, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, fast: false }
})
const tmpFile = async () => join(await mkdtemp(join(tmpdir(), 'est-')), 'usage-estimates.json')

test('EstimateCache drops everything on a version change', async () => {
  const f = await tmpFile()
  const c = new EstimateCache(f)
  await c.load()
  c.merge('/x.jsonl', { messages: [msg('a', 1)], offset: 10, size: 10 })
  await c.save()
  const again = new EstimateCache(f)
  await again.load()
  expect(again.get('/x.jsonl')?.messages).toHaveLength(1)
  await writeFile(
    f,
    JSON.stringify({ version: ESTIMATE_VERSION - 1, logs: { '/x.jsonl': { size: 1, offset: 1, messages: [msg('a', 1)] } } })
  )
  const stale = new EstimateCache(f)
  await stale.load()
  expect(stale.get('/x.jsonl')).toBeUndefined()
})

test('EstimateCache merge keeps the larger message', async () => {
  const c = new EstimateCache(await tmpFile())
  c.merge('/x', { messages: [msg('a', 5)], offset: 1, size: 1 })
  c.merge('/x', { messages: [msg('a', 3), msg('b', 2)], offset: 2, size: 2 })
  c.merge('/x', { messages: [msg('a', 9)], offset: 3, size: 3 })
  const got = c.get('/x')!
  expect(got.messages.find((m) => m.id === 'a')!.tokens.output).toBe(9)
  expect(got.messages).toHaveLength(2)
  expect(got).toMatchObject({ offset: 3, size: 3 })
  c.reset('/x')
  expect(c.get('/x')).toBeUndefined()
})
