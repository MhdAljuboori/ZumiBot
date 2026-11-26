import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserSite } from '../../../e2e/fixtures/browser-site.mjs'
import { cleanStyle, createChromiumAdapter, jpegSize, pngSize } from '../../src/core/browser/chromiumAdapter'
import { COMPUTED_STYLE_PROPS, STYLE_VALUE_MAX } from '../../src/core/browser/browserStyle'
import { FakeBrowser } from '../support/fakeBrowser'
import { boundBrowserResult, cutBrowserResult } from '../../src/core/browser/browserTools'
import { BROWSER_PAYLOAD, SCRUB_MARGIN } from '../../src/core/browser/browserLimits'
import { parseBrowserPageState } from '@zumibot/shared/browser'
import { loadBrowserConfig } from '../../src/core/browser/config'
import { BrowserManager } from '../../src/core/browser/browserManager'
import { BrowserProfileStore } from '../../src/core/browser/profileStore'
import type { BrowserTimers } from '../../src/core/browser/browserLeases'
import type {
  BrowserCommand,
  BrowserFill,
  BrowserFrame,
  BrowserInstance,
  BrowserModifier,
  BrowserResult,
  BrowserStamp,
  BrowserTab
} from '../../src/core/browser/types'

let dir: string, site: Awaited<ReturnType<typeof browserSite>>
const instances: BrowserInstance[] = []
// With the whole suite running beside it (any machine, not only a 2-core CI runner), Chrome can take longer than 1.5 s to
// start or answer one command. The test of the command bound itself sets 1.5 s again.
const config = { ...loadBrowserConfig({}), executablePath: '/usr/bin/google-chrome', commandMs: 6000 }
// Several commands per test at that limit would pass vitest's 5 s test timeout.
vi.setConfig({ testTimeout: 60_000 })
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cb-browser-'))
  site = await browserSite()
})
afterEach(async () => {
  await Promise.all(instances.splice(0).map((i) => i.close()))
  await site.close()
  await rm(dir, { recursive: true, force: true })
})
async function launch(path = dir, overrides: Partial<typeof config> = {}) {
  const i = await createChromiumAdapter().launch(path, { ...config, ...overrides })
  instances.push(i)
  return i
}
const run = (i: BrowserInstance, command: BrowserCommand) => i.execute(command, new AbortController().signal)
type Observation = {
  stamp: BrowserStamp
  text: string
  elements: { ref: string; name: string; role: string; text: string; frame?: string }[]
}
function data<T>(r: BrowserResult): T {
  expect(r.ok).toBe(true)
  if (!r.ok) throw Error(r.message)
  return r.data as T
}
async function observe(i: BrowserInstance) {
  return data<Observation>(await run(i, { op: 'observe' }))
}
// An observation as JSON with its random ids blanked: the stamp's and every ref are UUIDs, whose hex can hold any short
// digit run, so a "never contains 4242" check once failed on a stamp ending in …ab424295ba01.
const shown = (o: Observation) => JSON.stringify({ ...o, stamp: null, elements: o.elements.map((e) => ({ ...e, ref: '' })) })
async function click(i: BrowserInstance, name: string) {
  const o = await observe(i),
    ref = o.elements.find((e) => e.name === name)!.ref
  return run(i, { op: 'click', stamp: o.stamp, ref })
}

// A whole manager with a live viewer is the heaviest Chrome start here: on a shared CI runner it sometimes fails to come up.
for (const reason of ['release', 'inactivity'] as const)
  it(`rejects real same-turn references across ${reason} with a visible viewer`, { retry: process.env['CI'] ? 2 : 0 }, async () => {
    const profiles = new BrowserProfileStore(dir)
    await profiles.load()
    const profile = await profiles.ensure('agent'),
      owner = { profileId: profile.id, chatId: 'chat', turnId: 'turn' }
    // Only the lease deadline is controlled; Chromium and command deadlines use real time.
    const leaseDeadlines = new Map<ReturnType<typeof setTimeout>, () => void>()
    const timers: BrowserTimers = {
      setTimeout(callback, ms) {
        const timer = setTimeout(callback, ms)
        if (ms === config.leaseIdleMs) leaseDeadlines.set(timer, callback)
        return timer
      },
      clearTimeout(timer) {
        clearTimeout(timer)
        leaseDeadlines.delete(timer)
      }
    }
    const manager = new BrowserManager({
      profiles,
      adapter: createChromiumAdapter(),
      // The command bound is also Chrome's start bound, and this test is often a CI job's first Chrome start (a cold disk):
      // it gets the default 30 s, since three tries at 6 s each have all timed out there.
      config: { ...config, idleMs: 60000, commandMs: loadBrowserConfig({}).commandMs },
      timers,
      now: Date.now,
      newId: () => 'request',
      resolveTarget: async () => ({ ...profile, agent: 'agent' }),
      onHandoff: async () => {}
    })
    const command = (c: BrowserCommand) => manager.run(owner, c, new AbortController().signal)
    try {
      const watch = await manager.watch({ agent: 'agent' }, { id: 'viewer', sessionKey: 'session', sendStatus() {}, sendFrame() {} })
      expect(await command({ op: 'navigate', url: site.url })).toMatchObject({ ok: true })
      const old = data<Observation>(await command({ op: 'observe' }))
      const action = { op: 'click' as const, stamp: old.stamp, ref: old.elements.find((e) => e.name === 'Account')!.ref }
      expect(await command(action)).toMatchObject({ ok: true })
      expect(await command(action)).toMatchObject({ ok: true })
      if (reason === 'release') await command({ op: 'release' })
      else {
        expect(leaseDeadlines.size).toBe(1)
        for (const [timer, expire] of leaseDeadlines) {
          clearTimeout(timer)
          expire()
        }
        leaseDeadlines.clear()
      }
      expect(await command(action)).toMatchObject({ ok: false, code: 'stale_reference' })
      const fresh = data<Observation>(await command({ op: 'observe' }))
      expect(fresh.stamp.generation).toBe(old.stamp.generation)
      expect(fresh.stamp.observationId).not.toBe(old.stamp.observationId)
      expect(await command({ ...action, stamp: fresh.stamp, ref: fresh.elements.find((e) => e.name === 'Account')!.ref })).toMatchObject({
        ok: true
      })
      await watch.close()
    } finally {
      await manager.close()
    }
  })

it('observes bounded descriptions and rejects stale element stamps after navigation and invalidation', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  const o = await observe(i)
  expect(o.text).not.toContain('fixture-private-password')
  expect(o.text.length).toBeLessThanOrEqual(32000)
  expect(o.elements.find((e) => e.name === 'Click me')?.role).toBe('button')
  expect(await click(i, 'Click me')).toMatchObject({ ok: true })
  expect((await observe(i)).text).toContain('Clicked')
  await i.invalidateReferences()
  expect(await run(i, { op: 'click', stamp: o.stamp, ref: o.elements[0].ref })).toMatchObject({ ok: false, code: 'stale_reference' })
  const next = await observe(i)
  await run(i, { op: 'reload' })
  expect(await run(i, { op: 'click', stamp: next.stamp, ref: next.elements[0].ref })).toMatchObject({ ok: false, code: 'stale_reference' })
})

it('commits manual text once and rejects input from an old generation', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  const o = await observe(i),
    ref = o.elements.find((e) => e.name === 'Account')!.ref
  expect(await run(i, { op: 'type', stamp: o.stamp, ref, text: 'agent ' })).toMatchObject({ ok: true })
  expect(await run(i, { op: 'click', stamp: o.stamp, ref })).toMatchObject({ ok: true })
  await i.input({ type: 'text', text: 'committed', generation: i.generation, tabId: o.stamp.tabId }, new AbortController().signal)
  await expect(
    i.input({ type: 'text', text: 'stale', generation: 'old-generation', tabId: o.stamp.tabId }, new AbortController().signal)
  ).rejects.toThrow('Browser input unavailable')
  await click(i, 'Show account')
  expect((await observe(i)).text).toContain('agent committed')
  expect((await observe(i)).text).not.toContain('committedcommitted')
  const image = data<{ mimeType: string; base64: string }>(await run(i, { op: 'screenshot' }))
  expect(image.mimeType).toBe('image/jpeg')
  expect(Buffer.from(image.base64, 'base64').length).toBeLessThanOrEqual(3932160)
})

it('retains a usable leading action reference while bounding a large observation', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url + '/large' })
  const raw = await observe(i),
    o = data<Observation>(cutBrowserResult({ ok: true, data: raw })),
    action = o.elements.find((e) => e.name === 'Action')
  expect(action).toBeDefined()
  // The instance hands text over up to the scrub margin longer; the manager's cut, after the scrub, brings it to the bound.
  expect(raw.text.length).toBeLessThanOrEqual(32000 + SCRUB_MARGIN)
  expect(o.text.length + o.elements.reduce((sum, e) => sum + e.role.length + e.name.length + e.text.length, 0)).toBeLessThanOrEqual(32000)
  expect(await run(i, { op: 'click', stamp: o.stamp, ref: action!.ref })).toMatchObject({ ok: true })
  expect((await observe(i)).elements.find((e) => e.name === 'Large action clicked')).toBeDefined()
})

it('dispatches editing keys and modifier shortcuts without inserting printable keyDown text', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  const o = await observe(i),
    ref = o.elements.find((e) => e.name === 'Account')!.ref
  await run(i, { op: 'type', stamp: o.stamp, ref, text: 'agent' })
  await run(i, { op: 'click', stamp: o.stamp, ref })
  const target = { generation: i.generation, tabId: o.stamp.tabId }
  await i.input({ ...target, type: 'keyDown', key: 'Backspace', code: 'Backspace' }, new AbortController().signal)
  await i.input({ ...target, type: 'keyUp', key: 'Backspace', code: 'Backspace' }, new AbortController().signal)
  await click(i, 'Show account')
  expect((await observe(i)).text).toMatch(/(?:^|\n)agen(?:\n|$)/)
  const current = await observe(i)
  await run(i, { op: 'click', stamp: current.stamp, ref: current.elements.find((e) => e.name === 'Account')!.ref })
  await i.input({ ...target, type: 'keyDown', key: 'a', code: 'KeyA', modifiers: ['Control'] }, new AbortController().signal)
  await i.input({ ...target, type: 'keyUp', key: 'a', code: 'KeyA', modifiers: ['Control'] }, new AbortController().signal)
  await i.input({ ...target, type: 'text', text: 'selected' }, new AbortController().signal)
  await i.input({ ...target, type: 'keyDown', key: 'b', code: 'KeyB' }, new AbortController().signal)
  await i.input({ ...target, type: 'keyUp', key: 'b', code: 'KeyB' }, new AbortController().signal)
  await click(i, 'Show account')
  expect((await observe(i)).text).toMatch(/(?:^|\n)selected(?:\n|$)/)
})

it("takes a phone keyboard's Backspace and Enter, which come without a key code", async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url + '/form' })
  const o = await observe(i),
    target = { generation: i.generation, tabId: o.stamp.tabId }
  await run(i, { op: 'click', stamp: o.stamp, ref: o.elements.find((e) => e.name === 'Query')!.ref })
  const press = async (key: string) => {
    for (const type of ['keyDown', 'keyUp'] as const) await i.input({ ...target, type, key, code: '' }, new AbortController().signal)
  }
  await i.input({ ...target, type: 'text', text: 'd' }, new AbortController().signal)
  await press('Backspace')
  await press('Backspace')
  await press('Enter')
  expect((await observe(i)).text).toContain('Submitted ab')
  const page = (i as any).context.pages()[0]
  await page.getByRole('textbox', { name: 'Notes' }).focus()
  await i.input({ ...target, type: 'text', text: 'one' }, new AbortController().signal)
  await press('Enter')
  await i.input({ ...target, type: 'text', text: 'two' }, new AbortController().signal)
  expect(await page.getByRole('textbox', { name: 'Notes' }).inputValue()).toBe('one\ntwo')
})

it('keeps the focused field in view when a phone keyboard shortens the viewport', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url + '/form' })
  await i.setViewport({ width: 400, height: 800, scale: 1 })
  const o = await observe(i)
  await run(i, { op: 'click', stamp: o.stamp, ref: o.elements.find((e) => e.name === 'Query')!.ref })
  const page = (i as any).context.pages()[0],
    field = page.getByRole('textbox', { name: 'Query' })
  await page.evaluate(() => window.scrollTo(0, 0))
  await i.setViewport({ width: 400, height: 300, scale: 1 })
  await expect
    .poll(async () => {
      const box = await field.boundingBox()
      return box && box.y >= 0 && box.y + box.height <= 300
    })
    .toBe(true)
})

it('preserves held mouse buttons across manual drag moves and clears them on release', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  const o = await observe(i),
    target = { generation: i.generation, tabId: o.stamp.tabId }
  await i.input({ ...target, type: 'mouseDown', x: 650, y: 250, button: 'left' }, new AbortController().signal)
  await i.input({ ...target, type: 'mouseMove', x: 660, y: 260 }, new AbortController().signal)
  expect((await observe(i)).text).toContain('Buttons 1')
  await i.input({ ...target, type: 'mouseUp', x: 660, y: 260, button: 'left' }, new AbortController().signal)
  await i.input({ ...target, type: 'mouseMove', x: 670, y: 270 }, new AbortController().signal)
  expect((await observe(i)).text).toContain('Buttons 0')
  await i.input({ ...target, type: 'mouseDown', x: 650, y: 250, button: 'left' }, new AbortController().signal)
  await i.invalidateReferences()
  await i.input({ ...target, type: 'mouseMove', x: 660, y: 260 }, new AbortController().signal)
  expect((await observe(i)).text).toContain('Buttons 0')
})

it('chooses select options by value or label and refuses unusable choices without retiring the browser', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url + '/select' })
  const choose = async (name: string, values: string[]) => {
    const o = await observe(i)
    return run(i, { op: 'select', stamp: o.stamp, ref: o.elements.find((e) => e.name === name)!.ref, values })
  }
  expect((await observe(i)).elements.find((e) => e.name === 'Requested By')).toMatchObject({
    role: 'combobox',
    text: expect.stringContaining('Fadi Selo')
  })
  expect(await choose('Requested By', ['Fadi Selo'])).toMatchObject({ ok: true })
  expect((await observe(i)).text).toContain('Picked Fadi Selo')
  expect(await choose('Requested By', ['omima'])).toMatchObject({ ok: true })
  expect((await observe(i)).text).toContain('Picked omima')
  for (const [name, values] of [
    ['Requested By', ['Nobody']],
    ['Requested By', ['Retired']],
    ['Requested By', ['omima', 'Fadi Selo']],
    ['Locked', ['Locked']],
    ['Plain button', ['x']]
  ] as const) {
    expect(await choose(name, [...values])).toMatchObject({ ok: false, code: 'invalid_option' })
  }
  expect(i.isClosed()).toBe(false)
  expect((await observe(i)).text).toContain('Picked omima')
})

it('draws a manually opened select picker inside the page so viewer clicks and keys choose an option', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url + '/select' })
  const o = await observe(i),
    target = { generation: i.generation, tabId: o.stamp.tabId }
  const page = (i as any).context.pages()[0],
    select = page.getByRole('combobox', { name: 'Requested By' })
  const press = async (x: number, y: number) => {
    for (const type of ['mouseDown', 'mouseUp'] as const)
      await i.input({ ...target, type, x, y, button: 'left' }, new AbortController().signal)
  }
  const key = async (key: string, code: string, modifiers: BrowserModifier[] = []) => {
    for (const type of ['keyDown', 'keyUp'] as const) await i.input({ ...target, type, key, code, modifiers }, new AbortController().signal)
  }
  const box = await select.boundingBox()
  await press(box.x + 20, box.y + box.height / 2)
  expect(await select.evaluate((el: Element) => el.matches(':open'))).toBe(true)
  // A native popup lays out no option boxes in the page, so screencast frames and clicks miss it.
  const option = await page.getByRole('option', { name: 'Inas Nasri' }).boundingBox()
  expect(option).not.toBeNull()
  await press(option.x + 10, option.y + option.height / 2)
  expect((await observe(i)).text).toContain('Picked Inas Nasri')
  await expect
    .poll(() => select.evaluate((el: HTMLElement) => [el.matches(':open'), el.style.getPropertyValue('appearance'), el.style.width]))
    .toEqual([false, '', '300px'])
  await key('ArrowDown', 'ArrowDown', ['Alt'])
  expect(await select.evaluate((el: Element) => el.matches(':open'))).toBe(true)
  expect(await page.getByRole('option', { name: 'Fadi Selo' }).boundingBox()).not.toBeNull()
  await key('Escape', 'Escape')
  await expect
    .poll(() => select.evaluate((el: HTMLElement) => [el.matches(':open'), el.style.getPropertyValue('appearance'), el.style.width]))
    .toEqual([false, '', '300px'])
})

it('retains disk cookies across generations and isolates another profile', async () => {
  const first = await launch()
  await run(first, { op: 'navigate', url: site.url })
  await click(first, 'Set cookie')
  expect((await observe(first)).text).toContain('fixture=persisted')
  await first.close()
  const second = await launch()
  expect(second.generation).not.toBe(first.generation)
  await run(second, { op: 'navigate', url: site.url })
  expect((await observe(second)).text).toContain('fixture=persisted')
  const isolated = await launch(join(dir, 'isolated'))
  await run(isolated, { op: 'navigate', url: site.url })
  expect((await observe(isolated)).text).not.toContain('fixture=persisted')
})

it('caps explicit tabs and automatic popups at the adapter boundary', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  await click(i, 'Popups')
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(i.status().tabs.length).toBe(4)
  expect(await run(i, { op: 'newTab' })).toMatchObject({ ok: false, code: 'tab_limit' })
  const tabId = i.status().tabs[1].id
  expect(await run(i, { op: 'selectTab', tabId })).toMatchObject({ ok: true })
  expect(i.status().activeTabId).toBe(tabId)
  expect(await run(i, { op: 'closeTab', tabId })).toMatchObject({ ok: true })
  expect(i.status().tabs.length).toBe(3)
})

it('returns from dialog-triggering clicks so the queue can accept the dialog answer', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  expect(await click(i, 'Dialog')).toMatchObject({ ok: true })
  expect(await run(i, { op: 'dialog', accept: false })).toMatchObject({ ok: true })
  expect(await click(i, 'Click me')).toMatchObject({ ok: true })
})

it.each(['navigate', 'reload', 'back', 'forward', 'newTab'] as const)(
  '%s yields for a navigation dialog and drains it before later commands',
  async (op) => {
    const i = await launch(),
      generation = i.generation
    const modal = site.url + '/navigation-dialog'
    await run(i, { op: 'navigate', url: site.url })
    if (op === 'reload' || op === 'back' || op === 'forward') {
      expect(await run(i, { op: 'navigate', url: modal })).toMatchObject({ ok: true })
      expect(await run(i, { op: 'dialog', accept: false })).toMatchObject({ ok: true })
      if (op === 'back') await run(i, { op: 'navigate', url: site.url })
      if (op === 'forward') await run(i, { op: 'back' })
    }
    const command: BrowserCommand = op === 'navigate' || op === 'newTab' ? { op, url: modal } : { op }
    expect(await run(i, command)).toMatchObject({ ok: true, data: { dialogPending: true } })
    expect(i.isClosed()).toBe(false)
    expect(await run(i, { op: 'observe' })).toMatchObject({ ok: false, code: 'dialog_pending' })
    if (op === 'navigate') await new Promise((resolve) => setTimeout(resolve, 1700))
    expect(await run(i, { op: 'dialog', accept: false })).toMatchObject({ ok: true })
    expect(i.generation).toBe(generation)
    expect((await observe(i)).elements.find((e) => e.name === 'After alert')).toBeDefined()
    expect(await click(i, 'After alert')).toMatchObject({ ok: true })
    expect((await observe(i)).text).toContain('After dialog clicked')
  }
)

it('keeps a multi-dialog navigation suspended until each dialog is answered', async () => {
  const i = await launch()
  expect(await run(i, { op: 'navigate', url: site.url + '/navigation-dialog?double' })).toMatchObject({
    ok: true,
    data: { dialogPending: true }
  })
  expect(await run(i, { op: 'dialog', accept: false })).toMatchObject({ ok: true, data: { dialogPending: true } })
  expect(await run(i, { op: 'navigate', url: site.url })).toMatchObject({ ok: false, code: 'dialog_pending' })
  expect(await run(i, { op: 'dialog', accept: false })).toMatchObject({ ok: true })
  expect((await observe(i)).text).toContain('After alert')
})

it('bounds stalled navigation and aborts without reflecting secret URLs', async () => {
  // The bound under test is the command timeout itself, so it stays short here.
  const i = await launch(dir, { commandMs: 1500 })
  const start = Date.now()
  expect(await run(i, { op: 'navigate', url: site.url + '/slow?private-token' })).toEqual({
    ok: false,
    code: 'timeout',
    message: 'Browser command timed out'
  })
  expect(Date.now() - start).toBeLessThan(4000)
  expect(i.isClosed()).toBe(true)
  const fresh = await launch()
  const abort = new AbortController()
  const pending = fresh.execute({ op: 'navigate', url: site.url + '/slow' }, abort.signal)
  abort.abort()
  expect(await pending).toMatchObject({ ok: false, code: 'aborted' })
})

it('produces frames only during capture and stops delivery before close resolves', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  const frames: Uint8Array[] = []
  await i.startFrames((frame) => {
    expect(frame.generation).toBe(i.generation)
    frames.push(frame.jpeg)
  })
  await expect.poll(() => frames.length).toBeGreaterThan(0)
  expect(frames[0][0]).toBe(0xff)
  await i.stopFrames()
  const stopped = frames.length
  await new Promise((resolve) => setTimeout(resolve, 250))
  expect(frames.length).toBe(stopped)
  await i.startFrames((frame) => frames.push(frame.jpeg))
  await i.close()
  const closed = frames.length
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(frames.length).toBe(closed)
})

it('exposes bounded active-tab dialog metadata and accepts prompt replies without holding the operation queue', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url + '/files' })
  await click(i, 'Prompt')
  expect(i.status()).toMatchObject({ dialog: { type: 'prompt', message: 'Synthetic prompt', defaultValue: 'default' } })
  expect(await run(i, { op: 'dialog', accept: true, text: 'مرحبا' })).toMatchObject({ ok: true })
  expect((await observe(i)).text).toContain('مرحبا')
})

it('streams network, anchor and blob downloads to a bounded parent sink and uploads internal resolved paths', async () => {
  const received: { name: string; bytes: Buffer }[] = []
  const i = await createChromiumAdapter().launch(dir, config, {
    download: async (source, name) => {
      const chunks: Buffer[] = []
      for await (const chunk of source) {
        expect(chunk.length).toBeLessThanOrEqual(65536)
        chunks.push(Buffer.from(chunk))
      }
      const bytes = Buffer.concat(chunks)
      received.push({ name, bytes })
      return { id: 'opaque', name, size: bytes.length }
    }
  })
  instances.push(i)
  await run(i, { op: 'navigate', url: site.url + '/files' })
  for (const name of ['Blob download', 'Network download', 'Anchor download', 'Unknown length download']) {
    expect(await click(i, name)).toMatchObject({ ok: true })
    await expect
      .poll(() => received.length)
      .toBe(['Blob download', 'Network download', 'Anchor download', 'Unknown length download'].indexOf(name) + 1)
  }
  expect(received.map((f) => f.bytes.toString())).toEqual(['blob bytes', 'network bytes', 'anchor bytes', 'unknown length bytes'])
  const { writeFile } = await import('node:fs/promises')
  const path = join(dir, 'synthetic.txt')
  await writeFile(path, 'uploaded bytes')
  const o = await observe(i),
    ref = o.elements.find((e) => e.name === 'Upload file')!.ref
  expect(
    await i.execute({ op: 'upload', stamp: o.stamp, ref, fileIds: ['opaque-upload'] }, new AbortController().signal, [path])
  ).toMatchObject({ ok: true })
  expect((await observe(i)).text).toContain('synthetic.txt')
})
it('yields modal-triggering manual mouse input so a human dialog answer cannot queue behind it', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url + '/files' })
  const o = await observe(i),
    target = { generation: i.generation, tabId: o.stamp.tabId }
  const prompt = await (i as any).context.pages()[0].getByRole('button', { name: 'Prompt', exact: true }).boundingBox()
  const x = prompt.x + prompt.width / 2,
    y = prompt.y + prompt.height / 2
  await i.input({ ...target, type: 'mouseDown', x, y, button: 'left' }, new AbortController().signal)
  await i.input({ ...target, type: 'mouseUp', x, y, button: 'left' }, new AbortController().signal)
  expect(i.status().dialog).toMatchObject({ type: 'prompt' })
  expect(await run(i, { op: 'dialog', accept: true, text: 'manual answer' })).toMatchObject({ ok: true })
  expect((await observe(i)).text).toContain('manual answer')
}, 3000)

it('cancels a slow oversized download before the fixture finishes and cleans both scratch and staged partials', async () => {
  const { BrowserFiles } = await import('../../src/core/browser/browserFiles')
  const { readdir } = await import('node:fs/promises')
  const staging = join(dir, 'staged'),
    files = new BrowserFiles(staging)
  await files.clear()
  const owner = { profileId: 'p', generation: 'g', viewerId: 'v' }
  const i = await createChromiumAdapter().launch(dir, config, {
    download: (source, name, _generation, signal) => files.stageDownload(owner, source, name, signal)
  })
  instances.push(i)
  try {
    await run(i, { op: 'navigate', url: site.url + '/files' })
    await click(i, 'Oversized download')
    await expect.poll(() => site.oversized.closed, { timeout: 5000 }).toBe(true)
    expect(site.oversized.finished).toBe(false)
    expect(site.oversized.bytes).toBeLessThan(64 * 1024 * 1024)
    await expect.poll(() => readdir(staging)).toEqual([])
    const scratch = (await readdir(dir)).find((n) => n.startsWith('.downloads-'))!
    await expect.poll(() => readdir(join(dir, scratch))).toEqual([])
  } finally {
    await files.close()
  }
}, 10000)
it('retains simultaneous popup dialogs until each bounded pending dialog is answered', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  await click(i, 'Popup dialogs')
  await expect.poll(() => i.status().tabs.length, { timeout: 3000 }).toBe(3)
  await expect.poll(() => i.status().dialog).toMatchObject({ type: 'alert' })
  expect(await run(i, { op: 'dialog', accept: true })).toMatchObject({ ok: true })
  await expect.poll(() => i.status().dialog).toMatchObject({ type: 'alert' })
  expect(await run(i, { op: 'dialog', accept: true })).toMatchObject({ ok: true })
  expect(i.status().dialog).toBeNull()
})

it('sizes every tab and its frames to the viewer, renders HiDPI, and keeps agent screenshots in CSS pixels', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  const pages = () => (i as any).context.pages() as import('playwright-core').Page[]
  const frames: BrowserFrame[] = []
  await i.startFrames((f) => frames.push(f))
  await expect.poll(() => frames.length).toBeGreaterThan(0)
  expect(frames.at(-1)).toMatchObject({ width: 1280, height: 800 })
  // The launch default is viewed at 1x, though the page renders at 2x.
  expect(jpegSize(frames.at(-1)!.jpeg)).toEqual({ width: 1280, height: 800 })
  await i.setViewport({ width: 390, height: 600, scale: 2 })
  expect(await pages()[0].evaluate(() => [innerWidth, innerHeight, devicePixelRatio])).toEqual([390, 600, 2])
  await pages()[0].evaluate(() => {
    document.body.style.background = '#fee'
  })
  // Every frame's picture matches its own size; the last one is the settled page.
  await expect
    .poll(() => frames.at(-1) && [frames.at(-1)!.width, frames.at(-1)!.height, jpegSize(frames.at(-1)!.jpeg)])
    .toEqual([390, 600, { width: 780, height: 1200 }])
  const shot = data<{ base64: string }>(await run(i, { op: 'screenshot' }))
  expect(jpegSize(Buffer.from(shot.base64, 'base64'))).toEqual({ width: 390, height: 600 })
  expect(jpegSize(new Uint8Array([1, 2, 3]))).toBeNull()
  // A new tab opens at the viewer's size, not the launch default.
  await run(i, { op: 'newTab' })
  await expect.poll(() => pages().at(-1)!.viewportSize()).toEqual({ width: 390, height: 600 })
  await i.setViewport({ width: 700, height: 500, scale: 1 })
  await pages()
    .at(-1)!
    .evaluate(() => {
      document.body.style.background = '#efe'
    })
  await expect
    .poll(() => frames.at(-1) && [frames.at(-1)!.width, frames.at(-1)!.height, jpegSize(frames.at(-1)!.jpeg)])
    .toEqual([700, 500, { width: 700, height: 500 }])
  for (const f of frames) {
    const px = jpegSize(f.jpeg)!
    expect(Math.abs(px.width / px.height - f.width / f.height)).toBeLessThan(0.05)
  }
  expect(pages().map((p) => p.viewportSize())).toEqual([
    { width: 700, height: 500 },
    { width: 700, height: 500 }
  ])
  // A point from a frame painted before a shrink is kept on the page rather than refused.
  await i.input(
    { generation: i.generation, tabId: i.status().activeTabId!, type: 'mouseMove', x: 1000, y: 700 },
    new AbortController().signal
  )
})
it('selects the word under a double click count', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: site.url })
  const page = (i as any).context.pages()[0] as import('playwright-core').Page,
    target = { generation: i.generation, tabId: i.status().activeTabId! }
  const box = (await page.getByLabel('Account').boundingBox())!,
    y = box.y + box.height / 2
  const press = async (x: number, clickCount: number) => {
    for (const type of ['mouseDown', 'mouseUp'] as const)
      await i.input({ ...target, type, x, y, button: 'left', clickCount }, new AbortController().signal)
  }
  await press(box.x + 5, 1)
  await i.input({ ...target, type: 'text', text: 'hello world' }, new AbortController().signal)
  await press(box.x + 6, 1)
  await press(box.x + 6, 2)
  expect(await page.getByLabel('Account').evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe(
    'hello'
  )
})

it('observes elements inside a cross-origin iframe with their frame host', async () => {
  const i = await launch()
  expect(await run(i, { op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}` })).toMatchObject({ ok: true })
  const o = await observe(i)
  expect(o.elements.find((e) => e.name === 'Card number')).toMatchObject({ frame: 'localhost' })
  expect(o.elements.find((e) => e.name === 'Place order')?.frame).toBeUndefined()
  expect(o.text).toContain('Checkout')
  // Everything fits: main frame first, then the iframe, and nothing says it was cut.
  const firstFramed = o.elements.findIndex((e) => e.frame !== undefined)
  expect(firstFramed).toBeGreaterThan(0)
  expect(o.elements.slice(firstFramed).every((e) => e.frame !== undefined)).toBe(true)
  expect('truncated' in o).toBe(false)
})

it('keeps room for a card iframe on a page whose main frame alone would fill the observation, and says what was cut', async () => {
  const i = await launch()
  expect(await run(i, { op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}&many=300` })).toMatchObject({ ok: true })
  const o = (await observe(i)) as Observation & { truncated?: boolean }
  expect(o.elements.length).toBeLessThanOrEqual(256)
  for (const name of ['Card number', 'Expiry', 'CVC', 'Expiry month'])
    expect(
      o.elements.find((e) => e.name === name),
      name
    ).toMatchObject({ frame: 'localhost' })
  expect(o.elements.filter((e) => e.name === 'Extra').length).toBeGreaterThan(200)
  // The main frame's rest did not fit: the agent is told the observation is incomplete.
  expect(o.truncated).toBe(true)
  // The card's fields are usable by their refs.
  const card = o.elements.find((e) => e.name === 'Card number')!
  expect(await run(i, { op: 'type', stamp: o.stamp, ref: card.ref, text: '4242' })).toMatchObject({ ok: true })
})

it.each([6, 12, 20])(
  "hands the agent a card iframe's fields through the manager and the bound, beside 300 main-frame buttons of %i characters",
  async (size) => {
    const profiles = new BrowserProfileStore(dir)
    await profiles.load()
    const profile = await profiles.ensure('agent'),
      owner = { profileId: profile.id, chatId: 'chat', turnId: 'turn' }
    const manager = new BrowserManager({
      profiles,
      adapter: createChromiumAdapter(),
      config: { ...config, idleMs: 60000 },
      now: Date.now,
      newId: () => 'request',
      resolveTarget: async () => ({ ...profile, agent: 'agent' }),
      onHandoff: async () => {}
    })
    const command = (c: BrowserCommand) => manager.run(owner, c, new AbortController().signal)
    try {
      const label = 'b'.repeat(size)
      expect(await command({ op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}&many=300&label=${label}` })).toMatchObject({
        ok: true
      })
      // What the agent gets: the manager's scrubbed and cut result, bounded as the IPC sends it (browserIpc.ts).
      const seen = data<Observation & { truncated: boolean }>(boundBrowserResult(await command({ op: 'observe' })))
      for (const name of ['Card number', 'Expiry', 'CVC'])
        expect(
          seen.elements.find((e) => e.name === name),
          name
        ).toMatchObject({ frame: 'localhost' })
      expect(seen.elements.filter((e) => e.name === label).length).toBeGreaterThan(100)
      expect(seen.truncated).toBe(true)
    } finally {
      await manager.close()
    }
  }
)

it('types into an iframe field by its ref', async () => {
  const i = await launch()
  expect(await run(i, { op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}` })).toMatchObject({ ok: true })
  const o = await observe(i)
  const card = o.elements.find((e) => e.name === 'Card number')!
  expect(await run(i, { op: 'type', stamp: o.stamp, ref: card.ref, text: '4242' })).toMatchObject({ ok: true })
  expect((await observe(i)).elements.find((e) => e.name === 'Echo')?.text).toBe('Typed 4242')
  const again = await observe(i),
    month = again.elements.find((e) => e.name === 'Expiry month')!
  expect(await run(i, { op: 'select', stamp: again.stamp, ref: month.ref, values: ['02'] })).toMatchObject({ ok: true })
  expect((await observe(i)).elements.find((e) => e.name === 'Echo')?.text).toBe('Month 02')
})

it.each([
  ['card number', '4242 4242 4242 4242', { values: [], cards: ['4242424242424242'] }, '4242'],
  ['API key', 'ghp_Zq81TokenValueABCDEFxyz0123456789ab', { values: ['ghp_Zq81TokenValueABCDEFxyz0123456789ab'], cards: [] }, 'ghp_']
] as const)('replaces a %s an observation limit falls inside, then cuts', async (_kind, value, secrets, start) => {
  const profiles = new BrowserProfileStore(dir)
  await profiles.load()
  const profile = await profiles.ensure('agent'),
    owner = { profileId: profile.id, chatId: 'chat', turnId: 'turn' }
  const manager = new BrowserManager({
    profiles,
    adapter: createChromiumAdapter(),
    config,
    now: Date.now,
    newId: () => 'request',
    resolveTarget: async () => ({ ...profile, agent: 'agent' }),
    onHandoff: async () => {},
    vault: {
      item: () => null,
      status: () => 'ready',
      addApproval: async () => {},
      approve: async () => 'deny',
      secrets: () => ({ values: [...secrets.values], cards: [...secrets.cards] })
    }
  })
  const command = (c: BrowserCommand) => manager.run(owner, c, new AbortController().signal)
  try {
    // Each page puts the value 6 characters before a cut: the element name at 256, the page text at 32 000. The whole value is
    // replaced first, then the result is cut, so what is left is part of the replacement, never the value's start.
    expect(await command({ op: 'navigate', url: `${site.url}/straddle-name?v=${encodeURIComponent(value)}` })).toMatchObject({ ok: true })
    const named = data<Observation>(await command({ op: 'observe' }))
    expect(named.elements[0].name).toBe(`${'x'.repeat(249)} [hidden by vault]`.slice(0, 256))
    expect(shown(named)).not.toContain(start)
    expect(await command({ op: 'navigate', url: `${site.url}/straddle-text?v=${encodeURIComponent(value)}` })).toMatchObject({ ok: true })
    const texted = data<Observation>(await command({ op: 'observe' }))
    expect(texted.text).toBe(`${'a'.repeat(31993)} [hidden by vault] end`.slice(0, 32000))
    expect(shown(texted)).not.toContain(start)
  } finally {
    await manager.close()
  }
})

// A BrowserManager over the real adapter, with the given vault secrets.
async function vaultManager(secrets: { values: string[]; cards: string[] }) {
  const profiles = new BrowserProfileStore(dir)
  await profiles.load()
  const profile = await profiles.ensure('agent'),
    owner = { profileId: profile.id, chatId: 'chat', turnId: 'turn' }
  const manager = new BrowserManager({
    profiles,
    adapter: createChromiumAdapter(),
    config,
    now: Date.now,
    newId: () => 'request',
    resolveTarget: async () => ({ ...profile, agent: 'agent' }),
    onHandoff: async () => {},
    vault: {
      item: () => null,
      status: () => 'ready',
      addApproval: async () => {},
      approve: async () => 'deny',
      secrets: () => ({ values: [...secrets.values], cards: [...secrets.cards] })
    }
  })
  return { manager, command: (c: BrowserCommand) => manager.run(owner, c, new AbortController().signal) }
}

it.each(['page text', 'element name'] as const)(
  'never shows the start of a secret the worker cut after replacements shortened the %s',
  async (kind) => {
    // Two copies of a saved 4 200-character value, then a card number of which the worker's own cut hands over only '4242 42'.
    const seed = 'Zq81-key_',
      value = seed.repeat(Math.ceil(4200 / seed.length)).slice(0, 4200)
    const { manager, command } = await vaultManager({ values: [value], cards: ['4242424242424242'] })
    try {
      const path = kind === 'page text' ? 'shrink-text' : 'shrink-name'
      expect(
        await command({ op: 'navigate', url: `${site.url}/${path}?v=${seed}&c=${encodeURIComponent('4242 4242 4242 4242')}` })
      ).toMatchObject({ ok: true })
      const o = data<Observation>(await command({ op: 'observe' }))
      expect(shown(o)).not.toContain('4242')
      expect(shown(o)).not.toContain(seed)
      if (kind === 'page text') expect(o.text).toMatch(/^\[hidden by vault\] \[hidden by vault\] a+$/)
      else expect(o.elements[0].name).toBe('')
    } finally {
      await manager.close()
    }
  }
)

it('caps what one observation hands over: past the cap, a string longer than its limit is dropped, never sent without its margin', async () => {
  const i = await launch()
  const size = (o: Observation) => o.text.length + o.elements.reduce((n, e) => n + e.role.length + e.name.length + e.text.length, 0)
  const full = 80 + SCRUB_MARGIN
  // Under the cap, a page reads exactly as before: every long role keeps its whole margin.
  await run(i, { op: 'navigate', url: `${site.url}/hostile?n=100&len=9000` })
  const under = await observe(i)
  expect(under.elements.filter((e) => e.role.length === full)).toHaveLength(100)
  expect(under.elements.at(-1)).toMatchObject({ role: 'button', name: 'After' })
  // 250 such elements cost little against the 32 000 budget but would hand over two million characters.
  await run(i, { op: 'navigate', url: `${site.url}/hostile?n=250&len=9000` })
  const over = await observe(i)
  expect(size(over)).toBeLessThanOrEqual(BROWSER_PAYLOAD)
  const kept = over.elements.filter((e) => e.role.length === full).length
  expect(kept).toBeGreaterThan(100)
  // The rest lose only their long role; their short name and text stay, and so does the plain button after them.
  expect(over.elements.slice(kept, 250).every((e) => e.role === '' && e.name === '.' && e.text === '.')).toBe(true)
  expect(over.elements.at(-1)).toMatchObject({ role: 'button', name: 'After' })
  // The agent gets them cut to the final lengths as always.
  const cut = data<Observation>(cutBrowserResult({ ok: true, data: over }))
  expect(cut.elements[0].role).toBe('r'.repeat(80))
  expect(cut.elements.at(-1)).toMatchObject({ role: 'button', name: 'After' })
  expect(await run(i, { op: 'click', stamp: over.stamp, ref: over.elements.at(-1)!.ref })).toMatchObject({ ok: true })
})

it('hands tab titles, URLs and dialog text over with the scrub margin, and keeps the viewer state at the final lengths', async () => {
  const i = await launch()
  await run(i, { op: 'navigate', url: `${site.url}/long-status?v=mark` })
  await expect.poll(() => [i.status().tabs[0]?.title.length, i.status().tabs[0]?.url.length]).toEqual([500, 8192])
  const tabs = data<{ tabs: BrowserTab[] }>(await run(i, { op: 'tabs' })).tabs
  expect([tabs[0].title.length, tabs[0].url.length]).toEqual([500 + SCRUB_MARGIN, 8192 + SCRUB_MARGIN])
  expect(await click(i, 'Alert')).toMatchObject({ ok: true })
  expect(i.status().dialog).toMatchObject({ type: 'alert', defaultValue: '' })
  expect(i.status().dialog!.message.length).toBe(2000)
  const shown = data<{ dialog: { message: string } }>(await run(i, { op: 'tabs' }))
  expect(shown.dialog.message.length).toBe(2000 + SCRUB_MARGIN)
  // What a worker sends its server as its state must parse, or the server would close the worker.
  expect(() => parseBrowserPageState({ generation: i.generation, ...i.status() })).not.toThrow()
  expect(await run(i, { op: 'dialog', accept: true })).toMatchObject({ ok: true })
})

it('scrubs a secret a tab title, URL or dialog limit falls inside, then cuts them to the final lengths', async () => {
  const H = '[hidden by vault]',
    secret = 'Tok3n-Value_99'
  const { manager, command } = await vaultManager({ values: [secret], cards: [] })
  try {
    expect(await command({ op: 'navigate', url: `${site.url}/long-status?v=${secret}` })).toMatchObject({ ok: true })
    let tab: BrowserTab | undefined
    // The title is read again after the page's own history change, so wait for both.
    await expect
      .poll(async () => {
        tab = data<{ tabs: BrowserTab[] }>(await command({ op: 'tabs' })).tabs[0]
        return [tab.title.length, tab.url.length]
      })
      .toEqual([500, 8192])
    expect(tab!.title).toBe(`${'T'.repeat(493)} ${H}`.slice(0, 500))
    // The page puts the secret 6 characters before 8 192 in its fragment, and its query names it too.
    const fs = 'f'.repeat(8192 - `${site.url}/long-status?v=${secret}`.length - 8)
    expect(tab!.url).toBe(`${site.url}/long-status?v=${H}#${fs}_${H}`.slice(0, 8192))
    const o = data<Observation>(await command({ op: 'observe' }))
    expect(await command({ op: 'click', stamp: o.stamp, ref: o.elements.find((e) => e.name === 'Alert')!.ref })).toMatchObject({ ok: true })
    const status = data<{ tabs: BrowserTab[]; dialog: { message: string } }>(await command({ op: 'tabs' }))
    expect(status.dialog.message).toBe(`${'M'.repeat(1993)} ${H}`.slice(0, 2000))
    expect(JSON.stringify(status)).not.toContain(secret)
    expect(await command({ op: 'dialog', accept: true })).toMatchObject({ ok: true })
  } finally {
    await manager.close()
  }
})

describe('vault fills', () => {
  type Page = import('playwright-core').Page
  const pageOf = (i: BrowserInstance) => (i as any).context.pages()[0] as Page
  const cardFrame = (i: BrowserInstance) =>
    pageOf(i)
      .frames()
      .find((f) => f.url().endsWith('/card-frame'))!
  const fill = (i: BrowserInstance, o: Observation, name: string, f: Omit<BrowserFill, 'stamp' | 'ref'>) =>
    i.fill({ ...f, stamp: o.stamp, ref: o.elements.find((e) => e.name === name)!.ref }, new AbortController().signal)
  const password = {
    value: 'correct-horse',
    secret: true,
    target: 'password' as const,
    hosts: { kind: 'login' as const, sites: ['127.0.0.1'] }
  }
  const security = (el: Element) => getComputedStyle(el).getPropertyValue('-webkit-text-security')

  it('fills a password only into a password field and masks it', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/login` })
    const o = await observe(i)
    expect(await fill(i, o, 'Nickname', password)).toMatchObject({ ok: false, code: 'wrong_field_type' })
    expect(await pageOf(i).getByLabel('Nickname').inputValue()).toBe('')
    expect(await fill(i, o, 'Password', password)).toEqual({ ok: true, data: { filled: true } })
    const field = pageOf(i).getByLabel('Password')
    expect(await field.inputValue()).toBe('correct-horse')
    expect(await field.evaluate(security)).toBe('disc')
    // A username is not secret and goes into a plain field, unmasked.
    expect(await fill(i, o, 'Username', { value: 'bob', secret: false, target: 'any', hosts: password.hosts })).toEqual({
      ok: true,
      data: { filled: true }
    })
    expect(await pageOf(i).getByLabel('Username').evaluate(security)).not.toBe('disc')
    expect(JSON.stringify(await observe(i))).not.toContain('correct-horse')
  })

  it('masks a card number in a plain text input', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}` })
    const o = await observe(i),
      hosts = { kind: 'card' as const, approved: [{ site: '127.0.0.1', frameSite: 'localhost' }] }
    expect(await fill(i, o, 'Card number', { value: '4242424242424242', secret: true, target: 'input', hosts })).toEqual({
      ok: true,
      data: { filled: true }
    })
    const number = cardFrame(i).getByLabel('Card number')
    expect(await number.inputValue()).toBe('4242424242424242')
    expect(await number.evaluate(security)).toBe('disc')
    // A secret never goes into a select; an expiry part may, by value or label.
    expect(await fill(i, o, 'Expiry month', { value: '4242424242424242', secret: true, target: 'input', hosts })).toMatchObject({
      ok: false,
      code: 'wrong_field_type'
    })
    expect(await fill(i, o, 'Expiry month', { value: '02', secret: false, target: 'inputOrSelect', hosts })).toEqual({
      ok: true,
      data: { filled: true }
    })
    expect(await cardFrame(i).getByLabel('Expiry month').inputValue()).toBe('02')
    expect(await fill(i, o, 'Expiry month', { value: '13', secret: false, target: 'inputOrSelect', hosts })).toMatchObject({ ok: false })
    expect(await cardFrame(i).getByLabel('Expiry month').inputValue()).toBe('02')
  })

  it('masks an expiry part in an input, and still picks it in a select', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}` })
    const o = await observe(i),
      hosts = { kind: 'card' as const, approved: [{ site: '127.0.0.1', frameSite: 'localhost' }] }
    // Not secret for the element rule (a select may take it), but masked once it is in an input.
    expect(await fill(i, o, 'Expiry', { value: '2029', secret: false, mask: true, target: 'inputOrSelect', hosts })).toEqual({
      ok: true,
      data: { filled: true }
    })
    const expiry = cardFrame(i).getByLabel('Expiry', { exact: true })
    expect(await expiry.inputValue()).toBe('2029')
    expect(await expiry.evaluate(security)).toBe('disc')
    expect(await fill(i, o, 'Expiry month', { value: '03', secret: false, mask: true, target: 'inputOrSelect', hosts })).toEqual({
      ok: true,
      data: { filled: true }
    })
    expect(await cardFrame(i).getByLabel('Expiry month').inputValue()).toBe('03')
    // A plain field without the flag stays unmasked.
    expect(await fill(i, o, 'CVC', { value: 'Bob', secret: false, target: 'any', hosts })).toEqual({ ok: true, data: { filled: true } })
    expect(await cardFrame(i).getByLabel('CVC').evaluate(security)).not.toBe('disc')
  })

  it('refuses a login on a host not in its sites', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/login` })
    const o = await observe(i)
    const refused = await fill(i, o, 'Password', { ...password, hosts: { kind: 'login', sites: ['localhost', '*.example.com'] } })
    expect(refused).toMatchObject({ ok: false, code: 'wrong_site' })
    expect(!refused.ok && refused.message).toContain('localhost, *.example.com')
    expect(await pageOf(i).getByLabel('Password').inputValue()).toBe('')
    // Both hosts must match: the page's site alone does not cover a field in a frame of another host.
    await run(i, { op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}` })
    const checkout = await observe(i)
    expect(
      await fill(i, checkout, 'CVC', { value: '123', secret: true, target: 'input', hosts: { kind: 'login', sites: ['127.0.0.1'] } })
    ).toMatchObject({ ok: false, code: 'wrong_site' })
    expect(await cardFrame(i).getByLabel('CVC').inputValue()).toBe('')
  })

  it('asks approval for a new page and frame pair', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}` })
    const o = await observe(i)
    for (const approved of [
      [],
      [
        { site: '127.0.0.1', frameSite: '127.0.0.1' },
        { site: 'localhost', frameSite: 'localhost' }
      ]
    ]) {
      expect(
        await fill(i, o, 'Card number', { value: '4242424242424242', secret: true, target: 'input', hosts: { kind: 'card', approved } })
      ).toEqual({ ok: true, data: { approve: { site: '127.0.0.1', frameSite: 'localhost' } } })
    }
    expect(await cardFrame(i).getByLabel('Card number').inputValue()).toBe('')
    // The user is never asked about a fill the element would refuse anyway.
    expect(
      await fill(i, o, 'Expiry month', { value: '4242424242424242', secret: true, target: 'input', hosts: { kind: 'card', approved: [] } })
    ).toMatchObject({ ok: false, code: 'wrong_field_type' })
  })

  it('refuses http hosts', async () => {
    const i = await launch()
    await (i as any).context.route('http://example.test/**', (route: import('playwright-core').Route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><label>Password<input type="password" aria-label="Password"></label>'
      })
    )
    expect(await run(i, { op: 'navigate', url: 'http://example.test/' })).toMatchObject({ ok: true })
    const o = await observe(i)
    expect(await fill(i, o, 'Password', { ...password, hosts: { kind: 'login', sites: ['example.test'] } })).toMatchObject({
      ok: false,
      code: 'insecure_site'
    })
    expect(await fill(i, o, 'Password', { value: 'x', secret: false, target: 'any', hosts: { kind: 'any' } })).toMatchObject({
      ok: false,
      code: 'insecure_site'
    })
    expect(await pageOf(i).getByLabel('Password').inputValue()).toBe('')
  })

  it.each(['ad frame', 'top page'] as const)('writes into the checked field only, whatever a focus thief does: %s', async (thief) => {
    const i = await launch()
    const adHtml = await (await fetch(`${site.url}/ad-frame`)).text()
    await (i as any).context.route('http://ad.test/**', (route: import('playwright-core').Route) =>
      route.fulfill({ contentType: 'text/html', body: adHtml })
    )
    const url = `${site.url}/checkout?frame=${site.hostUrl}` + (thief === 'ad frame' ? '&ad=http://ad.test' : '&grab=1')
    expect(await run(i, { op: 'navigate', url })).toMatchObject({ ok: true })
    const thiefFrame = () =>
      thief === 'ad frame'
        ? pageOf(i)
            .frames()
            .find((f) => f.url().startsWith('http://ad.test'))!
        : pageOf(i).mainFrame()
    await expect.poll(() => !!thiefFrame() && !!cardFrame(i)).toBe(true)
    await cardFrame(i).getByLabel('Card number').waitFor()
    const hosts = { kind: 'card' as const, approved: [{ site: '127.0.0.1', frameSite: 'localhost' }] }
    for (let n = 0; n < 5; n++) {
      await cardFrame(i)
        .getByLabel('Card number')
        .evaluate((el) => {
          ;(el as HTMLInputElement).value = ''
        })
      const o = await observe(i)
      expect(await fill(i, o, 'Card number', { value: '4242424242424242', secret: true, target: 'input', hosts })).toEqual({
        ok: true,
        data: { filled: true }
      })
      expect(await cardFrame(i).getByLabel('Card number').inputValue()).toBe('4242424242424242')
      expect(await thiefFrame().evaluate(() => (document.getElementById('mine') as HTMLInputElement).value)).toBe('')
    }
  })

  it('keeps a password in its field when a focus handler moves focus to a plain input', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/login-redirect` })
    const o = await observe(i)
    expect(await fill(i, o, 'Password', password)).toEqual({ ok: true, data: { filled: true } })
    expect(await pageOf(i).getByLabel('Notes').inputValue()).toBe('')
    const field = pageOf(i).getByLabel('Password')
    expect(await field.inputValue()).toBe('correct-horse')
    expect(await field.evaluate(security)).toBe('disc')
  })

  it('answers with a code-only failure when the value does not stay in the checked field', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/fields` })
    const o = await observe(i)
    const hosts = { kind: 'login' as const, sites: ['127.0.0.1'] }
    // A number input refuses text, and a page that clears the field on input leaves nothing: neither is `filled`.
    for (const [name, value] of [
      ['Amount', '07/29'],
      ['Clearing', 'correct-horse']
    ]) {
      const r = await fill(i, o, name, { value, secret: true, target: 'input', hosts })
      expect(r).toEqual({ ok: false, code: 'fill_failed', message: 'The value did not stay in this field' })
      expect(JSON.stringify(r)).not.toContain(value)
    }
    expect(await fill(i, o, 'Amount', { value: '4242424242424242', secret: true, target: 'input', hosts })).toEqual({
      ok: true,
      data: { filled: true }
    })
  })

  it('fails rather than reports a fill the page undid, morphed or replaced', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/tricky` })
    const o = await observe(i)
    const login = { secret: true, target: 'password' as const, hosts: { kind: 'login' as const, sites: ['127.0.0.1'] } }
    // An input handler that turns the password field into a plain text input.
    expect(await fill(i, o, 'Morphing password', { ...login, value: 'correct-horse' })).toMatchObject({ ok: false, code: 'fill_failed' })
    // A focus handler that swaps the field for another element: the checked one is gone.
    expect(await fill(i, o, 'Replaced password', { ...login, value: 'correct-horse' })).toMatchObject({
      ok: false,
      code: 'stale_reference'
    })
    expect(await pageOf(i).getByLabel('Replacement').inputValue()).toBe('')
    // Exact for every field but the card's own: a password the page strips of '.' and '-' is not the saved one.
    const stripped = await fill(i, o, 'Stripping password', { ...login, value: 'p.ss-word-1' })
    expect(stripped).toEqual({ ok: false, code: 'fill_failed', message: 'The value did not stay in this field' })
    // A card number a formatter spaces out is still the number; without `loose` the same is a different value.
    const card = { secret: true, target: 'input' as const, hosts: { kind: 'login' as const, sites: ['127.0.0.1'] } }
    expect(await fill(i, o, 'Formatted card', { ...card, value: '4242424242424242' })).toMatchObject({ ok: false, code: 'fill_failed' })
    expect(await fill(i, o, 'Formatted card', { ...card, value: '4242424242424242', loose: true })).toEqual({
      ok: true,
      data: { filled: true }
    })
    expect(await pageOf(i).getByLabel('Formatted card').inputValue()).toBe('4242 4242 4242 4242')
  })

  it('takes a page reformatting a non-password field as filled, but fails a password the page changed in any way', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/reformat` })
    const o = await observe(i),
      hosts = { kind: 'login' as const, sites: ['127.0.0.1'] }
    const text = { secret: false, target: 'any' as const, hosts, loose: true }
    // Case, spaces, dashes, dots, slashes and parentheses a formatter adds or changes are not a different value.
    for (const [name, value, shown, f] of [
      ['Phone', '+15551234567', '+1 (555) 123-4567', text],
      ['Holder', 'Bob Builder', 'BOB BUILDER', text],
      ['Email', 'Bob@Example.com', 'bob@example.com', text],
      ['Postcode', 'sw1a 1aa', 'SW1A 1AA', text],
      ['Code', '123456', '123 456', { secret: true, target: 'input' as const, hosts, loose: true }]
    ] as const) {
      expect(await fill(i, o, name, { ...f, value }), name).toEqual({ ok: true, data: { filled: true } })
      expect(await pageOf(i).getByLabel(name, { exact: true }).inputValue()).toBe(shown)
    }
    // A password stays exact: upper-cased or spaced out by the page, it is not the saved one.
    const login = { secret: true, target: 'password' as const, hosts }
    for (const name of ['Shouting password', 'Spacing password']) {
      const r = await fill(i, o, name, { ...login, value: 'correct-horse.1' })
      expect(r, name).toEqual({ ok: false, code: 'fill_failed', message: 'The value did not stay in this field' })
      expect(JSON.stringify(r)).not.toContain('correct-horse')
    }
  })

  it('refuses hidden fields and hidden frames, read at fill time', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/login` })
    let o = await observe(i)
    await pageOf(i)
      .getByLabel('Password')
      .evaluate((el) => {
        ;(el as HTMLElement).style.visibility = 'hidden'
      })
    expect(await fill(i, o, 'Password', password)).toMatchObject({ ok: false, code: 'wrong_field_type' })
    await run(i, { op: 'navigate', url: `${site.url}/checkout?frame=${site.hostUrl}` })
    o = await observe(i)
    const hosts = { kind: 'card' as const, approved: [{ site: '127.0.0.1', frameSite: 'localhost' }] }
    await pageOf(i)
      .locator('iframe')
      .evaluate((el) => {
        ;(el as HTMLElement).style.width = '0'
        ;(el as HTMLElement).style.height = '0'
        ;(el as HTMLElement).style.border = '0'
      })
    expect(await fill(i, o, 'Card number', { value: '4242424242424242', secret: true, target: 'input', hosts })).toMatchObject({
      ok: false,
      code: 'wrong_field_type'
    })
    expect(await cardFrame(i).getByLabel('Card number').inputValue()).toBe('')
    // The frame's host is the frame's now, not the one observed: a frame sent elsewhere loses its fields.
    await pageOf(i)
      .locator('iframe')
      .evaluate((el, url) => {
        ;(el as HTMLElement).removeAttribute('style')
        ;(el as HTMLIFrameElement).src = url + '/card-frame'
      }, site.url)
    await expect
      .poll(() =>
        pageOf(i)
          .frames()
          .some((f) => f.url() === `${site.url}/card-frame`)
      )
      .toBe(true)
    expect(await fill(i, o, 'Card number', { value: '4242424242424242', secret: true, target: 'input', hosts })).toMatchObject({
      ok: false,
      code: 'stale_reference'
    })
  })
})

describe('audit tools', () => {
  type Shot = { mimeType: string; base64: string; width: number; height: number }
  type Style = { style: Record<string, string>; rect: { x: number; y: number; width: number; height: number } }
  const pageOf = (i: BrowserInstance) => (i as any).context.pages()[0] as import('playwright-core').Page
  const refOf = (o: Observation, name: string) => o.elements.find((e) => e.name === name)!.ref
  const bytesOf = (shot: Shot) => Buffer.from(shot.base64, 'base64')
  // The fixture's font lists (browser-site.mjs /style).
  const fonts = (n: number, len: number) => Array.from({ length: n }, (_, k) => `Font${k}`.padEnd(len, 'x')).join(', ')
  const stale = { ok: false, code: 'stale_reference', message: 'Observe the page again before using this element' }

  it('saves the viewport, the whole page or one element as a PNG in CSS pixels', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    const page = data<Shot>(await run(i, { op: 'saveScreenshot', name: 'page' }))
    expect(page.mimeType).toBe('image/png')
    expect([...bytesOf(page).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    // The browser renders at 2x; the shot stays at the viewport's CSS size, as the inline screenshot does.
    expect([page.width, page.height]).toEqual([1280, 800])
    expect(pngSize(bytesOf(page))).toEqual({ width: 1280, height: 800 })
    const full = data<Shot>(await run(i, { op: 'saveScreenshot', name: 'full', fullPage: true }))
    expect(full.height).toBeGreaterThanOrEqual(1500)
    expect(pngSize(bytesOf(full))).toEqual({ width: full.width, height: full.height })
    const o = await observe(i)
    const box = data<Shot>(await run(i, { op: 'saveScreenshot', name: 'box', stamp: o.stamp, ref: refOf(o, 'Styled') }))
    const rect = await pageOf(i)
      .locator('#box')
      .evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect)
    expect([box.width, box.height]).toEqual([Math.round(rect.width), Math.round(rect.height)])
    expect([box.width, box.height]).toEqual([200, 50])
    expect(pngSize(bytesOf(box))).toEqual({ width: 200, height: 50 })
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(pngSize(Buffer.from(data<{ base64: string }>(await run(i, { op: 'screenshot' })).base64, 'base64'))).toBeNull()
  })

  it('refuses a stale element shot and takes no shot', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    const o = await observe(i)
    await i.invalidateReferences()
    expect(await run(i, { op: 'saveScreenshot', name: 'box', stamp: o.stamp, ref: refOf(o, 'Styled') })).toEqual(stale)
  })

  it('refuses a shot over 5 MiB and keeps the browser', async () => {
    // Encoding seven megabytes of noise takes longer than the suite's short command deadline.
    const i = await launch(dir, { commandMs: 20000 })
    await run(i, { op: 'navigate', url: `${site.url}/noise` })
    expect(await run(i, { op: 'saveScreenshot', name: 'noise', fullPage: true })).toEqual({
      ok: false,
      code: 'image_too_large',
      message: 'The screenshot is over 5 MiB: shoot one element or a smaller area instead'
    })
    expect(i.isClosed()).toBe(false)
    expect(data<Shot>(await run(i, { op: 'saveScreenshot', name: 'viewport' })).width).toBe(1280)
    // An element shot that is too large points inside the element, not at an element.
    const o = await observe(i)
    expect(await run(i, { op: 'saveScreenshot', name: 'canvas', stamp: o.stamp, ref: refOf(o, 'Noise') })).toEqual({
      ok: false,
      code: 'image_too_large',
      message: 'The element itself is too large: its screenshot is over 5 MiB, so shoot a smaller element inside it instead'
    })
    expect(i.isClosed()).toBe(false)
  }, 60000)

  it('refuses an element removed while its stamp is still valid, and shoots nothing', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    const o = await observe(i),
      page = pageOf(i)
    // An element shot goes through the handle, a page shot through the page: watch both.
    const probe = (await page.$('#box'))!
    const pageShot = vi.spyOn(page, 'screenshot'),
      elementShot = vi.spyOn(Object.getPrototypeOf(probe), 'screenshot')
    try {
      await page.locator('#box').evaluate((el) => el.remove())
      for (const command of [{ op: 'saveScreenshot', name: 'box' }, { op: 'computedStyle' }, { op: 'hover' }] as const) {
        expect(await run(i, { ...command, stamp: o.stamp, ref: refOf(o, 'Styled') } as BrowserCommand), command.op).toEqual(stale)
      }
      expect(pageShot).not.toHaveBeenCalled()
      expect(elementShot).not.toHaveBeenCalled()
    } finally {
      pageShot.mockRestore()
      elementShot.mockRestore()
      await probe.dispose()
    }
  })

  it('refuses an element shot of an element that never shows, within the deadline, and keeps the browser', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    const o = await observe(i)
    await pageOf(i)
      .locator('#box')
      .evaluate((el) => {
        ;(el as HTMLElement).style.visibility = 'hidden'
      })
    expect(await run(i, { op: 'saveScreenshot', name: 'box', stamp: o.stamp, ref: refOf(o, 'Styled') })).toEqual({
      ok: false,
      code: 'not_actionable',
      message: 'The element did not become visible, still and reachable in time: observe the page again'
    })
    expect(i.isClosed()).toBe(false)
    expect(data<Shot>(await run(i, { op: 'saveScreenshot', name: 'page' })).width).toBe(1280)
  })

  it('answers a hover a page dialog held past its wait as dialog_interrupted, and one answered in time as hovered', async () => {
    // A 2 s deadline gives Playwright a 1 s wait.
    const i = await launch(dir, { commandMs: 2000 })
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    const o = await observe(i),
      alert = refOf(o, 'Hover alert')
    expect(await run(i, { op: 'hover', stamp: o.stamp, ref: alert })).toEqual({ ok: true, data: { dialogPending: true } })
    expect(i.status().dialog).toMatchObject({ type: 'alert', message: 'Hover dialog' })
    // The model's answer comes after the wait ran out: the dialog, not the element, is why the hover did not finish.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(await run(i, { op: 'dialog', accept: true })).toEqual({
      ok: false,
      code: 'dialog_interrupted',
      message: 'A page dialog opened during this command and has been answered: run it again if needed.'
    })
    expect(i.isClosed()).toBe(false)
    expect(i.status().dialog).toBeNull()
    // Answered within the wait, the hover finishes and says so. The pointer leaves first, so entering opens the dialog again.
    expect(await run(i, { op: 'hover', stamp: o.stamp, ref: refOf(o, 'Hover me') })).toEqual({ ok: true, data: { hovered: true } })
    expect(await run(i, { op: 'hover', stamp: o.stamp, ref: alert })).toEqual({ ok: true, data: { dialogPending: true } })
    expect(await run(i, { op: 'dialog', accept: true })).toEqual({ ok: true, data: { hovered: true } })
  })

  it('never saves or hands back a shot a page dialog interrupted: the save gives the cue, the answer a note', async () => {
    const real = createChromiumAdapter(),
      profiles = new BrowserProfileStore(dir)
    await profiles.load()
    const profile = await profiles.ensure('agent'),
      owner = { profileId: profile.id, chatId: 'chat', turnId: 'turn' }
    let instance: BrowserInstance | undefined
    const saved: string[] = []
    const manager = new BrowserManager({
      profiles,
      adapter: { launch: async (...args) => (instance = await real.launch(...args)) },
      config: { ...config, commandMs: 4000 },
      now: Date.now,
      newId: () => 'request',
      resolveTarget: async () => ({ ...profile, agent: 'agent' }),
      onHandoff: async () => {},
      shots: {
        save: async (_chat, name, png) => {
          saved.push(name)
          return { path: `/shots/${name}.png`, bytes: png.byteLength }
        }
      }
    })
    const command = (c: BrowserCommand) => manager.run(owner, c, new AbortController().signal)
    try {
      expect(await command({ op: 'navigate', url: `${site.url}/style` })).toMatchObject({ ok: true })
      const o = data<Observation>(await command({ op: 'observe' })),
        page = pageOf(instance!)
      // Hidden, so the shot waits; the dialog is scheduled only once the shot has started, and shows the element once answered,
      // so the suspended shot then completes and its PNG is what the dialog's answer carries out of the worker.
      await page.locator('#box').evaluate((el) => {
        ;(el as HTMLElement).style.visibility = 'hidden'
      })
      const probe = (await page.$('#box'))!,
        proto = Object.getPrototypeOf(probe),
        original = proto.screenshot
      const shoot = vi.spyOn(proto, 'screenshot').mockImplementation(async function (this: unknown, ...args: unknown[]) {
        await page.evaluate(() => {
          setTimeout(() => {
            alert('Shot dialog')
            ;(document.querySelector('#box') as HTMLElement).style.visibility = 'visible'
          }, 0)
        })
        return original.apply(this, args)
      })
      try {
        expect(await command({ op: 'saveScreenshot', name: 'box', stamp: o.stamp, ref: refOf(o, 'Styled') })).toEqual({
          ok: true,
          data: { dialogPending: true }
        })
        expect(instance!.status().dialog).toMatchObject({ type: 'alert', message: 'Shot dialog' })
        const answer = await command({ op: 'dialog', accept: true })
        expect(answer).toEqual({
          ok: true,
          data: { dialogAnswered: true, note: 'A screenshot was in progress and was not saved: run browser_save_screenshot again.' }
        })
        expect(JSON.stringify(answer)).not.toContain('base64')
        expect(shoot).toHaveBeenCalledTimes(1)
        expect(saved).toEqual([])
      } finally {
        shoot.mockRestore()
        await probe.dispose()
      }
      expect(instance!.status().dialog).toBeNull()
      expect(await command({ op: 'saveScreenshot', name: 'page' })).toMatchObject({
        ok: true,
        data: { path: '/shots/page.png', name: 'page', width: 1280 }
      })
      expect(saved).toEqual(['page'])
    } finally {
      await manager.close()
    }
  })

  it("reads an element's computed style and box, each value handed over with the scrub margin", async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    const o = await observe(i)
    const box = data<Style>(await run(i, { op: 'computedStyle', stamp: o.stamp, ref: refOf(o, 'Styled') }))
    expect(Object.keys(box.style)).toEqual([...COMPUTED_STYLE_PROPS])
    expect(box.style).toMatchObject({
      'font-size': '16px',
      'background-color': 'rgb(51, 102, 153)',
      color: 'rgb(255, 255, 255)',
      'border-top-left-radius': '6px',
      'padding-left': '8px',
      'padding-top': '4px',
      width: '200px',
      height: '50px'
    })
    expect(box.rect).toEqual({ x: 40, y: 30, width: 200, height: 50 })
    // 304 characters come over whole: the server cuts to 200 only after its scrub (cutBrowserResult).
    const short = data<Style>(await run(i, { op: 'computedStyle', stamp: o.stamp, ref: refOf(o, 'Short fonts') }))
    expect(short.style['font-family']).toBe(fonts(3, 100))
    expect(short.style['font-family'].length).toBeGreaterThan(STYLE_VALUE_MAX)
    // Past the limit plus the margin, the worker cuts.
    const long = data<Style>(await run(i, { op: 'computedStyle', stamp: o.stamp, ref: refOf(o, 'Long fonts') }))
    expect(fonts(9, 1000).length).toBeGreaterThan(STYLE_VALUE_MAX + SCRUB_MARGIN)
    expect(long.style['font-family']).toBe(fonts(9, 1000).slice(0, STYLE_VALUE_MAX + SCRUB_MARGIN))
  })

  it('cuts a value the page made huge, in Node, even when the page replaced the cutting itself', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    const o = await observe(i)
    // The read runs in the page's own world: it may return any length for a property and make String.prototype.slice a no-op.
    await pageOf(i).evaluate(() => {
      const real = CSSStyleDeclaration.prototype.getPropertyValue
      CSSStyleDeclaration.prototype.getPropertyValue = function (p: string) {
        return p === 'font-family' ? 'z'.repeat(100000) : real.call(this, p)
      }
      String.prototype.slice = function (this: string) {
        return String(this)
      }
    })
    const box = data<Style>(await run(i, { op: 'computedStyle', stamp: o.stamp, ref: refOf(o, 'Styled') }))
    expect(box.style['font-family']).toBe('z'.repeat(STYLE_VALUE_MAX + SCRUB_MARGIN))
    expect(Object.keys(box.style)).toEqual([...COMPUTED_STYLE_PROPS])
  })

  it('rebuilds the page-side answer: own names only, strings only, cut here, rect numbers finite and rounded', () => {
    const long = 'a'.repeat(STYLE_VALUE_MAX + SCRUB_MARGIN + 500)
    const out = cleanStyle({
      style: { color: 'red', 'font-family': long, width: 5, display: null, height: ['1'], extra: 'x', '--secret': 'y', opacity: 'inherit' },
      rect: { x: 1.23456, y: NaN, width: Infinity, height: '9', extra: 1 }
    })
    expect(out.style).toEqual({ color: 'red', 'font-family': long.slice(0, STYLE_VALUE_MAX + SCRUB_MARGIN), opacity: 'inherit' })
    expect(out.rect).toEqual({ x: 1.23, y: 0, width: 0, height: 0 })
    for (const bad of [null, undefined, 'x', 7, []])
      expect(cleanStyle(bad)).toEqual({ style: {}, rect: { x: 0, y: 0, width: 0, height: 0 } })
    expect(cleanStyle({ style: 'color: red', rect: null })).toEqual({ style: {}, rect: { x: 0, y: 0, width: 0, height: 0 } })
  })

  it('refuses stale references for computed style and hover', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    const o = await observe(i)
    await run(i, { op: 'reload' })
    expect(await run(i, { op: 'computedStyle', stamp: o.stamp, ref: refOf(o, 'Styled') })).toEqual(stale)
    expect(await run(i, { op: 'hover', stamp: o.stamp, ref: refOf(o, 'Hover me') })).toEqual(stale)
  })

  it('hovers an element so its :hover style shows, and refuses one the pointer cannot reach without retiring the browser', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    const o = await observe(i),
      hover = refOf(o, 'Hover me')
    const background = async () => data<Style>(await run(i, { op: 'computedStyle', stamp: o.stamp, ref: hover })).style['background-color']
    expect(await background()).toBe('rgb(0, 0, 255)')
    expect(await run(i, { op: 'hover', stamp: o.stamp, ref: hover })).toEqual({ ok: true, data: { hovered: true } })
    expect(await background()).toBe('rgb(255, 0, 0)')
    // Under another element: Playwright's own wait gives up before the command deadline, so the browser stays.
    expect(await run(i, { op: 'hover', stamp: o.stamp, ref: refOf(o, 'Covered') })).toMatchObject({ ok: false, code: 'not_actionable' })
    expect(i.isClosed()).toBe(false)
    expect(await run(i, { op: 'computedStyle', stamp: o.stamp, ref: hover })).toMatchObject({ ok: true })
  })

  it('leaves setViewport to the manager', async () => {
    const i = await launch()
    await run(i, { op: 'navigate', url: `${site.url}/style` })
    expect(await run(i, { op: 'setViewport', width: 1440, height: 900 })).toMatchObject({ ok: false, code: 'unsupported' })
    expect(await pageOf(i).evaluate(() => [innerWidth, innerHeight])).toEqual([1280, 800])
  })
})

describe('fake browser audit ops', () => {
  it('answers them with canned data, records them and honours respond', async () => {
    const fake = new FakeBrowser('generation1', dir),
      signal = new AbortController().signal
    const o = data<{ stamp: BrowserStamp }>(await fake.execute({ op: 'observe' }, signal))
    const shot = data<{ mimeType: string; base64: string; width: number; height: number }>(
      await fake.execute({ op: 'saveScreenshot', name: 'page' }, signal)
    )
    expect(shot).toMatchObject({ mimeType: 'image/png', width: 1, height: 1 })
    expect(pngSize(Buffer.from(shot.base64, 'base64'))).toEqual({ width: 1, height: 1 })
    expect(await fake.execute({ op: 'saveScreenshot', name: 'element', stamp: o.stamp, ref: 'r1' }, signal)).toMatchObject({
      ok: true,
      data: { mimeType: 'image/png' }
    })
    expect(data(await fake.execute({ op: 'computedStyle', stamp: o.stamp, ref: 'r1' }, signal))).toMatchObject({
      style: { 'font-size': '16px' },
      rect: { width: 100, height: 20 }
    })
    expect(await fake.execute({ op: 'hover', stamp: o.stamp, ref: 'r1' }, signal)).toEqual({ ok: true, data: { hovered: true } })
    // A stale stamp is refused as for any element command.
    expect(await fake.execute({ op: 'hover', stamp: { ...o.stamp, observationId: 'old' }, ref: 'r1' }, signal)).toMatchObject({ ok: false })
    expect(fake.commands.map((c) => c.op)).toEqual(['observe', 'saveScreenshot', 'saveScreenshot', 'computedStyle', 'hover', 'hover'])
    fake.respond = (c) => (c.op === 'saveScreenshot' ? { ok: false, code: 'image_too_large', message: 'Too large' } : undefined)
    expect(await fake.execute({ op: 'saveScreenshot', name: 'big' }, signal)).toEqual({
      ok: false,
      code: 'image_too_large',
      message: 'Too large'
    })
    expect(fake.commands.at(-1)).toEqual({ op: 'saveScreenshot', name: 'big' })
  })
})
