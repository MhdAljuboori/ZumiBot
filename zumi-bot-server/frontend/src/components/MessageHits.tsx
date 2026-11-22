import { useEffect, useState } from 'react'
import type { SearchHit } from '@zumibot/shared/search'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { useMessageSearch } from '../net/useMessageSearch'
import { hitRows, segments, statusText } from '../state/messageSearch'

interface Props {
  query: string
  /** Every chat, archived ones too: a hit names its chat. */
  chats: ChatMeta[]
  /** Every agent, so a title's handles read as display names. */
  agents: readonly AgentSummary[]
  connected: boolean
  /** The hit last opened from here, drawn as selected. */
  openedKey: string | null
  onOpen: (hit: SearchHit) => void
}

/** The sidebar search's message hits from the server's index, under the agents and chats whose names match. */
export function MessageHits({ query, chats, agents, connected, openedKey, onOpen }: Props) {
  const search = useMessageSearch(query, connected)
  // The day labels move at midnight; a minute is fine-grained enough.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const rows = hitRows(search.hits, chats, now, agents)
  const status = statusText(search.result, search.loading, search.failed)
  return (
    <section className="message-hits" aria-label="Messages" data-testid="message-hits">
      <div className="hits-head">
        <span className="hits-label">Messages</span>
        <span className="hits-status" role="status" data-testid="message-hits-status">
          {status}
        </span>
      </div>
      {rows.map((r) => (
        <button
          key={r.key}
          type="button"
          className={r.key === openedKey ? 'row hit-row on' : 'row hit-row'}
          data-testid="message-hit"
          data-chat-id={r.hit.chatId}
          data-hit-item={r.hit.itemId}
          onClick={() => onOpen(r.hit)}
        >
          <span className="hit-line">
            <span className="hit-title">{r.title}</span>
            {r.archived && <span className="hit-tag">Archived</span>}
            <span className="hit-when">{r.when}</span>
          </span>
          <span className="hit-snippet">
            <span className="hit-who">{r.who}: </span>
            {segments(r.hit.snippet, r.hit.marks).map((s, i) => (s.mark ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
          </span>
        </button>
      ))}
      {search.result?.more && (
        <button
          type="button"
          className="row folder-more hits-more"
          data-testid="message-hits-more"
          disabled={search.loading}
          onClick={search.more}
        >
          {search.loading ? 'Loading…' : 'Show more'}
        </button>
      )}
    </section>
  )
}
