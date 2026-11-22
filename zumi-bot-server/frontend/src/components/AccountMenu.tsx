import { useCallback, useState, type CSSProperties } from 'react'
import { USAGE_PAGE_URL, type ClaudeAccount, type UsageWindow } from '@zumibot/shared/types'
import { codexRows, percentUsed, resetLabel, sessionPercent, updatedLabel } from '../state/usage'
import { useDismiss } from '../useDismiss'

interface Props {
  account: ClaudeAccount | null
  // undefined until the first claude status check resolves
  claudeFound: boolean | undefined
  /** The usage popup opened: App reads the account again, so the usage shown is the latest. */
  onOpen: () => void
  /** Opens Settings › Usage, the full breakdown. */
  onUsageDetails: () => void
}

function Limit({ label, window: w, style, now }: { label: string; window: UsageWindow; style: 'in' | 'at'; now: number }) {
  const used = percentUsed(w, now)
  return (
    <div className="limit" data-testid="usage-limit">
      <div className="limit-line">
        <span className="limit-name">{label}</span>
        <span className="limit-reset">{resetLabel(w, now, style)}</span>
        <span className="limit-used">{used}%</span>
      </div>
      <div className="limit-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used}>
        <span style={{ width: `${used}%` }} />
      </div>
    </div>
  )
}

/** The rail's Usage ring: filled to the session limit used; a click shows the plan's session and weekly usage. */
export function AccountMenu({ account, claudeFound, onOpen, onUsageDetails }: Props) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, close)
  const name = account?.name ?? ''
  const usage = account?.usage ?? null
  const now = Date.now()
  const codex = codexRows(account)
  const session = sessionPercent(account, now)
  // The ring and the missing-Claude dot are drawn only, so the name says what they show.
  const usageName = ['Usage', session === null ? null : `session ${session}%`, claudeFound === false ? 'Claude not found' : null]
    .filter(Boolean)
    .join(', ')

  return (
    // Stops mousedown so useDismiss leaves the popup open for clicks inside it and on its toggle.
    <div className="account" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="rail-btn"
        data-testid="sidebar-user"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={usageName}
        data-tip={usageName}
        onClick={() => {
          if (!open) onOpen()
          setOpen(!open)
        }}
      >
        <span className="usage-ring" style={{ '--used': `${session ?? 0}%` } as CSSProperties} aria-hidden="true">
          <span className="avatar">{(name || '?').charAt(0).toUpperCase()}</span>
        </span>
        {claudeFound === false && <span className="rail-dot claude-missing" data-testid="claude-missing" />}
      </button>
      {open && (
        <div className="usage-pop" role="dialog" aria-label="Plan usage limits" data-testid="usage-popover">
          <div className="account-id">
            <p className="account-name" data-testid="account-name" data-tip={name}>
              {name}
            </p>
            {account?.email && (
              <p className="account-email" data-testid="account-email" data-tip={account.email}>
                {account.email}
              </p>
            )}
            {claudeFound !== undefined && (
              <p className={claudeFound ? 'account-status' : 'account-status off'}>{claudeFound ? 'Online' : 'Claude not found'}</p>
            )}
          </div>
          <div className="menu-sep" />
          <div className="usage-head">
            <span className="usage-title">Plan usage limits{account?.plan ? ` · ${account.plan}` : ''}</span>
            <a className="usage-link" href={USAGE_PAGE_URL} target="_blank" rel="noreferrer" data-testid="usage-see-all" onClick={close}>
              See all
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
            </a>
          </div>
          {usage ? (
            <>
              {usage.session && <Limit label="Session limit" window={usage.session} style="in" now={now} />}
              {usage.weekly && <Limit label="Weekly · all models" window={usage.weekly} style="at" now={now} />}
              <p className="usage-note">{updatedLabel(usage.updatedAt, now)}</p>
            </>
          ) : (
            <p className="usage-note none">
              {account?.email
                ? 'No usage seen yet. It shows here after your next message.'
                : 'Sign in to Claude Code with a Claude plan to see its usage limits.'}
            </p>
          )}
          {codex.length > 0 && account?.codex && (
            <div data-testid="usage-codex">
              <div className="menu-sep" />
              <div className="usage-head">
                <span className="usage-title">Codex usage limits</span>
              </div>
              {codex.map((r) => (
                <Limit key={r.key} label={r.label} window={r.window} style={r.style} now={now} />
              ))}
              <p className="usage-note">{updatedLabel(account.codex.updatedAt, now)}</p>
            </div>
          )}
          <div className="menu-sep" />
          <button
            type="button"
            className="account-action"
            data-testid="usage-details"
            onClick={() => {
              close()
              onUsageDetails()
            }}
          >
            Usage details
          </button>
        </div>
      )}
    </div>
  )
}
