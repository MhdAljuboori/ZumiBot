import { randomUUID } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import type { BrowserContext, CDPSession, Dialog, ElementHandle, FileChooser, Page } from 'playwright-core'
import { INLINE_IMAGE_MAX_BYTES } from '@zumibot/shared/attachments'
import {
  BROWSER_JPEG_BYTES,
  BROWSER_VIEWPORT_MAX,
  SHOT_BYTES_MAX,
  parseBrowserCommand,
  parseBrowserInput,
  sameBrowserViewport
} from '@zumibot/shared/browser'
import { secureHost, siteMatches } from '@zumibot/shared/vault'
import type {
  BrowserAdapter,
  BrowserCommand,
  BrowserConfig,
  BrowserFill,
  BrowserFrame,
  BrowserInput,
  BrowserInstance,
  BrowserResult,
  BrowserTab,
  BrowserViewport
} from './types'
import { BrowserDownloads } from './browserDownloads'
import { BrowserObservation } from './browserObservation'
import { BROWSER_CUTS, SCRUB_MARGIN } from './browserLimits'
import { COMPUTED_STYLE_PROPS, STYLE_VALUE_MAX } from './browserStyle'
import { browserKeyEvent } from './browserKeyboard'
import { selectPickerScript } from './browserSelect'
import { markWorkerState, ownershipVariable, recordBrowserProcesses } from './browserProcess'

const failure = (code: string, message: string): BrowserResult => ({ ok: false, code, message })
const success = (data: unknown = null): BrowserResult => ({ ok: true, data })
/** Pixel size from a JPEG's start-of-frame header, or null when there is none. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  for (let at = 2; at + 9 < bytes.length && bytes[at] === 0xff;) {
    const marker = bytes[at + 1]
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] }
    at += 2 + ((bytes[at + 2] << 8) | bytes[at + 3])
  }
  return null
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Pixel size from a PNG's IHDR chunk (bytes 16-23, big-endian), or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b) || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR')
    return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
/** Runs in the element's own frame, serialized, so self-contained: its own computed values (no pseudo-elements) and its box. */
function readStyle(el: Element, a: { props: readonly string[]; max: number }) {
  const computed = el.ownerDocument.defaultView!.getComputedStyle(el),
    box = el.getBoundingClientRect()
  const style: Record<string, string> = {}
  // Cut with the scrub margin, as page text is: a value is page-controlled (a font-family list, a custom shadow).
  for (const prop of a.props) style[prop] = computed.getPropertyValue(prop).slice(0, a.max)
  const px = (v: number) => Math.round(v * 100) / 100
  return { style, rect: { x: px(box.x), y: px(box.y), width: px(box.width), height: px(box.height) } }
}
/**
 * What the page-side read returned, rebuilt here: the evaluate runs in the page's own world, which can replace getComputedStyle or
 * String.prototype.slice, so nothing it returns is trusted. Only our own property names, string values cut here (the margin the
 * scrub needs), and rect numbers that are finite, rounded to 0.01.
 */
export function cleanStyle(raw: unknown): { style: Record<string, string>; rect: { x: number; y: number; width: number; height: number } } {
  const o = raw && typeof raw === 'object' ? (raw as { style?: unknown; rect?: unknown }) : {}
  const from = o.style && typeof o.style === 'object' && !Array.isArray(o.style) ? (o.style as Record<string, unknown>) : {}
  const style: Record<string, string> = {}
  for (const prop of COMPUTED_STYLE_PROPS) {
    const v = Object.hasOwn(from, prop) ? from[prop] : undefined
    if (typeof v === 'string') style[prop] = v.slice(0, STYLE_VALUE_MAX + SCRUB_MARGIN)
  }
  const r = o.rect && typeof o.rect === 'object' ? (o.rect as Record<string, unknown>) : {}
  const px = (k: string) => {
    const v = Object.hasOwn(r, k) ? r[k] : undefined
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0
  }
  return { style, rect: { x: px('x'), y: px('y'), width: px('width'), height: px('height') } }
}

const FILL_TARGETS: BrowserFill['target'][] = ['password', 'input', 'inputOrSelect', 'any']
/** The server builds it, but the worker still refuses anything malformed rather than guess. */
function validFill(f: BrowserFill): boolean {
  const strings = (v: unknown) => Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === 'string')
  const hosts = f?.hosts
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.value === 'string' &&
    f.value.length > 0 &&
    f.value.length <= 8192 &&
    typeof f.secret === 'boolean' &&
    (f.loose === undefined || typeof f.loose === 'boolean') &&
    (f.mask === undefined || typeof f.mask === 'boolean') &&
    FILL_TARGETS.includes(f.target) &&
    typeof f.ref === 'string' &&
    !!f.stamp &&
    typeof f.stamp === 'object' &&
    !!hosts &&
    typeof hosts === 'object' &&
    (hosts.kind === 'any' ||
      (hosts.kind === 'login' && strings(hosts.sites)) ||
      (hosts.kind === 'card' &&
        Array.isArray(hosts.approved) &&
        hosts.approved.every((a) => !!a && typeof a.site === 'string' && typeof a.frameSite === 'string')))
  )
}
type VaultCheck =
  | { mode: 'frame' }
  | { mode: 'check'; target: BrowserFill['target']; secret: boolean }
  | { mode: 'write'; target: BrowserFill['target']; secret: boolean; mask: boolean; value: string; loose: boolean }
/**
 * Runs in the element's own frame, serialized, so self-contained; the value comes in as an argument, never as source text.
 * `check` judges the element, `frame` an iframe element holding one, and `write` judges it again and puts the value into this
 * very element through the native setter, then checks it is there. Never the keyboard: typed keys go to whatever has focus,
 * and the page or another frame can take focus between the checks and the keys (an ad frame grabbing focus got the card
 * number, a focus handler moved a password into a plain input).
 */
function vaultElement(el: Element, a: VaultCheck): 'ok' | 'stale' | 'wrong' | 'option' | 'failed' | 'filled' {
  // Shown, not just laid out: a hidden, transparent or zero-size element never gets a value.
  const shown = (e: Element) => {
    const rect = e.getBoundingClientRect(),
      style = e.ownerDocument.defaultView!.getComputedStyle(e)
    const check = (e as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility === 'visible' &&
      style.display !== 'none' &&
      (check ? check.call(e, { visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true }) : true)
    )
  }
  if (!el.isConnected) return 'stale'
  if (a.mode === 'frame') return shown(el) ? 'ok' : 'wrong'
  // Input types a typed value makes sense in; a vault value never goes into a checkbox, file or hidden input.
  const TEXT = ['text', 'password', 'email', 'tel', 'number', 'search', 'url']
  // The element rule: what kind of element may take this field. A password only an input[type=password]; a secret only an input.
  const kind = (): boolean => {
    if (el instanceof HTMLInputElement) return a.target === 'password' ? el.type === 'password' : TEXT.includes(el.type)
    if (a.secret) return false
    if (el instanceof HTMLSelectElement) return (a.target === 'inputOrSelect' || a.target === 'any') && !el.multiple
    if (a.target !== 'any') return false
    return el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)
  }
  const usable = () =>
    !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) ||
    (!el.disabled && !('readOnly' in el && el.readOnly))
  const fits = (): boolean => el.isConnected && shown(el) && kind() && usable()
  if (!fits()) return 'wrong'
  if (a.mode === 'check') return 'ok'
  const value = a.value
  // Through the prototypes: a property the page put on the element itself never stands in for the real value.
  const native = (proto: object, key: string) => Object.getOwnPropertyDescriptor(proto, key)!
  const fire = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (el instanceof HTMLSelectElement) {
    const option = Array.from(el.options).find((o) => !o.disabled && (o.value === value || o.label === value))
    if (!option) return 'option'
    const prop = native(HTMLSelectElement.prototype, 'value')
    prop.set!.call(el, option.value)
    if (prop.get!.call(el) !== option.value) return 'failed'
    fire()
    return el.isConnected && kind() && prop.get!.call(el) === option.value ? 'filled' : 'failed'
  }
  // `secret` decides where a value may go, `mask` whether it is masked: an expiry part may go into a select, yet is masked here.
  const mask = () => {
    if (a.secret || a.mask) (el as HTMLElement).style.setProperty('-webkit-text-security', 'disc', 'important')
  }
  // Masked before the value goes in, so no frame ever shows it, and again after the page's own handlers ran.
  mask()
  ;(el as HTMLElement).focus({ preventScroll: true })
  // A focus handler runs inside focus(): it may have taken the element out of the page or changed its type.
  if (!el.isConnected) return 'stale'
  if (!fits()) return 'wrong'
  mask()
  const prop =
    el instanceof HTMLInputElement
      ? native(HTMLInputElement.prototype, 'value')
      : el instanceof HTMLTextAreaElement
        ? native(HTMLTextAreaElement.prototype, 'value')
        : native(Node.prototype, 'textContent')
  // Exact for a password; every other field a page may reformat ("4242 4242 …", "+1 (555) 123-4567", an upper-cased name, a
  // lower-cased email, "123 456"): there case, spaces, dashes, dots, slashes and parentheses are not a different value.
  const norm = (s: string) =>
    s
      .replace(/[\s\-\/.()]/g, '')
      .toUpperCase()
      .toLowerCase()
  const holds = () => {
    const now = String(prop.get!.call(el) ?? '')
    return now !== '' && (now === value || (a.loose && norm(now) === norm(value)))
  }
  prop.set!.call(el, value)
  if (!holds()) return 'failed'
  fire()
  mask()
  // The page's own input and change handlers have run: the element must still be in the page, still the kind it was checked
  // as (a password field turned into a plain input is not where a password goes), and still hold the value.
  return el.isConnected && kind() && holds() ? 'filled' : 'failed'
}

export function createChromiumAdapter(): BrowserAdapter {
  return {
    async launch(profileDir, config, files) {
      if (!config.executablePath) throw new Error('Browser unavailable')
      await mkdir(profileDir, { recursive: true, mode: 0o700 })
      await chmod(profileDir, 0o700)
      let context: BrowserContext
      try {
        context = await chromium.launchPersistentContext(profileDir, {
          executablePath: config.executablePath,
          headless: true,
          chromiumSandbox: true,
          viewport: { width: config.width, height: config.height },
          deviceScaleFactor: config.scale,
          // Screencast copies the real surface, which an emulated scale alone leaves at 1x.
          args: [`--force-device-scale-factor=${config.scale}`],
          acceptDownloads: true,
          timeout: config.commandMs
        })
        await context.addInitScript(selectPickerScript)
        if (process.env[ownershipVariable]) {
          const cdp = await context.browser()!.newBrowserCDPSession()
          try {
            const processes = await cdp.send('SystemInfo.getProcessInfo')
            const browser = processes.processInfo.find((p) => p.type === 'browser')
            if (!browser) throw new Error('Browser ownership proof unavailable')
            await recordBrowserProcesses(profileDir, [
              browser.id,
              ...processes.processInfo.filter((p) => p.id !== browser.id).map((p) => p.id)
            ])
          } finally {
            await cdp.detach()
          }
        }
      } catch {
        let confirmed = true
        try {
          await context!?.close()
        } catch {
          confirmed = false
        }
        await markWorkerState(profileDir, confirmed ? 'stopped' : 'unconfirmed')
        throw new Error('Browser unavailable')
      }
      const instance = new ChromiumInstance(context, config)
      try {
        await instance.downloads.start(context, profileDir, files, instance.generation)
        return instance
      } catch {
        await instance.close()
        throw new Error('Browser unavailable')
      }
    }
  }
}

class ChromiumInstance implements BrowserInstance {
  readonly generation = randomUUID()
  private pages = new Map<string, Page>()
  private tabs = new Map<string, BrowserTab>()
  private activeTabId: string | null = null
  private observation = new BrowserObservation(this.generation)
  private listeners = new Set<() => void>()
  private closed = false
  private closing: Promise<void> | null = null
  readonly downloads = new BrowserDownloads()
  private chooser: { chooser: FileChooser; tabId: string } | null = null
  private dialogTab: string | null = null
  private dialog: Dialog | null = null
  private dialogWaiters = new Set<() => void>()
  private suspended: Promise<BrowserResult> | null = null
  private manualPending: Promise<void> | null = null
  private frameCallback: ((frame: BrowserFrame) => void) | null = null
  private capture: CDPSession | null = null
  private captureWork = Promise.resolve()
  private sequence = 0
  private lastFrame = 0
  private heldFrame: { frame: BrowserFrame; session: CDPSession } | null = null
  private frameTimer: ReturnType<typeof setTimeout> | undefined
  private mouseButtons = 0
  private mousePosition = { x: 0, y: 0 }
  private heldKeys = new Map<string, Extract<BrowserInput, { type: 'keyDown' | 'keyUp' }>>()
  private viewport: BrowserViewport
  private wantedViewport: BrowserViewport
  private viewportWork = Promise.resolve()
  private quality = 80
  constructor(
    private context: BrowserContext,
    private config: BrowserConfig
  ) {
    this.viewport = this.wantedViewport = { width: config.width, height: config.height, scale: 1 }
    // The active execute deadline bounds operations. A modal yields that deadline
    // until its answer resumes/drains the same operation, rather than timing out unseen.
    context.setDefaultTimeout(0)
    context.setDefaultNavigationTimeout(0)
    context.on('page', (page) => this.track(page))
    for (const page of context.pages()) this.track(page)
    context.on('close', () => {
      this.closed = true
      this.frameCallback = null
      this.observation.invalidate()
      this.changed()
    })
  }
  /** For the server's own state and its viewers: page strings at their final lengths. */
  status() {
    return this.statusAt({ title: BROWSER_CUTS.title, url: BROWSER_CUTS.url, dialog: BROWSER_CUTS.dialog })
  }
  /** For an agent's command result: longer, since the manager scrubs vault secrets before it cuts (browserLimits.ts). */
  private agentStatus() {
    return this.statusAt({
      title: BROWSER_CUTS.title + SCRUB_MARGIN,
      url: BROWSER_CUTS.url + SCRUB_MARGIN,
      dialog: BROWSER_CUTS.dialog + SCRUB_MARGIN
    })
  }
  private statusAt(max: { title: number; url: number; dialog: number }) {
    return {
      tabs: [...this.tabs.values()].map((tab) => ({ ...tab, title: tab.title.slice(0, max.title), url: tab.url.slice(0, max.url) })),
      activeTabId: this.activeTabId,
      dialog: this.dialog
        ? {
            tabId: this.dialogTab!,
            type: this.dialog.type() as import('@zumibot/shared/browser').BrowserDialog['type'],
            message: this.dialog.message().slice(0, max.dialog),
            defaultValue: this.dialog.defaultValue().slice(0, max.dialog)
          }
        : null,
      fileChooser: this.chooser ? { tabId: this.chooser.tabId, multiple: this.chooser.chooser.isMultiple() } : null
    }
  }
  isClosed() {
    return this.closed
  }
  onChanged(cb: () => void) {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
  private changed() {
    for (const cb of this.listeners) cb()
  }
  private track(page: Page) {
    if ([...this.pages.values()].includes(page)) return
    if (this.closed || this.pages.size >= this.config.maxTabs) {
      void page.close().catch(() => {})
      return
    }
    const id = randomUUID()
    // A popup opens at the context's default size, not the size the viewer asked for.
    this.viewportWork = this.viewportWork.then(() => this.fitPage(page))
    this.pages.set(id, page)
    this.tabs.set(id, { id, title: '', url: page.url().slice(0, BROWSER_CUTS.url + SCRUB_MARGIN) })
    if (!this.activeTabId) this.activeTabId = id
    page.on('dialog', (dialog) => {
      this.dialog = dialog
      this.dialogTab = id
      for (const wake of this.dialogWaiters) wake()
      this.changed()
    })
    page.on('filechooser', (chooser) => {
      this.chooser = { chooser, tabId: id }
      this.changed()
    })
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      this.observation.invalidate()
      this.tabs.set(id, { id, title: '', url: page.url().slice(0, BROWSER_CUTS.url + SCRUB_MARGIN) })
      this.changed()
      void page
        .title()
        .then((title) => {
          if (this.pages.has(id)) {
            this.tabs.set(id, {
              id,
              title: title.slice(0, BROWSER_CUTS.title + SCRUB_MARGIN),
              url: page.url().slice(0, BROWSER_CUTS.url + SCRUB_MARGIN)
            })
            this.changed()
          }
        })
        .catch(() => {})
    })
    page.on('close', () => {
      this.pages.delete(id)
      this.tabs.delete(id)
      this.observation.invalidate()
      if (this.activeTabId === id) {
        this.mouseButtons = 0
        this.heldKeys.clear()
        this.activeTabId = this.pages.keys().next().value ?? null
        void this.refreshCapture()
      }
      this.changed()
    })
    this.changed()
  }
  async invalidateReferences() {
    await this.releaseInput()
    this.observation.invalidate()
  }
  private async releaseInput() {
    const buttons = this.mouseButtons,
      keys = [...this.heldKeys.values()]
    this.mouseButtons = 0
    this.heldKeys.clear()
    if ((!buttons && !keys.length) || this.closed || !this.activeTabId) return
    const session = await this.context.newCDPSession(this.page())
    try {
      for (const [button, mask] of [
        ['left', 1],
        ['right', 2],
        ['middle', 4]
      ] as const) {
        if (buttons & mask)
          await session.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button,
            buttons: 0,
            clickCount: 1,
            ...this.mousePosition
          })
      }
      for (const key of keys.reverse())
        await session.send('Input.dispatchKeyEvent', browserKeyEvent({ ...key, type: 'keyUp', modifiers: [] }))
    } finally {
      await session.detach().catch(() => {})
    }
  }
  private page(): Page {
    const page = this.activeTabId ? this.pages.get(this.activeTabId) : null
    if (this.closed || !page) throw new Error('Browser unavailable')
    return page
  }
  async execute(raw: BrowserCommand, signal: AbortSignal, uploadPaths?: string[]): Promise<BrowserResult> {
    let command: BrowserCommand
    try {
      command = parseBrowserCommand(raw)
    } catch {
      return failure('invalid_command', 'Invalid browser command')
    }
    if (this.closed) return failure('unavailable', 'Browser unavailable')
    if (command.op === 'tabs') return success(this.agentStatus())
    if ((this.dialog || this.suspended) && command.op !== 'dialog')
      return failure('dialog_pending', 'Answer the pending browser dialog before another command')
    return this.guarded(signal, command.op === 'dialog', () => this.dispatch(command, uploadPaths))
  }
  async fill(fill: BrowserFill, signal: AbortSignal): Promise<BrowserResult> {
    if (!validFill(fill)) return failure('invalid_command', 'Invalid browser command')
    if (this.closed) return failure('unavailable', 'Browser unavailable')
    if (this.dialog || this.suspended) return failure('dialog_pending', 'Answer the pending browser dialog before another command')
    return this.guarded(signal, false, () => this.fillElement(fill))
  }
  /** The command deadline, cancellation and dialog yield every agent operation shares. */
  private async guarded(signal: AbortSignal, answersDialog: boolean, work: () => Promise<BrowserResult>): Promise<BrowserResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    let wake!: () => void
    const yielded = Symbol('dialog')
    const dialogArrived = new Promise<typeof yielded>((resolve) => {
      wake = () => resolve(yielded)
      this.dialogWaiters.add(wake)
    })
    const interrupted = new Promise<BrowserResult>((resolve) => {
      abort = () => resolve(failure('aborted', 'Browser command cancelled'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => resolve(failure('timeout', 'Browser command timed out')), this.config.commandMs)
    })
    try {
      if (signal.aborted) return await interrupted
      const previous = this.suspended
      const manual = this.manualPending
      const operation = work()
        .then(async (result) => {
          if (answersDialog && result.ok) {
            if (manual) {
              await manual
              this.manualPending = null
            }
            return previous ?? result
          }
          return result
        })
        .catch((error) =>
          failure(
            error?.name === 'TimeoutError' ? 'timeout' : 'command_failed',
            error?.name === 'TimeoutError' ? 'Browser command timed out' : 'Browser command did not complete'
          )
        )
      const result = await Promise.race([operation, interrupted, dialogArrived])
      if (result === yielded) {
        this.suspended = operation
        return success({ dialogPending: true })
      }
      this.suspended = null
      // An interrupted Playwright call may still mutate its page; retire this generation.
      if (!result.ok && (result.code === 'timeout' || result.code === 'aborted')) await this.close()
      return result
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      this.dialogWaiters.delete(wake)
    }
  }
  /**
   * Every check is made here, right before typing, against the page as it is now: the hosts come from the browser's own idea of
   * the active tab's URL and the element's frame URL, never from the observation, since either may have moved since. Results
   * and failures carry codes and hosts only, never the value.
   */
  private async fillElement(f: BrowserFill): Promise<BrowserResult> {
    const page = this.page()
    const handle = this.observation.resolve(f.stamp, this.activeTabId!, f.ref)
    const stale = failure('stale_reference', 'Observe the page again before using this element')
    const wrong = failure('wrong_field_type', 'This element cannot take that vault field: use a visible, enabled field of the right type')
    if (!handle) return stale
    const frame = await handle.ownerFrame().catch(() => null)
    if (!frame || frame.isDetached() || frame.page() !== page) return stale
    const site = secureHost(page.url()),
      frameSite = secureHost(frame.url())
    if (site === null || frameSite === null) return failure('insecure_site', 'Vault values are filled only on https or local sites')
    const hosts = f.hosts
    if (hosts.kind === 'login' && ![site, frameSite].every((host) => hosts.sites.some((s) => siteMatches(s, host)))) {
      return failure('wrong_site', `This login is saved for ${hosts.sites.join(', ')}`)
    }
    // A frame that navigated away takes its elements' context with it: evaluating one throws.
    const checked = await handle
      .evaluate(vaultElement, { mode: 'check', target: f.target, secret: f.secret } as VaultCheck)
      .catch(() => 'stale' as const)
    if (checked === 'stale') return stale
    if (checked !== 'ok') return wrong
    // Every frame on the way up must be shown too: a hidden or zero-size iframe is not a field the user can see.
    for (let child = frame, parent = frame.parentFrame(); parent; child = parent, parent = parent.parentFrame()) {
      const holder = await child.frameElement()
      try {
        if ((await holder.evaluate(vaultElement, { mode: 'frame' } as VaultCheck)) !== 'ok') return wrong
      } finally {
        await holder.dispose().catch(() => {})
      }
    }
    // Nothing is written before the user allowed this card on this pair; the manager asks and calls again. Asked only once the
    // element itself would take the value, so the user is never asked about a fill that is refused anyway.
    if (hosts.kind === 'card' && !hosts.approved.some((a) => a.site === site && a.frameSite === frameSite))
      return success({ approve: { site, frameSite } })
    // The hosts once more, right before writing: still the pair that was checked.
    if (frame.isDetached() || secureHost(page.url()) !== site || secureHost(frame.url()) !== frameSite) return stale
    // One call in the element's frame re-checks it and writes it. A throw here is a failure without text (guarded).
    switch (
      await handle.evaluate(vaultElement, {
        mode: 'write',
        target: f.target,
        secret: f.secret,
        mask: f.mask === true,
        value: f.value,
        loose: f.loose === true
      } as VaultCheck)
    ) {
      case 'filled':
        return success({ filled: true })
      case 'option':
        return failure('invalid_option', 'No enabled option of this select matches the saved value')
      case 'wrong':
        return wrong
      case 'stale':
        return stale
      default:
        return failure('fill_failed', 'The value did not stay in this field')
    }
  }
  private async dispatch(command: BrowserCommand, uploadPaths?: string[]): Promise<BrowserResult> {
    if (command.op === 'tabs') return success(this.agentStatus())
    if (command.op === 'newTab') {
      if (this.pages.size >= this.config.maxTabs) return failure('tab_limit', 'Browser tab limit reached')
      await this.invalidateReferences()
      const page = await this.context.newPage()
      this.track(page)
      this.activeTabId = [...this.pages].find(([, p]) => p === page)![0]
      this.observation.invalidate()
      await this.refreshCapture()
      this.changed()
      if (command.url) await page.goto(command.url, { waitUntil: 'domcontentloaded' })
      return success(this.agentStatus())
    }
    if (command.op === 'selectTab' || command.op === 'closeTab') {
      const page = this.pages.get(command.tabId)
      if (!page) return failure('missing_tab', 'Browser tab unavailable')
      if (command.op === 'selectTab') {
        await this.invalidateReferences()
        this.activeTabId = command.tabId
        await this.refreshCapture()
        this.changed()
      } else {
        if (command.tabId === this.activeTabId) await this.invalidateReferences()
        await page.close()
        if (!this.pages.size) this.track(await this.context.newPage())
      }
      return success(this.agentStatus())
    }
    if (command.op === 'chooseFiles') {
      const pending = this.chooser
      if (!pending || pending.tabId !== this.activeTabId || !uploadPaths)
        return failure('no_file_chooser', 'No browser file chooser is pending')
      if (!pending.chooser.isMultiple() && uploadPaths.length > 1) return failure('file_limit', 'Choose one file')
      await pending.chooser.setFiles(uploadPaths)
      this.chooser = null
      this.changed()
      return success()
    }
    const page = this.page()
    switch (command.op) {
      case 'navigate':
        await page.goto(command.url, { waitUntil: 'domcontentloaded' })
        break
      case 'back':
        await page.goBack({ waitUntil: 'domcontentloaded' })
        break
      case 'forward':
        await page.goForward({ waitUntil: 'domcontentloaded' })
        break
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded' })
        break
      case 'observe':
        return success(await this.observation.observe(page, this.activeTabId!))
      case 'screenshot': {
        // CSS pixels: the agent's image stays the viewport's size whatever the render scale.
        const jpeg = await page.screenshot({ type: 'jpeg', quality: 70, scale: 'css' })
        return jpeg.length <= INLINE_IMAGE_MAX_BYTES
          ? success({ mimeType: 'image/jpeg', base64: jpeg.toString('base64') })
          : failure('image_limit', 'Browser image is too large')
      }
      case 'click':
      case 'type':
      case 'select':
      case 'upload': {
        const handle = this.observation.resolve(command.stamp, this.activeTabId!, command.ref)
        if (!handle || !(await handle.evaluate((el) => el.isConnected)))
          return failure('stale_reference', 'Observe the page again before using this element')
        if (command.op === 'upload') {
          if (!uploadPaths) return failure('invalid_files', 'Browser files unavailable')
          await handle.setInputFiles(uploadPaths)
          break
        }
        if (command.op === 'select') {
          // Commands run without a Playwright timeout, and selectOption waits forever for a
          // missing or disabled option, so check the choice first rather than retire the browser.
          const usable = await handle.evaluate(
            (el, values) =>
              el instanceof HTMLSelectElement &&
              !el.disabled &&
              !!el.getClientRects().length &&
              (el.multiple || values.length === 1) &&
              values.every((v) => Array.from(el.options).some((o) => !o.disabled && (o.value === v || o.label === v))),
            command.values
          )
          if (!usable) return failure('invalid_option', 'Choose enabled options of a select element from the latest observation')
          await handle.selectOption(command.values)
          break
        }
        if (command.op === 'type') await handle.fill(command.text)
        else await handle.click()
        break
      }
      case 'scroll':
        await page.mouse.wheel(command.deltaX, command.deltaY)
        break
      case 'saveScreenshot':
      case 'computedStyle':
      case 'hover':
        return this.audit(command, page)
      case 'dialog': {
        const dialog = this.dialog
        this.dialog = null
        this.dialogTab = null
        this.changed()
        if (!dialog) return failure('no_dialog', 'No browser dialog is pending')
        if (command.accept) await dialog.accept(command.text)
        else await dialog.dismiss()
        break
      }
      default:
        return failure('unsupported', 'Browser command is handled by the browser manager')
    }
    return success()
  }
  /**
   * Playwright's own wait, kept under the command deadline: the deadline retires the whole browser (the context's default
   * timeout is 0, so a waiting call would run into it), while a Playwright timeout ends its call cleanly and the browser stays.
   */
  // Never 0: Playwright reads a timeout of 0 as none.
  private get waitMs() {
    return Math.min(10000, Math.max(1, Math.floor(this.config.commandMs / 2)))
  }
  private async audit(
    command: Extract<BrowserCommand, { op: 'saveScreenshot' | 'computedStyle' | 'hover' }>,
    page: Page
  ): Promise<BrowserResult> {
    let handle: ElementHandle | null = null
    if (command.ref !== undefined) {
      handle = this.observation.resolve(command.stamp!, this.activeTabId!, command.ref)
      if (!handle || !(await handle.evaluate((el) => el.isConnected)))
        return failure('stale_reference', 'Observe the page again before using this element')
    }
    // A dialog blocks the page, so a call it interrupts runs out its wait; its timeout is the dialog's doing, not the element's.
    // The result reaches the agent only as the answer to its dialog command (guarded), so by then the dialog was answered.
    let dialogOpened = false
    const opened = () => {
      dialogOpened = true
    }
    this.dialogWaiters.add(opened)
    try {
      if (command.op === 'hover') {
        await handle!.hover({ timeout: this.waitMs })
        return success({ hovered: true })
      }
      if (command.op === 'computedStyle')
        return success(cleanStyle(await handle!.evaluate(readStyle, { props: COMPUTED_STYLE_PROPS, max: STYLE_VALUE_MAX + SCRUB_MARGIN })))
      // CSS pixels: a 1440 wide viewport gives a 1440 wide image whatever the render scale.
      const png = handle
        ? await handle.screenshot({ type: 'png', scale: 'css', timeout: this.waitMs })
        : await page.screenshot({ type: 'png', scale: 'css', fullPage: command.fullPage === true, timeout: this.waitMs })
      if (png.length > SHOT_BYTES_MAX) {
        return failure(
          'image_too_large',
          handle
            ? 'The element itself is too large: its screenshot is over 5 MiB, so shoot a smaller element inside it instead'
            : 'The screenshot is over 5 MiB: shoot one element or a smaller area instead'
        )
      }
      const size = pngSize(png)
      if (!size) return failure('command_failed', 'Browser command did not complete')
      return success({ mimeType: 'image/png', base64: png.toString('base64'), ...size })
    } catch (error) {
      if ((error as Error)?.name !== 'TimeoutError') throw error
      if (dialogOpened)
        return failure('dialog_interrupted', 'A page dialog opened during this command and has been answered: run it again if needed.')
      return handle
        ? failure('not_actionable', 'The element did not become visible, still and reachable in time: observe the page again')
        : failure('screenshot_failed', 'The page could not be captured in time: try the viewport instead of the full page, or one element')
    } finally {
      this.dialogWaiters.delete(opened)
    }
  }
  async input(raw: BrowserInput, signal: AbortSignal) {
    const input = parseBrowserInput(raw)
    if (signal.aborted || input.generation !== this.generation || input.tabId !== this.activeTabId)
      throw new Error('Browser input unavailable')
    if ('x' in input && (input.x >= BROWSER_VIEWPORT_MAX.width || input.y >= BROWSER_VIEWPORT_MAX.height))
      throw new Error('Browser input unavailable')
    if (this.dialog || this.manualPending) throw new Error('Browser dialog is pending')
    let wake!: () => void
    const yielded = Symbol('dialog')
    const modal = new Promise<typeof yielded>((resolve) => {
      wake = () => resolve(yielded)
      this.dialogWaiters.add(wake)
    })
    const operation = this.dispatchInput(input)
    try {
      if ((await Promise.race([operation, modal])) === yielded) this.manualPending = operation
    } finally {
      this.dialogWaiters.delete(wake)
    }
  }
  private async dispatchInput(input: BrowserInput) {
    // A point picked on a frame from just before a resize may lie past the new edge.
    if ('x' in input) input = { ...input, x: Math.min(input.x, this.viewport.width - 1), y: Math.min(input.y, this.viewport.height - 1) }
    const session = await this.context.newCDPSession(this.page())
    try {
      if (input.type === 'text') await session.send('Input.insertText', { text: input.text })
      else if (input.type === 'keyDown' || input.type === 'keyUp') {
        await session.send('Input.dispatchKeyEvent', browserKeyEvent(input))
        if (input.type === 'keyDown') this.heldKeys.set(input.code, input)
        else this.heldKeys.delete(input.code)
      } else if ('x' in input) {
        if (input.type === 'mouseDown') this.mouseButtons |= { left: 1, right: 2, middle: 4 }[input.button]
        if (input.type === 'mouseUp') this.mouseButtons &= ~{ left: 1, right: 2, middle: 4 }[input.button]
        this.mousePosition = { x: input.x, y: input.y }
        const type = { mouseDown: 'mousePressed', mouseUp: 'mouseReleased', mouseMove: 'mouseMoved', wheel: 'mouseWheel' }[input.type]
        await session.send('Input.dispatchMouseEvent', {
          type: type as 'mousePressed',
          x: input.x,
          y: input.y,
          buttons: this.mouseButtons,
          ...('button' in input ? { button: input.button, clickCount: input.clickCount ?? 1 } : {}),
          ...(input.type === 'wheel' ? { deltaX: input.deltaX, deltaY: input.deltaY } : {})
        })
      }
    } finally {
      await session.detach().catch(() => {})
    }
  }
  // Every resize runs on viewportWork: two overlapping resizes of one page can leave its
  // surface and its reported size apart, and frames then map clicks to the wrong place.
  private async fitPage(page: Page): Promise<void> {
    const size = page.viewportSize(),
      { width, height } = this.viewport
    if (!this.closed && !page.isClosed() && (size?.width !== width || size?.height !== height))
      await page.setViewportSize({ width, height }).catch(() => {})
  }
  /**
   * A phone keyboard opening shortens the viewer and so the page: the field being typed in comes back into view, as in a
   * phone's own browser. Not awaited, and skipped under a dialog: a page runs no script until its dialog is answered.
   */
  private revealFocus(): void {
    const page = this.activeTabId ? this.pages.get(this.activeTabId) : null
    if (this.closed || this.dialog || !page || page.isClosed()) return
    void page
      .evaluate(() => {
        const el = document.activeElement
        if (el instanceof HTMLElement && (el.isContentEditable || el.matches('input, textarea, select')))
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
      .catch(() => {})
  }
  /** Latest wins: a burst of resizes applies only the last one still wanted. */
  setViewport(viewport: BrowserViewport): Promise<void> {
    this.wantedViewport = viewport
    const work = this.viewportWork.then(async () => {
      const wanted = this.wantedViewport
      if (this.closed || sameBrowserViewport(wanted, this.viewport)) return
      const shorter = wanted.height < this.viewport.height
      this.viewport = wanted
      this.quality = 80
      await Promise.all([...this.pages.values()].map((page) => this.fitPage(page)))
      if (shorter) this.revealFocus()
      // The screencast's maximum size is fixed when it starts.
      await this.refreshCapture()
    })
    this.viewportWork = work.catch(() => {})
    return work
  }
  async startFrames(cb: (frame: BrowserFrame) => void) {
    if (this.closed) throw new Error('Browser unavailable')
    this.frameCallback = cb
    await this.refreshCapture()
  }
  async stopFrames() {
    this.frameCallback = null
    await this.refreshCapture()
  }
  private refreshCapture(): Promise<void> {
    const work = this.captureWork.then(async () => {
      const old = this.capture
      this.capture = null
      if (old) {
        await old.send('Page.stopScreencast').catch(() => {})
        await old.detach().catch(() => {})
      }
      if (!this.frameCallback || this.closed || !this.activeTabId) return
      const tabId = this.activeTabId,
        session = await this.context.newCDPSession(this.page())
      const { width, height, scale } = this.viewport,
        quality = this.quality
      this.capture = session
      session.on('Page.screencastFrame', (frame) => {
        void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
        if (!this.frameCallback || this.closed || this.capture !== session || this.activeTabId !== tabId) return
        const jpeg = frame.data.length > Math.ceil(BROWSER_JPEG_BYTES / 3) * 4 ? null : Buffer.from(frame.data, 'base64')
        if (!jpeg || jpeg.length > BROWSER_JPEG_BYTES) {
          // Viewers drop a frame this big, so a busy page would freeze; trade quality for a live picture.
          if (this.quality > 40) {
            this.quality -= 20
            void this.refreshCapture()
          }
          return
        }
        // The frame's own CSS size: a frame painted just after a resize must map clicks by its size, not the next one's.
        const css = (v: number | undefined, fallback: number, max: number) =>
          Math.min(max, Math.max(1, Math.round(v ?? fallback) || fallback))
        const cssWidth = css(frame.metadata.deviceWidth, width, BROWSER_VIEWPORT_MAX.width),
          cssHeight = css(frame.metadata.deviceHeight, height, BROWSER_VIEWPORT_MAX.height)
        // Mid-resize, a frame can carry the new size over the old surface; clicks on it would land off target.
        const pixels = jpegSize(jpeg)
        if (!pixels || Math.abs(pixels.width * cssHeight - pixels.height * cssWidth) > 0.03 * pixels.width * cssHeight) return
        this.showFrame(session, { generation: this.generation, tabId, sequence: 0, width: cssWidth, height: cssHeight, jpeg })
      })
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality,
        maxWidth: Math.round(width * scale),
        maxHeight: Math.round(height * scale),
        everyNthFrame: 1
      })
    })
    this.captureWork = work.catch(() => {})
    return work
  }
  /** At most fps frames a second, and never drop the last one: a page that stops changing must still show its final paint. */
  private showFrame(session: CDPSession, frame: BrowserFrame): void {
    const wait = this.lastFrame + 1000 / this.config.fps - Date.now()
    if (wait > 0) {
      this.heldFrame = { frame, session }
      this.frameTimer ??= setTimeout(() => {
        this.frameTimer = undefined
        const held = this.heldFrame
        this.heldFrame = null
        if (held) this.showFrame(held.session, held.frame)
      }, wait)
      return
    }
    if (!this.frameCallback || this.closed || this.capture !== session || this.activeTabId !== frame.tabId) return
    this.lastFrame = Date.now()
    this.frameCallback({ ...frame, sequence: ++this.sequence })
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true
      this.frameCallback = null
      this.observation.invalidate()
      this.suspended = null
      clearTimeout(this.frameTimer)
      this.heldFrame = null
      // Context teardown also terminates pending capture/CDP operations.
      await this.downloads.close()
      await this.context.close()
      await this.captureWork
      this.capture = null
      this.pages.clear()
      this.tabs.clear()
      this.activeTabId = null
      this.changed()
    })())
  }
}
