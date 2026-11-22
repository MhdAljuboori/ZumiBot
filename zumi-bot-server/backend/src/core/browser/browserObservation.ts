import { randomUUID } from 'node:crypto'
import type { ElementHandle, Frame, Page } from 'playwright-core'
import type { BrowserStamp } from './types'
import { BROWSER_CUTS, MARGIN_PAYLOAD, SCRUB_MARGIN, describedCost, pageTextCap } from './browserLimits'

const SELECTOR = 'button,a[href],input,textarea,select,[role],[tabindex]'
// Kept back for child frames while the main frame is read (see observe): elements, and characters of the description budget.
const CHILD_ELEMENTS = 32
const CHILD_CHARS = 4096
// Only the host is shown: a frame's path and query can carry tokens.
function frameHost(url: string): string {
  try {
    const u = new URL(url)
    return (u.hostname || u.protocol.replace(':', '') || 'frame').slice(0, 253)
  } catch {
    return 'frame'
  }
}
// Serialized into the page, so the lengths come in as an argument: each final limit plus the scrub margin (browserLimits.ts).
function describe(el: Element, max: { role: number; name: number; text: number }) {
  if (!(el instanceof HTMLElement) || !el.getClientRects().length) return null
  const tag = el.tagName.toLowerCase()
  const inputType = el.getAttribute('type') ?? ''
  const role =
    el.getAttribute('role') ??
    (
      {
        button: 'button',
        a: 'link',
        textarea: 'textbox',
        select: 'combobox',
        input: inputType === 'checkbox' ? 'checkbox' : 'textbox'
      } as Record<string, string>
    )[tag] ??
    tag
  const labelled = (el.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim()
  const name =
    el.getAttribute('aria-label') ??
    (labelled ||
      ('labels' in el
        ? Array.from((el as HTMLInputElement).labels ?? [])
            .map((l) => l.textContent ?? '')
            .join(' ')
        : '') ||
      el.innerText ||
      el.getAttribute('placeholder') ||
      '')
  return { role: role.slice(0, max.role), name: name.trim().slice(0, max.name), text: (el.innerText ?? '').slice(0, max.text) }
}

export class BrowserObservation {
  private observationId = randomUUID()
  private references = new Map<string, ElementHandle>()
  constructor(private generation: string) {}
  invalidate(): void {
    this.observationId = randomUUID()
    for (const handle of this.references.values()) void handle.dispose().catch(() => {})
    this.references.clear()
  }
  resolve(stamp: BrowserStamp, tabId: string, ref: string): ElementHandle | null {
    return stamp.generation === this.generation && stamp.tabId === tabId && stamp.observationId === this.observationId
      ? (this.references.get(ref) ?? null)
      : null
  }
  async observe(page: Page, tabId: string) {
    this.invalidate()
    const stamp = { generation: this.generation, tabId, observationId: this.observationId }
    // Strings are handed over longer than an agent gets them: the manager scrubs vault secrets, then cuts (cutBrowserResult).
    // Budgets count only what will be kept, so the page reads the same as before.
    const text = await page.evaluate((max) => (document.body?.innerText ?? '').slice(0, max), BROWSER_CUTS.pageText + SCRUB_MARGIN)
    const longer = {
      role: BROWSER_CUTS.role + SCRUB_MARGIN,
      name: BROWSER_CUTS.name + SCRUB_MARGIN,
      text: BROWSER_CUTS.text + SCRUB_MARGIN
    }
    const elements: { ref: string; role: string; name: string; text: string; frame?: string }[] = []
    // Reserve descriptions before truncating prose, so long pages remain actionable.
    const descriptionBudget = BROWSER_CUTS.pageText - Math.min(text.length, 24000)
    let budget = descriptionBudget
    // What element strings carry past their limits: margins would let a hostile page send millions of characters per observation
    // (many cheap elements with huge attributes), and the server scrubs all of it once per secret on its event loop.
    let margins = 0
    const past = (e: { role: string; name: string; text: string }) =>
      Math.max(0, e.role.length - BROWSER_CUTS.role) +
      Math.max(0, e.name.length - BROWSER_CUTS.name) +
      Math.max(0, e.text.length - BROWSER_CUTS.text)
    const main = page.mainFrame()
    // The main frame, then every attached child frame; all share one element and character budget. A child frame that can't be
    // read is left out; the main frame's failure fails the observation.
    const mainHandles = await main.$$(SELECTOR)
    const children: { frame: Frame; handles: ElementHandle[]; field: boolean }[] = []
    for (const frame of page.frames().filter((f) => f !== main)) {
      let handles: ElementHandle[]
      try {
        handles = await frame.$$(SELECTOR)
      } catch {
        continue
      }
      const field = await frame.evaluate(() => !!document.querySelector('input,select')).catch(() => false)
      children.push({ frame, handles, field })
    }
    // A card form is what an agent needs from an iframe: frames holding a field are read first.
    children.sort((a, b) => Number(b.field) - Number(a.field))
    // A share kept back for child frames, so a big main frame can't fill the observation before a card iframe is read. Only as
    // much as they could use: a page without child frames (or with empty ones) reads exactly as before.
    const keptElements = Math.min(
      CHILD_ELEMENTS,
      children.reduce((n, c) => n + c.handles.length, 0)
    )
    const keptChars = keptElements > 0 ? Math.min(CHILD_CHARS, Math.floor(budget / 2)) : 0
    // Set once an element goes unread for want of room. Said only on a page with child frames (`truncated`), where a card form
    // may be what was left out; a page without them reads exactly as before.
    let dropped = false
    // Reads handles while the budget lasts. Within `room` (what this pass may use) an element that does not fit is put off and
    // handed back, so the main frame can take what the child frames left; past the whole budget it is dropped.
    const read = async (
      handles: ElementHandle[],
      label: string | undefined,
      room: { elements: number; chars: number }
    ): Promise<ElementHandle[]> => {
      const later: ElementHandle[] = []
      const child = label !== undefined
      for (const [index, handle] of handles.entries()) {
        if (elements.length >= 256 || budget <= 0) {
          dropped = true
          await handle.dispose()
          continue
        }
        if (elements.length >= room.elements || budget <= room.chars) {
          later.push(handle)
          continue
        }
        let info
        try {
          info = await handle.evaluate(describe, longer)
        } catch (error) {
          // A child frame may detach while it is read: drop what is left of it, keep the observation.
          if (!child) throw error
          for (const left of handles.slice(index)) await left.dispose().catch(() => {})
          break
        }
        if (!info) {
          await handle.dispose()
          continue
        }
        // Past the cap, a string longer than its limit is dropped, not cut: without its margin, a cut could end in the start of a
        // secret, which no scrub may recognize. Strings within their limits are whole, so they stay, and a page under it is unchanged.
        if (margins + past(info) > MARGIN_PAYLOAD) {
          info = {
            role: info.role.length > BROWSER_CUTS.role ? '' : info.role,
            name: info.name.length > BROWSER_CUTS.name ? '' : info.name,
            text: info.text.length > BROWSER_CUTS.text ? '' : info.text
          }
        }
        const cost = describedCost({ role: info.role.length, name: info.name.length, text: info.text.length })
        if (cost > budget) {
          dropped = true
          await handle.dispose()
          continue
        }
        if (cost > budget - room.chars) {
          later.push(handle)
          continue
        }
        budget -= cost
        margins += past(info)
        const ref = randomUUID()
        this.references.set(ref, handle)
        elements.push(label === undefined ? { ref, ...info } : { ref, ...info, frame: label })
      }
      return later
    }
    const putOff = await read(mainHandles, undefined, { elements: 256 - keptElements, chars: keptChars })
    for (const c of children) await read(c.handles, frameHost(c.frame.url()), { elements: 256, chars: 0 })
    // What the child frames left goes back to the main frame.
    await read(putOff, undefined, { elements: 256, chars: 0 })
    // A navigation during collection must never stamp old handles as current.
    if (stamp.observationId !== this.observationId) throw new Error('Observation changed')
    // The manager works this cut out the same way (pageTextCap) to know whether the text ends in one.
    return {
      stamp,
      text: text.slice(0, pageTextCap(descriptionBudget - budget)),
      elements,
      ...(dropped && keptElements > 0 ? { truncated: true } : {})
    }
  }
}
