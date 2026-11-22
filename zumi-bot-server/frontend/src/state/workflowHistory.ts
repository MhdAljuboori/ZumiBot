import type { WorkflowInput } from '@zumibot/shared/workflows'
import { canon } from './workflowCanvas'

// Undo and redo for the workflow editor, as pure rules. What a step back restores is everything the canvas draws and the
// inspector edits; the on/off switch and the id are not part of it (undoing a rename must not turn a workflow off, and the
// id is the saved workflow's, not an edit).
export type Undoable = Omit<WorkflowInput, 'id' | 'enabled'>

export interface History {
  past: Undoable[]
  future: Undoable[]
  last: { key: string; at: number } | null
}

export const HISTORY_MAX = 100
/** Typing in one field within this long of its last edit is one step. */
export const COALESCE_MS = 1_000

export const emptyHistory: History = { past: [], future: [], last: null }

function undoable(w: WorkflowInput): Undoable {
  const { id: _id, enabled: _enabled, ...rest } = w
  return rest
}

/**
 * The history after `before` became `after`. Nothing changes (the same object comes back) when only the id or the switch
 * did. A keyed edit joins the step before it when that came from the same key within COALESCE_MS, so a burst of typing
 * undoes at once; a new edit always clears redo.
 */
export function record(h: History, before: WorkflowInput, after: WorkflowInput, key: string | null, now: number): History {
  const was = undoable(before)
  const next = canon(undoable(after))
  if (canon(was) === next) return h
  const last = key === null ? null : { key, at: now }
  const joins = key !== null && h.last !== null && h.last.key === key && now - h.last.at <= COALESCE_MS && h.past.length > 0
  // A burst that ended where it began (typing, then the field's own Ctrl+Z) leaves no step: undoing it would change
  // nothing. The next typing then starts a step of its own rather than joining the edit before the burst.
  if (joins && canon(h.past[h.past.length - 1]) === next) return { past: h.past.slice(0, -1), future: [], last: null }
  const past = joins ? h.past : [...h.past, was].slice(-HISTORY_MAX)
  return { past, future: [], last }
}

/** A step back: the draft with the last undoable state, `enabled` and `id` kept; null when there is none. */
export function undo(h: History, current: WorkflowInput): { h: History; w: WorkflowInput } | null {
  const to = h.past[h.past.length - 1]
  if (!to) return null
  return {
    h: { past: h.past.slice(0, -1), future: [...h.future, undoable(current)], last: null },
    w: { ...to, id: current.id, enabled: current.enabled }
  }
}

export function redo(h: History, current: WorkflowInput): { h: History; w: WorkflowInput } | null {
  const to = h.future[h.future.length - 1]
  if (!to) return null
  return {
    h: { past: [...h.past, undoable(current)].slice(-HISTORY_MAX), future: h.future.slice(0, -1), last: null },
    w: { ...to, id: current.id, enabled: current.enabled }
  }
}
