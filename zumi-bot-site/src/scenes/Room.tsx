import { useState, type CSSProperties } from 'react'
import { AgentBot } from '../Bot.tsx'
import { Glyph } from '../Glyph.tsx'
import { AGENTS, CAST, ROOM_ASKS, roomQueue, type CastId } from '../showcase.ts'

const ENGINE: Record<CastId, string> = { planner: 'Claude Code', coder: 'Claude Code', reviewer: 'Codex', ops: 'ACP' }
const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` })

export function RoomScene({ cls }: { cls: string }) {
  const [mention, setMention] = useState<CastId | null>(null)
  return (
    <section id="room" data-scene="room" className={`scene band ${cls}`}>
      <div className="wrap split rev">
        <div className="txt">
          <p className="lbl">04 · The group room</p>
          <h2 className="h2">A few agents, one table, one speaker at a time.</h2>
          <p className="lede">
            A moderator picks who answers next. An <span className="code">@mention</span> pulls a specific agent in. A queue shows who's up,
            and a hop cap stops the room from running in circles.
          </p>
          <ul className="facts">
            <li>Claude Code, Codex, ACP and AG-UI agents in the same room</li>
            <li>Clone a room with a summary to start fresh</li>
          </ul>
          <p className="muted small-14">Try it: tap a name in the composer.</p>
        </div>
        <div className="mock">
          <div className="win">
            <div className="winbar">
              <span className="fg strong">Launch checklist · Nov 18</span>
              <span className="chip">4 agents</span>
              <span className="chip mono">hop 3 / 8</span>
              <span className="push">moderator: on</span>
            </div>
            <div className="win-body room">
              <div className="table">
                {CAST.map((id, i) => (
                  <div key={id} className="seat">
                    <span className={`speak c-${AGENTS[id].color}`} style={delay(i * 2)}>
                      <span className="ring" style={delay(i * 2)} />
                      <AgentBot id={id} size={46} />
                    </span>
                    <span className="seat-name">{AGENTS[id].name}</span>
                    <span className="muted tiny">{ENGINE[id]}</span>
                  </div>
                ))}
                <span className="baton" />
              </div>
              <div className="col-10">
                <div className="say rise" style={delay(0.2)}>
                  <AgentBot id="planner" size={18} />
                  <p>
                    <strong>Planner</strong> Split the export work: <span className="mention">@coder</span> takes the API,{' '}
                    <span className="mention">@reviewer</span> checks the migration.
                  </p>
                </div>
                <div className="rise mono muted tiny indent" style={delay(0.5)}>
                  moderator → Coder (named by Planner)
                </div>
                <div className="say rise" style={delay(0.8)}>
                  <AgentBot id="coder" size={18} />
                  <p>
                    <strong>Coder</strong> Endpoint is up on <span className="code">/v1/export</span>. Streaming CSV, 10k rows per page.
                  </p>
                </div>
                <div className="say rise" style={delay(1.1)}>
                  <AgentBot id="reviewer" size={18} />
                  <p>
                    <strong>Reviewer</strong> Migration drops an index on <span className="code">orders.created_at</span>. Keep it.
                  </p>
                </div>
              </div>
              <div className="row wrap-row small">
                <span className="lbl">Queue</span>
                {roomQueue(mention).map((id, i) => (
                  <span key={id} className={i === 0 ? 'chip sel' : 'chip'}>
                    <span className={`dot c-${AGENTS[id].color}`} />
                    {AGENTS[id].name}
                  </span>
                ))}
              </div>
              <div className="composer wrap-row">
                <span className={mention ? 'composer-text fg' : 'composer-text'}>
                  {mention ? `@${mention} ${ROOM_ASKS[mention]}` : 'Message the room…'}
                </span>
                {CAST.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={mention === id ? 'chip sel mention-btn' : 'chip mention-btn'}
                    aria-pressed={mention === id}
                    onClick={() => setMention(mention === id ? null : id)}
                  >
                    @{id}
                  </button>
                ))}
                <span className="send">
                  <Glyph name="send" size={13} weight={2.6} />
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
