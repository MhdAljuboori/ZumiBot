import type { RunEvent } from '../chat/streamParser'
import type { BrowserResult } from '@zumibot/shared/browser'
import { luhnOk } from '@zumibot/shared/vault'

// Longest value first, so a value that contains another one is replaced whole. Literal split/join: a value is never a pattern.
const byLength = (scrub: ReadonlyMap<string, string>): [string, string][] =>
  [...scrub].filter(([value]) => value !== '').sort((a, b) => b[0].length - a[0].length)

export function scrubText(text: string, scrub: ReadonlyMap<string, string>): string {
  if (scrub.size === 0 || text === '') return text
  for (const [value, label] of byLength(scrub)) text = text.split(value).join(label)
  return text
}

/** Every string inside any JSON-like value (arrays and plain objects are copied, the rest is kept). */
export function scrubValue<T>(v: T, scrub: ReadonlyMap<string, string>): T {
  if (scrub.size === 0) return v
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return scrubText(x, scrub)
    if (Array.isArray(x)) return x.map(walk)
    if (x !== null && typeof x === 'object' && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null)) {
      return Object.fromEntries(Object.entries(x).map(([k, val]) => [scrubText(k, scrub), walk(val)]))
    }
    return x
  }
  return walk(v) as T
}

/**
 * Every string of a stream event, whatever its kind. A permission request goes back unchanged: the CLI is answered with its own
 * input (an approved command must run with the real value), so the caller scrubs only the copy it stores or shows.
 */
export function scrubEvent(e: RunEvent, scrub: ReadonlyMap<string, string>): RunEvent {
  if (scrub.size === 0 || e.kind === 'permissionRequest') return e
  return scrubValue(e, scrub)
}

/** Streaming text: holds back the last `longest - 1` characters, so a value split across two deltas is still caught. */
export class DeltaScrubber {
  private held = ''
  private readonly keep: number

  constructor(private readonly scrub: ReadonlyMap<string, string>) {
    this.keep = Math.max(0, ...[...scrub.keys()].map((v) => v.length - 1))
  }

  push(text: string): string {
    if (this.keep === 0) return text
    const all = scrubText(this.held + text, this.scrub)
    let cut = Math.max(0, all.length - this.keep)
    // Never split a surrogate pair between what is sent and what is held.
    if (cut > 0 && cut < all.length) {
      const c = all.charCodeAt(cut)
      if (c >= 0xdc00 && c <= 0xdfff) cut--
    }
    this.held = all.slice(cut)
    return all.slice(0, cut)
  }

  flush(): string {
    const rest = this.held
    this.held = ''
    return rest
  }
}

export const BROWSER_HIDDEN = '[hidden by vault]'

const SEP = '[\\s-]?'
const SEP_CHAR = /[\s-]/
const isDigit = (c: number): boolean => c >= 48 && c <= 57

/**
 * Every run of 12 to 19 digits (one optional space or dash between two) that ends in the last 4 of a saved card and passes the
 * Luhn check, or, for a saved card that does not pass it, any such run. Only the last 4 are looked at, and they are public (the
 * card's label shows them): replacing the saved number alone would tell a page which of its Luhn-valid guesses is the card, so
 * every guess it could make is replaced the same way. A run inside longer digits is caught too, as the saved number would be.
 */
function cardRuns(t: string, last4: ReadonlyMap<string, boolean>): { text: string; removed: number } {
  const spans: [number, number][] = []
  for (let i = 0; i < t.length;) {
    if (!isDigit(t.charCodeAt(i))) {
      i++
      continue
    }
    // One run: where each digit is, so a window of digits maps back to the characters it covers.
    const at = [i]
    let j = i + 1
    for (;;) {
      if (j < t.length && isDigit(t.charCodeAt(j))) at.push(j++)
      else if (j + 1 < t.length && SEP_CHAR.test(t[j]) && isDigit(t.charCodeAt(j + 1))) {
        at.push(j + 1)
        j += 2
      } else break
    }
    i = j
    if (at.length < 12) continue
    const digits = at.map((p) => t[p]).join('')
    for (let end = 11; end < digits.length; end++) {
      const any = last4.get(digits.slice(end - 3, end + 1))
      if (any === undefined) continue
      // The longest window ending here covers every shorter one.
      for (let length = Math.min(19, end + 1); length >= 12; length--) {
        if (any || luhnOk(digits.slice(end - length + 1, end + 1))) {
          spans.push([at[end - length + 1], at[end]])
          break
        }
      }
    }
  }
  if (spans.length === 0) return { text: t, removed: 0 }
  spans.sort((a, b) => a[0] - b[0])
  let out = '',
    from = 0,
    removed = 0
  for (let k = 0; k < spans.length;) {
    let [start, stop] = spans[k++]
    while (k < spans.length && spans[k][0] <= stop) stop = Math.max(stop, spans[k++][1])
    out += t.slice(from, start) + BROWSER_HIDDEN
    removed += Math.max(0, stop + 1 - start - BROWSER_HIDDEN.length)
    from = stop + 1
  }
  return { text: out + t.slice(from), removed }
}

// Ids the server makes itself (randomUUID): a stamp's parts, a ref, a tab or download id. Never page text, and a match inside one
// (a card run across its dashes, a short hex password) would corrupt it: a changed `generation` voids every stamp for the
// browser's life. Skipped only in these fields and only in that shape, so a page string under such a name is still scrubbed.
const ID_KEYS = new Set(['ref', 'generation', 'tabId', 'observationId', 'id', 'activeTabId'])
const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const serverId = (key: string, v: unknown): boolean => ID_KEYS.has(key) && typeof v === 'string' && SERVER_ID.test(v)

/** What the scrub did to one string of a browser result: its length before, and the characters its replacements took out. */
export interface ScrubbedString {
  raw: number
  removed: number
}

/**
 * Every vault secret the server holds, whoever it is granted to, out of a browser result before an agent reads it: observation
 * text and element names, tab titles and URLs, dialog text, error messages. Only whole secrets are replaced: values literally, a
 * card number as any Luhn-valid digit run ending in its last 4 (cardRuns) and as its own digits with one optional space or dash
 * between any two (the pattern is built from validated digits only, never from a value). Nothing is ever blanked for merely
 * looking like a secret's start: that would tell a page which of its guesses begin a secret. So the caller must scrub strings
 * before cutting them (BROWSER_CUTS), and `trace` gets, by path (`data/elements/3/name`), each changed string's length before
 * and how much shorter its replacements made it, which the cut needs (cutBrowserResult). Keys are the server's own and are kept,
 * and so are its ids (serverId). An image's base64 is left alone: a screenshot can't be scrubbed, which is why filled secret
 * fields are masked.
 */
export function scrubBrowserResult(
  r: BrowserResult,
  s: { values: string[]; cards: string[] },
  trace?: Map<string, ScrubbedString>
): BrowserResult {
  // Sorted once, longest first, so a value that contains another is replaced whole.
  const values = [...new Set(s.values.filter((v) => v !== ''))].sort((a, b) => b.length - a.length)
  const digits = [...new Set(s.cards)].filter((d) => /^\d{12,19}$/.test(d))
  const cards = digits.map((d) => new RegExp(d.split('').join(SEP), 'g'))
  // Last 4 → whether some saved card ending in them fails the Luhn check (then every run ending in them goes).
  const last4 = new Map<string, boolean>()
  for (const d of digits) last4.set(d.slice(-4), last4.get(d.slice(-4)) === true || !luhnOk(d))
  if (values.length === 0 && digits.length === 0) return r
  const shrink = (length: number) => Math.max(0, length - BROWSER_HIDDEN.length)
  const text = (t: string, path: string): string => {
    let out = t,
      removed = 0
    for (const v of values) {
      const parts = out.split(v)
      if (parts.length === 1) continue
      removed += (parts.length - 1) * shrink(v.length)
      out = parts.join(BROWSER_HIDDEN)
    }
    // The runs first: the saved number itself is always one of them, so the exact pattern after them finds nothing more.
    const runs = cardRuns(out, last4)
    out = runs.text
    removed += runs.removed
    for (const card of cards)
      out = out.replace(card, (m) => {
        removed += shrink(m.length)
        return BROWSER_HIDDEN
      })
    if (out !== t) trace?.set(path, { raw: t.length, removed })
    return out
  }
  const walk = (x: unknown, path: string): unknown => {
    if (typeof x === 'string') return text(x, path)
    if (Array.isArray(x)) return x.map((v, i) => walk(v, `${path}/${i}`))
    if (x !== null && typeof x === 'object' && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null)) {
      const o = x as Record<string, unknown>
      const image = typeof o.mimeType === 'string' && typeof o.base64 === 'string'
      return Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k, (image && k === 'base64') || serverId(k, v) ? v : walk(v, path === '' ? k : `${path}/${k}`)])
      )
    }
    return x
  }
  return walk(r, '') as BrowserResult
}
