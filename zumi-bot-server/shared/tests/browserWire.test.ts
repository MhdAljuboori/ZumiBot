import { describe, expect, it } from 'vitest'
import * as wire from '../src/browser'

describe('browser socket boundary', () => {
  it('accepts only bounded envelopes and never client-assigned identities', () => {
    expect(wire.parseBrowserRequest({ id: 1, op: 'watch', target: { agent: 'a', chatId: 'chat' } })).toEqual({
      id: 1,
      op: 'watch',
      target: { agent: 'a', chatId: 'chat' }
    })
    for (const value of [
      { id: 1, op: 'watch', target: { agent: 'a', owner: 'fabricated' } },
      { id: 1, op: 'watch', target: { agent: 'a' }, viewerId: 'fabricated' },
      { id: -1, op: 'unwatch', watchId: 1 },
      { id: 1, op: 'unwatch', watchId: Infinity },
      { id: 1, op: 'navigate', watchId: 1, generation: 'g', tabId: 't', command: { op: 'observe' } },
      { id: 1, op: 'answer', target: { agent: 'a' }, requestId: 'r', decision: 'allow' }
    ])
      expect(() => wire.parseBrowserRequest(value)).toThrow()
  })
  it('round-trips browser-safe binary frames with explicit watch identity and bounded metadata', () => {
    const frame = { generation: 'g', tabId: 't', sequence: 2, width: 1280, height: 800, jpeg: new Uint8Array([255, 216, 255, 217]) }
    const encoded = wire.encodeBrowserFrame(3, frame)
    expect(encoded).toBeInstanceOf(Uint8Array)
    expect(wire.decodeBrowserFrame(encoded)).toEqual({ watchId: 3, ...frame })
    expect(() => wire.decodeBrowserFrame(encoded.subarray(0, 4))).toThrow()
    expect(() => wire.encodeBrowserFrame(3, { ...frame, jpeg: new Uint8Array(wire.BROWSER_JPEG_BYTES + 1) })).toThrow()
    expect(
      wire.decodeBrowserFrame(wire.encodeBrowserFrame(3, { ...frame, jpeg: new Uint8Array(wire.BROWSER_JPEG_BYTES) })).jpeg.byteLength
    ).toBe(wire.BROWSER_JPEG_BYTES)
    expect(() => wire.encodeBrowserFrame(3, { ...frame, tabId: 'x'.repeat(129) })).toThrow()
    const bad = encoded.slice()
    new DataView(bad.buffer).setUint32(0, 100000)
    expect(() => wire.decodeBrowserFrame(bad)).toThrow()
  })
  it('bounds site-controlled status metadata before sending', () => {
    const status = wire.boundBrowserStatus({
      agent: 'a',
      profileId: 'p',
      generation: 'g',
      state: 'ready',
      tabs: Array.from({ length: 40 }, () => ({ id: 't', title: 'x'.repeat(1000000), url: 'https://x.test/' + 'x'.repeat(1000000) })),
      activeTabId: 't',
      control: 'agent',
      pendingRequestId: null,
      error: null
    })
    expect(status.tabs).toHaveLength(32)
    expect(status.tabs[0].title.length).toBeLessThanOrEqual(1024)
    expect(status.tabs[0].url.length).toBeLessThanOrEqual(8192)
    expect(JSON.stringify(status).length).toBeLessThan(310000)
  })
})

it('validates dialog and chooser metadata at the worker boundary and caps uploaded opaque ids', () => {
  const state = {
    generation: 'g',
    tabs: [{ id: 't', title: 'title', url: 'about:blank' }],
    activeTabId: 't',
    dialog: { tabId: 't', type: 'prompt', message: 'message', defaultValue: '' },
    fileChooser: { tabId: 't', multiple: false }
  }
  expect(wire.parseBrowserPageState(state)).toEqual(state)
  for (const invalid of [
    { ...state, dialog: { ...state.dialog, type: 'script' } },
    { ...state, dialog: { ...state.dialog, message: 'x'.repeat(2001) } },
    { ...state, fileChooser: { tabId: 't', multiple: 'yes' } },
    { ...state, privatePath: '/etc/passwd' }
  ])
    expect(() => wire.parseBrowserPageState(invalid)).toThrow()
  expect(
    wire.parseBrowserRequest({
      id: 2,
      op: 'navigate',
      watchId: 1,
      generation: 'g',
      tabId: 't',
      command: { op: 'chooseFiles', fileIds: ['opaque'] }
    })
  ).toBeTruthy()
  expect(() => wire.parseBrowserCommand({ op: 'chooseFiles', fileIds: ['/etc/passwd'] })).toThrow()
})

it('refuses a viewer request wrapping any audit op: only the agent runs them', () => {
  const stamp = { generation: 'g', tabId: 't', observationId: 'o' }
  for (const command of [
    { op: 'saveScreenshot', name: 'x' },
    { op: 'computedStyle', stamp, ref: 'e1' },
    { op: 'hover', stamp, ref: 'e1' },
    { op: 'setViewport', width: 1440, height: 900 }
  ]) {
    expect(() => wire.parseBrowserRequest({ id: 2, op: 'navigate', watchId: 1, generation: 'g', tabId: 't', command })).toThrow()
  }
})

describe('browser viewport', () => {
  it('fits a viewer surface into the protocol bounds and a frame pixel budget', () => {
    expect(wire.fitBrowserViewport(390.7, 586.2, 3)).toEqual({ width: 390, height: 586, scale: 2 })
    expect(wire.fitBrowserViewport(600, 700, 1)).toEqual({ width: 600, height: 700, scale: 1 })
    expect(wire.fitBrowserViewport(600, 700, 1.25)).toEqual({ width: 600, height: 700, scale: 1.25 })
    // Letterboxed past the bounds; never below one device pixel per CSS pixel.
    expect(wire.fitBrowserViewport(100, 50, 0.5)).toEqual({ width: 240, height: 200, scale: 1 })
    expect(wire.fitBrowserViewport(5000, 3000, 2)).toMatchObject({ width: 1920, height: 1080 })
    expect(wire.fitBrowserViewport(NaN, Infinity, NaN)).toEqual({ width: 240, height: 200, scale: 1 })
    const big = wire.fitBrowserViewport(1920, 1080, 2)
    expect(big.scale).toBeGreaterThan(1)
    expect(big.scale).toBeLessThan(2)
    expect(big.width * big.height * big.scale ** 2).toBeLessThanOrEqual(4_000_000)
  })
  it('accepts only an already fitted viewport request', () => {
    expect(wire.parseBrowserRequest({ id: 2, op: 'viewport', watchId: 1, width: 390, height: 586, scale: 2 })).toEqual({
      id: 2,
      op: 'viewport',
      watchId: 1,
      width: 390,
      height: 586,
      scale: 2
    })
    for (const value of [
      { id: 2, op: 'viewport', watchId: 1, width: 390.5, height: 586, scale: 2 },
      { id: 2, op: 'viewport', watchId: 1, width: 100, height: 586, scale: 2 },
      { id: 2, op: 'viewport', watchId: 1, width: 390, height: 586, scale: 3 },
      { id: 2, op: 'viewport', watchId: 1, width: 1920, height: 1080, scale: 2 },
      { id: 2, op: 'viewport', watchId: 1, width: '390', height: 586, scale: 2 },
      { id: 2, op: 'viewport', watchId: 1, width: 390, height: 586, scale: 2, generation: 'g' },
      { id: 2, op: 'viewport', width: 390, height: 586, scale: 2 }
    ])
      expect(() => wire.parseBrowserRequest(value)).toThrow()
  })
  it('carries a bounded click count so a double click selects a word', () => {
    const at = { generation: 'g', tabId: 't', x: 1, y: 1, button: 'left' }
    expect(wire.parseBrowserInput({ ...at, type: 'mouseDown', clickCount: 2 })).toMatchObject({ clickCount: 2 })
    expect(wire.parseBrowserInput({ ...at, type: 'mouseUp' })).not.toHaveProperty('clickCount')
    for (const clickCount of [0, 4, 1.5, '2']) expect(() => wire.parseBrowserInput({ ...at, type: 'mouseDown', clickCount })).toThrow()
    expect(() => wire.parseBrowserInput({ generation: 'g', tabId: 't', type: 'mouseMove', x: 1, y: 1, clickCount: 2 })).toThrow()
  })
})
