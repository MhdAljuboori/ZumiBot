// Pure helpers for editing, resending and stepping through versions of a user message.
import type { ChatItem, VersionInfo } from '@zumibot/shared/types'

/**
 * The user message Resend on this agent message sends again: only for the chat's latest agent message (in a room, the
 * room's last one), and the last user message above it. Null for anything else.
 */
export function resendTarget(items: readonly ChatItem[], agentItemId: string): string | null {
  let i = items.length - 1
  while (i >= 0 && items[i].type !== 'assistant') i--
  if (i < 0 || items[i].id !== agentItemId) return null
  for (i--; i >= 0; i--) if (items[i].type === 'user') return items[i].id
  return null
}

/** "2 / 3": the shown version, counted from 1. */
export const versionLabel = (v: VersionInfo): string => `${v.index + 1} / ${v.count}`

/** Whether the arrow in that direction leads to another version. */
export const canStep = (v: VersionInfo, dir: -1 | 1): boolean => v.index + dir >= 0 && v.index + dir < v.count

/**
 * Why the version arrows are off, shown as their tooltip, or null when a switch can go. The server refuses a switch
 * while the chat runs, so without a reason the arrows look broken.
 */
export function switchBlocked(s: { canAct: boolean; running: boolean; switching: boolean }): string | null {
  if (s.switching) return 'Switching versions…'
  // Offline or no CLI first: a running flag seen before the connection dropped may be stale.
  if (!s.canAct) return "Versions can't be switched while sending is unavailable"
  if (s.running) return 'Wait for the reply to finish to switch versions'
  return null
}

/** Ids drawn dimmed while this message is edited: everything after it, since Send moves it to the old version. */
export function dimmedAfter(items: readonly ChatItem[], editingId: string | null): ReadonlySet<string> {
  const at = editingId === null ? -1 : items.findIndex((i) => i.id === editingId)
  return new Set(at < 0 ? [] : items.slice(at + 1).map((i) => i.id))
}

/**
 * What Send does with an edit: blank text without files has nothing to send, unchanged text is a plain resend (no extra
 * version of different text), anything else is an edit. A `/` menu pick is a choice a resend can't carry, so it makes an edit.
 */
export function editOutcome(
  original: string,
  draft: string,
  hasAttachments: boolean,
  picked = false
): { kind: 'edit'; text: string } | { kind: 'resend' } | { kind: 'empty' } {
  // Compared trimmed, but sent as typed, like the composer: trimming the text would drop leading indentation.
  const blank = draft.trim() === ''
  if (blank && !hasAttachments) return { kind: 'empty' }
  return draft.trim() === original.trim() && !picked ? { kind: 'resend' } : { kind: 'edit', text: draft }
}

/** Whether an edit can stay open after the items changed: another tab may have switched versions and dropped the message. */
export const editStillValid = (items: readonly ChatItem[], editingId: string): boolean =>
  items.some((i) => i.type === 'user' && i.id === editingId)
