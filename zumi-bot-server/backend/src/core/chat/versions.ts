import type { ChatItem } from '@zumibot/shared/types'

// Message versions. The visible list holds one version of each edited message; the others sit here, away
// from every reader of the chat's items. Pure: callers store the result.
export type UserItem = Extract<ChatItem, { type: 'user' }>
export interface StoredVersion {
  user: UserItem
  tail: ChatItem[]
}
/**
 * list[current] is null: that version is the one on screen. The shown item's `versions.index` is the truth: after a
 * crash between a switch's item write and its last versions write, `current` can lag behind it, so both functions
 * below read the shown index first. They fall back to `current` when the set is missing (a lost file) or the index
 * is no slot of it.
 */
export interface VersionSet {
  current: number
  list: (StoredVersion | null)[]
}
export type Versions = Record<string, VersionSet> // by root id

/** The slot on screen: the shown item's own index (0 when unmarked) when this set has that slot, else `current`. */
function shownSlot(old: UserItem, set: VersionSet, known: boolean): number {
  // No marker on a message whose set exists: a failed first edit put the original back, which is slot 0.
  const i = old.versions?.index ?? (known ? 0 : undefined)
  return known && i !== undefined && i >= 0 && i < set.list.length ? i : set.current
}

/** An empty slot that is not the one on screen: a branch whose items never got written left it behind. */
const staleSlot = (set: VersionSet, cur: number): boolean => cur !== set.current && set.list[set.current] === null

const bare = ({ versions: _v, ...rest }: UserItem): UserItem => rest

function findVisible(items: readonly ChatItem[], userId: string): number {
  const i = items.findIndex((it) => it.id === userId && it.type === 'user')
  if (i < 0) throw new Error('Message not found')
  return i
}

export function branch(
  items: readonly ChatItem[],
  versions: Versions,
  userId: string,
  next: UserItem
): { items: ChatItem[]; versions: Versions; hidden: StoredVersion } {
  const at = findVisible(items, userId)
  const old = items[at] as UserItem
  const root = old.versions?.root ?? old.id
  const set = versions[root] ?? { current: 0, list: [null] }
  const hidden: StoredVersion = { user: bare(old), tail: items.slice(at + 1) }
  const cur = shownSlot(old, set, versions[root] !== undefined)
  const list = set.list.map((v, i) => (i === cur ? hidden : v))
  // The new version takes a stale empty slot over adding another one nobody can step to.
  const reuse = staleSlot(set, cur)
  if (!reuse) list.push(null)
  const current = reuse ? set.current : list.length - 1
  const shown: UserItem = { ...next, versions: { root, index: current, count: list.length } }
  return {
    items: [...items.slice(0, at), shown],
    versions: { ...versions, [root]: { current, list } },
    hidden
  }
}

export function switchTo(
  items: readonly ChatItem[],
  versions: Versions,
  userId: string,
  index: number
): { items: ChatItem[]; versions: Versions } {
  const at = findVisible(items, userId)
  const old = items[at] as UserItem
  const root = old.versions?.root ?? old.id
  const set = versions[root] ?? { current: 0, list: [null] }
  const cur = shownSlot(old, set, versions[root] !== undefined)
  if (index === cur) return { items: items as ChatItem[], versions }
  const slot = set.list[index]
  if (!slot) throw new Error('Version not found')
  let list = set.list.map((v, i) => (i === cur ? { user: bare(old), tail: items.slice(at + 1) } : i === index ? null : v))
  // Drop a stale empty slot; it is always the last one, so no other index moves.
  if (staleSlot(set, cur)) list = list.filter((_, i) => i !== set.current)
  const shown: UserItem = { ...slot.user, versions: { root, index, count: list.length } }
  return {
    items: [...items.slice(0, at), shown, ...slot.tail],
    versions: { ...versions, [root]: { current: index, list } }
  }
}

const slots = (versions: Versions): StoredVersion[] =>
  Object.values(versions).flatMap((s) => s.list.filter((v): v is StoredVersion => v !== null))

export function hiddenItems(versions: Versions): ChatItem[] {
  return slots(versions).flatMap((v) => [v.user, ...v.tail])
}

export function mapHidden(versions: Versions, fn: (i: ChatItem) => ChatItem): Versions {
  return Object.fromEntries(
    Object.entries(versions).map(([root, s]) => [
      root,
      {
        ...s,
        list: s.list.map((v) => (v ? { user: fn(v.user) as UserItem, tail: v.tail.map(fn) } : v))
      }
    ])
  )
}
