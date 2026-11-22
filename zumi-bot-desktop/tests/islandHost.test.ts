import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ISLAND_PATH } from '@zumibot/shared/island'

// A stand-in for Electron: the island host's IPC handlers, its one window and the X pointer.
const fake = vi.hoisted(() => {
  type Rect = { x: number; y: number; width: number; height: number }
  class FakeWindow {
    bounds: Rect[] = []
    shapes: Rect[][] = []
    ignores: boolean[] = []
    sent: [string, unknown][] = []
    url = ''
    visible = false
    destroyed = false
    readonly webContents = {
      mainFrame: { url: '' },
      on: () => {},
      send: (channel: string, payload: unknown) => this.sent.push([channel, payload]),
      getURL: () => this.url,
      isLoading: () => false
    }
    constructor() {
      fake.windows.push(this)
    }
    setAlwaysOnTop(): void {}
    setVisibleOnAllWorkspaces(): void {}
    on(): void {}
    loadURL(url: string): Promise<void> {
      this.url = url
      this.webContents.mainFrame.url = url
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    isVisible(): boolean {
      return this.visible
    }
    showInactive(): void {
      this.visible = true
    }
    hide(): void {
      this.visible = false
    }
    destroy(): void {
      this.destroyed = true
    }
    setBounds(r: Rect): void {
      this.bounds.push(r)
    }
    setShape(r: Rect[]): void {
      this.shapes.push(r)
    }
    setIgnoreMouseEvents(ignore: boolean): void {
      this.ignores.push(ignore)
    }
  }
  return {
    FakeWindow,
    windows: [] as FakeWindow[],
    ipc: new Map<string, (...args: unknown[]) => unknown>(),
    cursor: { x: 0, y: 0 }
  }
})

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeWindow,
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => unknown) => fake.ipc.set(channel, fn),
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => fake.ipc.set(channel, fn),
    removeListener: (channel: string) => fake.ipc.delete(channel),
    removeHandler: (channel: string) => fake.ipc.delete(channel)
  },
  screen: { on: () => {}, removeListener: () => {}, getCursorScreenPoint: () => ({ ...fake.cursor }) }
}))
vi.mock('../src/main/window', () => ({ lockToOrigin: () => {} }))

const { createIslandHost } = await import('../src/main/island')
const { loadIslandPrefs, saveIslandPrefs } = await import('../src/main/islandPrefs')
const { POPUP_WIDTH, islandBounds } = await import('@zumibot/shared/islandLayout')

const origin = 'http://127.0.0.1:4318'
const area = { x: 0, y: 0, width: 1920, height: 1080 }

describe('island drag', () => {
  let dir: string
  let host: ReturnType<typeof createIslandHost>
  beforeEach(() => {
    fake.windows.length = 0
    fake.ipc.clear()
    dir = mkdtempSync(join(tmpdir(), 'island-host-'))
    const prefsFile = join(dir, 'island.json')
    saveIslandPrefs(prefsFile, { v: 1, startAtLogin: false, top: null, agents: { [origin]: ['a', 'b', 'c'] }, voiceHotkey: null })
    host = createIslandHost({
      prefsFile,
      preload: '',
      area: () => area,
      openMain: () => {},
      openAttachment: async () => false,
      quitting: () => false
    })
  })
  afterEach(() => {
    host.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const savedTop = (): number | null => loadIslandPrefs(join(dir, 'island.json')).top
  const layouts = (win: InstanceType<typeof fake.FakeWindow>) =>
    win.sent.filter(([c]) => c === 'island:layout').map(([, l]) => l as ReturnType<typeof islandBounds>['layout'])
  const shown = (open = false) => {
    host.setOrigin(origin)
    const win = fake.windows[0]!
    expect(win.url).toBe(`${origin}${ISLAND_PATH}`)
    const e = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    fake.ipc.get('island:ready')!(e)
    fake.ipc.get('island:shape')!(e, 3, open)
    expect(win.visible).toBe(true)
    return { win, send: (phase: string, screenY: number, top?: number) => fake.ipc.get('island:drag')!(e, phase, screenY, top) }
  }

  it('keeps the window still through a drag: the page slides the strip, the shell only swaps the shape and saves where it ended', () => {
    const { win, send } = shown()
    const column = islandBounds({ area, top: null, icons: 3, open: false })
    expect(win.bounds.at(-1)).toEqual(column.window)
    const moves = win.bounds.length
    fake.cursor.y = 500
    send('start', 500)
    // While the page slides the strip, its whole track takes the pointer and is drawn.
    expect(win.shapes.at(-1)).toEqual([column.layout.track])
    send('end', 600, 650)
    expect(win.bounds.length).toBe(moves)
    const ended = islandBounds({ area, top: 650, icons: 3, open: false }).layout
    expect(win.shapes.at(-1)).toEqual([ended.strip])
    expect(layouts(win).at(-1)).toEqual(ended)
    expect(savedTop()).toBe(650)
  })

  it("with the popup open the popup's column takes the drag too, since it slides along", () => {
    const { win, send } = shown(true)
    fake.cursor.y = 500
    send('start', 500)
    const { layout } = islandBounds({ area, top: null, icons: 3, open: true })
    expect(win.shapes.at(-1)).toEqual([layout.track, { x: 0, y: 0, width: POPUP_WIDTH, height: area.height }])
    send('end', 500, 100)
    const ended = islandBounds({ area, top: 100, icons: 3, open: true }).layout
    expect(win.shapes.at(-1)).toEqual([ended.strip, ended.popup])
  })

  it('an older page sending moves: the strip follows the X pointer in the layout, not the page screenY, and the window stays', () => {
    const { win, send } = shown()
    const start = islandBounds({ area, top: null, icons: 3, open: false }).top
    const moves = win.bounds.length
    fake.cursor.y = 500
    send('start', 500)
    // X11 Chromium's screenY can run a move's delta past the pointer: the shell reads the pointer itself.
    fake.cursor.y = 540
    send('move', 600)
    expect(layouts(win).at(-1)).toEqual(islandBounds({ area, top: start + 40, icons: 3, open: false }).layout)
    send('end', 600)
    expect(win.bounds.length).toBe(moves)
    expect(savedTop()).toBe(start + 40)
  })

  it('a plain click on the strip saves nothing', () => {
    const { win, send } = shown()
    const start = islandBounds({ area, top: null, icons: 3, open: false })
    fake.cursor.y = 500
    send('start', 500)
    send('end', 500)
    expect(savedTop()).toBeNull()
    expect(win.shapes.at(-1)).toEqual([start.layout.strip])
    send('start', 500)
    send('end', 500, start.layout.strip.y) // a slide that came back where it began
    expect(savedTop()).toBeNull()
  })

  it('ignores a final top that is not a finite number and falls back to the pointer', () => {
    const { send } = shown()
    const start = islandBounds({ area, top: null, icons: 3, open: false }).top
    fake.cursor.y = 500
    send('start', 500)
    fake.cursor.y = 520
    send('end', 520, Number.NaN)
    expect(savedTop()).toBe(start + 20)
  })
})

describe('island voice', () => {
  let dir: string
  let host: ReturnType<typeof createIslandHost>
  const setup = (agents: string[]) => {
    fake.windows.length = 0
    fake.ipc.clear()
    dir = mkdtempSync(join(tmpdir(), 'island-voice-'))
    const prefsFile = join(dir, 'island.json')
    saveIslandPrefs(prefsFile, { v: 1, startAtLogin: false, top: null, agents: { [origin]: agents }, voiceHotkey: null })
    host = createIslandHost({
      prefsFile,
      preload: '',
      area: () => area,
      openMain: () => {},
      openAttachment: async () => false,
      quitting: () => false
    })
    host.setOrigin(origin)
  }
  afterEach(() => {
    host.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const frame = (win: InstanceType<typeof fake.FakeWindow>) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
  const voiceSent = (win: InstanceType<typeof fake.FakeWindow>) => win.sent.filter(([c]) => c === 'island:voice').map(([, v]) => v)

  it('a press with no agent picked makes a window, and the page is told once it is ready', () => {
    setup([])
    expect(fake.windows).toHaveLength(0)
    host.voicePress()
    const win = fake.windows[0]!
    expect(win.url).toBe(`${origin}${ISLAND_PATH}`)
    expect(win.visible).toBe(false)
    expect(voiceSent(win)).toEqual([]) // the page is not there yet to hear it
    fake.ipc.get('island:ready')!(frame(win))
    expect(voiceSent(win)).toEqual([true])
    expect(win.visible).toBe(true)
    fake.ipc.get('island:shape')!(frame(win), 0, true)
    expect(win.bounds.at(-1)).toEqual(islandBounds({ area, top: null, icons: 0, open: true }).window)
    const layout = win.sent.filter(([c]) => c === 'island:layout').at(-1)![1] as ReturnType<typeof islandBounds>['layout']
    expect(layout.popup).not.toBeNull()
    expect(layout.strip.height).toBe(0)
    expect(win.shapes.at(-1)).toEqual([layout.popup])
  })

  it('a press on a ready page sends at once, and a second press asks it to stop', () => {
    setup([])
    host.voicePress()
    const win = fake.windows[0]!
    fake.ipc.get('island:ready')!(frame(win))
    host.voicePress()
    expect(voiceSent(win)).toEqual([true, false])
    expect(win.visible).toBe(true) // the page ends it, with voiceEnded
  })

  it('the page ending the talk drops a voice-only window', () => {
    setup([])
    host.voicePress()
    const win = fake.windows[0]!
    fake.ipc.get('island:ready')!(frame(win))
    fake.ipc.get('island:voiceEnded')!(frame(win))
    expect(win.destroyed).toBe(true)
    host.voicePress() // a fresh talk makes a fresh window
    expect(fake.windows).toHaveLength(2)
  })

  it('keeps the strip window when agents are picked, and never takes focus', () => {
    setup(['a', 'b'])
    const win = fake.windows[0]!
    fake.ipc.get('island:ready')!(frame(win))
    fake.ipc.get('island:shape')!(frame(win), 2, false)
    expect(win.visible).toBe(true)
    host.voicePress()
    expect(fake.windows).toHaveLength(1)
    expect(voiceSent(win)).toEqual([true])
    fake.ipc.get('island:voiceEnded')!(frame(win))
    expect(win.destroyed).toBe(false)
    expect(win.visible).toBe(true)
  })

  it('a second press with a page that never came up ends it on the spot', () => {
    setup([])
    host.voicePress()
    const win = fake.windows[0]!
    host.voicePress()
    expect(win.destroyed).toBe(true)
  })

  it('ignores a press with no server, and voiceEnded from anything but the island page', () => {
    setup([])
    host.setOrigin(null)
    host.voicePress()
    expect(fake.windows.filter((w) => !w.destroyed)).toHaveLength(0)
    host.setOrigin(origin)
    host.voicePress()
    const win = fake.windows.at(-1)!
    fake.ipc.get('island:ready')!(frame(win))
    fake.ipc.get('island:voiceEnded')!({ sender: {}, senderFrame: null })
    fake.ipc.get('island:voiceEnded')!({ sender: win.webContents, senderFrame: { url: 'http://evil.test/' } })
    expect(win.destroyed).toBe(false)
  })
})

describe('island on macOS (no setShape)', () => {
  it('ignores the mouse except over the strip, and takes it for a whole drag', () => {
    vi.useFakeTimers()
    fake.windows.length = 0
    fake.ipc.clear()
    const dir = mkdtempSync(join(tmpdir(), 'island-mac-'))
    const prefsFile = join(dir, 'island.json')
    saveIslandPrefs(prefsFile, { v: 1, startAtLogin: false, top: null, agents: { [origin]: ['a', 'b'] }, voiceHotkey: null })
    const host = createIslandHost({
      hitTest: 'cursor',
      prefsFile,
      preload: '',
      area: () => area,
      openMain: () => {},
      openAttachment: async () => false,
      quitting: () => false
    })
    try {
      fake.cursor = { x: 10, y: 10 }
      host.setOrigin(origin)
      const win = fake.windows[0]!
      const e = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
      fake.ipc.get('island:ready')!(e)
      fake.ipc.get('island:shape')!(e, 2, false)
      expect(win.shapes).toEqual([]) // never called: macOS has no setShape
      expect(win.ignores.at(-1)).toBe(true)
      const { window, layout } = islandBounds({ area, top: null, icons: 2, open: false })
      fake.cursor = { x: window.x + layout.strip.x + 2, y: window.y + layout.strip.y + 2 }
      vi.advanceTimersByTime(60)
      expect(win.ignores.at(-1)).toBe(false)
      fake.cursor = { x: window.x + 2, y: window.y + 2 } // the transparent rest, left of the strip
      vi.advanceTimersByTime(60)
      expect(win.ignores.at(-1)).toBe(true)
      fake.ipc.get('island:drag')!(e, 'start', 0)
      vi.advanceTimersByTime(60)
      expect(win.ignores.at(-1)).toBe(false)
    } finally {
      host.dispose()
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
