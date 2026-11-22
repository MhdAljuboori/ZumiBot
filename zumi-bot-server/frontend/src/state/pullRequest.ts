import { GH_LOGGED_OUT, GH_MISSING, checksLine, prLabel } from '@zumibot/shared/pullRequest'
import type { ChatMeta, ChatPr, GhState, PrChecks } from '@zumibot/shared/types'

/** What the PR chip beside the git chip shows, or null when the chat has no pull request. */
export function prChipView(pr: ChatPr | undefined): { label: string; title: string; tone: 'done' | 'you' | 'busy' | 'quiet' } | null {
  if (!pr) return null
  const checks = checksLine(pr.checks)
  const lines = [`Pull request #${pr.number}`, pr.url, checks === null ? 'No checks reported' : checks]
  if (pr.error) lines.push(`Last read failed: ${pr.error}`)
  return { label: prLabel(pr), title: lines.filter(Boolean).join('\n'), tone: prTone(pr) }
}

/** How loudly the PR is drawn: a failing check wants the user, a merged one is done, a running one is busy. */
export function prTone(pr: Pick<ChatPr, 'state' | 'checks'>): 'done' | 'you' | 'busy' | 'quiet' {
  if (pr.checks?.status === 'failing') return 'you'
  if (pr.state === 'merged') return 'done'
  if (pr.state === 'closed') return 'quiet'
  return pr.checks?.status === 'pending' ? 'busy' : pr.checks?.status === 'passing' ? 'done' : 'quiet'
}

/** The sentence shown instead of any PR action when gh cannot be used; null once it can. */
export function ghNote(state: GhState | undefined): string | null {
  if (state === undefined || state === 'ready') return null
  return state === 'missing' ? GH_MISSING : GH_LOGGED_OUT
}

/** Whether a chat could have a pull request at all: it runs on a worktree branch that still exists. */
export const canOpenPr = (chat: Pick<ChatMeta, 'worktree'>): boolean => chat.worktree !== undefined && chat.worktree.removed !== true

/** "2 checks running" and friends, or a line saying none were reported. */
export const checksText = (checks: PrChecks | undefined): string => checksLine(checks) ?? 'No checks reported'
