import { useCallback, useRef, useState } from 'react'
import { chatEngine, engineCaps, type Engine } from '@zumibot/shared/engine'
import { displayName } from '@zumibot/shared/frontmatter'
import { COMPACT_NOTE_MAX, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import {
  canCompact,
  compactAtOf,
  compactNoteShown,
  contextMeter,
  fullest,
  memberMeters,
  meterLimit,
  selfCompactText,
  tokens,
  type Meter
} from '../state/contextMeter'
import { findAgent, missingAgent } from '../state/groupChat'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'
import { BotIcon } from './BotIcon'
import { MenuIcon } from './MenuIcon'

const R = 6
const C = 2 * Math.PI * R

/** A ring filled to the share of the context used; amber near full. */
export function Ring({ meter, size = 16 }: { meter: Meter | null; size?: number }) {
  return (
    <svg className={meter?.warn ? 'context-ring warn' : 'context-ring'} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle className="context-ring-track" cx="8" cy="8" r={R} />
      {meter !== null && meter.fraction > 0 && (
        <circle
          className="context-ring-fill"
          cx="8"
          cy="8"
          r={R}
          strokeDasharray={`${meter.fraction * C} ${C}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  )
}

interface Props {
  chat: ChatMeta
  agents: AgentSummary[]
  /** Why a compaction can't start now (a reply running, offline); null when it can. */
  blockedReason: string | null
  /** agent: the room member to compact. */
  onCompact: (note: string, agent?: string) => void
  /** A single chat's engine: Codex takes no compact note, and an engine that cannot compact offers no Compact. Default Claude. A room's members go by their own. */
  engine?: Engine
  /** A room: opens the Clone room dialog, offered where the user sees the context filling up. */
  onCloneRoom?: () => void
}

/**
 * The context meter in the pickers row: a ring for the agent's context (a room's fullest member), opening a popover
 * with Compact. Hidden until a turn reports how full the context is.
 */
export function ContextMeter({ chat, agents, blockedReason, onCompact, engine = 'claude', onCloneRoom }: Props) {
  // Opens upward: the pickers sit at the bottom of the window.
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const [note, setNote] = useState('')
  const close = useCallback(() => setPos(null), [])
  useDismiss(pos !== null, close)
  const popupRef = useRef<HTMLDivElement>(null)
  useFitInViewport(popupRef, pos)
  // A single chat's ring fills up to where its agent compacts (its Compact at size), not to the whole window; Codex honours it too.
  const compactAt = chat.group ? undefined : compactAtOf(agents, chat.agentName)
  const rows = chat.group ? memberMeters(chat.group, agents) : null
  const meter = rows ? fullest(rows) : contextMeter(chat.context, compactAt)
  if (meter === null) return null

  // An engine whose Compact is off (a later probe failed) shows the ring alone, as Phase 1 did for Codex. A room member goes by its
  // own agent's engine.
  const engineOf = (member?: string): Engine => (member === undefined ? engine : chatEngine(chat, agents, member))
  const engineCompacts = engineCaps(engine).compact
  const takesNote = (e: Engine): boolean => engineCaps(e).compact && compactNoteShown(e)
  const singleReady = !rows && canCompact(chat.sessionId, chat.next) && blockedReason === null
  const compact = (agent?: string): void => {
    // Never a note for an engine that cannot take one, whatever the field held before.
    onCompact(compactNoteShown(engineOf(agent)) ? note : '', agent)
    setNote('')
    close()
  }
  const noteField = !(rows ? rows.some((r) => takesNote(engineOf(r.member))) : takesNote(engine)) ? null : (
    <input
      className="field context-note"
      data-testid="context-note"
      maxLength={COMPACT_NOTE_MAX}
      placeholder="Optional: what to keep"
      value={note}
      onChange={(e) => setNote(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && singleReady) compact()
      }}
    />
  )
  const c = chat.context
  return (
    <>
      <button
        type="button"
        className={pos ? 'picker context-chip open' : 'picker context-chip'}
        data-testid="context-chip"
        data-percent={meter.percent}
        aria-haspopup="dialog"
        aria-expanded={pos !== null}
        aria-label={meter.title}
        data-tip={meter.title}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (pos) return close()
          const r = e.currentTarget.getBoundingClientRect()
          setPos({ left: r.left, bottom: window.innerHeight - r.top + 4 })
        }}
      >
        <Ring meter={meter} />
      </button>
      {pos && (
        <div
          ref={popupRef}
          className="menu context-popup"
          role="dialog"
          aria-label="Context"
          data-testid="context-popup"
          style={{ left: pos.left, bottom: pos.bottom }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {rows ? (
            <>
              <div className="context-label">Context per member</div>
              {rows.map((row) => {
                const agent = findAgent(agents, row.member) ?? missingAgent(row.member)
                return (
                  <div
                    key={row.member}
                    className="context-member"
                    data-testid="context-member"
                    data-agent-name={row.member}
                    data-tip={row.meter?.title}
                  >
                    <BotIcon
                      icon={agent.icon}
                      color={agent.error === null ? agent.color : null}
                      builtIn={agent.builtIn}
                      working={false}
                      size={18}
                    />
                    <span className="context-member-name">{displayName(row.member)}</span>
                    <Ring meter={row.meter} />
                    <span className="context-member-use">
                      {row.meter === null
                        ? row.canCompact
                          ? '–'
                          : 'not started'
                        : row.meter.compacted
                          ? 'compacted'
                          : `${row.meter.percent}%`}
                    </span>
                    {engineCaps(engineOf(row.member)).compact && (
                      <button
                        type="button"
                        className="btn small"
                        data-testid="context-compact"
                        disabled={!row.canCompact || blockedReason !== null}
                        data-tip={blockedReason ?? undefined}
                        onClick={() => compact(row.member)}
                      >
                        Compact
                      </button>
                    )}
                  </div>
                )
              })}
              {noteField}
              {onCloneRoom && (
                <>
                  <div className="menu-sep" />
                  <button
                    type="button"
                    className="context-clone"
                    data-testid="context-clone"
                    onClick={() => {
                      close()
                      onCloneRoom()
                    }}
                  >
                    <MenuIcon name="copy" />
                    <span className="menu-text">Clone room…</span>
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <div className="context-label">Context</div>
              <div className="context-head">
                <Ring meter={meter} size={30} />
                <div>
                  <div className="context-amount">
                    {meter.compacted || c?.used == null ? (
                      'Compacted'
                    ) : (
                      <>
                        {tokens(c.used)} <span>/ {tokens(meterLimit(c.window ?? 0, compactAt))}</span>
                      </>
                    )}
                  </div>
                  <div className="context-sub">
                    {meter.compacted
                      ? `${c?.compacted ? `${tokens(c.compacted.pre)} → ${tokens(c.compacted.post)} · ` : ''}exact size after the next reply`
                      : `${meter.percent}% used`}
                  </div>
                </div>
              </div>
              <div className="context-sub">{selfCompactText(compactAt, c?.window ?? 0, engine)}</div>
              {noteField}
              {engineCompacts && (
                <div className="context-actions">
                  <button
                    type="button"
                    className="btn small primary"
                    data-testid="context-compact"
                    disabled={!singleReady}
                    data-tip={blockedReason ?? undefined}
                    onClick={() => compact()}
                  >
                    Compact now
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
}
