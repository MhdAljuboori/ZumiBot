import { describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import type { Engine } from '@zumibot/shared/engine'
import type { ProcessInfo } from '@zumibot/shared/processes'
import { RUN_REFUSALS } from '@zumibot/shared/runBlocks'
import { runBlock, type RunBlockDeps } from '../../../src/core/processes/runBlock'

const info = { id: 'p_0000000001' } as ProcessInfo
const block = '```bash\nls\n```'
const asst = (over: Record<string, unknown> = {}): ChatItem =>
  ({ type: 'assistant', id: 'm1', text: block, ts: 1, agent: 'dev', ...over }) as ChatItem

function setup(items: ChatItem[], engine: Engine = 'claude', meta: Partial<ChatMeta> | null = { agentName: 'main' }) {
  const run = vi.fn(async () => info)
  const d: RunBlockDeps = {
    meta: async () => (meta ? ({ id: 'c', ...meta } as ChatMeta) : null),
    items: async () => items,
    engineOf: async () => engine,
    run
  }
  return { d, run }
}

describe('runBlock', () => {
  it('runs a block of the message as its author', async () => {
    const { d, run } = setup([asst()])
    expect(await runBlock(d, 'c', 'm1', 'ls')).toBe(info)
    expect(run).toHaveBeenCalledWith('c', 'dev', 'm1', 'ls')
  })
  it('falls back to the chat agent when the item names no author', async () => {
    const { d, run } = setup([asst({ agent: undefined })])
    await runBlock(d, 'c', 'm1', 'ls')
    expect(run).toHaveBeenCalledWith('c', 'main', 'm1', 'ls')
  })
  it('refuses a command not in the message', async () => {
    const { d, run } = setup([asst()])
    await expect(runBlock(d, 'c', 'm1', 'rm -rf /')).rejects.toThrow(RUN_REFUSALS.notBlock)
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses a user item, a missing id or a gone chat', async () => {
    const { d, run } = setup([{ type: 'user', id: 'm1', text: block, ts: 1 } as ChatItem])
    await expect(runBlock(d, 'c', 'm1', 'ls')).rejects.toThrow(RUN_REFUSALS.gone)
    await expect(runBlock(d, 'c', 'zz', 'ls')).rejects.toThrow(RUN_REFUSALS.gone)
    await expect(runBlock(setup([asst()], 'claude', null).d, 'c', 'm1', 'ls')).rejects.toThrow(RUN_REFUSALS.gone)
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses a chat another agent asked, which the user only reads', async () => {
    const asked = { by: 'lead', from: 'c0', fromTitle: 'Plan', chain: [] }
    const { d, run } = setup([asst()], 'claude', { agentName: 'main', asked })
    await expect(runBlock(d, 'c', 'm1', 'ls')).rejects.toThrow(RUN_REFUSALS.asked)
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses a remote author', async () => {
    const { d, run } = setup([asst()], 'ag-ui')
    await expect(runBlock(d, 'c', 'm1', 'ls')).rejects.toThrow(RUN_REFUSALS.remote)
    expect(run).not.toHaveBeenCalled()
  })
})
