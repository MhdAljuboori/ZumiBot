import type { ChatWorktree, GitStatus } from '@zumibot/shared/types'
import { gitChipView } from '../state/gitStatus'
import { MenuIcon } from './MenuIcon'

/**
 * The chat's branch (or short sha when detached) and a dot while it has uncommitted changes. A click opens the side
 * panel's Changes (pressed while it shows) and closes it again; a removed worktree has nothing to show, so it stays locked.
 */
export function GitChip({
  status,
  worktree,
  open,
  onToggle
}: {
  status: GitStatus | null
  worktree?: ChatWorktree
  open: boolean
  onToggle: () => void
}) {
  if (status === null) return null
  const view = gitChipView(status, worktree)
  const classes = ['picker', 'set', 'git-chip', view.muted ? 'muted' : '', open ? 'open' : ''].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={classes}
      data-testid="chat-git"
      disabled={view.muted}
      aria-pressed={view.muted ? undefined : open}
      aria-label={view.muted ? undefined : `${view.label}: ${open ? 'hide' : 'show'} changes`}
      data-tip={view.title}
      onClick={onToggle}
    >
      <MenuIcon name="gitBranch" className="menu-icon git-icon" />
      <span className="picker-text">{view.label}</span>
      {view.dirty && (
        <span className="git-dirty" data-testid="chat-git-dirty" aria-label="Uncommitted changes">
          ●
        </span>
      )}
    </button>
  )
}
