import { describe, expect, it } from 'vitest'
import { DESKTOP_ACTION_TOOLS, DESKTOP_LOOK_TOOLS, parseDesktopCommand, type DesktopCommand } from '@zumibot/shared/desktop'
import { INLINE_IMAGE_MAX_BYTES } from '@zumibot/shared/attachments'
import {
  boundDesktopResult,
  cuaPlan,
  desktopToolCommand,
  desktopToolResult,
  desktopTools,
  elementsOf,
  filterApps,
  filterWindows,
  shapeResult,
  type CuaPlan,
  type PlanContext
} from '../../../src/core/desktop/desktopTools'
import { desktopPrompt, desktopUnavailablePrompt } from '../../../src/core/desktop/desktopPrompt'
import type { CuaResult } from '../../../src/core/desktop/types'

const stamp = { generation: 'g1', epoch: 1, observationId: 'o1' }
const bounds = { x: 5, y: 56, width: 640, height: 480 }
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  desktop: { width: 1280, height: 800 },
  windows: new Map([[37748739, { pid: 4242, bounds }]]),
  apps: [
    { name: 'Mousepad', running: false, launchPath: 'mousepad' },
    { name: 'Calculator', running: true }
  ],
  elements: new Map([['e1', { cuaToken: 's00000001:3', frame: { x: 100, y: 200, width: 40, height: 20 } }]]),
  ...over
})
const plan = (command: DesktopCommand, c = ctx()): CuaPlan => {
  const p = cuaPlan(command, c)
  if ('error' in p) throw new Error(`unexpected plan error ${p.error.code}`)
  return p
}
const planError = (command: DesktopCommand, c = ctx()) => {
  const p = cuaPlan(command, c)
  if (!('error' in p)) throw new Error('expected a plan error')
  return p.error
}

describe('tool list', () => {
  const names = [
    'desktop_screenshot',
    'desktop_windows',
    'desktop_apps',
    'desktop_window_state',
    'desktop_zoom',
    'desktop_click',
    'desktop_drag',
    'desktop_scroll',
    'desktop_move',
    'desktop_type',
    'desktop_key',
    'desktop_launch',
    'desktop_focus',
    'desktop_request_user_action',
    'desktop_release'
  ]
  it('has exactly the 15 tools, closed schemas', () => {
    expect(desktopTools.map((t) => t.name)).toEqual(names)
    for (const t of desktopTools) {
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })
  it('every action tool requires a stamp, looking and ZumiBot tools do not', () => {
    for (const t of desktopTools) expect(t.inputSchema.required.includes('stamp')).toBe(DESKTOP_ACTION_TOOLS.includes(t.name))
    for (const n of DESKTOP_LOOK_TOOLS) expect(desktopTools.find((t) => t.name === n)?.inputSchema.required).not.toContain('stamp')
    expect(desktopTools.map((t) => t.name).filter((n) => DESKTOP_ACTION_TOOLS.includes(n))).toHaveLength(DESKTOP_ACTION_TOOLS.length)
  })
  it('descriptions say where coordinates, elements and passwords come from', () => {
    const d = (n: string) => desktopTools.find((t) => t.name === n)!.description
    expect(d('desktop_screenshot')).toMatch(/screen pixels/)
    expect(d('desktop_window_state')).toMatch(/element ids/i)
    expect(d('desktop_window_state')).toMatch(/frame values are screen pixels.*window-local/)
    expect(d('desktop_zoom')).toMatch(/pixels inside that window/)
    expect(d('desktop_click')).toMatch(/element id from desktop_window_state/)
    expect(d('desktop_type')).toMatch(/Never type passwords/)
  })
})

describe('desktopToolCommand', () => {
  it('maps a tool call to the validated command', () => {
    expect(desktopToolCommand('desktop_click', { stamp, x: 1, y: 2 })).toEqual({ op: 'click', stamp, x: 1, y: 2 })
    expect(desktopToolCommand('desktop_window_state', { windowId: 7 })).toEqual({ op: 'windowState', windowId: 7 })
    expect(desktopToolCommand('desktop_request_user_action', { reason: 'Sign in' })).toEqual({ op: 'requestUserAction', reason: 'Sign in' })
    expect(desktopToolCommand('desktop_release', {})).toEqual({ op: 'release' })
    expect(desktopToolCommand('desktop_zoom', { windowId: 3, x1: 0, y1: 0, x2: 10, y2: 10 })).toEqual({
      op: 'zoom',
      windowId: 3,
      x1: 0,
      y1: 0,
      x2: 10,
      y2: 10
    })
  })
  it('refuses unknown tools, forged ops, non-objects and invalid args', () => {
    expect(() => desktopToolCommand('desktop_eval', {})).toThrow('Invalid desktop tool')
    expect(() => desktopToolCommand('desktop_click', { op: 'screenshot', stamp, x: 1, y: 2 })).toThrow('Invalid desktop tool')
    expect(() => desktopToolCommand('desktop_click', null)).toThrow('Invalid desktop tool')
    expect(() => desktopToolCommand('desktop_click', [])).toThrow('Invalid desktop tool')
    expect(() => desktopToolCommand('desktop_click', { stamp, x: 1 })).toThrow('Invalid desktop message')
    expect(() => desktopToolCommand('desktop_screenshot', { agent: 'other' })).toThrow('Invalid desktop message')
  })
})

describe('cuaPlan', () => {
  it('screenshot is always full size, even on a wide desktop, and coordinates are real screen pixels', () => {
    const wide = ctx({
      desktop: { width: 1920, height: 1080 },
      elements: new Map([['e1', { cuaToken: 's00000001:3', frame: { x: 1700, y: 1000, width: 40, height: 20 } }]])
    })
    expect(plan({ op: 'screenshot' }).calls).toEqual([{ tool: 'get_desktop_state', args: {} }])
    expect(plan({ op: 'screenshot' }, wide).calls).toEqual([{ tool: 'get_desktop_state', args: {} }])
    expect(JSON.stringify(plan({ op: 'screenshot' }, wide))).not.toContain('max_image_dimension')
    expect(plan({ op: 'click', stamp, x: 1500, y: 900 }, wide).calls[0].args).toEqual({ scope: 'desktop', x: 1500, y: 900 })
    expect(plan({ op: 'click', stamp, x: 1919, y: 1079 }, wide).calls[0].args).toEqual({ scope: 'desktop', x: 1919, y: 1079 })
    expect(planError({ op: 'click', stamp, x: 1920, y: 5 }, wide).code).toBe('out_of_bounds')
    expect(planError({ op: 'click', stamp, x: 5, y: 1080 }, wide).code).toBe('out_of_bounds')
    expect(plan({ op: 'click', stamp, element: 'e1', button: 'right' }, wide).calls[0].args).toEqual({
      scope: 'desktop',
      x: 1720,
      y: 1010,
      button: 'right'
    })
  })
  it('windows and apps', () => {
    expect(plan({ op: 'windows' }).calls).toEqual([{ tool: 'list_windows', args: {} }])
    expect(plan({ op: 'apps' }).calls).toEqual([{ tool: 'list_apps', args: {} }])
  })
  it('windowState takes the pid from the window map and asks for elements', () => {
    expect(plan({ op: 'windowState', windowId: 37748739 }).calls).toEqual([
      { tool: 'get_window_state', args: { pid: 4242, window_id: 37748739, tree_format: 'elements' } }
    ])
    expect(planError({ op: 'windowState', windowId: 9 }).code).toBe('unknown_window')
  })
  it('zoom refreshes the window state, then zooms in window pixels', () => {
    expect(plan({ op: 'zoom', windowId: 37748739, x1: 0, y1: 430, x2: 640, y2: 480 }).calls).toEqual([
      { tool: 'get_window_state', args: { pid: 4242, window_id: 37748739, include_accessibility_tree: false } },
      { tool: 'zoom', args: { pid: 4242, window_id: 37748739, x1: 0, y1: 430, x2: 640, y2: 480 } }
    ])
    expect(planError({ op: 'zoom', windowId: 1, x1: 0, y1: 0, x2: 5, y2: 5 }).code).toBe('unknown_window')
    expect(planError({ op: 'zoom', windowId: 37748739, x1: 0, y1: 0, x2: 641, y2: 5 }).code).toBe('out_of_bounds')
    expect(planError({ op: 'zoom', windowId: 37748739, x1: 0, y1: 0, x2: 5, y2: 481 }).code).toBe('out_of_bounds')
  })
  it('click by point uses desktop scope with options', () => {
    expect(plan({ op: 'click', stamp, x: 114, y: 70 }).calls).toEqual([{ tool: 'click', args: { scope: 'desktop', x: 114, y: 70 } }])
    expect(plan({ op: 'click', stamp, x: 114.4, y: 70.6, button: 'right', count: 2, modifiers: ['shift', 'ctrl'] }).calls[0].args).toEqual({
      scope: 'desktop',
      x: 114,
      y: 71,
      button: 'right',
      count: 2,
      modifier: ['shift', 'ctrl']
    })
    expect(planError({ op: 'click', stamp, x: 1280, y: 5 }).code).toBe('out_of_bounds')
    expect(planError({ op: 'click', stamp, x: 5, y: 800 }).code).toBe('out_of_bounds')
  })
  it('click by element uses the token and retries in foreground', () => {
    expect(plan({ op: 'click', stamp, element: 'e1' }).calls).toEqual([
      {
        tool: 'click',
        args: { element_token: 's00000001:3' },
        retry: { onCode: 'background_unavailable', args: { element_token: 's00000001:3', delivery_mode: 'foreground' } }
      }
    ])
    expect(planError({ op: 'click', stamp, element: 'e9' }).code).toBe('stale')
  })
  it('click by element with options clicks the frame centre in desktop scope', () => {
    expect(plan({ op: 'click', stamp, element: 'e1', button: 'right' }).calls).toEqual([
      { tool: 'click', args: { scope: 'desktop', x: 120, y: 210, button: 'right' } }
    ])
  })
  it('default button and count are not options: the element click stays on the accessibility route', () => {
    for (const extra of [{}, { count: 1 }, { button: 'left' }, { button: 'left', count: 1 }] as const) {
      expect(plan({ op: 'click', stamp, element: 'e1', ...extra }).calls).toEqual([
        {
          tool: 'click',
          args: { element_token: 's00000001:3' },
          retry: { onCode: 'background_unavailable', args: { element_token: 's00000001:3', delivery_mode: 'foreground' } }
        }
      ])
    }
    expect(plan({ op: 'click', stamp, element: 'e1', count: 2 }).calls[0].args).toEqual({ scope: 'desktop', x: 120, y: 210, count: 2 })
    expect(plan({ op: 'click', stamp, element: 'e1', modifiers: ['ctrl'] }).calls[0].args).toEqual({
      scope: 'desktop',
      x: 120,
      y: 210,
      modifier: ['ctrl']
    })
    expect(plan({ op: 'click', stamp, element: 'e1', button: 'middle' }).calls[0].args).toEqual({
      scope: 'desktop',
      x: 120,
      y: 210,
      button: 'middle'
    })
  })
  it('drag, scroll and move use desktop scope', () => {
    expect(plan({ op: 'drag', stamp, fromX: 600, fromY: 104, toX: 420, toY: 104 }).calls).toEqual([
      { tool: 'drag', args: { scope: 'desktop', from_x: 600, from_y: 104, to_x: 420, to_y: 104 } }
    ])
    expect(plan({ op: 'scroll', stamp, x: 300, y: 300, direction: 'up', amount: 5 }).calls).toEqual([
      { tool: 'scroll', args: { scope: 'desktop', x: 300, y: 300, direction: 'up', amount: 5 } }
    ])
    expect(plan({ op: 'scroll', stamp, x: 300, y: 300, direction: 'down' }).calls[0].args).toMatchObject({ amount: 3 })
    expect(plan({ op: 'move', stamp, x: 900, y: 600 }).calls).toEqual([{ tool: 'move_cursor', args: { scope: 'desktop', x: 900, y: 600 } }])
    expect(planError({ op: 'drag', stamp, fromX: 1, fromY: 1, toX: 1500, toY: 1 }).code).toBe('out_of_bounds')
  })
  it('type is desktop scope text, byte-identical for Arabic', () => {
    const text = 'مرحبا بالعالم 😀 é'
    const calls = plan({ op: 'type', stamp, text }).calls
    expect(calls).toEqual([{ tool: 'type_text', args: { scope: 'desktop', text } }])
    expect(Buffer.from((calls[0].args as { text: string }).text).equals(Buffer.from(text))).toBe(true)
  })
  it('type into an element clicks it first and never uses type_text on the token', () => {
    const calls = plan({ op: 'type', stamp, text: 'hi', element: 'e1' }).calls
    expect(calls.map((c) => c.tool)).toEqual(['click', 'type_text'])
    expect(calls[0].retry?.onCode).toBe('background_unavailable')
    expect(calls[1].args).toEqual({ scope: 'desktop', text: 'hi' })
    expect(JSON.stringify(calls[1])).not.toContain('element_token')
    expect(planError({ op: 'type', stamp, text: 'hi', element: 'e7' }).code).toBe('stale')
  })
  it('key: one key is press_key, a combination is hotkey, names are normalised', () => {
    expect(plan({ op: 'key', stamp, keys: ['Return'] }).calls).toEqual([{ tool: 'press_key', args: { scope: 'desktop', key: 'return' } }])
    expect(plan({ op: 'key', stamp, keys: ['a'] }).calls[0].args).toEqual({ scope: 'desktop', key: 'a' })
    expect(plan({ op: 'key', stamp, keys: ['A'] }).calls[0].args).toEqual({ scope: 'desktop', key: 'a' })
    expect(plan({ op: 'key', stamp, keys: ['Ctrl', 'S'] }).calls[0].args).toEqual({ scope: 'desktop', keys: ['ctrl', 's'] })
    expect(plan({ op: 'key', stamp, keys: ['Ctrl', 's'] }).calls).toEqual([
      { tool: 'hotkey', args: { scope: 'desktop', keys: ['ctrl', 's'] } }
    ])
    expect(plan({ op: 'key', stamp, keys: ['Control', 'Esc'] }).calls[0].args).toEqual({ scope: 'desktop', keys: ['ctrl', 'escape'] })
  })
  it('launch accepts only an exact listed name', () => {
    expect(plan({ op: 'launch', stamp, name: 'Mousepad' }).calls).toEqual([{ tool: 'launch_app', args: { launch_path: 'mousepad' } }])
    expect(plan({ op: 'launch', stamp, name: 'Calculator' }).calls).toEqual([{ tool: 'launch_app', args: { name: 'Calculator' } }])
    for (const bad of ['mousepad', 'Mousepad ', 'rm -rf ~', 'Mousepad; id', ''])
      expect(planError({ op: 'launch', stamp, name: bad }).code).toBe('unknown_app')
  })
  it('focus uses the window pid', () => {
    expect(plan({ op: 'focus', stamp, windowId: 37748739 }).calls).toEqual([
      { tool: 'bring_to_front', args: { pid: 4242, window_id: 37748739 } }
    ])
    expect(planError({ op: 'focus', stamp, windowId: 5 }).code).toBe('unknown_window')
  })
  it('ZumiBot-only ops make no cua call', () => {
    expect(plan({ op: 'release' }).calls).toEqual([])
    expect(plan({ op: 'requestUserAction', reason: 'x' }).calls).toEqual([])
  })
  it('every parsed op maps without throwing', () => {
    for (const c of [{ op: 'screenshot' }, { op: 'windows' }, { op: 'apps' }, { op: 'release' }] as const)
      expect(() => cuaPlan(parseDesktopCommand(c), ctx())).not.toThrow()
  })
})

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const ok = (structuredContent: Record<string, unknown> | null, content: CuaResult['content'] = []): CuaResult => ({
  content,
  isError: false,
  structuredContent
})
const panel = {
  app_name: 'Xfce4-panel',
  bounds: { height: 3, width: 3, x: -9999, y: -9999 },
  height: 3,
  is_on_screen: true,
  pid: 4100,
  title: 'xfce4-panel',
  width: 3,
  window_id: 16777223,
  x: -9999,
  y: -9999,
  z_index: 1
}
const mousepad = {
  app_name: 'Mousepad',
  bounds,
  height: 480,
  is_on_screen: true,
  pid: 1766881,
  title: 'Untitled 1 - Mousepad',
  width: 640,
  window_id: 37748739,
  x: 5,
  y: 56,
  z_index: 3
}

describe('extractors', () => {
  it('filterWindows keeps real windows with integer ids and drops the panel dot and off-screen windows', () => {
    const out = filterWindows({
      windows: [
        panel,
        mousepad,
        { ...mousepad, window_id: 5, is_on_screen: false },
        { ...mousepad, window_id: 'x' },
        { ...mousepad, window_id: 6, bounds: { x: -700, y: 0, width: 640, height: 480 } },
        null,
        'str'
      ]
    })
    expect(out).toEqual([{ windowId: 37748739, pid: 1766881, app: 'Mousepad', title: 'Untitled 1 - Mousepad', bounds, zIndex: 3 }])
    expect(filterWindows(null)).toEqual([])
    expect(filterWindows({ windows: 'nope' })).toEqual([])
  })
  it('filterApps skips, never truncates, an over-long name or launch path', () => {
    const out = filterApps({
      apps: [
        { kind: 'desktop', name: 'n'.repeat(201), launch_path: 'ok', running: false },
        { kind: 'desktop', name: 'Long path', launch_path: 'p'.repeat(501), running: false },
        { kind: 'desktop', name: 'n'.repeat(200), launch_path: 'p'.repeat(500), running: true }
      ]
    })
    expect(out).toEqual([{ name: 'n'.repeat(200), running: true, launchPath: 'p'.repeat(500) }])
  })
  it('filterApps keeps only desktop entries and never the processes', () => {
    const out = filterApps({
      apps: [
        { kind: 'desktop', name: 'Mousepad', launch_path: 'mousepad', running: false, pid: 0 },
        { kind: 'process', name: 'systemd', pid: 1, running: true },
        { kind: 'desktop', name: 'Calculator', running: true, launch_path: null },
        { kind: 'desktop', name: '' }
      ],
      processes: [{ name: 'systemd', pid: 1 }]
    })
    expect(out).toEqual([
      { name: 'Mousepad', running: false, launchPath: 'mousepad' },
      { name: 'Calculator', running: true }
    ])
    expect(JSON.stringify(out)).not.toContain('systemd')
  })
  it('elementsOf numbers acted-on elements and reads frames in screen pixels', () => {
    const els = elementsOf({
      elements: [
        {
          actions: ['click'],
          element_token: 's00000002:0',
          frame: { h: 27, w: 39, x: 5, y: 56 },
          label: 'File',
          role: 'menu',
          screenshot_frame: { h: 27, w: 39, x: 0, y: 0 }
        },
        { element_token: 'bad-token', frame: { h: 1, w: 1, x: 0, y: 0 }, role: 'x' },
        { element_token: 's00000002:17', frame: { h: 447, w: 638, x: 6, y: 86 }, role: 'text', unlabelled: true, value: 'hello' },
        { element_token: 's00000002:18', role: 'text' }
      ]
    })
    expect(els).toEqual([
      {
        id: 'e1',
        token: 's00000002:0',
        role: 'menu',
        label: 'File',
        value: '',
        actions: ['click'],
        frame: { x: 5, y: 56, width: 39, height: 27 }
      },
      {
        id: 'e2',
        token: 's00000002:17',
        role: 'text',
        label: '',
        value: 'hello',
        actions: [],
        frame: { x: 6, y: 86, width: 638, height: 447 }
      }
    ])
  })
  it('elementsOf stops at 256', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ element_token: `s00000001:${i}`, frame: { x: 0, y: 0, w: 1, h: 1 }, role: 'x' }))
    expect(elementsOf({ elements: many })).toHaveLength(256)
  })
})

describe('shapeResult', () => {
  it('screenshot: PNG, size from the screenshot, not the screen', () => {
    const r = shapeResult({ op: 'screenshot' }, [
      ok({ screenshot_width: 1280, screenshot_height: 800, screen_width: 1920, screen_height: 1200, frame_scale: 1.5 }, [
        { type: 'image', mimeType: 'image/png', data: png },
        { type: 'text', text: '✅ Desktop screenshot 1280x800' }
      ])
    ])
    expect(r).toEqual({ ok: true, data: { image: { mimeType: 'image/png', base64: png }, width: 1280, height: 800 } })
  })
  it('screenshot without an image is an error', () => {
    expect(shapeResult({ op: 'screenshot' }, [ok({}, [{ type: 'text', text: 'x' }])])).toMatchObject({ ok: false, code: 'no_image' })
  })
  it('windows are filtered, apps lose launch paths and processes', () => {
    const windows = shapeResult({ op: 'windows' }, [ok({ windows: [panel, mousepad] })])
    expect(windows).toEqual({
      ok: true,
      data: { windows: [{ windowId: 37748739, app: 'Mousepad', title: 'Untitled 1 - Mousepad', bounds }] }
    })
    expect(JSON.stringify(windows)).not.toMatch(/pid|zIndex/)
    const apps = shapeResult({ op: 'apps' }, [
      ok({
        apps: [
          { kind: 'desktop', name: 'Mousepad', launch_path: 'mousepad', running: false },
          { kind: 'process', name: 'sshd', pid: 9 }
        ],
        processes: [{ name: 'sshd', pid: 9 }]
      })
    ])
    expect(apps).toEqual({ ok: true, data: { apps: [{ name: 'Mousepad', running: false }] } })
  })
  it('windowState has the window image and numbered elements without cua tokens', () => {
    const r = shapeResult({ op: 'windowState', windowId: 37748739 }, [
      ok(
        {
          window_title: 'Untitled 1 - Mousepad',
          screenshot_width: 640,
          screenshot_height: 480,
          elements: [
            { element_token: 's00000002:0', label: 'File', role: 'menu', actions: ['click'], frame: { x: 5, y: 56, w: 39, h: 27 } }
          ]
        },
        [
          { type: 'text', text: 'tree' },
          { type: 'image', mimeType: 'image/png', data: png }
        ]
      )
    ])
    expect(r).toEqual({
      ok: true,
      data: {
        image: { mimeType: 'image/png', base64: png },
        width: 640,
        height: 480,
        windowId: 37748739,
        title: 'Untitled 1 - Mousepad',
        elements: [{ id: 'e1', role: 'menu', label: 'File', value: '', actions: ['click'], frame: { x: 5, y: 56, width: 39, height: 27 } }]
      }
    })
    expect(JSON.stringify(r)).not.toContain('s00000002')
  })
  it('zoom takes the last output, not the window state', () => {
    const state = ok({ screenshot_width: 640 }, [{ type: 'image', mimeType: 'image/png', data: png }])
    const zoom = ok({ format: 'jpeg', width: 500, height: 47 }, [
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/AA==' },
      { type: 'text', text: 'Zoom' }
    ])
    expect(shapeResult({ op: 'zoom', windowId: 1, x1: 0, y1: 0, x2: 5, y2: 5 }, [state, zoom])).toEqual({
      ok: true,
      data: { image: { mimeType: 'image/jpeg', base64: '/9j/AA==' }, width: 500, height: 47 }
    })
  })
  it('launch returns the new window ids', () => {
    const r = shapeResult({ op: 'launch', stamp, name: 'Mousepad' }, [ok({ name: 'mousepad', pid: 1, windows: [mousepad] })])
    expect(r).toEqual({
      ok: true,
      data: { done: true, windows: [{ windowId: 37748739, app: 'Mousepad', title: 'Untitled 1 - Mousepad', bounds }] }
    })
  })
  it('actions return done and a bounded summary', () => {
    expect(
      shapeResult({ op: 'click', stamp, x: 1, y: 1 }, [
        ok({ summary: 'Sent screen-absolute click at (1,1) (desktop scope).', hint: 'use run_steps', route: 'global_input' })
      ])
    ).toEqual({ ok: true, data: { done: true, summary: 'Sent screen-absolute click at (1,1) (desktop scope).' } })
    expect(
      shapeResult({ op: 'type', stamp, text: 'a', element: 'e1' }, [
        ok({ route: 'accessibility' }),
        ok({ summary: 'Typed 1 character(s).' })
      ])
    ).toEqual({ ok: true, data: { done: true, summary: 'Typed 1 character(s).' } })
    expect(shapeResult({ op: 'release' }, [])).toEqual({ ok: true, data: {} })
  })
  it('errors map the code to our own text and never forward cua text or hints', () => {
    const failed: CuaResult = {
      content: [{ type: 'text', text: 'Background keyboard delivery needs uinput /home/user/secret' }],
      isError: true,
      structuredContent: { code: 'background_unavailable', hint: 'Xvfb/Xtigervnc cannot hot-add', detail: '/home/user/secret' }
    }
    const r = shapeResult({ op: 'key', stamp, keys: ['a'] }, [failed])
    expect(r).toEqual({ ok: false, code: 'background_unavailable', message: 'The desktop did not accept that input' })
    expect(JSON.stringify(r)).not.toMatch(/uinput|secret|Xvfb/)
    expect(shapeResult({ op: 'key', stamp, keys: ['a'] }, [{ ...failed, structuredContent: { code: 'Weird Code!' } }])).toMatchObject({
      ok: false,
      code: 'desktop_error'
    })
    expect(shapeResult({ op: 'key', stamp, keys: ['a'] }, [{ ...failed, structuredContent: null }])).toMatchObject({
      ok: false,
      code: 'desktop_error'
    })
    for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(shapeResult({ op: 'key', stamp, keys: ['a'] }, [{ ...failed, structuredContent: { code } }])).toMatchObject({
        ok: false,
        message: 'The desktop could not do that'
      })
    }
    expect(shapeResult({ op: 'key', stamp, keys: ['a'] }, [{ ...failed, structuredContent: { code: 'brand_new' } }])).toEqual({
      ok: false,
      code: 'brand_new',
      message: 'The desktop could not do that'
    })
  })
  it('a failure in the first step of a plan wins over a later output', () => {
    const failed: CuaResult = { content: [], isError: true, structuredContent: { code: 'capture_not_found' } }
    expect(shapeResult({ op: 'type', stamp, text: 'a', element: 'e1' }, [failed])).toMatchObject({ ok: false, code: 'capture_not_found' })
  })
})

describe('boundDesktopResult', () => {
  const imageResult = (base64: string, mimeType = 'image/png') => ({
    ok: true as const,
    data: { image: { mimeType, base64 }, width: 1, height: 1 }
  })
  it('passes a PNG and a JPEG', () => {
    expect(boundDesktopResult(imageResult(png))).toEqual(imageResult(png))
    expect(boundDesktopResult(imageResult('/9j/AA==', 'image/jpeg'))).toEqual(imageResult('/9j/AA==', 'image/jpeg'))
  })
  it('rejects a 6 MiB image, other MIME types and malformed base64', () => {
    const big = 'A'.repeat(Math.ceil((6 * 1024 * 1024) / 3) * 4)
    expect(boundDesktopResult(imageResult(big))).toMatchObject({ ok: false, code: 'image_limit' })
    expect(boundDesktopResult(imageResult('A'.repeat(Math.ceil(INLINE_IMAGE_MAX_BYTES / 3) * 4))).ok).toBe(true)
    expect(boundDesktopResult(imageResult(png, 'image/gif'))).toMatchObject({ ok: false, code: 'image_limit' })
    expect(boundDesktopResult(imageResult('not base64!!'))).toMatchObject({ ok: false, code: 'image_limit' })
    expect(boundDesktopResult(imageResult('QUJD='))).toMatchObject({ ok: false, code: 'image_limit' })
    expect(boundDesktopResult(imageResult('QUJDRA=='))).toMatchObject({ ok: true })
    expect(boundDesktopResult({ ok: true, data: { image: 'x' } })).toMatchObject({ ok: false, code: 'image_limit' })
  })
  it('clips failure text', () => {
    expect(boundDesktopResult({ ok: false, code: 'c'.repeat(100), message: 'm'.repeat(900) })).toEqual({
      ok: false,
      code: 'c'.repeat(64),
      message: 'm'.repeat(500)
    })
  })
  it('caps elements at 256 and keeps the stamp', () => {
    const elements = Array.from({ length: 400 }, (_, i) => ({
      id: `e${i + 1}`,
      role: 'button',
      label: 'L',
      value: '',
      actions: [],
      frame: { x: 0, y: 0, width: 1, height: 1 }
    }))
    const r = boundDesktopResult({ ok: true, data: { stamp, elements } })
    expect(r.ok && (r.data as { elements: unknown[]; stamp: unknown; truncated: boolean })).toMatchObject({ stamp, truncated: true })
    expect((r as { data: { elements: unknown[] } }).data.elements).toHaveLength(256)
  })
  it('shrinks elements to keep text under 48000 characters', () => {
    const elements = Array.from({ length: 256 }, (_, i) => ({
      id: `e${i + 1}`,
      role: 'r'.repeat(64),
      label: 'l'.repeat(200),
      value: 'v'.repeat(200),
      actions: ['click'],
      frame: { x: 0, y: 0, width: 1, height: 1 }
    }))
    const r = boundDesktopResult({ ok: true, data: { stamp, elements, windowId: 1 } })
    expect(r.ok).toBe(true)
    const data = (r as { data: { elements: unknown[]; truncated: boolean; stamp: unknown } }).data
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(48000)
    expect(data.elements.length).toBeLessThan(256)
    expect(data.truncated).toBe(true)
    expect(data.stamp).toEqual(stamp)
  })
  it('refuses data that cannot be shrunk', () => {
    expect(boundDesktopResult({ ok: true, data: { blob: 'x'.repeat(60000) } })).toMatchObject({ ok: false, code: 'output_limit' })
    expect(boundDesktopResult({ ok: true, data: 'x'.repeat(60000) })).toMatchObject({ ok: false, code: 'output_limit' })
  })
})

describe('desktopToolResult', () => {
  it('puts the text with the stamp first and the image second', () => {
    const r = desktopToolResult({ ok: true, data: { stamp, image: { mimeType: 'image/png', base64: png }, width: 1280, height: 800 } })
    expect(r.isError).toBeUndefined()
    expect(r.content).toHaveLength(2)
    expect(r.content[0].type).toBe('text')
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ stamp, width: 1280, height: 800 })
    expect(r.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: png })
    expect((r.content[0] as { text: string }).text).not.toContain(png)
  })
  it('has no image block for text results and flags errors', () => {
    expect(desktopToolResult({ ok: true, data: { apps: [{ name: 'Mousepad', running: false }] } }).content).toEqual([
      { type: 'text', text: JSON.stringify({ apps: [{ name: 'Mousepad', running: false }] }) }
    ])
    const e = desktopToolResult({ ok: false, code: 'stale', message: 'The desktop changed; take a new screenshot' })
    expect(e.isError).toBe(true)
    expect(JSON.parse((e.content[0] as { text: string }).text)).toEqual({
      ok: false,
      code: 'stale',
      message: 'The desktop changed; take a new screenshot'
    })
  })
  it('turns an oversized image into an error result', () => {
    const r = desktopToolResult({ ok: true, data: { image: { mimeType: 'image/png', base64: 'A'.repeat(7 * 1024 * 1024) } } })
    expect(r.isError).toBe(true)
    expect(JSON.parse((r.content[0] as { text: string }).text).code).toBe('image_limit')
  })
})

describe('prompts', () => {
  it('desktopPrompt covers the agent rules', () => {
    for (const re of [
      /zumibot_browser/,
      /screenshot before acting/,
      /click into a field before typing/i,
      /windowIds from desktop_windows/,
      /Never type passwords/,
      /desktop_request_user_action/,
      /desktop_release/,
      /After the user had control, look again/,
      /stale/,
      /take a new screenshot/i
    ])
      expect(desktopPrompt).toMatch(re)
  })
  it('desktopUnavailablePrompt says unavailable and no fallback', () => {
    expect(desktopUnavailablePrompt).toMatch(/unavailable/)
    expect(desktopUnavailablePrompt).toMatch(/Do not fall back to any other screen control/)
    expect(desktopUnavailablePrompt).toMatch(/Continue with the text/)
  })
})
