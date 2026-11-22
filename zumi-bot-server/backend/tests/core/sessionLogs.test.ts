import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { priceMessage } from '@zumibot/shared/pricing'
import { findSessionFiles, readLogMessages } from '../../src/core/usage/sessionLogs'

const tmp = () => mkdtemp(join(tmpdir(), 'slogs-'))
const line = (id: string, output: number, extra: Record<string, unknown> = {}, model = 'claude-opus-5-5') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-01T10:00:00.000Z',
    message: {
      id,
      model,
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, ...extra }
    }
  }) + '\n'

test('findSessionFiles finds main and subagent logs under any project folder', async () => {
  const d = await tmp()
  await mkdir(join(d, 'p1'), { recursive: true })
  await mkdir(join(d, 'p2', 's2', 'subagents'), { recursive: true })
  await writeFile(join(d, 'p1', 's1.jsonl'), '')
  await writeFile(join(d, 'p1', 's3.jsonl'), '')
  await writeFile(join(d, 'p2', 's2.jsonl'), '')
  await writeFile(join(d, 'p2', 's2', 'subagents', 'agent-a.jsonl'), '')
  const m = await findSessionFiles(d, new Set(['s1', 's2']))
  expect(m.get('s1')).toEqual([join(d, 'p1', 's1.jsonl')])
  expect(m.get('s2')).toEqual([join(d, 'p2', 's2.jsonl'), join(d, 'p2', 's2', 'subagents', 'agent-a.jsonl')])
  expect(m.has('s3')).toBe(false)
  expect((await findSessionFiles(join(d, 'missing'), new Set(['s1']))).size).toBe(0)
})

test('readLogMessages keeps one entry per message id', async () => {
  const f = join(await tmp(), 'a.jsonl')
  await writeFile(f, line('msg_1', 0) + line('msg_1', 0) + line('msg_1', 120))
  const r = await readLogMessages(f, 0)
  expect(r.messages).toHaveLength(1)
  expect(r.messages[0].tokens.output).toBe(120)
})

test('readLogMessages splits cache writes by TTL and prices them', async () => {
  const f = join(await tmp(), 'a.jsonl')
  await writeFile(
    f,
    line('m1', 7, { cache_creation_input_tokens: 150, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 50 } }) +
      line('m2', 7, { cache_creation_input_tokens: 40 })
  )
  const { messages } = await readLogMessages(f, 0)
  const [a, b] = messages
  expect(a.tokens).toMatchObject({ cacheWrite5m: 100, cacheWrite1h: 50 })
  expect(a.costUsd).toBe(priceMessage('claude-opus-5-5', a.tokens))
  expect(b.tokens).toMatchObject({ cacheWrite5m: 40, cacheWrite1h: 0 })
  expect(a.at).toBe(Date.parse('2026-10-01T10:00:00.000Z'))
})

test('readLogMessages ignores synthetic lines', async () => {
  const f = join(await tmp(), 'a.jsonl')
  await writeFile(
    f,
    line('s', 1, {}, '<synthetic>') +
      JSON.stringify({ type: 'user', message: { content: 'hi' } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', message: { id: 'x', model: 'claude-opus-5-5' } }) +
      '\n' +
      'not json\n'
  )
  expect((await readLogMessages(f, 0)).messages).toEqual([])
})

test('readLogMessages keeps a partial last line for later', async () => {
  const f = join(await tmp(), 'a.jsonl')
  const first = line('m1', 3)
  const second = line('m2', 4)
  await writeFile(f, first + second.slice(0, 20))
  const r1 = await readLogMessages(f, 0)
  expect(r1.messages.map((m) => m.id)).toEqual(['m1'])
  expect(r1.offset).toBe(Buffer.byteLength(first))
  await appendFile(f, second.slice(20))
  const r2 = await readLogMessages(f, r1.offset)
  expect(r2.messages.map((m) => m.id)).toEqual(['m2'])
  expect(r2.offset).toBe(Buffer.byteLength(first + second))
})

test('readLogMessages reads from an offset', async () => {
  const f = join(await tmp(), 'a.jsonl')
  await writeFile(f, line('m1', 3))
  const r1 = await readLogMessages(f, 0)
  await appendFile(f, line('m2', 4))
  const r2 = await readLogMessages(f, r1.offset)
  expect(r2.messages.map((m) => m.id)).toEqual(['m2'])
  expect(r2.size).toBe(r2.offset)
})
