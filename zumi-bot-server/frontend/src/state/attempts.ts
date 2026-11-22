import { ATTEMPTS_MAX, ATTEMPTS_MIN, type TodoAttempt, type TodoItem } from '@zumibot/shared/todos'
import { attemptLabel, attemptState, attemptTone, type AttemptChat, type AttemptState } from '@zumibot/shared/attempts'
import type { AgentSummary, ChatMeta, GitChanges } from '@zumibot/shared/types'
import { shortAgo } from './islandView'

/** One row under the card: the attempt, its chat and what that chat is doing. */
export interface AttemptRow {
  attempt: TodoAttempt
  chat: ChatMeta | undefined
  state: AttemptState
  label: string
  tone: ReturnType<typeof attemptTone>
  /** The kept attempt of a decided set. */
  winner: boolean
}

/** A row per attempt, in the set's own order, read from the chat list and approval counts the app already holds. */
export function attemptRows(item: TodoItem, chats: readonly ChatMeta[], approvals: Readonly<Record<string, number>>): AttemptRow[] {
  const set = item.attempts
  if (!set) return []
  return set.attempts.map((attempt) => {
    const chat = chats.find((c) => c.id === attempt.chatId)
    const state = attemptState(chat as AttemptChat | undefined, approvals[attempt.chatId] ?? 0)
    return { attempt, chat, state, label: attemptLabel(state, chat), tone: attemptTone(state), winner: set.winner === attempt.chatId }
  })
}

/** "3 files · +40 −12", or what is known instead: nothing changed, or the list could not be read. */
export function changesLabel(changes: GitChanges | null | undefined): string {
  if (changes === undefined) return '…'
  if (changes === null) return 'no diff'
  const files = changes.files.length + changes.more
  if (files === 0) return 'nothing yet'
  let added = 0
  let removed = 0
  for (const f of changes.files) {
    added += f.added ?? 0
    removed += f.removed ?? 0
  }
  const counts = [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(Boolean).join(' ')
  return `${files} ${files === 1 ? 'file' : 'files'}${counts === '' ? '' : ` · ${counts}`}`
}

/** How long the attempt has been going: since the set started, or until its last reply landed. */
export function durationLabel(setAt: number, chat: ChatMeta | undefined, now: number): string {
  const end = chat?.inFlight ? now : (chat?.replyAt ?? now)
  return shortAgo(setAt, Math.max(setAt, end))
}

/** Exactly two picked rows compare side by side; one or three has nothing to show. */
export const canCompare = (picked: readonly string[]): boolean => picked.length === 2

/** Ticking a row for Compare: at most two stay ticked, the oldest dropping out, so a third click just moves the pair. */
export function togglePick(picked: readonly string[], chatId: string): string[] {
  if (picked.includes(chatId)) return picked.filter((id) => id !== chatId)
  return [...picked, chatId].slice(-2)
}

// ---------- The Run attempts dialog ----------

/** The dialog starts on two rows: the card's agent if it has one, else the first agents by name. */
export function defaultPicks(agents: readonly AgentSummary[], assignee: string | undefined): string[] {
  const names = agents.map((a) => a.name)
  const first = assignee && assignee !== 'user' && names.includes(assignee) ? assignee : names[0]
  if (first === undefined) return []
  return [first, names.find((n) => n !== first) ?? first]
}

export const canAddPick = (picks: readonly string[]): boolean => picks.length < ATTEMPTS_MAX
export const canDropPick = (picks: readonly string[]): boolean => picks.length > ATTEMPTS_MIN

export function addPick(picks: readonly string[], agents: readonly AgentSummary[]): string[] {
  if (!canAddPick(picks)) return [...picks]
  const next = agents.map((a) => a.name).find((n) => !picks.includes(n)) ?? picks[picks.length - 1] ?? agents[0]?.name
  return next === undefined ? [...picks] : [...picks, next]
}

export const dropPick = (picks: readonly string[], i: number): string[] =>
  canDropPick(picks) ? picks.filter((_, n) => n !== i) : [...picks]
export const setPick = (picks: readonly string[], i: number, agent: string): string[] => picks.map((p, n) => (n === i ? agent : p))

/** What the dialog says a set will do to the folder. */
export function folderLine(folder: string | undefined, isolated: boolean | undefined): string {
  if (!folder) return 'Pick the folder its chats run in first.'
  if (isolated === undefined) return `Each attempt gets its own worktree beside ${folder}.`
  return isolated
    ? `Each attempt gets its own worktree beside ${folder}, all from the commit it is on now.`
    : `${folder} does not isolate in worktrees. Turn "Isolate in worktree" on for it in a new chat there, then run attempts.`
}
