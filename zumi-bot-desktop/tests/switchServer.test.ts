import { describe, expect, it } from 'vitest'
import { createSwitchServer, type SwitchDeps } from '../src/main/switchServer'

function make(over: Partial<SwitchDeps> = {}) {
  const calls: string[] = []
  const deps: SwitchDeps = {
    isDirty: () => false,
    askUnsaved: async () => {
      calls.push('unsaved?')
      return 'discard'
    },
    saveBeforeClose: async () => (calls.push('save'), true),
    isLocal: () => true,
    busy: async () => 0,
    askRunning: async (n) => {
      calls.push(`ask ${n}`)
      return true
    },
    stopLocal: async () => void calls.push('stop'),
    showPicker: () => void calls.push('picker'),
    onError: (e) => void calls.push(`error ${String(e)}`),
    ...over
  }
  return { calls, run: createSwitchServer(deps) }
}

describe('switchServer', () => {
  it('stops the local server and opens the picker when idle, without asking', async () => {
    const { calls, run } = make()
    await run()
    expect(calls).toEqual(['stop', 'picker'])
  })

  it('asks with the running count and does nothing on Cancel', async () => {
    const { calls, run } = make({ busy: async () => 2, askRunning: async (n) => (calls.push(`ask ${n}`), false) })
    await run()
    expect(calls).toEqual(['ask 2'])
  })

  it('Stop & Switch stops, then opens the picker', async () => {
    const { calls, run } = make({ busy: async () => 1 })
    await run()
    expect(calls).toEqual(['ask 1', 'stop', 'picker'])
  })

  it('a VPS connection just opens the picker', async () => {
    const { calls, run } = make({ isLocal: () => false, busy: async () => 5 })
    await run()
    expect(calls).toEqual(['picker'])
  })

  it('an unreachable control socket counts as idle', async () => {
    const { calls, run } = make({ busy: async () => Promise.reject(new Error('no socket')) })
    await run()
    expect(calls).toEqual(['stop', 'picker'])
  })

  it('ignores a second switch while one is asking', async () => {
    let release!: (v: boolean) => void
    const { calls, run } = make({
      busy: async () => 1,
      askRunning: () => new Promise<boolean>((r) => (release = r))
    })
    const first = run()
    await new Promise((r) => setTimeout(r, 0)) // let it reach the dialog
    await run()
    release(false)
    await first
    expect(calls).toEqual([])
  })

  it('reports a failing stop and still lets the user try again', async () => {
    let fail = true
    const { calls, run } = make({
      stopLocal: async () => {
        if (fail) throw new Error('stuck')
        calls.push('stop')
      }
    })
    await run()
    fail = false
    await run()
    expect(calls).toEqual(['error Error: stuck', 'stop', 'picker'])
  })

  describe('unsaved edits come first', () => {
    const dirty = { isDirty: () => true }

    it('unsaved -> running -> stop -> picker, in that order', async () => {
      const { calls, run } = make({ ...dirty, busy: async () => 1, askUnsaved: async () => (calls.push('unsaved?'), 'save') })
      await run()
      expect(calls).toEqual(['unsaved?', 'save', 'ask 1', 'stop', 'picker'])
    })

    it('Discard goes on without saving', async () => {
      const { calls, run } = make({ ...dirty, askUnsaved: async () => (calls.push('unsaved?'), 'discard') })
      await run()
      expect(calls).toEqual(['unsaved?', 'stop', 'picker'])
    })

    it('Cancel stops everything', async () => {
      const { calls, run } = make({ ...dirty, busy: async () => 3, askUnsaved: async () => (calls.push('unsaved?'), 'cancel') })
      await run()
      expect(calls).toEqual(['unsaved?'])
    })

    it('a failed save stays put', async () => {
      const { calls, run } = make({ ...dirty, askUnsaved: async () => 'save', saveBeforeClose: async () => (calls.push('save'), false) })
      await run()
      expect(calls).toEqual(['save'])
    })

    it('applies to a VPS connection too, without any running check', async () => {
      const { calls, run } = make({ ...dirty, isLocal: () => false, busy: async () => 9 })
      await run()
      expect(calls).toEqual(['unsaved?', 'picker'])
    })

    it('a running-reply Cancel after Discard still stays', async () => {
      const { calls, run } = make({ ...dirty, busy: async () => 2, askRunning: async (n) => (calls.push(`ask ${n}`), false) })
      await run()
      expect(calls).toEqual(['unsaved?', 'ask 2'])
    })
  })
})

describe('switchServer with background processes', () => {
  it('asks when only processes run, with both counts, and does nothing on Cancel', async () => {
    const asked: [number, number][] = []
    const { calls, run } = make({ processes: async () => 2, askRunning: async (n, p) => (asked.push([n, p]), false) })
    await run()
    expect(asked).toEqual([[0, 2]])
    expect(calls).toEqual([])
  })

  it('reads a server without the processes line as none', async () => {
    const { calls, run } = make({ processes: async () => Promise.reject(new Error('bad control reply')) })
    await run()
    expect(calls).toEqual(['stop', 'picker'])
  })
})
