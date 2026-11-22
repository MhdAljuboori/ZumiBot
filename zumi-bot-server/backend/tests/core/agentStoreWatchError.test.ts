import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const watchers: (EventEmitter & { close: () => void })[] = []

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    watch: () => {
      const w = Object.assign(new EventEmitter(), { close: vi.fn() })
      watchers.push(w)
      return w
    }
  }
})

import { AgentStore } from '../../src/core/agents/agentStore'
import os from 'node:os'

describe('AgentStore.watch error handling', () => {
  it('closes the watcher quietly on an error event', () => {
    const store = new AgentStore(os.tmpdir(), async () => {})
    store.watch(() => {})
    expect(() => watchers[0].emit('error', new Error('EPERM'))).not.toThrow()
    expect(watchers[0].close).toHaveBeenCalled()
  })
})
