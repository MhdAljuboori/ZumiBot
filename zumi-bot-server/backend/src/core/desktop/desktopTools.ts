// The pure layer under `zumibot_desktop`: tool schemas, mapping a validated command to cua-driver
// calls, shaping cua results for the agent, and output bounds. It holds no state; the manager passes
// in what it knows (PlanContext) and runs the calls. Exports:
//   desktopTools, desktopToolCommand          tool list and args -> DesktopCommand (bridge)
//   cuaPlan(command, ctx)                     command -> ordered cua calls, or a short error (manager)
//   shapeResult(command, outputs)             cua outputs -> DesktopResult; the manager adds the stamp
//   filterApps / filterWindows / elementsOf   extractors over cua `structuredContent` (manager state)
//   boundDesktopResult, desktopToolResult     output limits and the MCP result (bridge)
// Input shapes follow docs/superpowers/verification/2026-11-04-computer-use-spike.md.
import { INLINE_IMAGE_MAX_BYTES } from '@zumibot/shared/attachments'
import { parseDesktopCommand, type DesktopCommand, type DesktopResult } from '@zumibot/shared/desktop'
import type { CuaContent, CuaResult } from './types'

export type Rect = { x: number; y: number; width: number; height: number }
export interface DesktopApp {
  name: string
  running: boolean
  launchPath?: string
}
export interface DesktopWindow {
  windowId: number
  pid: number
  app: string
  title: string
  bounds: Rect
  zIndex: number
}
export interface DesktopElement {
  id: string
  token: string
  role: string
  label: string
  value: string
  actions: string[]
  frame: Rect
}

/** What the manager knows when a command arrives; keeping it an input keeps the mapping pure. */
export interface PlanContext {
  desktop: { width: number; height: number }
  windows: ReadonlyMap<number, { pid: number; bounds: Rect }>
  apps: readonly DesktopApp[]
  /** Keyed by the `e<n>` id the agent got; the cua token and screen-pixel frame of the latest observation. */
  elements: ReadonlyMap<string, { cuaToken: string; frame: Rect }>
}
export interface CuaCall {
  tool: string
  args: Record<string, unknown>
  /** On this error code, run the same call again with these args (replacing `args`). */
  retry?: { onCode: string; args: Record<string, unknown> }
}
export type CuaPlan = { calls: CuaCall[] }
export type PlanError = { error: { code: string; message: string } }

// ---- Tool list -------------------------------------------------------------------------------

const str = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength })
const stamp = {
  type: 'object',
  description: 'The stamp of the latest desktop_screenshot or desktop_window_state result.',
  properties: { generation: str(128), epoch: { type: 'integer', minimum: 0 }, observationId: str(128) },
  required: ['generation', 'epoch', 'observationId'],
  additionalProperties: false
}
const x = { type: 'integer', minimum: 0, maximum: 1919, description: 'Screen pixel x, as in the latest desktop_screenshot.' }
const y = { type: 'integer', minimum: 0, maximum: 1079, description: 'Screen pixel y, as in the latest desktop_screenshot.' }
const windowId = { type: 'integer', minimum: 1, description: 'A windowId from desktop_windows.' }
const element = { ...str(128), description: 'An element id (e1, e2, ...) from the latest desktop_window_state.' }
const modifiers = { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['ctrl', 'alt', 'shift', 'super'] } }
const point = (nx: string, ny: string, what: string) => ({
  [nx]: { ...x, description: `${what} x in screen pixels.` },
  [ny]: { ...y, description: `${what} y in screen pixels.` }
})

const definitions: [string, DesktopCommand['op'], string, Record<string, unknown>, string[]][] = [
  [
    'screenshot',
    'screenshot',
    'Capture the whole desktop as an image and get a stamp. Coordinates of the other tools are screen pixels of this image.',
    {},
    []
  ],
  ['windows', 'windows', 'List the open windows (windowId, app, title, bounds). Use these windowIds for the window tools.', {}, []],
  ['apps', 'apps', 'List the apps that can be launched, with their running state.', {}, []],
  [
    'window_state',
    'windowState',
    "Get one window's accessibility elements (ids like e1) with its image, and a stamp. Element ids stay valid until the next observation. Element frame values are screen pixels, but the returned image is window-local.",
    { windowId },
    ['windowId']
  ],
  [
    'zoom',
    'zoom',
    'Get a close-up image of a region of one window. Coordinates are pixels inside that window, not the screen.',
    {
      windowId,
      x1: { ...x, description: 'Left edge, window pixels.' },
      y1: { ...y, description: 'Top edge, window pixels.' },
      x2: { ...x, description: 'Right edge, window pixels.' },
      y2: { ...y, description: 'Bottom edge, window pixels.' }
    },
    ['windowId', 'x1', 'y1', 'x2', 'y2']
  ],
  [
    'click',
    'click',
    'Click a screen point (x, y of the latest desktop_screenshot) or an element id from desktop_window_state, not both. Click into a field before typing.',
    {
      stamp,
      ...point('x', 'y', 'Click'),
      element,
      button: { enum: ['left', 'right', 'middle'] },
      count: { enum: [1, 2], description: '2 double-clicks.' },
      modifiers
    },
    ['stamp']
  ],
  [
    'drag',
    'drag',
    'Press at one screen point and release at another.',
    { stamp, ...point('fromX', 'fromY', 'Start'), ...point('toX', 'toY', 'End') },
    ['stamp', 'fromX', 'fromY', 'toX', 'toY']
  ],
  [
    'scroll',
    'scroll',
    'Scroll at a screen point.',
    {
      stamp,
      ...point('x', 'y', 'Scroll'),
      direction: { enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 3.' }
    },
    ['stamp', 'x', 'y', 'direction']
  ],
  ['move', 'move', 'Move the pointer to a screen point (hover).', { stamp, ...point('x', 'y', 'Target') }, ['stamp', 'x', 'y']],
  [
    'type',
    'type',
    'Type text into the focused field, or into an element id (it is clicked first). Never type passwords or verification codes: use desktop_request_user_action.',
    { stamp, text: { type: 'string', maxLength: 16384 }, element },
    ['stamp', 'text']
  ],
  [
    'key',
    'key',
    'Press one key (enter, tab, escape, f5, a) or a combination (["ctrl","s"]); modifiers are ctrl, alt, shift, super.',
    { stamp, keys: { type: 'array', minItems: 1, maxItems: 5, items: str(32) } },
    ['stamp', 'keys']
  ],
  ['launch', 'launch', 'Start an app by the exact name desktop_apps gave.', { stamp, name: str(256) }, ['stamp', 'name']],
  ['focus', 'focus', 'Bring a window to the front.', { stamp, windowId }, ['stamp', 'windowId']],
  [
    'request_user_action',
    'requestUserAction',
    'Ask the user to do something on the desktop (sign-in, passwords, codes, CAPTCHA). Use a short safe reason, never credentials. It waits for Done, Cancel or expiry; do not poll.',
    { reason: str(500) },
    ['reason']
  ],
  ['release', 'release', "Release this turn's hold on the desktop after use.", {}, []]
]
export const desktopTools = definitions.map(([name, , description, properties, required]) => ({
  name: `desktop_${name}`,
  description,
  inputSchema: { type: 'object' as const, properties, required, additionalProperties: false }
}))

export function desktopToolCommand(name: string, args: unknown): DesktopCommand {
  const definition = definitions.find((d) => `desktop_${d[0]}` === name)
  if (!definition || !args || typeof args !== 'object' || Array.isArray(args) || 'op' in args) throw new Error('Invalid desktop tool')
  return parseDesktopCommand({ ...args, op: definition[1] })
}

// ---- Command -> cua calls --------------------------------------------------------------------

const fail = (code: string, message: string): PlanError => ({ error: { code, message } })
const STALE = fail('stale', 'The desktop changed; take a new screenshot')
const round = Math.round
const KEY_ALIASES: Record<string, string> = { control: 'ctrl', esc: 'escape', meta: 'super', win: 'super', cmd: 'super' }
// cua names keys in lower case, single characters included: capitals are typed with desktop_type or shift.
const keyName = (k: string): string => KEY_ALIASES[k.toLowerCase()] ?? k.toLowerCase()
const centre = (f: Rect) => ({ x: round(f.x + f.width / 2), y: round(f.y + f.height / 2) })

export function cuaPlan(command: DesktopCommand, ctx: PlanContext): CuaPlan | PlanError {
  const inside = (px: number, py: number) => px >= 0 && py >= 0 && px < ctx.desktop.width && py < ctx.desktop.height
  const outside = () => fail('out_of_bounds', `Point is outside the ${ctx.desktop.width}x${ctx.desktop.height} screen`)
  const window = (id: number) => ctx.windows.get(id)
  const desktop = (args: Record<string, unknown>) => ({ scope: 'desktop', ...args })
  const plan = (tool: string, args: Record<string, unknown>): CuaPlan => ({ calls: [{ tool, args }] })
  switch (command.op) {
    case 'screenshot':
      // Always full size, never `max_image_dimension`: it makes cua's frame scale sticky, so the agent's
      // coordinates, element frames and ctx.desktop would stop sharing one pixel space.
      return plan('get_desktop_state', {})
    case 'windows':
      return plan('list_windows', {})
    case 'apps':
      return plan('list_apps', {})
    case 'windowState': {
      const w = window(command.windowId)
      return w
        ? plan('get_window_state', { pid: w.pid, window_id: command.windowId, tree_format: 'elements' })
        : fail('unknown_window', 'Unknown window; call desktop_windows')
    }
    case 'zoom': {
      const w = window(command.windowId)
      if (!w) return fail('unknown_window', 'Unknown window; call desktop_windows')
      if (command.x2 > w.bounds.width || command.y2 > w.bounds.height)
        return fail('out_of_bounds', `Region is outside the ${w.bounds.width}x${w.bounds.height} window`)
      // zoom crops that window's own capture, so one must exist.
      return {
        calls: [
          { tool: 'get_window_state', args: { pid: w.pid, window_id: command.windowId, include_accessibility_tree: false } },
          {
            tool: 'zoom',
            args: {
              pid: w.pid,
              window_id: command.windowId,
              x1: round(command.x1),
              y1: round(command.y1),
              x2: round(command.x2),
              y2: round(command.y2)
            }
          }
        ]
      }
    }
    case 'click': {
      // Left button, a single click and no modifiers are the defaults, not options.
      const options = {
        ...(command.button && command.button !== 'left' ? { button: command.button } : {}),
        ...(command.count && command.count > 1 ? { count: command.count } : {}),
        ...(command.modifiers?.length ? { modifier: command.modifiers } : {})
      }
      if (command.element !== undefined) {
        const e = ctx.elements.get(command.element)
        if (!e) return STALE
        // The element click tool takes no button, count or modifiers: use the element's centre instead.
        if (Object.keys(options).length) {
          const c = centre(e.frame)
          return inside(c.x, c.y) ? plan('click', desktop({ x: c.x, y: c.y, ...options })) : outside()
        }
        return { calls: [elementClick(e.cuaToken)] }
      }
      const px = round(command.x!),
        py = round(command.y!)
      return inside(px, py) ? plan('click', desktop({ x: px, y: py, ...options })) : outside()
    }
    case 'drag': {
      const [fx, fy, tx, ty] = [command.fromX, command.fromY, command.toX, command.toY].map(round)
      return inside(fx, fy) && inside(tx, ty) ? plan('drag', desktop({ from_x: fx, from_y: fy, to_x: tx, to_y: ty })) : outside()
    }
    case 'scroll': {
      const px = round(command.x),
        py = round(command.y)
      return inside(px, py)
        ? plan('scroll', desktop({ x: px, y: py, direction: command.direction, amount: command.amount ?? 3 }))
        : outside()
    }
    case 'move': {
      const px = round(command.x),
        py = round(command.y)
      return inside(px, py) ? plan('move_cursor', desktop({ x: px, y: py })) : outside()
    }
    case 'type': {
      // Never `type_text {element_token}`: that route truncates multibyte text yet reports success.
      const typing: CuaCall = { tool: 'type_text', args: desktop({ text: command.text }) }
      if (command.element === undefined) return { calls: [typing] }
      const e = ctx.elements.get(command.element)
      return e ? { calls: [elementClick(e.cuaToken), typing] } : STALE
    }
    case 'key': {
      const keys = command.keys.map(keyName)
      return keys.length === 1 ? plan('press_key', desktop({ key: keys[0] })) : plan('hotkey', desktop({ keys }))
    }
    case 'launch': {
      // Only an exact entry of the filtered list: `name` is tried as a command and `launch_path` goes through a shell.
      const app = ctx.apps.find((a) => a.name === command.name)
      if (!app) return fail('unknown_app', 'Unknown app; use a name from desktop_apps')
      return plan('launch_app', app.launchPath ? { launch_path: app.launchPath } : { name: app.name })
    }
    case 'focus': {
      const w = window(command.windowId)
      return w
        ? plan('bring_to_front', { pid: w.pid, window_id: command.windowId })
        : fail('unknown_window', 'Unknown window; call desktop_windows')
    }
    // Answered by the manager itself; nothing reaches cua.
    case 'requestUserAction':
    case 'release':
      return { calls: [] }
  }
}

function elementClick(cuaToken: string): CuaCall {
  // Elements without an accessibility action need a real pointer click, which only foreground delivery gives.
  return {
    tool: 'click',
    args: { element_token: cuaToken },
    retry: { onCode: 'background_unavailable', args: { element_token: cuaToken, delivery_mode: 'foreground' } }
  }
}

// ---- cua structuredContent extractors --------------------------------------------------------

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObject) : [])
const MAX_ELEMENTS = 256,
  MAX_APPS = 300
export const MAX_WINDOWS = 100

/**
 * Only desktop entries; the raw `processes` array and `kind:"process"` rows list the host and never leave here.
 * An over-long name or launch path skips the entry: cutting either would name a different app or command.
 */
export function filterApps(structured: Json | null): DesktopApp[] {
  const apps: DesktopApp[] = []
  for (const a of list(structured?.apps)) {
    if (a.kind !== 'desktop' || typeof a.name !== 'string' || !a.name) continue
    if (a.name.length > 200 || (typeof a.launch_path === 'string' && a.launch_path.length > 500)) continue
    const launchPath = typeof a.launch_path === 'string' ? a.launch_path : ''
    apps.push({ name: a.name, running: a.running === true, ...(launchPath ? { launchPath } : {}) })
    if (apps.length >= MAX_APPS) break
  }
  return apps
}

const rect = (v: unknown): Rect | null => {
  if (!isObject(v) || !finite(v.x) || !finite(v.y)) return null
  const width = v.width ?? v.w,
    height = v.height ?? v.h
  return finite(width) && finite(height) ? { x: v.x, y: v.y, width, height } : null
}

/** Real windows only: the panel's 3x3 window at (-9999, -9999) and anything off screen are dropped. */
export function filterWindows(structured: Json | null): DesktopWindow[] {
  const windows: DesktopWindow[] = []
  for (const w of list(structured?.windows)) {
    const bounds = rect(w.bounds)
    if (!bounds || !Number.isSafeInteger(w.window_id) || (w.window_id as number) < 1 || !Number.isSafeInteger(w.pid)) continue
    if (w.is_on_screen === false || bounds.width < 8 || bounds.height < 8 || bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0)
      continue
    windows.push({
      windowId: w.window_id as number,
      pid: w.pid as number,
      app: text(w.app_name, 100),
      title: text(w.title, 300),
      bounds,
      zIndex: finite(w.z_index) ? w.z_index : 0
    })
    if (windows.length >= MAX_WINDOWS) break
  }
  return windows
}

const TOKEN = /^s[0-9a-f]{8}:[0-9]+$/
/** Elements that can be acted on, numbered `e1…`; `frame` is in screen pixels, `token` is cua's own. */
export function elementsOf(structured: Json | null): DesktopElement[] {
  const elements: DesktopElement[] = []
  for (const e of list(structured?.elements)) {
    const frame = rect(e.frame)
    if (typeof e.element_token !== 'string' || !TOKEN.test(e.element_token) || !frame) continue
    elements.push({
      id: `e${elements.length + 1}`,
      token: e.element_token,
      role: text(e.role, 64),
      label: text(e.label, 200),
      value: text(e.value, 200),
      actions: Array.isArray(e.actions)
        ? e.actions
            .filter((a): a is string => typeof a === 'string')
            .slice(0, 8)
            .map((a) => a.slice(0, 32))
        : [],
      frame
    })
    if (elements.length >= MAX_ELEMENTS) break
  }
  return elements
}

// ---- Result shaping --------------------------------------------------------------------------

const ERROR_TEXT: Readonly<Record<string, string>> = {
  background_unavailable: 'The desktop did not accept that input',
  screenshot_context_missing: 'Take a fresh window state first',
  capture_not_found: 'The desktop changed; take a new screenshot',
  invalid_action_target: 'That action does not work on this target',
  invalid_element_token: 'The element is stale; call desktop_window_state again',
  element_not_found: 'The element is stale; call desktop_window_state again',
  invalid_arguments: 'The desktop refused those arguments'
}
const SAFE_CODE = /^[a-z0-9_]{1,64}$/

/** cua's own text and hints are never forwarded: only a known code gets a fixed sentence. */
function failure(out: CuaResult): DesktopResult {
  const raw = out.structuredContent?.code
  const code = typeof raw === 'string' && SAFE_CODE.test(raw) ? raw : 'desktop_error'
  return { ok: false, code, message: Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code] : 'The desktop could not do that' }
}
const imageOf = (out: CuaResult): Extract<CuaContent, { type: 'image' }> | undefined =>
  out.content.find((c): c is Extract<CuaContent, { type: 'image' }> => c.type === 'image')
const agentWindow = ({ windowId, app, title, bounds }: DesktopWindow) => ({ windowId, app, title, bounds })
const dimension = (v: unknown): number | undefined => (finite(v) && v > 0 ? Math.round(v) : undefined)

/**
 * `outputs` are the results of the plan's calls, in order, up to and including the first failure.
 * The manager adds the stamp to observation data (screenshot, windowState).
 */
export function shapeResult(command: DesktopCommand, outputs: CuaResult[]): DesktopResult {
  const failed = outputs.find((o) => o.isError)
  if (failed) return failure(failed)
  const last = outputs[outputs.length - 1]
  if (!last) return { ok: true, data: {} }
  const s = last.structuredContent
  const withImage = (out: CuaResult, width: unknown, height: unknown): Json | null => {
    const image = imageOf(out)
    return image
      ? {
          image: { mimeType: image.mimeType, base64: image.data },
          ...(dimension(width) ? { width: dimension(width) } : {}),
          ...(dimension(height) ? { height: dimension(height) } : {})
        }
      : null
  }
  switch (command.op) {
    case 'screenshot': {
      const data = withImage(last, s?.screenshot_width ?? s?.screen_width, s?.screenshot_height ?? s?.screen_height)
      return data ? { ok: true, data } : { ok: false, code: 'no_image', message: 'The desktop returned no image' }
    }
    case 'zoom': {
      const data = withImage(last, s?.width, s?.height)
      return data ? { ok: true, data } : { ok: false, code: 'no_image', message: 'The desktop returned no image' }
    }
    // pid and z-order are host details the manager keeps in its own window map.
    case 'windows':
      return { ok: true, data: { windows: filterWindows(s).map(agentWindow) } }
    // The launch path stays server-side: the agent only needs names.
    case 'apps':
      return { ok: true, data: { apps: filterApps(s).map(({ name, running }) => ({ name, running })) } }
    case 'windowState': {
      const data = withImage(last, s?.screenshot_width, s?.screenshot_height) ?? {}
      return {
        ok: true,
        data: {
          ...data,
          windowId: command.windowId,
          title: text(s?.window_title, 300),
          elements: elementsOf(s).map(({ id, role, label, value, actions, frame }) => ({ id, role, label, value, actions, frame }))
        }
      }
    }
    case 'launch':
      return { ok: true, data: { done: true, windows: filterWindows(s).map(agentWindow) } }
    default:
      return { ok: true, data: { done: true, ...(typeof s?.summary === 'string' ? { summary: s.summary.slice(0, 200) } : {}) } }
  }
}

// ---- Bounds and the MCP result ---------------------------------------------------------------

const textLimit = 48000
const imageLimit = Math.ceil(INLINE_IMAGE_MAX_BYTES / 3) * 4
const clip = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
const boundedFrame = (v: unknown): Rect => rect(v) ?? { x: 0, y: 0, width: 0, height: 0 }
const boundedElement = (raw: unknown) => {
  const e = isObject(raw) ? raw : {}
  return {
    id: clip(e.id, 16),
    role: clip(e.role, 64),
    label: clip(e.label, 200),
    value: clip(e.value, 200),
    actions: Array.isArray(e.actions)
      ? e.actions
          .filter((a): a is string => typeof a === 'string')
          .slice(0, 8)
          .map((a) => a.slice(0, 32))
      : [],
    frame: boundedFrame(e.frame)
  }
}
const imageFailure = (): DesktopResult => ({ ok: false, code: 'image_limit', message: 'Desktop image is unavailable or too large' })

/** Text under 48000 characters, the image under the inline limit, lists capped; elements are cut last-first. */
export function boundDesktopResult(result: DesktopResult): DesktopResult {
  if (!result.ok) return { ok: false, code: clip(result.code, 64), message: clip(result.message, 500) }
  const data = result.data
  if (!isObject(data)) {
    try {
      if (JSON.stringify(result).length <= textLimit) return result
    } catch {
      /* Keep serialization errors private. */
    }
    return { ok: false, code: 'output_limit', message: 'Desktop output exceeded the tool limit; take a fresh screenshot' }
  }
  const { image, ...rest } = data
  let kept: Json = rest
  if (image !== undefined) {
    if (
      !isObject(image) ||
      (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') ||
      typeof image.base64 !== 'string' ||
      image.base64.length > imageLimit ||
      image.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64)
    )
      return imageFailure()
  }
  if (Array.isArray(rest.windows)) kept = { ...kept, windows: rest.windows.slice(0, MAX_WINDOWS) }
  if (Array.isArray(rest.apps)) kept = { ...kept, apps: rest.apps.slice(0, MAX_APPS) }
  let truncated =
    rest.truncated === true ||
    (Array.isArray(rest.windows) && rest.windows.length > MAX_WINDOWS) ||
    (Array.isArray(rest.apps) && rest.apps.length > MAX_APPS)
  let elements: ReturnType<typeof boundedElement>[] | null = null
  if (Array.isArray(rest.elements)) {
    truncated ||= rest.elements.length > MAX_ELEMENTS
    elements = rest.elements.slice(0, MAX_ELEMENTS).map(boundedElement)
  }
  const build = (): Json => ({ ...kept, ...(elements ? { elements } : {}), ...(truncated ? { truncated: true } : {}) })
  const size = (): number => {
    try {
      return JSON.stringify(build()).length
    } catch {
      return Infinity
    }
  }
  while (elements?.length && size() > textLimit) {
    elements = elements.slice(0, Math.floor(elements.length * 0.8))
    truncated = true
  }
  if (size() > textLimit)
    return { ok: false, code: 'output_limit', message: 'Desktop output exceeded the tool limit; take a fresh screenshot' }
  return { ok: true, data: { ...build(), ...(image !== undefined ? { image } : {}) } }
}

/** Observation text first (stamp, elements, sizes), then the image, so a client that shows only text still gets the stamp. */
export function desktopToolResult(result: DesktopResult): { content: CuaContent[]; isError?: boolean } {
  const bounded = boundDesktopResult(result)
  if (!bounded.ok)
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, code: bounded.code, message: bounded.message }) }], isError: true }
  const { image, ...rest } = (isObject(bounded.data) ? bounded.data : { value: bounded.data }) as Json
  const content: CuaContent[] = [{ type: 'text', text: JSON.stringify(rest) }]
  if (isObject(image)) content.push({ type: 'image', mimeType: image.mimeType as string, data: image.base64 as string })
  return { content }
}
