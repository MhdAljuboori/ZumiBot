import type { ChangedFile, ChangeStep } from './files'

/**
 * "Restore to before this change" in the Files panel: the file on disk must still be the change's kept after copy (or
 * still absent, for a delete), then the kept before copy is written back (or the file goes to the Trash, for a create).
 */
export const RESTORE_REFUSALS = {
  noBefore: "The file from before this change was not kept, so it can't be restored.",
  noAfter: "The file from after this change was not kept, so ZumiBot can't check that it is unchanged.",
  changed: 'The file was changed since. Nothing was restored.',
  running: 'Wait for the reply to finish, then restore.',
  gone: 'This change is no longer in the chat.',
  failed: "Couldn't restore the file."
} as const

export type RestoreRefusal = keyof typeof RESTORE_REFUSALS

/** What the disk must hold now, and what goes back. */
export interface RestorePlan {
  expect: { id: string } | { absent: true }
  put: { id: string } | { remove: true }
}

/**
 * The plan for undoing the steps `fromId`..`toId` of one file (both inclusive, oldest first): the first step's before
 * against the last step's after. Pure, so the panel greys the button out by the same rule the server refuses by.
 */
export function restorePlan(file: ChangedFile, fromId: string, toId: string): RestorePlan | { refused: RestoreRefusal } {
  const from = file.changes.findIndex((s) => s.id === fromId)
  const to = file.changes.findIndex((s) => s.id === toId)
  if (from < 0 || to < 0 || from > to) return { refused: 'gone' }
  const first = file.changes[from]
  const last = file.changes[to]
  const put = beforeOf(first)
  if (put === null) return { refused: 'noBefore' }
  const expect = afterOf(last)
  if (expect === null) return { refused: 'noAfter' }
  return { expect, put }
}

function beforeOf(s: ChangeStep): RestorePlan['put'] | null {
  if (s.before !== null) return { id: s.before }
  // A legacy step has op 'unknown', so only a recorded create counts as "the file did not exist".
  return s.op === 'create' ? { remove: true } : null
}

function afterOf(s: ChangeStep): RestorePlan['expect'] | null {
  if (s.after !== null) return { id: s.after }
  return s.why?.after === 'deleted' ? { absent: true } : null
}
