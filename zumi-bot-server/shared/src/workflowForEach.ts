import { FOREACH_CONCURRENCY_MAX, FOREACH_ITEMS_MAX, FOREACH_ITEM_MAX, FOREACH_OUTPUT_MAX, spaced } from './workflows'
import type { ItemRun, Step } from './workflows'

export const ITEM_CUT_NOTE = '… (cut; the full reply is in the run view)'

/** One item per line: trimmed, no empty lines, no exact repeats (a repeat would only run twice), order kept. */
export function parseItems(input: string): { items: string[] } | { error: string } {
  const items = [
    ...new Set(
      input
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '')
    )
  ]
  if (items.length > FOREACH_ITEMS_MAX) return { error: `The list has ${items.length} items; the most is ${FOREACH_ITEMS_MAX}` }
  const long = items.findIndex((t) => t.length > FOREACH_ITEM_MAX)
  if (long >= 0) return { error: `Item ${long + 1} is over ${spaced(FOREACH_ITEM_MAX)} characters` }
  return { items }
}

export const newItems = (texts: string[], newId: () => string): ItemRun[] =>
  texts.map((text, i) => ({ id: newId(), n: i + 1, text, status: 'pending' }))

export function itemCounts(items: ItemRun[]): { done: number; failed: number; pending: number; total: number } {
  const count = (s: ItemRun['status']) => items.filter((i) => i.status === s).length
  return { done: count('done'), failed: count('failed'), pending: count('pending'), total: items.length }
}

export const nextPending = (items: ItemRun[]): ItemRun | undefined => items.find((i) => i.status === 'pending')

/** How many items a For each step runs at once: 1 unless it says 2 or 3 (runs and workflows stored before it say nothing). */
export const concurrencyOf = (s: Pick<Extract<Step, { kind: 'foreach' }>, 'concurrency'>): number =>
  s.concurrency === 2 || s.concurrency === 3 ? s.concurrency : 1

/** The stored form of a concurrency the client or Zumi Bot sends: 2 or 3, else absent (one at a time). */
export function concurrencyKey(n: number): { concurrency?: 2 | 3 } {
  const c = Math.min(FOREACH_CONCURRENCY_MAX, Math.max(1, Math.round(n)))
  return c === 2 || c === 3 ? { concurrency: c } : {}
}

const openItem = (i: Pick<ItemRun, 'status'>): boolean => i.status === 'running' || i.status === 'waiting'

/**
 * Marks pending items running, in list order, until `limit` are open; `started` are the ones it marked, to begin once
 * written. A paused item is open, so it keeps its slot.
 */
export function startPending(items: ItemRun[], limit: number, now: number): { items: ItemRun[]; started: ItemRun[] } {
  let room = limit - items.filter(openItem).length
  const started: ItemRun[] = []
  const next = items.map((i) => {
    if (room <= 0 || i.status !== 'pending') return i
    room--
    const item: ItemRun = { ...i, status: 'running', startedAt: now }
    started.push(item)
    return item
  })
  return { items: started.length ? next : items, started }
}

/** A For each visit's status while items are open: waiting while any of them waits on the user, else running. */
export const openVisitStatus = (items: ItemRun[]): 'running' | 'waiting' =>
  items.some((i) => i.status === 'waiting') ? 'waiting' : 'running'

/** Every reply under its item's heading; each section gets an equal share of the output cap, so one long reply can't push out the rest. */
export function joinItemOutputs(items: Pick<ItemRun, 'text' | 'output'>[]): string {
  const share = Math.floor((FOREACH_OUTPUT_MAX - 2 * Math.max(items.length - 1, 0)) / Math.max(items.length, 1)) // minus the blank lines between sections
  return items
    .map((i) => {
      // A long item text is cut to fit too, or a heading alone could pass the share; "## " and the blank line after it come off the share.
      const head = `## ${i.text.slice(0, Math.max(share - 5, 0))}`
      const room = Math.max(share - head.length - 2, 0)
      const out = i.output ?? ''
      // Only a reply that really does not fit is cut, and the note counts toward the share (it is left off when there is no room for it).
      const body =
        out.length <= room
          ? out
          : room > ITEM_CUT_NOTE.length
            ? `${out.slice(0, room - ITEM_CUT_NOTE.length - 1)}\n${ITEM_CUT_NOTE}`
            : out.slice(0, room)
      return `${head}\n\n${body}`
    })
    .join('\n\n')
}

/**
 * The item list of a Retry. Done items stay as they were, marked `carried` (they ran in an earlier visit); failed, stopped
 * and pending ones start over but keep their chat, so the agent's session carries on. With `only`, just that item restarts
 * and the others are carried as they ended; a pending or stopped one keeps its status and is not carried, so it still runs
 * (a failed visit holds none today: every item is tried before it fails, and a paused item stays open instead of failing).
 * Every item gets a new id: an old one would still name the item in the earlier visit, and a new one is what makes a late
 * answer for an old run harmless.
 */
export function retryItems(items: ItemRun[], newId: () => string, only?: string): ItemRun[] {
  return items.map((i) => {
    const reset = only === undefined ? i.status !== 'done' : i.id === only
    if (!reset) {
      return only !== undefined && i.status !== 'done' && i.status !== 'failed'
        ? { ...i, id: newId() }
        : { ...i, id: newId(), carried: true as const }
    }
    const fresh: ItemRun = { id: newId(), n: i.n, text: i.text, status: 'pending' }
    if (i.chatId) fresh.chatId = i.chatId
    return fresh
  })
}

export const itemsFailedText = (failed: number, total: number): string => `${failed} of ${total} items failed`
