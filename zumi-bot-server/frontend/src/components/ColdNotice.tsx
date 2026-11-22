import { useEffect, useState } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { coldContexts, coldNotice } from '../state/contextMeter'

// Per chat, the contexts the user dismissed; it comes back once one of them runs again and later cools down.
const dismissed = new Map<string, string>()

interface Props {
  chat: ChatMeta
  agents: AgentSummary[]
  /** Why a compaction can't start now (offline, no CLI); null when it can. */
  blockedReason: string | null
  /** agent: the room member to compact. */
  onCompact: (note: string, agent?: string) => void
  /** False for an engine with no prompt cache to go cold (Codex): there is nothing to warn about. Default true. */
  cacheCools?: boolean
}

/**
 * Over the composer: the next message would reload a big context whose prompt cache expired, at full price.
 * Offers Compact first; the user may also just send.
 */
export function ColdNotice({ chat, agents, blockedReason, onCompact, cacheCools = true }: Props) {
  // The cache expires while the chat sits open, so the check runs again each minute.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const [, setHidden] = useState(0)
  const rows = cacheCools ? coldContexts(chat, agents, now) : []
  if (rows.length === 0) return null
  const key = rows.map((r) => `${r.member ?? ''}:${r.since}`).join(',')
  if (dismissed.get(chat.id) === key) return null
  return (
    <div className="cold-notice" role="status" data-testid="cold-notice">
      <span className="cold-notice-text">{coldNotice(rows, now)}</span>
      <div className="cold-notice-actions">
        {rows.map((r) => (
          <button
            key={r.member ?? ''}
            type="button"
            className="btn small primary"
            data-testid="cold-compact"
            disabled={blockedReason !== null}
            data-tip={blockedReason ?? undefined}
            onClick={() => onCompact('', r.member ?? undefined)}
          >
            {r.member === null ? 'Compact first' : `Compact ${displayName(r.member)}`}
          </button>
        ))}
        <button
          type="button"
          className="btn small"
          data-testid="cold-dismiss"
          onClick={() => {
            dismissed.set(chat.id, key)
            setHidden((n) => n + 1)
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
