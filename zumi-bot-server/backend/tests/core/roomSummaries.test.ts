import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { scriptBin } from '../support/chatFakeBin'
import {
  NOTHING_TO_SUMMARIZE,
  RoomSummaries,
  SUMMARY_BUSY,
  SUMMARY_CANCELLED,
  SUMMARY_FAILED,
  SUMMARY_MAX_RUNNING,
  SUMMARY_TIMEOUT_MS,
  type RoomSummariesDeps
} from '../../src/core/chat/roomSummary'
import type { RunCost } from '../../src/core/usage/runCost'
import type { AgentSummary, ChatItem, ChatMeta } from '@zumibot/shared/types'

const fake = scriptBin(fileURLToPath(new URL('../fixtures/fake-moderator.mjs', import.meta.url)))
const ok = JSON.stringify({ result: '## Goal\nShip it', total_cost_usd: 0.5, uuid: 'u-1', usage: { input_tokens: 10, output_tokens: 5 } })
const items: ChatItem[] = [
  { type: 'user', id: 'u1', text: 'hi', ts: 1 },
  { type: 'assistant', id: 'a1', agent: 'writer', text: 'done', ts: 2 } as ChatItem
]

const room = (id: string): ChatMeta =>
  ({
    id,
    cwd: process.cwd(),
    group: { members: ['writer', 'gone'], role: 'r', sessions: {}, seen: {}, active: [], queue: [] }
  }) as unknown as ChatMeta
const single = (id: string): ChatMeta => ({ id, cwd: process.cwd() }) as unknown as ChatMeta
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let svc: RoomSummaries | null = null
afterEach(() => {
  svc?.stopAll()
  svc = null
})

function make(env: NodeJS.ProcessEnv, o: Partial<RoomSummariesDeps> = {}, chatItems: ChatItem[] = items): RoomSummaries {
  const metas: Record<string, ChatMeta> = { r1: room('r1'), r2: room('r2'), r3: room('r3'), s1: single('s1') }
  svc = new RoomSummaries({
    store: { get: async (id) => metas[id] ?? null, loadItems: async () => chatItems },
    agents: async () => [{ name: 'writer', description: 'writes' } as AgentSummary],
    bin: async () => fake,
    env: async () => ({ ...process.env, ...env }),
    home: '/home/x',
    ...o
  })
  return svc
}

describe('RoomSummaries', () => {
  it('has the documented limits', () => {
    expect(SUMMARY_TIMEOUT_MS).toBe(180_000)
    expect(SUMMARY_MAX_RUNNING).toBe(2)
    expect(SUMMARY_FAILED).toBe("Couldn't write the summary. Try again.")
    expect(SUMMARY_BUSY).toBe('Too many summaries running. Try again in a moment.')
    expect(SUMMARY_CANCELLED).toBe('Cancelled')
    expect(NOTHING_TO_SUMMARIZE).toBe('Nothing to summarize yet')
  })

  it('resolves with the parsed draft', async () => {
    expect(await make({ FAKE_MODERATOR_OUT: ok }).summarize('r1')).toBe('## Goal\nShip it')
  })

  it('keeps a multi-byte character that arrives split across chunks', async () => {
    const out = JSON.stringify({ result: '## Goal\nمرحبا بالعالم' })
    expect(await make({ FAKE_MODERATOR_OUT: out, FAKE_MODERATOR_SPLIT: '1' }).summarize('r1')).toBe('## Goal\nمرحبا بالعالم')
  })

  it('rejects an unknown chat, a single chat and an empty room', async () => {
    const s = make({ FAKE_MODERATOR_OUT: ok })
    await expect(s.summarize('nope')).rejects.toThrow('Chat not found: nope')
    await expect(s.summarize('s1')).rejects.toThrow('Not a group chat')
    const empty = make({ FAKE_MODERATOR_OUT: ok }, {}, [])
    await expect(empty.summarize('r1')).rejects.toThrow(NOTHING_TO_SUMMARIZE)
  })

  it('maps a missing binary, bad output and a failed run to the plain error', async () => {
    await expect(make({ FAKE_MODERATOR_OUT: ok }, { bin: async () => null }).summarize('r1')).rejects.toThrow(SUMMARY_FAILED)
    await expect(make({ FAKE_MODERATOR_OUT: 'not json' }).summarize('r1')).rejects.toThrow(SUMMARY_FAILED)
    await expect(
      make({ FAKE_MODERATOR_OUT: JSON.stringify({ is_error: true, result: 'secret cli text' }) }).summarize('r1')
    ).rejects.toThrow(SUMMARY_FAILED)
    await expect(make({}, { bin: async () => '/nonexistent/claude' }).summarize('r1')).rejects.toThrow(SUMMARY_FAILED)
    await expect(
      make(
        {},
        {
          env: async () => {
            throw new Error('boom')
          }
        }
      ).summarize('r1')
    ).rejects.toThrow(SUMMARY_FAILED)
  })

  it('a second call for the same room cancels the first', async () => {
    let hanging = true
    const s = make({}, { env: async () => ({ ...process.env, ...(hanging ? { FAKE_MODERATOR_HANG: '1' } : { FAKE_MODERATOR_OUT: ok }) }) })
    const firstErr = expect(s.summarize('r1')).rejects.toThrow(SUMMARY_CANCELLED)
    await wait(30)
    hanging = false
    expect(await s.summarize('r1')).toBe('## Goal\nShip it')
    await firstErr
  })

  it('refuses a third room while two run, and cancel frees the slot', async () => {
    const s = make({ FAKE_MODERATOR_HANG: '1' })
    const aErr = expect(s.summarize('r1')).rejects.toThrow(SUMMARY_CANCELLED)
    const bErr = expect(s.summarize('r2')).rejects.toThrow(SUMMARY_CANCELLED)
    await wait(30)
    await expect(s.summarize('r3')).rejects.toThrow(SUMMARY_BUSY)
    const t0 = Date.now()
    s.cancel('r1')
    await aErr
    expect(Date.now() - t0).toBeLessThan(5_000)
    const cErr = expect(s.summarize('r3')).rejects.toThrow(SUMMARY_CANCELLED)
    await wait(30)
    s.stopAll()
    await Promise.all([bErr, cErr])
  })

  it('times out as a plain failure', async () => {
    await expect(make({ FAKE_MODERATOR_HANG: '1' }, { timeoutMs: 50 }).summarize('r1')).rejects.toThrow(SUMMARY_FAILED)
  })

  it('reports the cost once, also after a failed exit, and none when nothing was printed', async () => {
    const costs: Array<[string, RunCost, string | null]> = []
    const onCost = (c: string, cost: RunCost, id: string | null): void => {
      costs.push([c, cost, id])
    }
    await make({ FAKE_MODERATOR_OUT: ok }, { onCost }).summarize('r1')
    expect(costs).toHaveLength(1)
    expect(costs[0][0]).toBe('r1')
    expect(costs[0][1].totalUsd).toBe(0.5)
    expect(costs[0][2]).toBe('u-1')

    costs.length = 0
    const bad = JSON.stringify({ is_error: true, result: 'x', total_cost_usd: 0.2, usage: { input_tokens: 1, output_tokens: 1 } })
    await expect(make({ FAKE_MODERATOR_OUT: bad }, { onCost }).summarize('r1')).rejects.toThrow(SUMMARY_FAILED)
    expect(costs).toHaveLength(1)

    // A non-zero exit with a valid-looking result: still the plain failure, and the spend is reported.
    costs.length = 0
    await expect(make({ FAKE_MODERATOR_OUT: ok, FAKE_MODERATOR_EXIT: '1' }, { onCost }).summarize('r1')).rejects.toMatchObject({
      message: SUMMARY_FAILED
    })
    expect(costs).toHaveLength(1)
    expect(costs[0][1].totalUsd).toBe(0.5)

    costs.length = 0
    await expect(make({ FAKE_MODERATOR_OUT: '' }, { onCost }).summarize('r1')).rejects.toThrow(SUMMARY_FAILED)
    expect(costs).toHaveLength(0)
  })
})
