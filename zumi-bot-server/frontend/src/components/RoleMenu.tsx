import { useCallback, useRef, useState } from 'react'
import { ROLE_MAX_CHARS } from '@zumibot/shared/types'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'

interface Props {
  /** The group's role text; '' when none. */
  role: string
  disabled?: boolean
  onSave: (role: string) => void
}

function RoleIcon() {
  return (
    <svg className="role-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 2h6l3 3v9H4z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
      <path d="M6 7.5h5M6 10h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** The group's Role chip with its popup: how this team works, read by every agent and the moderator. */
export function RoleChip({ role, disabled = false, onSave }: Props) {
  // Opens upward: the pickers sit at the bottom of the window.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const [text, setText] = useState(role)
  const close = useCallback(() => setPos(null), [])
  // Esc and a click outside drop the edit.
  useDismiss(pos !== null, close)
  const popupRef = useRef<HTMLDivElement>(null)
  useFitInViewport(popupRef, pos)
  return (
    <>
      <button
        type="button"
        className={['picker', 'role-chip', role.trim() !== '' && 'has-role', pos && 'open'].filter(Boolean).join(' ')}
        data-testid="role-chip"
        aria-haspopup="dialog"
        aria-expanded={pos !== null}
        disabled={disabled}
        data-tip={role.trim() !== '' ? role : 'Group role'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (pos) return close()
          const r = e.currentTarget.getBoundingClientRect()
          setText(role)
          setPos({ left: r.left, bottom: window.innerHeight - r.top + 4 })
        }}
      >
        <RoleIcon />
        <span className="picker-text">Role</span>
      </button>
      {pos && (
        <div
          ref={popupRef}
          className="menu role-popup"
          role="dialog"
          aria-label="Group role"
          data-testid="role-popup"
          style={{ left: pos.left, bottom: pos.bottom }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="role-title">
            <RoleIcon />
            Group role
          </div>
          <div className="role-sub">How this team works. Every agent and the moderator read it.</div>
          <textarea
            className="field role-input"
            data-testid="role-input"
            autoFocus
            rows={6}
            maxLength={ROLE_MAX_CHARS}
            placeholder="Who does what, and who waits for whom."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="role-actions">
            <button type="button" className="btn small" data-testid="role-cancel" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn small primary"
              data-testid="role-save"
              onClick={() => {
                onSave(text.trim())
                close()
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </>
  )
}
