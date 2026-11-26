// No imports: browser-viewer.e2e.mjs loads this file with plain node, whose type stripping resolves no extensionless import.
/** Every field a vault fill can name, the one list of them: vault.ts builds its per-kind lists and labels from it. */
export const VAULT_FILL_FIELD_NAMES = [
  'username',
  'password',
  'code',
  'number',
  'expiry',
  'expiryMonth',
  'expiryYear',
  'expiryYear2',
  'cvc',
  'holder',
  'fullName',
  'company',
  'email',
  'phone',
  'line1',
  'line2',
  'city',
  'region',
  'postalCode',
  'country'
] as const
export type VaultFillField = (typeof VAULT_FILL_FIELD_NAMES)[number]
const FILL_FIELD_SET: ReadonlySet<string> = new Set(VAULT_FILL_FIELD_NAMES)
/** A name of the list itself, so `toString` or `__proto__` never pass for a field. */
export const isFillField = (v: unknown): v is VaultFillField => typeof v === 'string' && FILL_FIELD_SET.has(v)

export interface BrowserConfig {
  maxBrowsers: number
  maxTabs: number
  idleMs: number
  leaseIdleMs: number
  handoffIdleMs: number
  commandMs: number
  queueMs: number
  fps: number
  width: number
  height: number
  /** Device pixels per CSS pixel the browser renders at, so HiDPI viewers get sharp frames. */
  scale: number
  executablePath: string | null
}
/** CSS size of the remote page and the viewer's pixel density for its frames. */
export type BrowserViewport = { width: number; height: number; scale: number }
export const BROWSER_VIEWPORT_MIN = { width: 240, height: 200 }
export const BROWSER_VIEWPORT_MAX = { width: 1920, height: 1080 }
export const BROWSER_SCALE_MAX = 2
// About 2560x1560 device pixels: keeps a JPEG frame well under BROWSER_JPEG_BYTES.
const BROWSER_FRAME_PIXELS = 4_000_000
/** Clamp a viewer's surface to what the protocol and screencast accept; the page is letterboxed past the bounds. */
export function fitBrowserViewport(width: number, height: number, scale: number): BrowserViewport {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? Math.floor(v) : min))
  const w = clamp(width, BROWSER_VIEWPORT_MIN.width, BROWSER_VIEWPORT_MAX.width),
    h = clamp(height, BROWSER_VIEWPORT_MIN.height, BROWSER_VIEWPORT_MAX.height)
  const s = Math.min(BROWSER_SCALE_MAX, Number.isFinite(scale) ? scale : 1, Math.sqrt(BROWSER_FRAME_PIXELS / (w * h)))
  return { width: w, height: h, scale: Math.max(1, Math.floor(s * 100) / 100) }
}
export const sameBrowserViewport = (a: BrowserViewport, b: BrowserViewport): boolean =>
  a.width === b.width && a.height === b.height && a.scale === b.scale
export type BrowserTarget = { agent: string; chatId?: string; requestId?: string }
export type BrowserOwner = { profileId: string; chatId: string; turnId: string }
export type BrowserStamp = { generation: string; tabId: string; observationId: string }
export type BrowserTab = { id: string; title: string; url: string }
export type BrowserDialog = { tabId: string; type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultValue: string }
export interface BrowserStatus {
  dialog?: BrowserDialog | null
  fileChooser?: { tabId: string; multiple: boolean } | null
  downloads?: { id: string; name: string; size: number }[]
  uploadToken?: string

  agent: string
  profileId: string
  generation: string
  state: 'stopped' | 'queued' | 'starting' | 'ready' | 'closing' | 'unavailable'
  tabs: BrowserTab[]
  activeTabId: string | null
  control: 'agent' | 'pausing' | 'you' | 'other'
  pendingRequestId: string | null
  error: string | null
}
/** Names an agent gives a saved screenshot: a bare file stem, so it can never reach another folder. */
export const SHOT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const SHOTS_PER_CHAT_MAX = 200
export const SHOT_BYTES_MAX = 5 * 1024 * 1024
export type BrowserCommand =
  | { op: 'navigate'; url: string }
  | { op: 'back' | 'forward' | 'reload' | 'tabs' | 'observe' | 'screenshot' | 'release' }
  | { op: 'newTab'; url?: string }
  | { op: 'selectTab' | 'closeTab'; tabId: string }
  | { op: 'click'; stamp: BrowserStamp; ref: string }
  | { op: 'type'; stamp: BrowserStamp; ref: string; text: string }
  | { op: 'select'; stamp: BrowserStamp; ref: string; values: string[] }
  | { op: 'scroll'; deltaX: number; deltaY: number }
  | { op: 'dialog'; accept: boolean; text?: string }
  | { op: 'chooseFiles'; fileIds: string[] }
  | { op: 'upload'; stamp: BrowserStamp; ref: string; fileIds: string[] }
  | { op: 'requestUserAction'; reason: string }
  // ref and stamp go together (an element shot); fullPage is for the whole page, so it never comes with them.
  | { op: 'saveScreenshot'; name: string; ref?: string; stamp?: BrowserStamp; fullPage?: boolean }
  | { op: 'computedStyle'; stamp: BrowserStamp; ref: string }
  | { op: 'hover'; stamp: BrowserStamp; ref: string }
  | { op: 'setViewport'; width: number; height: number }
  // Names a vault item and field only: the value is looked up and sent to the browser by the server (BrowserFill).
  | { op: 'fillVault'; stamp: BrowserStamp; ref: string; item: string; field: VaultFillField }
/**
 * What the server sends the browser worker to fill one element from the vault. Never a BrowserCommand: no agent and no IPC
 * line can carry one, so a value only ever travels server to worker. The worker checks the hosts and the element at fill time.
 */
export interface BrowserFill {
  stamp: BrowserStamp
  ref: string
  value: string
  /** Typed into a visible input only, then masked with -webkit-text-security. */
  secret: boolean
  /**
   * Masked with -webkit-text-security once in an input or textarea, whatever `secret` says: every card part (the expiry parts
   * too, which may also go into a select, where nothing can be masked), the password and the 2FA code. Absent is unmasked.
   */
  mask?: boolean
  target: 'password' | 'input' | 'inputOrSelect' | 'any'
  /** Every field but a password: a page may change case or add spaces, dashes, dots, slashes or parentheses. Absent is exact. */
  loose?: boolean
  hosts: { kind: 'login'; sites: string[] } | { kind: 'card'; approved: { site: string; frameSite: string }[] } | { kind: 'any' }
}
export type BrowserResult = { ok: true; data: unknown } | { ok: false; code: string; message: string }
export type BrowserModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'
export type BrowserInput = { generation: string; tabId: string } & (
  | { type: 'mouseDown' | 'mouseUp'; x: number; y: number; button: 'left' | 'middle' | 'right'; clickCount?: number }
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'keyDown' | 'keyUp'; key: string; code: string; modifiers?: BrowserModifier[] }
  | { type: 'text'; text: string }
)
export interface BrowserHandoff {
  readonly id: string
  readonly profileId: string
  readonly generation: string
  readonly chatId: string
  readonly turnId: string
  readonly site: string
  readonly reason: string
  readonly createdAt: number
  agent: string
  status: 'pending' | 'done' | 'cancelled' | 'expired' | 'interrupted'
}
export type BrowserFrame = { generation: string; tabId: string; sequence: number; width: number; height: number; jpeg: Uint8Array }
export interface BrowserApi {
  status(agent: string): Promise<BrowserStatus>
  clear(agent: string): Promise<void>
}

function invalid(): never {
  throw new Error('Invalid browser message')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid()
}
function string(value: unknown, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.length) || value.includes('\0')) invalid()
}
function id(value: unknown): asserts value is string {
  string(value, 128)
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) invalid()
}
function delta(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10000) invalid()
}
function url(value: unknown): void {
  string(value, 8192)
  if (value === 'about:blank') return
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalid()
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid()
}
function stamp(value: unknown): void {
  const s = object(value)
  fields(s, ['generation', 'tabId', 'observationId'])
  id(s.generation)
  id(s.tabId)
  id(s.observationId)
}

/** Validate the complete boundary, including extra fields, before passing anything to Chromium. */
export function parseBrowserCommand(value: unknown): BrowserCommand {
  const c = object(value)
  let allowed: string[] = []
  switch (c.op) {
    case 'back':
    case 'forward':
    case 'reload':
    case 'tabs':
    case 'observe':
    case 'screenshot':
    case 'release':
      break
    case 'navigate':
      url(c.url)
      allowed = ['url']
      break
    case 'newTab':
      if (c.url !== undefined) url(c.url)
      allowed = ['url']
      break
    case 'selectTab':
    case 'closeTab':
      id(c.tabId)
      allowed = ['tabId']
      break
    case 'chooseFiles':
      if (!Array.isArray(c.fileIds) || c.fileIds.length > 10) invalid()
      c.fileIds.forEach(id)
      allowed = ['fileIds']
      break
    case 'saveScreenshot':
      if (typeof c.name !== 'string' || !SHOT_NAME_RE.test(c.name)) invalid()
      if ((c.ref === undefined) !== (c.stamp === undefined)) invalid()
      if (c.ref !== undefined) {
        stamp(c.stamp)
        id(c.ref)
      }
      if (c.fullPage !== undefined && (typeof c.fullPage !== 'boolean' || c.ref !== undefined)) invalid()
      allowed = ['name', 'ref', 'stamp', 'fullPage']
      break
    case 'computedStyle':
    case 'hover':
      stamp(c.stamp)
      id(c.ref)
      allowed = ['stamp', 'ref']
      break
    case 'setViewport':
      // Same bounds fitBrowserViewport clamps to, but refused rather than clamped: the agent should know what it got.
      if (!Number.isInteger(c.width) || !Number.isInteger(c.height)) invalid()
      if ((c.width as number) < BROWSER_VIEWPORT_MIN.width || (c.width as number) > BROWSER_VIEWPORT_MAX.width) invalid()
      if ((c.height as number) < BROWSER_VIEWPORT_MIN.height || (c.height as number) > BROWSER_VIEWPORT_MAX.height) invalid()
      allowed = ['width', 'height']
      break
    case 'click':
    case 'type':
    case 'select':
    case 'upload':
      stamp(c.stamp)
      id(c.ref)
      allowed = ['stamp', 'ref']
      if (c.op === 'type') {
        string(c.text, 16384, true)
        allowed.push('text')
      }
      if (c.op === 'select') {
        if (!Array.isArray(c.values) || !c.values.length || c.values.length > 32) invalid()
        c.values.forEach((v) => string(v, 1024, true))
        allowed.push('values')
      }
      if (c.op === 'upload') {
        if (!Array.isArray(c.fileIds) || !c.fileIds.length || c.fileIds.length > 10) invalid()
        c.fileIds.forEach(id)
        allowed.push('fileIds')
      }
      break
    case 'scroll':
      delta(c.deltaX)
      delta(c.deltaY)
      allowed = ['deltaX', 'deltaY']
      break
    case 'dialog':
      if (typeof c.accept !== 'boolean') invalid()
      if (c.text !== undefined) string(c.text, 16384, true)
      allowed = ['accept', 'text']
      break
    case 'requestUserAction':
      string(c.reason, 500)
      allowed = ['reason']
      break
    case 'fillVault':
      stamp(c.stamp)
      id(c.ref)
      string(c.item, 128)
      if (!isFillField(c.field)) invalid()
      allowed = ['stamp', 'ref', 'item', 'field']
      break
    default:
      return invalid()
  }
  fields(c, ['op', ...allowed])
  return c as BrowserCommand
}

const NAMED_KEYS = new Set([
  'Backspace',
  'Tab',
  'Enter',
  'Escape',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Pause',
  'PrintScreen',
  'ContextMenu'
])
/**
 * The physical key a key event stands for. A phone keyboard's events have an empty `code`, and Chrome acts on a key's
 * code (Backspace deletes, Enter submits) only when it has one, so it is named from the key where that is unambiguous.
 */
export function browserKeyCode(key: string, code: string): string {
  if (code) return code
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (key === ' ') return 'Space'
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) return `${key}Left`
  return NAMED_KEYS.has(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key) ? key : ''
}

export function parseBrowserInput(value: unknown): BrowserInput {
  const c = object(value)
  id(c.generation)
  id(c.tabId)
  let allowed: string[]
  switch (c.type) {
    case 'mouseDown':
    case 'mouseUp':
    case 'mouseMove':
    case 'wheel':
      if (
        typeof c.x !== 'number' ||
        !Number.isFinite(c.x) ||
        c.x < 0 ||
        c.x >= 1920 ||
        typeof c.y !== 'number' ||
        !Number.isFinite(c.y) ||
        c.y < 0 ||
        c.y >= 1080
      )
        invalid()
      allowed = ['x', 'y']
      if (c.type === 'mouseDown' || c.type === 'mouseUp') {
        if (!['left', 'middle', 'right'].includes(c.button as string)) invalid()
        // 2 and 3 select a word and a line, as a real double or triple click does.
        if (c.clickCount !== undefined && (!Number.isInteger(c.clickCount) || (c.clickCount as number) < 1 || (c.clickCount as number) > 3))
          invalid()
        allowed.push('button', 'clickCount')
      }
      if (c.type === 'wheel') {
        delta(c.deltaX)
        delta(c.deltaY)
        allowed.push('deltaX', 'deltaY')
      }
      break
    case 'keyDown':
    case 'keyUp':
      string(c.key, 128)
      // A phone keyboard's keys come from no physical key, so their code is empty; browserKeyCode names them.
      string(c.code, 128, true)
      if (
        c.modifiers !== undefined &&
        (!Array.isArray(c.modifiers) || c.modifiers.length > 4 || c.modifiers.some((m) => !['Alt', 'Control', 'Meta', 'Shift'].includes(m)))
      )
        invalid()
      allowed = ['key', 'code', 'modifiers']
      break
    case 'text':
      string(c.text, 16384)
      allowed = ['text']
      break
    default:
      return invalid()
  }
  fields(c, ['type', 'generation', 'tabId', ...allowed])
  return c as BrowserInput
}

/** Never persist path/query/fragment/credentials in an action-required card. */
export function safeBrowserSite(value: string): string {
  try {
    const parsed = new URL(value)
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.origin : ''
  } catch {
    return ''
  }
}

export const BROWSER_COMMAND_BYTES = 64 * 1024
export const BROWSER_JPEG_BYTES = 2 * 1024 * 1024
export type BrowserRequest = { id: number } & (
  | { op: 'watch'; target: BrowserTarget }
  | { op: 'unwatch'; watchId: number }
  | { op: 'takeControl' | 'releaseControl'; watchId: number; generation: string; tabId: string }
  | { op: 'input'; watchId: number; input: BrowserInput }
  | ({ op: 'viewport'; watchId: number } & BrowserViewport)
  | { op: 'navigate'; watchId: number; generation: string; tabId: string; command: BrowserCommand }
  | { op: 'answer'; target: BrowserTarget; requestId: string; decision: 'done' | 'cancel' }
)
export type BrowserResponse = { type: 'response'; id: number } & ({ ok: true; value: null | BrowserResult } | { ok: false; error: string })
export type BrowserStatusMessage = { type: 'status'; watchId: number; status: BrowserStatus }
export type BrowserFrameMessage = BrowserFrame & { watchId: number }
function requestId(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid()
}
function target(value: unknown): void {
  const t = object(value)
  fields(t, ['agent', 'chatId', 'requestId'])
  string(t.agent, 128)
  if (t.chatId !== undefined) id(t.chatId)
  if (t.requestId !== undefined) id(t.requestId)
}
export function parseBrowserRequest(value: unknown): BrowserRequest {
  const c = object(value)
  requestId(c.id)
  let allowed: string[]
  switch (c.op) {
    case 'watch':
      target(c.target)
      allowed = ['target']
      break
    case 'unwatch':
      requestId(c.watchId)
      allowed = ['watchId']
      break
    case 'takeControl':
    case 'releaseControl':
      requestId(c.watchId)
      id(c.generation)
      id(c.tabId)
      allowed = ['watchId', 'generation', 'tabId']
      break
    case 'input':
      requestId(c.watchId)
      parseBrowserInput(c.input)
      allowed = ['watchId', 'input']
      break
    case 'viewport': {
      requestId(c.watchId)
      const fit =
        typeof c.width === 'number' && typeof c.height === 'number' && typeof c.scale === 'number'
          ? fitBrowserViewport(c.width, c.height, c.scale)
          : null
      // Only an already fitted size is accepted, so the server never guesses what the viewer meant.
      if (!fit || fit.width !== c.width || fit.height !== c.height || fit.scale !== c.scale) invalid()
      allowed = ['watchId', 'width', 'height', 'scale']
      break
    }
    case 'navigate':
      requestId(c.watchId)
      id(c.generation)
      id(c.tabId)
      if (
        !['navigate', 'back', 'forward', 'reload', 'newTab', 'selectTab', 'closeTab', 'dialog', 'chooseFiles'].includes(
          parseBrowserCommand(c.command).op
        )
      )
        invalid()
      allowed = ['watchId', 'generation', 'tabId', 'command']
      break
    case 'answer':
      target(c.target)
      id(c.requestId)
      if (c.decision !== 'done' && c.decision !== 'cancel') invalid()
      allowed = ['target', 'requestId', 'decision']
      break
    default:
      return invalid()
  }
  fields(c, ['id', 'op', ...allowed])
  return c as BrowserRequest
}
/** Site text is untrusted even when the adapter is healthy. Never serialize unbounded tab metadata. */
export function boundBrowserStatus(s: BrowserStatus): BrowserStatus {
  const clip = (s: string, max: number) => s.slice(0, max)
  return {
    agent: clip(s.agent, 128),
    profileId: clip(s.profileId, 128),
    generation: clip(s.generation, 128),
    state: s.state,
    tabs: s.tabs.slice(0, 32).map((t) => ({ id: clip(t.id, 128), title: clip(t.title, 1024), url: clip(t.url, 8192) })),
    activeTabId: s.activeTabId === null ? null : clip(s.activeTabId, 128),
    control: s.control,
    pendingRequestId: s.pendingRequestId === null ? null : clip(s.pendingRequestId, 128),
    error: s.error === null ? null : clip(s.error, 512),
    ...(s.dialog
      ? {
          dialog: {
            tabId: clip(s.dialog.tabId, 128),
            type: s.dialog.type,
            message: clip(s.dialog.message, 2000),
            defaultValue: clip(s.dialog.defaultValue, 2000)
          }
        }
      : { dialog: null }),
    ...(s.fileChooser
      ? { fileChooser: { tabId: clip(s.fileChooser.tabId, 128), multiple: !!s.fileChooser.multiple } }
      : { fileChooser: null }),
    ...(s.downloads
      ? {
          downloads: s.downloads
            .slice(0, 10)
            .map((f) => ({ id: clip(f.id, 128), name: clip(f.name, 180), size: Math.min(26214400, Math.max(0, f.size)) }))
        }
      : {}),
    ...(s.uploadToken ? { uploadToken: clip(s.uploadToken, 128) } : {})
  }
}
function frameMeta(v: Record<string, unknown>): void {
  fields(v, ['watchId', 'generation', 'tabId', 'sequence', 'width', 'height'])
  requestId(v.watchId)
  id(v.generation)
  id(v.tabId)
  requestId(v.sequence)
  if (
    !Number.isInteger(v.width) ||
    !Number.isInteger(v.height) ||
    (v.width as number) < 1 ||
    (v.width as number) > 1920 ||
    (v.height as number) < 1 ||
    (v.height as number) > 1080
  )
    invalid()
}
/** Binary: uint32 big-endian JSON byte length, UTF-8 metadata (<=1024 bytes), then JPEG (<=2 MiB). */
export function encodeBrowserFrame(watchId: number, frame: BrowserFrame): Uint8Array {
  const { jpeg, ...data } = frame,
    meta = { watchId, ...data }
  frameMeta(meta)
  if (!jpeg.byteLength || jpeg.byteLength > BROWSER_JPEG_BYTES) invalid()
  const json = new TextEncoder().encode(JSON.stringify(meta))
  if (json.length > 1024) invalid()
  const bytes = new Uint8Array(4 + json.length + jpeg.byteLength)
  new DataView(bytes.buffer).setUint32(0, json.length)
  bytes.set(json, 4)
  bytes.set(jpeg, 4 + json.length)
  return bytes
}
export function decodeBrowserFrame(bytes: Uint8Array): BrowserFrameMessage {
  if (bytes.byteLength < 5 || bytes.byteLength > BROWSER_JPEG_BYTES + 1028) invalid()
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (size < 1 || size > 1024 || size + 4 >= bytes.byteLength || bytes.byteLength - size - 4 > BROWSER_JPEG_BYTES) invalid()
  const meta = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + size))))
  frameMeta(meta)
  return { ...meta, jpeg: bytes.subarray(4 + size) } as BrowserFrameMessage
}

export type BrowserPageState = {
  generation: string
  tabs: BrowserTab[]
  activeTabId: string | null
  dialog?: BrowserDialog | null
  fileChooser?: { tabId: string; multiple: boolean } | null
}
/** The worker may carry site text, never arbitrary objects or private paths. */
export function parseBrowserPageState(value: unknown): BrowserPageState {
  const s = object(value)
  fields(s, ['generation', 'tabs', 'activeTabId', 'dialog', 'fileChooser'])
  id(s.generation)
  if (!Array.isArray(s.tabs) || s.tabs.length > 32) invalid()
  for (const raw of s.tabs as unknown[]) {
    const t = object(raw)
    fields(t, ['id', 'title', 'url'])
    id(t.id)
    string(t.title, 1024, true)
    string(t.url, 8192, true)
  }
  if (s.activeTabId !== null) id(s.activeTabId)
  if (s.dialog !== undefined && s.dialog !== null) {
    const d = object(s.dialog)
    fields(d, ['tabId', 'type', 'message', 'defaultValue'])
    id(d.tabId)
    if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(d.type as string)) invalid()
    string(d.message, 2000, true)
    string(d.defaultValue, 2000, true)
  }
  if (s.fileChooser !== undefined && s.fileChooser !== null) {
    const f = object(s.fileChooser)
    fields(f, ['tabId', 'multiple'])
    id(f.tabId)
    if (typeof f.multiple !== 'boolean') invalid()
  }
  return s as BrowserPageState
}
