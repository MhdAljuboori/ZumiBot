import { CLONE_TITLE_MAX, HANDOFF_MAX_CHARS, hasSummarizable, nextCopyTitle } from '@zumibot/shared/roomClone'
import type { ChatViewState } from './chatView'

export type CloneOption = 'fresh' | 'summary'
export type CloneStep = 'choose' | 'writing' | 'review' | 'failed' | 'creating'

export interface CloneState {
  step: CloneStep
  name: string
  option: CloneOption
  /** The last summary the server wrote; null until one arrives. */
  draft: string | null
  /** What the agents will read: the draft plus the user's edits. */
  text: string
  edited: boolean
  error: string | null
  /** Where `creating` returns to when it fails. */
  from: 'choose' | 'review'
}

export type CloneEvent =
  | { type: 'name'; name: string }
  | { type: 'option'; option: CloneOption }
  | { type: 'write' }
  | { type: 'summaryReady'; text: string }
  | { type: 'summaryFailed'; error: string }
  | { type: 'edit'; text: string }
  | { type: 'rewrite' }
  | { type: 'back' }
  | { type: 'create' }
  | { type: 'createFailed'; error: string }
  | { type: 'cancelWriting' }

export function initialClone(title: string, taken: readonly string[]): CloneState {
  return {
    step: 'choose',
    name: nextCopyTitle(title, taken),
    option: 'fresh',
    draft: null,
    text: '',
    edited: false,
    error: null,
    from: 'choose'
  }
}

export function canCreate(s: CloneState): boolean {
  if (s.step === 'writing' || s.step === 'creating') return false
  const name = s.name.trim()
  if (!name || name.length > CLONE_TITLE_MAX) return false
  if (s.step !== 'review') return true
  const text = s.text.trim()
  return text.length > 0 && s.text.length <= HANDOFF_MAX_CHARS
}

/** The handoff to send: null for Start over. */
export const handoffOf = (s: CloneState): string | null => (s.option === 'fresh' ? null : s.text)

// Events that do not fit the step return the same object, so a late or double event is harmless.
export function cloneReducer(s: CloneState, e: CloneEvent): CloneState {
  switch (e.type) {
    case 'name':
      return s.step === 'choose' ? { ...s, name: e.name } : s
    case 'option':
      return s.step === 'choose' ? { ...s, option: e.option } : s
    case 'write':
      if (s.step === 'failed') return { ...s, step: 'writing', error: null }
      // A kept draft is shown again; only Rewrite pays for a new call.
      if (s.step === 'choose') return { ...s, option: 'summary', step: s.draft === null ? 'writing' : 'review', error: null }
      return s
    case 'rewrite':
      return s.step === 'review' ? { ...s, step: 'writing', error: null } : s
    case 'summaryReady':
      return s.step === 'writing' ? { ...s, step: 'review', draft: e.text, text: e.text, edited: false, error: null } : s
    case 'summaryFailed':
      return s.step === 'writing' ? { ...s, step: 'failed', error: e.error } : s
    case 'cancelWriting':
      return s.step === 'writing' ? { ...s, step: 'choose' } : s
    case 'edit':
      return s.step === 'review' ? { ...s, text: e.text, edited: e.text !== s.draft } : s
    case 'back':
      return s.step === 'review' || s.step === 'failed' ? { ...s, step: 'choose', error: null } : s
    case 'create': {
      // Start over is created from choose; a summary only from review.
      const ok = (s.step === 'choose' && s.option === 'fresh') || s.step === 'review'
      return ok && canCreate(s) ? { ...s, step: 'creating', from: s.step as 'choose' | 'review', error: null } : s
    }
    case 'createFailed':
      return s.step === 'creating' ? { ...s, step: s.from, error: e.error } : s
  }
}

/**
 * Whether With summary is worth offering, from what this tab has loaded. A room not loaded yet, or with older pages,
 * is left to the server, whose check is the real one.
 */
export function canSummarizeView(view: Pick<ChatViewState, 'items' | 'start'> | undefined): boolean {
  if (!view || view.start === null || view.start > 0) return true
  return hasSummarizable(view.items)
}

/** With summary can be picked: a kept draft needs no new call. */
export const summaryOffered = (s: CloneState, canSummarize: boolean): boolean => canSummarize || s.draft !== null

export interface PrimaryAction {
  kind: 'create' | 'write' | 'retry'
  enabled: boolean
}

/** The dialog's main button for the step; null while writing (only Cancel shows). */
export function primaryOf(s: CloneState, canSummarize: boolean): PrimaryAction | null {
  switch (s.step) {
    case 'choose':
      // canCreate on choose checks only the name, which Write summary needs too: review shows no name field.
      return s.option === 'fresh'
        ? { kind: 'create', enabled: canCreate(s) }
        : { kind: 'write', enabled: canCreate(s) && summaryOffered(s, canSummarize) }
    case 'review':
      return { kind: 'create', enabled: canCreate(s) }
    case 'failed':
      return { kind: 'retry', enabled: true }
    case 'creating':
      return { kind: 'create', enabled: false }
    case 'writing':
      return null
  }
}

/** Closing would drop the user's edits to a summary. Writing came from a Rewrite that already asked. */
export const closeAsks = (s: CloneState): boolean => s.edited && s.step !== 'writing' && s.step !== 'creating'

const count = (n: number): string => n.toLocaleString('en-US')

/** The handoff box's count, shown only past 90 % of the cap. */
export function handoffCount(text: string): { label: string; over: boolean } | null {
  if (text.length <= HANDOFF_MAX_CHARS * 0.9) return null
  return { label: `${count(text.length)} / ${count(HANDOFF_MAX_CHARS)}`, over: text.length > HANDOFF_MAX_CHARS }
}

const LINE_MARK = /^(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/
const INLINE_MARK = /\*\*|__|`/g

/** The collapsed handoff card's first two lines with text, without the Markdown marks that would show raw. */
export function handoffPreview(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().replace(LINE_MARK, '').replace(INLINE_MARK, '').trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('\n')
}
