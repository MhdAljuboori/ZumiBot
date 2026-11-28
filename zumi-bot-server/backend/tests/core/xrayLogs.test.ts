import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { priceMessage } from '@zumibot/shared/pricing'
import { readRequests, subagentLogs } from '../../src/core/xray/xrayLogs'

const tmp = () => mkdtemp(join(tmpdir(), 'xlogs-'))
const T0 = Date.parse('2026-11-28T10:00:00.000Z')
const line = (id: string, sec: number, content: unknown[], output: number, model = 'claude-opus-5-5') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(T0 + sec * 1000).toISOString(),
    message: {
      id,
      model,
      content,
      usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 500, cache_creation_input_tokens: 40 }
    }
  }) + '\n'

test('readRequests joins a request’s block lines: first and last time, tool ids, the fullest usage', async () => {
  const f = join(await tmp(), 's.jsonl')
  await writeFile(
    f,
    JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { content: 'hi' } }) +
      '\n' +
      line('msg_1', 1, [{ type: 'thinking', thinking: '' }], 5) +
      line('msg_1', 3, [{ type: 'tool_use', id: 'toolu_a' }], 30) +
      line('msg_1', 3.2, [{ type: 'tool_use', id: 'toolu_b' }], 42) +
      line('msg_2', 9, [{ type: 'text', text: 'done' }], 12) +
      '{"type":"assistant","message":{"id":"torn'
  )
  const r = await readRequests(f, T0, T0 + 60_000)
  expect(r.map((x) => x.id)).toEqual(['msg_1', 'msg_2'])
  expect(r[0]).toMatchObject({ startedAt: T0 + 1000, endedAt: T0 + 3200, toolIds: ['toolu_a', 'toolu_b'], wrote: true })
  expect(r[0].tokens.output).toBe(42)
  expect(r[0].costUsd).toBe(priceMessage('claude-opus-5-5', r[0].tokens))
  expect(r[1]).toMatchObject({ toolIds: [], wrote: true })
})

test('readRequests keeps only lines inside the window; a missing file reads as none', async () => {
  const d = await tmp()
  const f = join(d, 's.jsonl')
  await writeFile(f, line('old', -100, [], 1) + line('in', 5, [], 1) + line('late', 500, [], 1))
  expect((await readRequests(f, T0, T0 + 60_000)).map((x) => x.id)).toEqual(['in'])
  expect(await readRequests(join(d, 'gone.jsonl'), T0, T0 + 1)).toEqual([])
})

test('readRequests leaves synthetic messages out and keeps an unpriced model unpriced', async () => {
  const f = join(await tmp(), 's.jsonl')
  await writeFile(f, line('syn', 1, [], 1, '<synthetic>') + line('x', 2, [], 1, 'some-other-model'))
  const r = await readRequests(f, T0, T0 + 60_000)
  expect(r.map((x) => x.id)).toEqual(['x'])
  expect(r[0].costUsd).toBeNull()
})

test('subagentLogs reads the dispatching tool use id from each meta file', async () => {
  const d = join(await tmp(), 'sess', 'subagents')
  await mkdir(d, { recursive: true })
  await writeFile(join(d, 'agent-a.jsonl'), '')
  await writeFile(join(d, 'agent-a.meta.json'), JSON.stringify({ toolUseId: 'toolu_x', agentType: 'Explore' }))
  await writeFile(join(d, 'agent-b.jsonl'), '')
  await writeFile(join(d, 'agent-c.jsonl'), '')
  await writeFile(join(d, 'agent-c.meta.json'), '{broken')
  expect(await subagentLogs([join(d, 'agent-a.jsonl'), join(d, 'agent-b.jsonl'), join(d, 'agent-c.jsonl')])).toEqual([
    { file: join(d, 'agent-a.jsonl'), toolUseId: 'toolu_x' },
    { file: join(d, 'agent-b.jsonl'), toolUseId: null },
    { file: join(d, 'agent-c.jsonl'), toolUseId: null }
  ])
})
