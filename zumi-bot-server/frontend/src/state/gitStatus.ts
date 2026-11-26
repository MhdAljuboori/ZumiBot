import type { ChatWorktree, GitStatus, WorktreeKeep } from '@zumibot/shared/types'

export interface GitChipView {
  label: string
  dirty: boolean
  muted: boolean
  title: string
}

/** What the header chip shows for a chat's git state. */
export function gitChipView(s: GitStatus, worktree?: ChatWorktree): GitChipView {
  const removed = s.removed === true
  const count = s.changed === 0 ? 'No uncommitted changes' : s.changed === 1 ? '1 uncommitted change' : `${s.changed} uncommitted changes`
  const first = removed ? `Worktree folder removed. Branch ${worktree?.branch ?? s.branch ?? s.head} is kept.` : count
  // The agent made a worktree of its own and works there: the status was read in it, so the chat's root would mislead.
  const where = s.agentTree ? `In the agent's worktree: ${s.agentTree}` : worktree ? `Worktree: ${worktree.root}` : null
  const lines = where === null ? [first] : [first, where]
  if (!removed) lines.push('Click to see the changes')
  return { label: s.branch ?? s.head, dirty: !removed && s.changed > 0, muted: removed, title: lines.join('\n') }
}

/** Refetch when a chat opens and when its turn ends; the status doesn't change while it runs, so a running chat is left alone. */
export function shouldRefetchGit(prev: { chatId: string; inFlight: boolean } | null, next: { chatId: string; inFlight: boolean }): boolean {
  return prev === null || prev.chatId !== next.chatId || (prev.inFlight && !next.inFlight)
}

// A Record, so a new WorktreeKeep reason fails to compile until it has text.
const KEPT_REASON: Record<WorktreeKeep, string> = {
  dirty: 'uncommitted changes',
  ignored: 'ignored files that would be lost',
  detached: 'detached HEAD',
  shared: 'another chat uses it',
  failed: 'removing its folder failed'
}

/** The extra line the archived note shows about the worktree, from what the background release left on the meta. */
export function worktreeArchiveLine(w: ChatWorktree | undefined): string | null {
  if (!w) return null
  if (w.removed) return `Its worktree folder was removed. Branch ${w.branch} is kept.`
  if (w.kept) return `Its worktree was kept: ${KEPT_REASON[w.kept]}.`
  return null
}
