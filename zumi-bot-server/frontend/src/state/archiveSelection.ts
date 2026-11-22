/**
 * The Archived list's ticked chats, and the row a shift click ranges from. Ticked rows a search hides stay ticked, but
 * only the shown ones are counted and acted on, so Delete never reaches a chat the user cannot see.
 */
export interface ArchivedPick {
  ids: readonly string[]
  anchor: string | null
}

export const NO_PICK: ArchivedPick = { ids: [], anchor: null }

/**
 * A click on a row's box. With shift and an anchor the list still shows, every row from the anchor to the clicked one
 * takes the clicked row's new state; otherwise only that row flips. Either way the clicked row is the next anchor.
 */
export function pickRow(pick: ArchivedPick, shown: readonly string[], id: string, range: boolean): ArchivedPick {
  const on = !pick.ids.includes(id)
  const from = pick.anchor === null ? -1 : shown.indexOf(pick.anchor)
  const to = shown.indexOf(id)
  const span = range && from >= 0 && to >= 0 ? shown.slice(Math.min(from, to), Math.max(from, to) + 1) : [id]
  const rest = pick.ids.filter((x) => !span.includes(x))
  return { ids: on ? [...rest, ...span] : rest, anchor: id }
}

/** What the bar counts and the actions touch: the ticked rows the list shows now, in list order. */
export function pickedShown(pick: ArchivedPick, shown: readonly string[]): string[] {
  return shown.filter((id) => pick.ids.includes(id))
}

/** Select all: every shown row joins the ticked ones. */
export function pickAll(pick: ArchivedPick, shown: readonly string[]): ArchivedPick {
  return { ids: [...pick.ids.filter((id) => !shown.includes(id)), ...shown], anchor: pick.anchor }
}

/** Forget chats that left the archive (deleted, or unarchived by a send), so one archived again comes back unticked. */
export function keepArchived(pick: ArchivedPick, archived: readonly string[]): ArchivedPick {
  const ids = pick.ids.filter((id) => archived.includes(id))
  if (ids.length === pick.ids.length) return pick
  return { ids, anchor: pick.anchor !== null && archived.includes(pick.anchor) ? pick.anchor : null }
}
