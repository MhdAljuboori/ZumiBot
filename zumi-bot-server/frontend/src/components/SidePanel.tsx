import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SideQuestion } from '@zumibot/shared/btw'
import { COMMAND_PROMPT_MAX } from '@zumibot/shared/commands'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { errorMessage } from '../errors'
import { coarsePointer, keepFocus } from '../media'
import { agentColor } from '../state/bot'
import { findAgent } from '../state/groupChat'
import {
  groupThreads,
  pickChips,
  sideTexts,
  sideThreads,
  threadCountText,
  threadLine,
  threadOf,
  tooLong,
  type PickChip,
  type SideThread
} from '../state/sideQuestions'
import { SideBackButton } from './SidePanelMenu'
import { SideThreadView, type ThreadOpen } from './SideThreadView'

interface Props {
  chat: ChatMeta
  chats: readonly ChatMeta[]
  list: SideQuestion[]
  agents: AgentSummary[]
  /** Any entry of a thread: the panel opens the thread that holds it and shows that entry. */
  focusId: string | null
  focusRequest: number
  failed: boolean
  /** An A→B chat's source chat is still listed (always true elsewhere); its asker cannot answer without it. */
  sourceExists: boolean
  onRetry(): void
  /** One btw:ask for one text, resolving the new entry's id; the panel calls it once per text of a pick, in order. */
  onAsk(text: string): Promise<string>
  /** One btw:follow on the thread `threadId`. */
  onFollow(threadId: string, text: string): Promise<void>
  /** Back to the side panel's list. */
  onBack(): void
  onClose(): void
  /** Called with a thread's root id, the one its chip under the message carries. */
  onShowInChat(rootId: string): void
  onStop(id: string): Promise<void>
  onAgain(id: string): Promise<void>
  /** A link chip: the side entry another agent answered in its own chat. */
  onOpenLink(chatId: string, entryId: string): void
}

/** Enter asks, as in the composer: Shift+Enter is a new line, and so is Enter on a touch keyboard (Ctrl/Cmd+Enter asks there). */
export function askOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, ask: () => void): void {
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
  if (coarsePointer() && !e.metaKey && !e.ctrlKey) return
  e.preventDefault()
  ask()
}

/** The composer's round send button, labelled Ask. */
export function AskButton({ testId, disabled }: { testId: string; disabled: boolean }) {
  return (
    <button type="submit" className="send-btn" data-testid={testId} aria-label="Ask" data-tip="Ask" disabled={disabled} onMouseDown={keepFocus}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 13V3.5M3.75 7.5L8 3.25l4.25 4.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="sr-only">Ask</span>
    </button>
  )
}

export function AgentDot({ agents, name }: { agents: AgentSummary[]; name: string }) {
  const agent = findAgent(agents, name)
  const color = agent && agent.error === null ? agentColor(agent.color) : null
  return <span className="file-dot" aria-hidden="true" style={color ? { background: color } : undefined} />
}

export function SideTime({ at }: { at: number }) {
  const date = new Date(at)
  return (
    <time dateTime={date.toISOString()} data-tip={date.toLocaleString()}>
      {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </time>
  )
}

// The Dispatched agents dot classes: green pulsing while open, else the last entry's state (grey when done).
const DOT: Record<SideThread['status'], string> = { running: 'running', done: '', error: 'failed', stopped: 'stopped' }

// Hidden from screen readers: the row's line and the thread's entries already say Answering…, Stopped or the error.
export function ThreadDot({ thread }: { thread: SideThread }) {
  return <span className={`dispatch-dot ${DOT[thread.status]}`} aria-hidden="true" />
}

const LINE_CLASS = { live: 'dispatch-now', error: 'side-row-error', muted: 'dispatch-usage' } as const

const groupTime = (ms: number): string =>
  new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function SideRow({ thread: t, agents, onOpen }: { thread: SideThread; agents: AgentSummary[]; onOpen(): void }) {
  const { root } = t
  const line = threadLine(t)
  const count = threadCountText(t)
  return (
    <button
      type="button"
      className="dispatch-row side-row"
      data-testid="side-row"
      data-thread-id={t.id}
      data-status={t.status}
      onClick={onOpen}
    >
      <span className="dispatch-row-top">
        <ThreadDot thread={t} />
        <span className="dispatch-name side-row-title">{root.question}</span>
        {count !== null && (
          <span className="dispatch-type" data-testid="side-row-count">
            {count}
          </span>
        )}
        <span className="dispatch-chev" aria-hidden="true">
          ›
        </span>
      </span>
      <span className={`side-row-line ${LINE_CLASS[line.tone]}`} data-testid="side-row-line">
        {line.text}
      </span>
      <span className="side-row-meta">
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
      </span>
    </button>
  )
}

const chipColor = (chip: PickChip, agents: AgentSummary[]): string | null => {
  const agent = chip.agent ? findAgent(agents, chip.agent) : undefined
  return agent && agent.error === null ? agentColor(agent.color) : null
}

/** The question box at the top of the panel, with "Answer from" chips where there is a choice. */
function SideInput({
  chat,
  agents,
  sourceExists,
  list,
  text,
  onText,
  pick,
  onPick,
  onAsk,
  onAsked
}: {
  chat: ChatMeta
  agents: AgentSummary[]
  sourceExists: boolean
  list: SideQuestion[]
  text: string
  onText(text: string | ((prev: string) => string)): void
  pick: string
  onPick(key: string): void
  onAsk(text: string): Promise<string>
  onAsked(ids: string[]): void
}) {
  const chips = useMemo(() => pickChips(chat, agents, sourceExists, list), [chat, agents, sourceExists, list])
  // A pick that became unusable (Both once a slot fills, A once its chat is gone) falls back to the first usable chip.
  const chosen = (chips.find((c) => c.key === pick && c.disabled === null) ?? chips.find((c) => c.disabled === null))?.key ?? ''
  useEffect(() => {
    if (chosen !== pick) onPick(chosen)
  }, [chosen, pick, onPick])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const asking = useRef(false) // a guard, not `disabled`: a disabled box would drop its focus
  const box = useRef<HTMLTextAreaElement>(null)
  const texts = sideTexts(chat, chosen, text)

  const ask = async (): Promise<void> => {
    if (texts.length === 0 || asking.current) return
    if (tooLong(texts)) {
      setError(`Question is longer than ${COMMAND_PROMPT_MAX} characters`)
      box.current?.focus()
      return
    }
    asking.current = true
    setBusy(true)
    setError(null)
    const sent = text
    const ids: string[] = []
    let done = true
    // In order, so Both's second answer (the asker's) lands on top; the first failure stops the rest.
    for (const t of texts) {
      try {
        ids.push(await onAsk(t))
      } catch (e) {
        setError(errorMessage(e))
        done = false
        break
      }
    }
    // Text typed while the ask was in flight belongs to the next one.
    if (done) onText((prev) => (prev === sent ? '' : prev))
    asking.current = false
    setBusy(false)
    box.current?.focus()
    if (done) onAsked(ids)
  }
  return (
    <form
      className="side-ask"
      onSubmit={(e) => {
        e.preventDefault()
        void ask()
      }}
    >
      {chips.length > 0 && (
        <div className="side-picks" role="group" aria-label="Answer from">
          <span className="side-picks-label">Answer from</span>
          {chips.map((c) => {
            const color = chipColor(c, agents)
            return (
              <button
                key={c.key}
                type="button"
                className="side-pick"
                data-testid="side-pick"
                data-pick={c.key}
                aria-pressed={c.key === chosen}
                disabled={c.disabled !== null}
                data-tip={c.disabled ?? undefined}
                onClick={() => onPick(c.key)}
              >
                {c.agent && <span className="file-dot" style={color ? { background: color } : undefined} />}
                {c.label}
              </button>
            )
          })}
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={box}
          className="composer-input side-input"
          data-testid="side-input"
          rows={1}
          value={text}
          maxLength={COMMAND_PROMPT_MAX}
          placeholder="Ask a side question…"
          aria-label="Ask a side question"
          onChange={(e) => {
            onText(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => askOnEnter(e, () => void ask())}
        />
        <AskButton testId="side-ask" disabled={busy || texts.length === 0} />
      </div>
      {error && (
        <div className="side-error side-input-error" role="alert" data-testid="side-input-error">
          {error}
        </div>
      )}
    </form>
  )
}

/** The side panel's Side questions: one row per thread, and a row opens the thread in chat style. */
export function SidePanel({
  chat,
  chats,
  list,
  agents,
  focusId,
  focusRequest,
  failed,
  sourceExists,
  onRetry,
  onAsk,
  onFollow,
  onBack,
  onClose,
  onShowInChat,
  onStop,
  onAgain,
  onOpenLink
}: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const threads = useMemo(() => sideThreads(list), [list])
  const groups = useMemo(() => groupThreads(threads, groupTime), [threads])
  // The drafts live here, not in the boxes, so opening a thread and coming back loses no typed text or pick.
  // The panel is keyed by chat id, so every chat starts empty and on its default pick.
  const [askText, setAskText] = useState('')
  const [pick, setPick] = useState('')
  const [followTexts, setFollowTexts] = useState<Record<string, string>>({})
  // A request already listed opens its thread on the first render, so the list never flashes before it.
  const [open, setOpen] = useState<ThreadOpen | null>(() => {
    const t = focusId ? threadOf(threads, focusId) : undefined
    return t ? { id: t.id, focus: focusId } : null
  })

  // A focus request names any entry; it waits here until the list holds it.
  const handled = useRef<string | null>(open?.focus ? `${focusRequest}:${open.focus}` : null)
  useEffect(() => {
    if (!focusId) return
    const request = `${focusRequest}:${focusId}`
    if (handled.current === request) return
    const t = threadOf(threads, focusId)
    if (!t) return
    handled.current = request
    setOpen({ id: t.id, focus: focusId })
  }, [focusId, focusRequest, threads])

  // An id just asked may not be listed yet, so only a thread that was shown and then went away returns to the list.
  const thread = open === null ? undefined : threadOf(threads, open.id)
  const shown = useRef<string | null>(null)
  useEffect(() => {
    if (open === null) return
    if (thread) shown.current = open.id
    else if (shown.current === open.id) setOpen(null)
  }, [open, thread])

  if (open !== null && thread) {
    return (
      <SideThreadView
        key={thread.id}
        thread={thread}
        open={open}
        chat={chat}
        chats={chats}
        agents={agents}
        sourceExists={sourceExists}
        draft={followTexts[thread.id] ?? ''}
        onDraft={(text) =>
          setFollowTexts((prev) => ({ ...prev, [thread.id]: typeof text === 'function' ? text(prev[thread.id] ?? '') : text }))
        }
        onBack={() => setOpen(null)}
        onClose={onClose}
        onShowInChat={() => onShowInChat(thread.id)}
        onFollow={(text) => onFollow(thread.id, text)}
        onStop={onStop}
        onAgain={onAgain}
        onOpenLink={onOpenLink}
      />
    )
  }
  return (
    <aside className="files-panel side-panel" data-testid="side-panel" aria-label="Side questions">
      <header className="files-head">
        <span className="side-head-title">
          <SideBackButton onBack={onBack} />
          <span className="files-title">Side questions · {threads.length}</span>
        </span>
        <button type="button" className="icon-btn" data-testid="side-close" aria-label="Close side questions" onClick={onClose}>
          ✕
        </button>
      </header>
      <SideInput
        chat={chat}
        agents={agents}
        sourceExists={sourceExists}
        list={list}
        text={askText}
        onText={setAskText}
        pick={pick}
        onPick={setPick}
        onAsk={onAsk}
        // One question opens its thread to watch it and follow up; Both's two land on top of the newest-first list.
        onAsked={(ids) => {
          if (ids.length === 1) setOpen({ id: ids[0], focus: null, box: true })
          else listRef.current?.scrollTo({ top: 0 })
        }}
      />
      <div className="side-list" ref={listRef}>
        {failed && (
          <div className="file-note" role="alert">
            Couldn't load side questions.{' '}
            <button type="button" className="btn small" data-testid="side-retry" onClick={onRetry}>
              Retry
            </button>
          </div>
        )}
        {!failed && threads.length === 0 && <div className="file-note">No side questions yet.</div>}
        {groups.map((g) => (
          <section key={g.key} className="dispatch-group" data-testid="side-group">
            <div className="dispatch-group-head">{g.label}</div>
            {g.rows.map((t) => (
              <SideRow key={t.id} thread={t} agents={agents} onOpen={() => setOpen({ id: t.id, focus: null })} />
            ))}
          </section>
        ))}
      </div>
    </aside>
  )
}
