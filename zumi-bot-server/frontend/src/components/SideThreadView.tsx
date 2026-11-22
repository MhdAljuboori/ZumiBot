import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { isOpen, type SideQuestion } from '@zumibot/shared/btw'
import { COMMAND_PROMPT_MAX } from '@zumibot/shared/commands'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { errorMessage } from '../errors'
import { mentionHandles } from '../state/agentAsk'
import { askLinkText, canAskAgain, canFollow, type SideThread } from '../state/sideQuestions'
import { Markdown, MentionScope } from './Markdown'
import { AgentDot, AskButton, SideTime, ThreadDot, askOnEnter } from './SidePanel'
import { SideBackButton } from './SidePanelMenu'

/** Why the panel shows a thread. A new object for every request, so a repeated focus on the same entry still scrolls. */
export interface ThreadOpen {
  id: string // any entry of the thread
  focus: string | null // an entry a focus request named: scrolled into view and focused
  box?: true // opened by the panel's own ask: the follow-up box takes the keyboard focus
}

// As in Dispatched agents: within this many pixels of the bottom, the reader is following it.
const AT_BOTTOM_PX = 60

function SideEntry({
  entry,
  thread,
  chats,
  agents,
  onStop,
  onAgain,
  onOpenLink
}: {
  entry: SideQuestion
  thread: SideThread
  chats: readonly ChatMeta[]
  agents: AgentSummary[]
  onStop(): Promise<void>
  onAgain(): Promise<void>
  onOpenLink(chatId: string, entryId: string): void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  const act = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await run()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="side-entry" data-testid="side-entry" data-side-id={entry.id} data-state={entry.state} tabIndex={-1}>
      {/* The user's question sits on the right like a chat message; one an agent asked sits on the left, marked as its. */}
      <div className={`side-bubble-row${entry.from ? ' from' : ''}`}>
        {entry.from && (
          <span className="side-who" data-testid="side-from">
            from <AgentDot agents={agents} name={entry.from} />
            {displayName(entry.from)}
          </span>
        )}
        <div className="side-bubble" data-testid="side-bubble">
          {entry.question}
        </div>
      </div>
      {entry.asks?.map((link) => {
        const gone = !chats.some((c) => c.id === link.chatId)
        return (
          <button
            key={`${link.chatId}:${link.entryId}`}
            type="button"
            className="side-ask-link"
            data-testid="side-ask-link"
            data-state={link.state}
            disabled={gone}
            onClick={() => onOpenLink(link.chatId, link.entryId)}
          >
            {link.state === 'running' && <span className="spinner" aria-label="Asking" />}
            {link.state === 'error' && (
              <span className="side-warning" aria-label="Error">
                ⚠
              </span>
            )}
            <AgentDot agents={agents} name={link.agent} />
            <span className="side-chip-text">
              {askLinkText(link)}
              {gone ? ' (deleted chat)' : ''}
            </span>
          </button>
        )
      })}
      {entry.state === 'picking' && (
        <div className="side-status" role="status">
          <span className="spinner" aria-hidden="true" /> Picking who answers…
        </div>
      )}
      {entry.answer !== '' && <Markdown text={entry.answer} live={entry.state !== 'done'} />}
      {entry.state === 'running' && (
        <div className="side-status" role="status">
          <span className="spinner" aria-hidden="true" /> Answering…
        </div>
      )}
      {entry.state === 'error' && (
        <div className="side-error" role="alert">
          {entry.error ?? 'Could not answer'}
        </div>
      )}
      {entry.state === 'stopped' && <div className="side-status">Stopped</div>}
      {error && (
        <div className="side-error" role="alert">
          {error}
        </div>
      )}
      <div className="side-actions">
        <button
          type="button"
          className="btn small"
          data-testid="side-copy"
          disabled={entry.answer === ''}
          onClick={() =>
            void navigator.clipboard.writeText(entry.answer).then(
              () => setCopied(true),
              () => setError('Could not copy answer')
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        {isOpen(entry) && (
          <button type="button" className="btn small" data-testid="side-stop" disabled={busy} onClick={() => void act(onStop)}>
            Stop
          </button>
        )}
        {canAskAgain(entry, thread) && (
          <button type="button" className="btn small" data-testid="side-again" disabled={busy} onClick={() => void act(onAgain)}>
            Ask again
          </button>
        )}
      </div>
    </article>
  )
}

/** The follow-up box pinned under the thread. */
function FollowBox({
  thread,
  chat,
  sourceExists,
  draft,
  onDraft,
  onFollow,
  onAsking,
  box
}: {
  thread: SideThread
  chat: ChatMeta
  sourceExists: boolean
  draft: string
  onDraft(text: string | ((prev: string) => string)): void
  onFollow(text: string): Promise<void>
  onAsking(): void
  box: RefObject<HTMLTextAreaElement | null>
}) {
  const reason = canFollow(thread, chat, sourceExists)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const asking = useRef(false)
  const noteId = useId()
  // An agent's question takes no follow-ups at all, so there is no box to wait on.
  if (thread.root.from) {
    return (
      <div className="side-ask side-follow">
        <div className="side-follow-note" data-testid="side-follow-note">
          {reason}
        </div>
      </div>
    )
  }
  const question = draft.trim()
  const ask = async (): Promise<void> => {
    if (question === '' || reason !== null || asking.current) return
    asking.current = true
    setBusy(true)
    setError(null)
    const sent = draft
    onAsking()
    try {
      await onFollow(question)
      // Text typed while the ask was in flight belongs to the next one.
      onDraft((prev) => (prev === sent ? '' : prev))
    } catch (e) {
      setError(errorMessage(e))
    }
    asking.current = false
    setBusy(false)
    // As the panel's own box: a click on Ask leaves the focus on the page, where Esc would close the panel.
    box.current?.focus()
  }
  return (
    <form
      className="side-ask side-follow"
      onSubmit={(e) => {
        e.preventDefault()
        void ask()
      }}
    >
      <div className="composer-box">
        {/* Only Ask waits on a running answer: the box stays editable, so the next follow-up can be typed meanwhile. */}
        <textarea
          ref={box}
          className="composer-input side-input"
          data-testid="side-follow-input"
          rows={1}
          value={draft}
          maxLength={COMMAND_PROMPT_MAX}
          placeholder="Ask a follow-up…"
          aria-label="Ask a follow-up"
          aria-describedby={reason !== null ? noteId : undefined}
          onChange={(e) => {
            onDraft(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => askOnEnter(e, () => void ask())}
        />
        <AskButton testId="side-follow" disabled={busy || reason !== null || question === ''} />
      </div>
      {reason !== null && (
        <div className="side-follow-note" id={noteId} data-testid="side-follow-note">
          {reason}
        </div>
      )}
      {error && (
        <div className="side-error side-input-error" role="alert" data-testid="side-follow-error">
          {error}
        </div>
      )}
    </form>
  )
}

/** One side thread in chat style: its questions as bubbles, each answer under its question, a follow-up box at the bottom. */
export function SideThreadView({
  thread: t,
  open,
  chat,
  chats,
  agents,
  sourceExists,
  draft,
  onDraft,
  onBack,
  onClose,
  onShowInChat,
  onFollow,
  onStop,
  onAgain,
  onOpenLink
}: {
  thread: SideThread
  open: ThreadOpen
  chat: ChatMeta
  chats: readonly ChatMeta[]
  agents: AgentSummary[]
  sourceExists: boolean
  draft: string
  onDraft(text: string | ((prev: string) => string)): void
  onBack(): void
  onClose(): void
  onShowInChat(): void
  onFollow(text: string): Promise<void>
  onStop(id: string): Promise<void>
  onAgain(id: string): Promise<void>
  onOpenLink(chatId: string, entryId: string): void
}) {
  const { root } = t
  const members = chat.group?.members
  const scope = useMemo(
    () => ({ members: mentionHandles(agents, chat.agentName, members ?? null), agents }),
    [members, chat.agentName, agents]
  )
  const ref = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const atBottom = useRef(true)
  const handled = useRef<ThreadOpen | null>(null)
  // Before paint, so neither the bottom nor the focused entry shows a frame late.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (handled.current !== open) {
      handled.current = open
      const target = open.focus ? el.querySelector<HTMLElement>(`[data-side-id="${CSS.escape(open.focus)}"]`) : null
      if (target) {
        target.scrollIntoView({ block: 'start' })
        target.focus({ preventScroll: true })
        // Measured now: a scroll that changed nothing fires no scroll event.
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX
        return
      }
      if (open.box) box.current?.focus({ preventScroll: true })
      atBottom.current = true
    }
    // Opened without a focus, or still at the bottom: show the newest; a reader who scrolled up stays put.
    if (atBottom.current) el.scrollTop = el.scrollHeight
  }, [t, open])

  return (
    <aside className="files-panel side-panel" data-testid="side-panel" aria-label="Side question">
      <header className="files-head">
        <span className="side-head-title">
          <SideBackButton onBack={onBack} />
          <span className="files-title side-thread-title" data-tip={root.question}>
            {root.question}
          </span>
        </span>
        <button type="button" className="icon-btn" data-testid="side-close" aria-label="Close side questions" onClick={onClose}>
          ✕
        </button>
      </header>
      <div
        className="side-list side-thread"
        data-testid="side-thread"
        data-thread-id={t.id}
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX
        }}
      >
        <div className="side-thread-meta" data-testid="side-thread-meta">
          <ThreadDot thread={t} />
          {root.agent && (
            <span className="side-who">
              <AgentDot agents={agents} name={root.agent} />
              {displayName(root.agent)}
            </span>
          )}
          {root.from && (
            <span className="side-who">
              from <AgentDot agents={agents} name={root.from} />
              {displayName(root.from)}
            </span>
          )}
          <SideTime at={root.askedAt} />
          <button type="button" className="file-show" data-testid="side-show" onClick={onShowInChat}>
            Show in chat
          </button>
        </div>
        <MentionScope.Provider value={scope}>
          {t.entries.map((entry) => (
            <SideEntry
              key={entry.id}
              entry={entry}
              thread={t}
              chats={chats}
              agents={agents}
              onStop={() => onStop(entry.id)}
              onAgain={() => onAgain(entry.id)}
              onOpenLink={onOpenLink}
            />
          ))}
        </MentionScope.Provider>
      </div>
      <FollowBox
        thread={t}
        chat={chat}
        sourceExists={sourceExists}
        draft={draft}
        onDraft={onDraft}
        onFollow={onFollow}
        // The new question lands at the bottom: follow it there, even after reading further up.
        onAsking={() => {
          atBottom.current = true
          const el = ref.current
          if (el) el.scrollTop = el.scrollHeight
        }}
        box={box}
      />
    </aside>
  )
}
