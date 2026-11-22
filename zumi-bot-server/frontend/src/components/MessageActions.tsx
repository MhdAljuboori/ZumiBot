import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { REACTIONS } from '@zumibot/shared/types'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'

// The reaction picker's width (8 emoji buttons and padding), so it can be kept inside the window.
const PICKER_WIDTH = 276

export function ReplyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6.5 3.5 2.75 7.25 6.5 11M3 7.25h6.25a4 4 0 0 1 4 4v1.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SmileIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.6 9.4a2.9 2.9 0 0 0 4.8 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6.1" cy="6.6" r="0.85" fill="currentColor" />
      <circle cx="9.9" cy="6.6" r="0.85" fill="currentColor" />
    </svg>
  )
}

export function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10.5 3.25A1.75 1.75 0 0 0 8.75 2.5h-4.5A1.75 1.75 0 0 0 2.5 4.25v4.5c0 .8.53 1.47 1.25 1.68"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function EditIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M10.25 2.75 13.25 5.75 6 13H3v-3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ResendIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13 8a5 5 0 1 1-1.5-3.55M13 2.75V5.5h-2.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ForkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4.25" cy="3.25" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.75" cy="3.25" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="12.75" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.25 4.75V6a2 2 0 0 0 2 2h3.5a2 2 0 0 0 2-2V4.75M8 8v3.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.5v7.25M5.25 7 8 9.75 10.75 7M2.75 10.25v1.5c0 .97.78 1.75 1.75 1.75h7c.97 0 1.75-.78 1.75-1.75v-1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function UnreadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.25 8.5v3.25a1.75 1.75 0 0 1-1.75 1.75h-7a1.75 1.75 0 0 1-1.75-1.75v-6A1.75 1.75 0 0 1 4.5 4H9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 5.25 8 8.75l1.6-1.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12.5" cy="4.25" r="2" fill="currentColor" />
    </svg>
  )
}

/** One action button; the same look beside user and agent messages. */
function ActionButton({
  testId,
  label,
  disabled,
  onClick,
  children
}: {
  testId: string
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="msg-action"
      data-testid={testId}
      aria-label={label}
      data-tip={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** The copy button: its icon turns into a check for a moment. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <ActionButton
      testId="copy-button"
      label={copied ? 'Copied' : 'Copy'}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false)
        )
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </ActionButton>
  )
}

/** A read-only chat (agent to agent): the only thing to do to a message is copy it. */
export function CopyActions({ text }: { text: string }) {
  return (
    <div className="msg-actions" data-testid="copy-actions">
      <CopyButton text={text} />
    </div>
  )
}

interface UserProps {
  /** The message's text, for Copy. */
  text: string
  /** Edit and Resend are absent while sending can't happen (offline, no claude); Copy and Fork stay. */
  onEdit?: () => void
  onResend?: () => void
  /** Absent where the engine can't fork (the `fork` cap). */
  onFork?: () => void
  /** That action's request is on its way: its button waits. */
  resendBusy: boolean
  forkBusy: boolean
}

/** The buttons beside a user message, shown while it is hovered. From the bubble outward: edit, resend, fork, copy. */
export function UserMessageActions({ text, onEdit, onResend, onFork, resendBusy, forkBusy }: UserProps) {
  return (
    <div className="msg-actions" data-testid="user-message-actions">
      <CopyButton text={text} />
      {onFork && (
        <ActionButton testId="fork-button" label="Fork" disabled={forkBusy} onClick={onFork}>
          <ForkIcon />
        </ActionButton>
      )}
      {onResend && (
        <ActionButton testId="resend-button" label="Resend" disabled={resendBusy} onClick={onResend}>
          <ResendIcon />
        </ActionButton>
      )}
      {onEdit && (
        <ActionButton testId="edit-button" label="Edit" onClick={onEdit}>
          <EditIcon />
        </ActionButton>
      )}
    </div>
  )
}

interface Props {
  /** The message's text, as the agent wrote it (markdown). */
  text: string
  onReply: () => void
  onReact: (emoji: string) => void
  /** Absent where Resend doesn't apply: only the latest answer resends the message above it. */
  onResend?: () => void
  resendBusy?: boolean
  /** Absent where the engine can't fork (the `fork` cap). */
  onFork?: () => void
  forkBusy: boolean
  onMarkUnread: () => void
  /** Opens Export with this reply picked; absent where no Export dialog can open (the island popup). */
  onExport?: () => void
}

/** The buttons beside an agent message, shown while it is hovered: react, reply, copy, resend, fork, export and mark unread. */
export function MessageActions({ text, onReply, onReact, onResend, resendBusy = false, onFork, forkBusy, onMarkUnread, onExport }: Props) {
  const [picker, setPicker] = useState<CSSProperties | null>(null)
  const closePicker = useCallback(() => setPicker(null), [])
  useDismiss(picker !== null, closePicker)
  // Its buttons grow on a touch screen, past PICKER_WIDTH.
  const pickerRef = useRef<HTMLDivElement>(null)
  useFitInViewport(pickerRef, picker)

  // The picker is fixed to the window, so scrolling the messages would leave it behind.
  useEffect(() => {
    if (picker === null) return
    window.addEventListener('scroll', closePicker, true)
    return () => window.removeEventListener('scroll', closePicker, true)
  }, [picker, closePicker])

  return (
    <div className={picker ? 'msg-actions open' : 'msg-actions'} data-testid="message-actions">
      <button
        type="button"
        className="msg-action"
        data-testid="react-button"
        aria-label="Add reaction"
        data-tip="Add reaction"
        aria-haspopup="menu"
        aria-expanded={picker !== null}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (picker) {
            setPicker(null)
            return
          }
          const r = e.currentTarget.getBoundingClientRect()
          const left = Math.max(8, Math.min(r.left, window.innerWidth - PICKER_WIDTH - 8))
          // Opens upward, unless the message is too close to the top of the window.
          setPicker(r.top > 56 ? { left, bottom: window.innerHeight - r.top + 4 } : { left, top: r.bottom + 4 })
        }}
      >
        <SmileIcon />
      </button>
      <button type="button" className="msg-action" data-testid="reply-button" aria-label="Reply" data-tip="Reply" onClick={onReply}>
        <ReplyIcon />
      </button>
      <CopyButton text={text} />
      {onResend && (
        <ActionButton testId="resend-button" label="Resend" disabled={resendBusy} onClick={onResend}>
          <ResendIcon />
        </ActionButton>
      )}
      {onFork && (
        <ActionButton testId="fork-button" label="Fork" disabled={forkBusy} onClick={onFork}>
          <ForkIcon />
        </ActionButton>
      )}
      {onExport && (
        <ActionButton testId="export-button" label="Export reply" onClick={onExport}>
          <ExportIcon />
        </ActionButton>
      )}
      <ActionButton testId="mark-unread-button" label="Mark unread" onClick={onMarkUnread}>
        <UnreadIcon />
      </ActionButton>
      {picker && (
        <div
          ref={pickerRef}
          className="menu reaction-menu"
          role="menu"
          aria-label="Reactions"
          data-testid="reaction-menu"
          style={picker}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              aria-label={`React with ${emoji}`}
              onClick={() => {
                onReact(emoji)
                setPicker(null)
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The reactions under an agent message; clicking one takes it off. */
export function Reactions({ emojis, onToggle }: { emojis: string[]; onToggle: (emoji: string) => void }) {
  return (
    <div className="reactions" data-testid="reactions">
      {emojis.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="reaction"
          aria-pressed="true"
          aria-label={`Remove reaction ${emoji}`}
          data-tip="Remove reaction"
          onClick={() => onToggle(emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}
