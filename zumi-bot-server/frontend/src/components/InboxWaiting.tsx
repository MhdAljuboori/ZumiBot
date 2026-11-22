import { Fragment, useEffect, useState } from 'react'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { inboxRows, rowKey, type AnsweredLine, type InboxAnswer, type WaitingEntry } from '../state/inbox'
import { InboxCard } from './InboxCard'

type Point = { x: number; y: number }
type HandoffEntry = Extract<WaitingEntry, { kind: 'handoff' }>

interface Props {
  /** The same list the rail counts. */
  entries: readonly WaitingEntry[]
  chats: readonly ChatMeta[]
  agents: readonly AgentSummary[]
  /** Answered here: held while the send is on its way, then a few seconds (the app keeps them, see useInboxHolds). */
  lines: readonly AnsweredLine[]
  /** Why an answer from here failed, by entry key. */
  errors: Record<string, string>
  onAnswer: (entry: WaitingEntry, answer: InboxAnswer) => void
  onOpenChat: (chatId: string) => void
  onOpenRun: (workflowId: string, runId: string) => void
  /** A card's Open to-do →: the board, with the card open. */
  onOpenTodo: (todoId: string) => void
  onShowDesktop: (chatId: string, agent: string, point: Point | null) => void
  onOpenLive: (entry: HandoffEntry) => void
}

const TICK_MS = 30_000 // "waiting N min" needs no finer clock

/**
 * The Waiting section. An entry answered here gives way at once to its result line; its card stays mounted but hidden
 * under the line (so it cannot be pressed twice and keeps what was typed in it) until the send settles. A failed send
 * shows the same card again, with the reason on it.
 */
export function InboxWaiting({
  entries,
  chats,
  agents,
  lines,
  errors,
  onAnswer,
  onOpenChat,
  onOpenRun,
  onOpenTodo,
  onShowDesktop,
  onOpenLive
}: Props) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [])

  // The app drops expired lines itself; the clock here is only for "waiting N min", so lines are judged at this render.
  const rows = inboxRows(entries, lines, Date.now())
  if (rows.length === 0) {
    return (
      <div className="file-note" data-testid="inbox-waiting-empty">
        Nothing is waiting for you.
      </div>
    )
  }
  return (
    <>
      {rows.map((row) => {
        const line = row.kind === 'answered' ? row.line : null
        const e = row.entry
        const chat = e === null || e.kind === 'workflow' || e.kind === 'todo' ? undefined : chats.find((c) => c.id === e.chatId)
        // Same key and same child slots either way, so the card is the same component under its line.
        return (
          <Fragment key={rowKey(row)}>
            {line && (
              <div className={line.no ? 'inbox-done no' : 'inbox-done'} data-testid="inbox-answered" role="status">
                {line.text}
              </div>
            )}
            {e && (
              <InboxCard
                entry={e}
                held={line !== null}
                chats={chats}
                agents={agents}
                now={now}
                chatRunning={chat?.inFlight ?? false}
                error={line === null ? (errors[e.key] ?? null) : null}
                onAnswer={(a) => onAnswer(e, a)}
                onOpen={() =>
                  e.kind === 'workflow'
                    ? onOpenRun(e.approval.workflowId, e.approval.runId)
                    : e.kind === 'todo'
                      ? onOpenTodo(e.item.id)
                      : onOpenChat(e.chatId)
                }
                onShowDesktop={(agent, point) => {
                  if (e.kind === 'card' || e.kind === 'handoff') onShowDesktop(e.chatId, agent, point)
                }}
                onOpenLive={() => {
                  if (e.kind === 'handoff') onOpenLive(e)
                }}
              />
            )}
          </Fragment>
        )
      })}
    </>
  )
}
