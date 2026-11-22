import { INLINE_IMAGE_MAX_BYTES } from '@zumibot/shared/attachments'
// The parser's own bounds, so the schema the model reads never drifts from what is refused.
import { BROWSER_VIEWPORT_MAX as VMAX, BROWSER_VIEWPORT_MIN as VMIN, SHOT_NAME_RE, parseBrowserCommand } from '@zumibot/shared/browser'
import { FILL_FIELD_LABELS } from '@zumibot/shared/vault'
import type { BrowserCommand, BrowserResult } from './types'
import { BROWSER_CUTS as CUT, SCRUB_MARGIN, SECRET_MAX, describedCost, pageTextCap } from './browserLimits'
import { COMPUTED_STYLE_PROPS } from './browserStyle'
import type { ScrubbedString } from '../vault/scrub'

const str = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength })
const stamp = {
  type: 'object',
  properties: { generation: str(128), tabId: str(128), observationId: str(128) },
  required: ['generation', 'tabId', 'observationId'],
  additionalProperties: false
}
const definitions: [string, BrowserCommand['op'], string, Record<string, unknown>, string[]][] = [
  ['navigate', 'navigate', 'Navigate to an HTTP(S) URL.', { url: str(8192) }, ['url']],
  ['back', 'back', 'Go back.', {}, []],
  ['forward', 'forward', 'Go forward.', {}, []],
  ['reload', 'reload', 'Reload the active tab.', {}, []],
  ['tabs', 'tabs', 'List tabs.', {}, []],
  ['new_tab', 'newTab', 'Create a tab.', { url: str(8192) }, []],
  ['select_tab', 'selectTab', 'Select a tab.', { tabId: str(128) }, ['tabId']],
  ['close_tab', 'closeTab', 'Close a tab.', { tabId: str(128) }, ['tabId']],
  ['observe', 'observe', 'Get fresh page text, stamp, and actionable references. Replaces prior refs.', {}, []],
  ['screenshot', 'screenshot', 'Explicitly capture the active page as an image.', {}, []],
  ['click', 'click', 'Click a reference from the latest observation.', { stamp, ref: str(128) }, ['stamp', 'ref']],
  [
    'type',
    'type',
    'Fill a reference. Never pass passwords or verification codes.',
    { stamp, ref: str(128), text: { type: 'string', maxLength: 16384 } },
    ['stamp', 'ref', 'text']
  ],
  [
    'select',
    'select',
    'Choose options of a select (combobox) reference by option value or label; one value unless it allows multiple.',
    { stamp, ref: str(128), values: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', maxLength: 1024 } } },
    ['stamp', 'ref', 'values']
  ],
  [
    'scroll',
    'scroll',
    'Scroll the active page.',
    { deltaX: { type: 'number', minimum: -10000, maximum: 10000 }, deltaY: { type: 'number', minimum: -10000, maximum: 10000 } },
    ['deltaX', 'deltaY']
  ],
  [
    'dialog',
    'dialog',
    'Answer a pending page dialog.',
    { accept: { type: 'boolean' }, text: { type: 'string', maxLength: 16384 } },
    ['accept']
  ],
  [
    'upload',
    'upload',
    'Upload only opaque attachment IDs explicitly attached in this chat.',
    { stamp, ref: str(128), fileIds: { type: 'array', minItems: 1, maxItems: 10, items: str(128) } },
    ['stamp', 'ref', 'fileIds']
  ],
  [
    'fill_from_vault',
    'fillVault',
    'Fill a reference from the latest observation with a field of a vault item listed by vault_items (its id). ZumiBot types the value itself; you never see it. A card on a new site waits for the user to allow it.',
    { stamp, ref: str(128), item: str(128), field: { type: 'string', enum: Object.keys(FILL_FIELD_LABELS) } },
    ['stamp', 'ref', 'item', 'field']
  ],
  [
    'save_screenshot',
    'saveScreenshot',
    'Save a screenshot as a PNG file and get its file path; attach that file, never paste it as a link. Name it with lowercase letters, digits, - and _. With stamp and ref it shoots that element; otherwise the viewport, or the whole page with fullPage (omit fullPage when you pass a ref).',
    { name: { type: 'string', pattern: SHOT_NAME_RE.source, maxLength: 64 }, stamp, ref: str(128), fullPage: { type: 'boolean' } },
    ['name']
  ],
  [
    'computed_style',
    'computedStyle',
    'Read a fixed set of 40 computed style properties (colors, fonts, spacing, borders, radius, shadow, size) of a reference from the latest observation, plus its rect in CSS pixels, relative to the element’s own frame.',
    { stamp, ref: str(128) },
    ['stamp', 'ref']
  ],
  [
    'hover',
    'hover',
    'Move the pointer over a reference from the latest observation, to see or measure a hover state; then shoot or measure with the same stamp and ref.',
    { stamp, ref: str(128) },
    ['stamp', 'ref']
  ],
  [
    'set_viewport',
    'setViewport',
    `Resize the page viewport to width and height in CSS pixels, from ${VMIN.width}x${VMIN.height} up to ${VMAX.width}x${VMAX.height}. Layout changes, so observe again afterwards.`,
    {
      width: { type: 'integer', minimum: VMIN.width, maximum: VMAX.width },
      height: { type: 'integer', minimum: VMIN.height, maximum: VMAX.height }
    },
    ['width', 'height']
  ],
  [
    'request_user_action',
    'requestUserAction',
    'Wait for user help in the app browser. Use a safe reason, never credentials.',
    { reason: str(500) },
    ['reason']
  ],
  ['release', 'release', 'Release this turn’s browser lease after use.', {}, []]
]
export const browserTools = definitions.map(([name, , description, properties, required]) => ({
  name: `browser_${name}`,
  description,
  inputSchema: { type: 'object' as const, properties, required, additionalProperties: false }
}))
export function browserToolCommand(name: string, args: unknown): BrowserCommand {
  const definition = definitions.find((d) => `browser_${d[0]}` === name)
  if (!definition || !args || typeof args !== 'object' || Array.isArray(args) || 'op' in args) throw new Error('Invalid browser tool')
  return parseBrowserCommand({ ...args, op: definition[1] })
}
type Loose = Record<string, unknown>
// What the replacements took out is rounded up to this before it moves a cut: the exact count would tell, by the cut's length,
// how long a secret was hidden. Rounding up only cuts shorter, so it never shows more.
const REMOVED_STEP = 256
const stepped = (removed: number): number => Math.ceil(removed / REMOVED_STEP) * REMOVED_STEP
/**
 * Page strings to the lengths an agent gets, run after the vault scrub: the worker hands them over longer, so no cut ever
 * leaves part of a secret. Lengths only; it never looks at what a string says. A string as long as the worker's own cut for it
 * may still end in the start of a secret, so what lies within SECRET_MAX - 1 characters of that cut is never shown, counted
 * after the scrub (`trace`: each changed string's length before it and the characters its replacements took out, which pull
 * that cut closer, in steps of REMOVED_STEP). Only whole secrets' replacements count, and the markers show those anyway.
 */
export function cutBrowserResult(result: BrowserResult, trace?: ReadonlyMap<string, ScrubbedString>): BrowserResult {
  if (!result.ok || !result.data || typeof result.data !== 'object') return result
  const data = result.data as Loose
  const before = (path: string, v: string): ScrubbedString => trace?.get(path) ?? { raw: v.length, removed: 0 }
  const keep = (v: unknown, path: string, limit: number, cap: number): unknown => {
    if (typeof v !== 'string') return v
    const { raw, removed } = before(path, v)
    return v.slice(0, raw >= cap ? Math.max(0, Math.min(limit, cap - (SECRET_MAX - 1) - stepped(removed))) : limit)
  }
  const margin = (limit: number) => limit + SCRUB_MARGIN
  if (typeof data.text === 'string' && data.stamp && Array.isArray(data.elements)) {
    let used = 0,
      sent = 0
    const elements = data.elements.map((raw, i) => {
      if (!raw || typeof raw !== 'object') return raw
      const e = raw as Loose,
        at = `data/elements/${i}`
      const length = (key: 'role' | 'name' | 'text') => (typeof e[key] === 'string' ? before(`${at}/${key}`, e[key] as string).raw : 0)
      // What the worker counted, from the strings as it sent them: that set where it cut the page text.
      sent += describedCost({ role: length('role'), name: length('name'), text: length('text') })
      const out = {
        ...e,
        role: keep(e.role, `${at}/role`, CUT.role, margin(CUT.role)),
        name: keep(e.name, `${at}/name`, CUT.name, margin(CUT.name)),
        text: keep(e.text, `${at}/text`, CUT.text, margin(CUT.text))
      }
      for (const v of [out.role, out.name, out.text]) if (typeof v === 'string') used += v.length
      return out
    })
    // The page text gets what the descriptions left, as the observation's own budget gave it.
    return {
      ok: true,
      data: { ...data, elements, text: keep(data.text, 'data/text', Math.max(0, CUT.pageText - used), pageTextCap(sent)) }
    }
  }
  // The style a page's computed values come from: every key and type is checked, since a page decides what the worker returns.
  if (Object.hasOwn(data, 'style')) {
    const raw = data.style && typeof data.style === 'object' && !Array.isArray(data.style) ? (data.style as Loose) : {}
    const style: Record<string, string> = {}
    for (const name of COMPUTED_STYLE_PROPS.slice(0, CUT.styleProps)) {
      const v = Object.hasOwn(raw, name) ? raw[name] : undefined
      if (typeof v === 'string') style[name] = keep(v, `data/style/${name}`, CUT.styleValue, margin(CUT.styleValue)) as string
    }
    const r = data.rect && typeof data.rect === 'object' ? (data.rect as Loose) : {}
    const num = (k: string) => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? r[k] : 0)
    return { ok: true, data: { style, rect: { x: num('x'), y: num('y'), width: num('width'), height: num('height') } } }
  }
  if (Array.isArray(data.tabs)) {
    const tabs = data.tabs.map((raw, i) => {
      if (!raw || typeof raw !== 'object') return raw
      const t = raw as Loose
      return {
        ...t,
        title: keep(t.title, `data/tabs/${i}/title`, CUT.title, margin(CUT.title)),
        url: keep(t.url, `data/tabs/${i}/url`, CUT.url, margin(CUT.url))
      }
    })
    const d = data.dialog as Loose | null | undefined
    return {
      ok: true,
      data: {
        ...data,
        tabs,
        ...(d && typeof d === 'object'
          ? {
              dialog: {
                ...d,
                message: keep(d.message, 'data/dialog/message', CUT.dialog, margin(CUT.dialog)),
                defaultValue: keep(d.defaultValue, 'data/dialog/defaultValue', CUT.dialog, margin(CUT.dialog))
              }
            }
          : {})
      }
    }
  }
  return result
}
const textLimit = 48000
const imageLimit = Math.ceil(INLINE_IMAGE_MAX_BYTES / 3) * 4
function boundedString(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}
// What an observation's elements may take of the result, in JSON characters, and the share child-frame elements get ahead of the
// main frame's tail: as many elements as the observation itself keeps back for them (browserObservation.ts), and their 4 096
// characters with room for refs, frame labels and escaping. A hostile iframe can take no more of the first-party page than that.
const ELEMENTS_JSON = 24000
const FRAMED_KEPT = 32
const FRAMED_JSON = 8192
/** Bound serialized text, preserving stamp and useful refs before page prose. */
export function boundBrowserResult(result: BrowserResult): BrowserResult {
  if (!result.ok) return { ok: false, code: boundedString(result.code, 64), message: boundedString(result.message, 500) }
  const data = result.data as Record<string, unknown> | null
  if (data && data.mimeType !== undefined) {
    if (
      data.mimeType !== 'image/jpeg' ||
      typeof data.base64 !== 'string' ||
      data.base64.length > imageLimit ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)
    )
      return { ok: false, code: 'image_limit', message: 'Browser image is unavailable or too large' }
    return { ok: true, data: { mimeType: 'image/jpeg', base64: data.base64 } }
  }
  if (data && typeof data.text === 'string' && data.stamp && Array.isArray(data.elements)) {
    const stampData = data.stamp as Record<string, unknown>
    const observation = {
      stamp: {
        generation: boundedString(stampData.generation, 128),
        tabId: boundedString(stampData.tabId, 128),
        observationId: boundedString(stampData.observationId, 128)
      },
      elements: [] as { ref: string; role: string; name: string; text: string; frame?: string }[],
      text: '',
      truncated: false
    }
    const candidates: typeof observation.elements = []
    for (const raw of data.elements.slice(0, 256)) {
      if (!raw || typeof raw !== 'object') continue
      const e = raw as Record<string, unknown>
      const element: { ref: string; role: string; name: string; text: string; frame?: string } = {
        ref: boundedString(e.ref, 128),
        role: boundedString(e.role, 100),
        name: boundedString(e.name, 300),
        text: boundedString(e.text, 300)
      }
      if (typeof e.frame === 'string' && e.frame) element.frame = e.frame.slice(0, 253)
      candidates.push(element)
    }
    // The elements share ELEMENTS_JSON characters. Child frames' elements come after the main frame's, so a card form's fields are
    // taken first, within the share (FRAMED_KEPT elements, FRAMED_JSON characters), then the main frame's in order, then every
    // framed one not yet kept, in order; the observation's order is kept. Without framed elements this is the rule it always was:
    // the leading elements, up to the first that does not fit. Sizes add up exactly as JSON.stringify would count them: the
    // elements plus a comma between each two. A framed element too big for what is left is passed over, so it can't hide the rest.
    const sizes = candidates.map((e) => JSON.stringify(e).length)
    const kept = new Set<number>()
    let used = JSON.stringify(observation).length
    const take = (indexes: number[], cap: number, passOver: boolean) => {
      for (const i of indexes) {
        const next = used + sizes[i] + (kept.size > 0 ? 1 : 0)
        if (next > cap) {
          if (passOver) continue
          return
        }
        used = next
        kept.add(i)
      }
    }
    const framed = candidates.flatMap((e, i) => (e.frame === undefined ? [] : [i])),
      plain = candidates.flatMap((e, i) => (e.frame === undefined ? [i] : []))
    take(framed.slice(0, FRAMED_KEPT), Math.min(ELEMENTS_JSON, used + FRAMED_JSON), true)
    take(plain, ELEMENTS_JSON, false)
    take(
      framed.filter((i) => !kept.has(i)),
      ELEMENTS_JSON,
      true
    )
    observation.elements = candidates.filter((_, i) => kept.has(i))
    // Never drops an element: the elements stay under ELEMENTS_JSON, half the limit, so only the page text is shortened.
    observation.text = data.text.slice(0, 32000)
    while (JSON.stringify({ ok: true, data: observation }).length > textLimit)
      observation.text = observation.text.slice(0, Math.floor(observation.text.length * 0.8))
    observation.truncated =
      data.truncated === true || observation.text.length < data.text.length || observation.elements.length < data.elements.length
    return { ok: true, data: observation }
  }
  try {
    if (JSON.stringify(result).length <= textLimit) return result
  } catch {
    /* Keep serialization errors private. */
  }
  return { ok: false, code: 'output_limit', message: 'Browser output exceeded the tool limit; request a fresh observation' }
}
export function browserToolResult(result: BrowserResult): {
  content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string })[]
  isError?: boolean
} {
  const bounded = boundBrowserResult(result)
  const data = bounded.ok ? (bounded.data as { mimeType?: string; base64?: string } | null) : null
  if (data?.mimeType === 'image/jpeg' && data.base64) return { content: [{ type: 'image', mimeType: data.mimeType, data: data.base64 }] }
  return { content: [{ type: 'text', text: JSON.stringify(bounded) }], ...(!bounded.ok ? { isError: true } : {}) }
}
