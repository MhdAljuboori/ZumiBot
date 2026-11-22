import type { ReactNode } from 'react'
import type { InboxFilter } from '../state/inbox'

interface Props {
  filter: InboxFilter
  onFilter: (f: InboxFilter) => void
  /** The Waiting section's content, empty state included. */
  waiting: ReactNode
  /** The Messages section's content. */
  messages: ReactNode
  waitingCount: number
  newCount: number
}

const CHIPS: Array<{ id: InboxFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'messages', label: 'Messages' }
]

/** The Inbox: what waits on the user and the messages workflows left, one stream with a filter. */
export function InboxPage(p: Props) {
  const chipText = (id: InboxFilter, label: string): string =>
    id === 'waiting' && p.waitingCount > 0
      ? `${label} ${p.waitingCount}`
      : id === 'messages' && p.newCount > 0
        ? `${label} · ${p.newCount} new`
        : label
  return (
    <section className="inbox-page" data-testid="inbox-page" aria-label="Inbox">
      <header className="inbox-head">
        <h2>Inbox</h2>
        <div className="inbox-chips" role="group" aria-label="Filter">
          {CHIPS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={p.filter === id ? 'inbox-chip on' : 'inbox-chip'}
              data-testid={`inbox-chip-${id}`}
              aria-pressed={p.filter === id}
              onClick={() => p.onFilter(id)}
            >
              {chipText(id, label)}
            </button>
          ))}
        </div>
      </header>
      <div className="inbox-body">
        <div className="inbox-inner">
          {/* Each section is hidden, not removed, under the other chip: a card keeps what was typed in it, a delete its
              Undo and the archived list its fold. */}
          <section className="inbox-section" data-testid="inbox-waiting" aria-label="Waiting for you" hidden={p.filter === 'messages'}>
            <div className="inbox-group">Waiting for you{p.waitingCount > 0 ? ` · ${p.waitingCount}` : ''}</div>
            {p.waiting}
          </section>
          <section className="inbox-section" data-testid="inbox-messages" aria-label="Messages" hidden={p.filter === 'waiting'}>
            <div className="inbox-group">Messages</div>
            {p.messages}
          </section>
        </div>
      </div>
    </section>
  )
}
