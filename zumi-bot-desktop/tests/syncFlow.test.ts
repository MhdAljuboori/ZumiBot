import { describe, expect, it } from 'vitest'
import { createSyncFlow, type SyncFlowDeps } from '../src/main/syncFlow'

function setup(over: Partial<SyncFlowDeps> = {}) {
  const calls: string[] = []
  const flow = createSyncFlow({
    prepare: async () => (calls.push('prepare'), true),
    isDirty: () => false,
    askUnsaved: async () => 'save',
    save: async () => (calls.push('save'), true),
    busy: async () => 0,
    pause: async () => {
      calls.push('pause')
    },
    execute: async () => (calls.push('execute'), 0),
    restore: async () => {
      calls.push('restore')
    },
    log: (line) => {
      calls.push(line)
    },
    ...over
  })
  return { flow, calls }
}

describe('sync lifecycle', () => {
  it('plain sync asks about unsaved edits but never checks replies, pauses or restores', async () => {
    const { flow, calls } = setup({ isDirty: () => true, busy: async () => (calls.push('busy'), 0) })
    await flow.run(false)
    expect(calls).toEqual(['prepare', 'save', 'execute', 'Sync complete.'])
  })
  it('passes the mode to prepare and execute', async () => {
    const seen: boolean[] = []
    const { flow } = setup({ prepare: async (c) => (seen.push(c), true), execute: async (c) => (seen.push(c), 0) })
    await flow.run(true)
    await flow.run(false)
    expect(seen).toEqual([true, true, false, false])
  })
  it('plain sync reports a failed run', async () => {
    const { flow, calls } = setup({ execute: async () => 1 })
    await flow.run(false)
    expect(calls).toEqual(['prepare', 'Sync failed: see the log above.'])
  })

  it('prepares, saves dirty edits, pauses, syncs, and restores', async () => {
    const { flow, calls } = setup({ isDirty: () => true })
    await flow.run(true)
    expect(calls).toEqual(['prepare', 'save', 'pause', 'execute', 'restore', 'Sync complete.'])
    expect(flow.active()).toBe(false)
  })
  it.each([1, -1, NaN])('refuses a busy or invalid local reply count %s', async (count) => {
    const { flow, calls } = setup({ busy: async () => count })
    await flow.run(true)
    expect(calls).not.toContain('pause')
    expect(calls).not.toContain('execute')
    expect(calls.at(-1)).toMatch(/running|check/)
  })
  it('fails closed when the busy query fails', async () => {
    const { flow, calls } = setup({
      busy: async () => {
        throw new Error('control unavailable')
      }
    })
    await flow.run(true)
    expect(calls).toEqual(['prepare', 'Sync failed: control unavailable'])
  })
  it.each(['cancel', 'save'] as const)('leaves the server alone on cancelled or failed save: %s', async (answer) => {
    const { flow, calls } = setup({ isDirty: () => true, askUnsaved: async () => answer, save: async () => false })
    await flow.run(true)
    expect(calls).not.toContain('pause')
    expect(calls).not.toContain('execute')
  })
  it('restores after an exception, even if pausing partially failed', async () => {
    const { flow, calls } = setup({
      pause: async () => {
        throw new Error('stop failed')
      }
    })
    await flow.run(true)
    expect(calls).toEqual(['prepare', 'restore', 'Sync failed: stop failed'])
  })
  it('reports a nonzero exit and restores before allowing retry', async () => {
    const { flow, calls } = setup({ execute: async () => 1 })
    await flow.run(true)
    expect(calls).toEqual(['prepare', 'pause', 'restore', 'Sync failed: see the log above.'])
    expect(flow.active()).toBe(false)
  })
  it('reports restoration failures without losing the sync failure', async () => {
    const { flow, calls } = setup({
      execute: async () => {
        throw new Error('SSH failed')
      },
      restore: async () => {
        throw new Error('port in use')
      }
    })
    await flow.run(true)
    expect(calls).toContain('Could not reconnect: port in use')
    expect(calls.at(-1)).toBe('Sync failed: SSH failed')
  })
  it('does not report complete success when reconnecting fails', async () => {
    const { flow, calls } = setup({
      restore: async () => {
        throw new Error('port in use')
      }
    })
    await flow.run(true)
    expect(calls).toContain('Could not reconnect: port in use')
    expect(calls.at(-1)).toBe('Sync finished, but reconnecting failed. Close this window and retry the connection.')
  })
  it('ignores duplicate starts while preparing and restores only once', async () => {
    let release!: (ok: boolean) => void
    const { flow, calls } = setup({
      prepare: () =>
        new Promise((resolve) => {
          release = resolve
        })
    })
    const first = flow.run(true)
    expect(flow.active()).toBe(true)
    await flow.run(true)
    release(true)
    await first
    expect(calls.filter((c) => c === 'execute')).toHaveLength(1)
  })
})
