import { describe, expect, it } from 'vitest'
import { createCloseFlow } from '../src/main/closeFlow'

type Unsaved = 'save' | 'discard' | 'cancel'

function setup(init: {
  dirty?: boolean
  running?: number
  unsaved?: Unsaved | (() => Promise<Unsaved>)
  save?: boolean | (() => Promise<boolean>)
  stopRun?: boolean
  stopAll?: () => Promise<void>
  refresh?: () => Promise<void> | undefined
  hooks?: boolean
}) {
  const log: string[] = []
  const errors: unknown[] = []
  const s = { editorDirty: init.dirty ?? false, runningCount: init.running ?? 0 }
  let closed = false
  const flow = createCloseFlow({
    getState: () => s,
    askUnsaved: async () => {
      log.push('unsaved')
      return typeof init.unsaved === 'function' ? init.unsaved() : (init.unsaved ?? 'cancel')
    },
    saveBeforeClose: async () => {
      log.push('save')
      return typeof init.save === 'function' ? init.save() : (init.save ?? true)
    },
    askRunning: async (n) => {
      log.push(`running:${n}`)
      return init.stopRun ?? false
    },
    stopAll: async () => {
      log.push('stopAll')
      await init.stopAll?.()
    },
    // Electron's win.close() emits 'close' synchronously, re-entering the handler.
    closeWindow: () => {
      log.push('closeWindow')
      if (flow.onClose()) closed = true
    },
    refreshState: init.refresh ? () => (log.push('refresh'), init.refresh!()) : undefined,
    isGone: () => false,
    onError: (e) => errors.push(e),
    ...(init.hooks ? { onAsk: () => void log.push('onAsk'), onStay: () => void log.push('onStay') } : {})
  })
  // The user's close click: a real close event the handler may prevent.
  const requestClose = () => {
    if (flow.onClose()) closed = true
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { log, errors, s, flow, requestClose, settle, isClosed: () => closed }
}

describe('closeFlow', () => {
  it('closes clean and idle with no dialog', async () => {
    const t = setup({})
    t.requestClose()
    await t.settle()
    expect(t.isClosed()).toBe(true)
    expect(t.log).toEqual([])
  })

  it('dirty + running + Discard asks unsaved then running', async () => {
    const t = setup({ dirty: true, running: 2, unsaved: 'discard', stopRun: false })
    t.requestClose()
    expect(t.isClosed()).toBe(false)
    await t.settle()
    expect(t.log).toEqual(['unsaved', 'closeWindow', 'running:2'])
    expect(t.isClosed()).toBe(false)
  })

  it('dirty + running + Discard + Stop & Quit stops once then closes', async () => {
    const t = setup({ dirty: true, running: 1, unsaved: 'discard', stopRun: true })
    t.requestClose()
    await t.settle()
    expect(t.log).toEqual(['unsaved', 'closeWindow', 'running:1', 'stopAll', 'closeWindow'])
    expect(t.isClosed()).toBe(true)
  })

  it('Save success still asks about running replies', async () => {
    const t = setup({ dirty: true, running: 3, unsaved: 'save', save: true })
    t.requestClose()
    await t.settle()
    expect(t.log).toEqual(['unsaved', 'save', 'closeWindow', 'running:3'])
    expect(t.isClosed()).toBe(false)
  })

  it('Save success with nothing running closes', async () => {
    const t = setup({ dirty: true, unsaved: 'save', save: true })
    t.requestClose()
    await t.settle()
    expect(t.isClosed()).toBe(true)
  })

  it('Save returning false stays open', async () => {
    const t = setup({ dirty: true, unsaved: 'save', save: false })
    t.requestClose()
    await t.settle()
    expect(t.isClosed()).toBe(false)
    expect(t.log).toEqual(['unsaved', 'save'])
  })

  it('Cancel at the unsaved dialog stays open and can ask again', async () => {
    const t = setup({ dirty: true, unsaved: 'cancel' })
    t.requestClose()
    await t.settle()
    t.requestClose()
    await t.settle()
    expect(t.isClosed()).toBe(false)
    expect(t.log).toEqual(['unsaved', 'unsaved'])
  })

  it('Cancel at the running dialog resets the Discard skip so edits prompt again', async () => {
    const t = setup({ dirty: true, running: 1, unsaved: 'discard', stopRun: false })
    t.requestClose()
    await t.settle()
    t.log.length = 0
    t.requestClose()
    await t.settle()
    expect(t.log[0]).toBe('unsaved')
  })

  it('ignores a second close request while a dialog is open', async () => {
    let release: (v: Unsaved) => void = () => {}
    const t = setup({ dirty: true, unsaved: () => new Promise<Unsaved>((r) => (release = r)) })
    t.requestClose()
    t.requestClose()
    t.requestClose()
    release('cancel')
    await t.settle()
    expect(t.log).toEqual(['unsaved'])
  })

  it('a rejecting dependency is reported and does not wedge the guard', async () => {
    let fail = true
    const t = setup({
      dirty: true,
      running: 1,
      unsaved: 'discard',
      stopRun: true,
      stopAll: async () => {
        if (fail) throw new Error('boom')
      }
    })
    t.requestClose()
    await t.settle()
    expect(t.errors).toHaveLength(1)
    expect(t.isClosed()).toBe(false)
    fail = false
    t.log.length = 0
    t.requestClose()
    await t.settle()
    expect(t.log[0]).toBe('unsaved') // skip flag reset after the failure
    expect(t.log).toContain('running:1')
  })
})

describe('createCloseFlow with a state refresh', () => {
  it('refreshes before deciding, so a reply that started since the last poll is guarded', async () => {
    let c!: ReturnType<typeof setup>
    c = setup({ running: 0, stopRun: false, refresh: async () => void (c.s.runningCount = 2) })
    c.requestClose()
    expect(c.isClosed()).toBe(false) // held until the fresh count is in
    await c.settle()
    expect(c.log).toEqual(['refresh', 'closeWindow', 'running:2'])
    expect(c.isClosed()).toBe(false)
  })
  it('closes after the refresh when nothing is running', async () => {
    const c = setup({ refresh: async () => {} })
    c.requestClose()
    await c.settle()
    expect(c.log).toEqual(['refresh', 'closeWindow'])
    expect(c.isClosed()).toBe(true)
  })
  it('closes straight away when there is nothing to refresh (VPS mode)', () => {
    const c = setup({ refresh: () => undefined })
    c.requestClose()
    expect(c.isClosed()).toBe(true)
  })
  it('a second close click during the refresh does not start another one', async () => {
    const c = setup({ refresh: () => new Promise<void>((r) => setTimeout(r, 10)) })
    c.requestClose()
    c.requestClose()
    await new Promise((r) => setTimeout(r, 30))
    expect(c.log.filter((l) => l === 'refresh')).toHaveLength(1)
    expect(c.isClosed()).toBe(true)
  })
  it('a failed refresh still lets the cached decision run', async () => {
    const c = setup({ running: 1, stopRun: false, refresh: () => Promise.reject(new Error('x')) })
    c.requestClose()
    await c.settle()
    expect(c.log).toContain('running:1')
  })
})

describe('createCloseFlow hooks', () => {
  it('onAsk runs right before askUnsaved, and Cancel calls onStay once', async () => {
    const t = setup({ dirty: true, unsaved: 'cancel', hooks: true })
    t.requestClose()
    await t.settle()
    expect(t.log).toEqual(['onAsk', 'unsaved', 'onStay'])
  })
  it('onAsk runs before each ask, and Cancel at the running dialog calls onStay', async () => {
    const t = setup({ dirty: true, running: 1, unsaved: 'discard', stopRun: false, hooks: true })
    t.requestClose()
    await t.settle()
    expect(t.log).toEqual(['onAsk', 'unsaved', 'closeWindow', 'onAsk', 'running:1', 'onStay'])
  })
  it('a failed ask counts as staying', async () => {
    const t = setup({ dirty: true, unsaved: () => Promise.reject(new Error('x')), hooks: true })
    t.requestClose()
    await t.settle()
    expect(t.log).toEqual(['onAsk', 'unsaved', 'onStay'])
  })
  it('Stop & Quit and a clean close call no onStay', async () => {
    const a = setup({ running: 1, stopRun: true, hooks: true })
    a.requestClose()
    await a.settle()
    expect(a.log).toEqual(['onAsk', 'running:1', 'stopAll', 'closeWindow'])
    const b = setup({ hooks: true })
    b.requestClose()
    await b.settle()
    expect(b.log).toEqual([])
  })
})
