import type { ItemsPush } from './chatView'

/**
 * Which pushed list a chat's items are, so a delta lands only on the list it was made from. A push that does not fit
 * (one was missed, the chat was loading, or it changes items before the loaded ones) is dropped, and a chat the user
 * has loaded reloads.
 */
export interface ItemSync {
  held: number | null // the number of the list the chat holds; null: none a delta can build on
  // Where the held items start in the chat's history, as last loaded or pushed. Older pages added since only lower
  // it, so this is never below the real start: a delta it lets through always lands on loaded items.
  start: number | null
  loading: boolean
  missed: number // the newest push dropped while a load was out; 0: none
}

export const unsynced: ItemSync = { held: null, start: null, loading: false, missed: 0 }

export interface SyncStep {
  next: ItemSync
  take: boolean
  reload: boolean
}

export function onItemsPush(s: ItemSync, p: ItemsPush, loaded: boolean): SyncStep {
  if (p.base === null) return { next: { ...s, held: p.seq, start: p.from }, take: true, reload: false }
  if (p.base === s.held && s.start !== null && p.from >= s.start) return { next: { ...s, held: p.seq }, take: true, reload: false }
  // The load out now may not include it; that is checked when it lands.
  if (s.loading) return { next: { ...s, held: null, missed: Math.max(s.missed, p.seq) }, take: false, reload: false }
  return { next: { ...s, held: null }, take: false, reload: loaded }
}

export const loadStarted = (s: ItemSync): ItemSync => ({ ...s, loading: true, missed: 0 })

export const loadFailed = (s: ItemSync): ItemSync => ({ ...s, loading: false, missed: 0 })

/** A load landed with the latest page of the list numbered `seq`, starting at `start`. */
export function onLoaded(s: ItemSync, seq: number, start: number): SyncStep {
  // A push that landed while it loaded may already be newer.
  const take = s.held === null || seq > s.held
  const held = take ? seq : (s.held as number)
  return { next: { held, start: take ? start : s.start, loading: false, missed: 0 }, take, reload: s.missed > held }
}
