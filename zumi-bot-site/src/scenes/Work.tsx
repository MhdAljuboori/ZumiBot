import { useState } from 'react'
import { Glyph } from '../Glyph.tsx'
import type { AgentColor } from '../showcase.ts'

type Status = 'new' | 'todo' | 'blocked' | 'progress' | 'review' | 'done'
const STATUS_NAME: Record<Status, string> = {
  new: 'New',
  todo: 'To do',
  blocked: 'Blocked',
  progress: 'In progress',
  review: 'In review',
  done: 'Done'
}

interface Card {
  title: string
  by: string
  /** Initials on the assignee chip, and its color: an agent's, or the accent for you. */
  who: string
  tint: AgentColor | 'you'
  due: string
}

const you = (title: string, due: string): Card => ({ title, by: 'you', who: 'You', tint: 'you', due })

const BOARD: { status: Status; cards: Card[]; count?: number; empty?: string }[] = [
  { status: 'new', cards: [you('Price test for the winter menu', '9 days')] },
  {
    status: 'todo',
    cards: [
      you('Add oat milk to the order form', '6 days'),
      { title: 'Translate checkout errors to French', by: '@Planner', who: 'WS', tint: 'pink', due: '4 days' }
    ]
  },
  { status: 'blocked', cards: [], empty: 'No agent is waiting on you.' },
  { status: 'progress', cards: [{ title: 'Cursor pagination for order export', by: '@Planner', who: 'CO', tint: 'green', due: 'today' }] },
  { status: 'review', cards: [{ title: 'Keep the created_at index', by: '@Coder', who: 'RV', tint: 'purple', due: 'today' }] },
  {
    status: 'done',
    count: 52,
    cards: [
      { title: 'Fix cart rounding', by: 'you', who: 'CO', tint: 'green', due: 'today' },
      { title: 'Nightly backup routine', by: '@Zumi Bot', who: 'OP', tint: 'orange', due: 'Nov 16' }
    ]
  }
]

const ATTEMPTS = [
  { id: 'A', color: 'green', stats: '412/412 · +24 −9' },
  { id: 'B', color: 'purple', stats: '412/412 · +18 −6' },
  { id: 'C', color: 'blue', stats: '409/412 · +31 −4' }
] as const

const CHECKS = [
  { name: 'typecheck', time: '14s', delay: 0.6 },
  { name: 'unit · 412 tests', time: '1m 02s', delay: 1.3 },
  { name: 'e2e · checkout', time: '3m 40s', delay: 2.1 }
]

function Board() {
  return (
    <div className="win pad-18 col-14">
      <div className="row wrap-row">
        <h3 className="h3-18">To-dos</h3>
        <span className="pill">6 open</span>
        <span className="miniseg push">
          <span className="on">Kanban</span>
          <span>Grid</span>
        </span>
      </div>
      <div className="row wrap-row">
        <span className="field muted grow-260">Add a to-do…</span>
        <span className="btn pri h34">Add</span>
        <span className="field">Any assignee</span>
        <span className="field">Made by anyone</span>
      </div>
      <div className="board-scroll">
        <div className="board">
          {BOARD.map((col) => (
            <div key={col.status} className="column">
              <div className="column-head">
                <span className={`dot st-${col.status}`} />
                {STATUS_NAME[col.status]}
                <span className="pill">{col.count ?? col.cards.length}</span>
              </div>
              {col.empty && <div className="column-empty">{col.empty}</div>}
              {col.cards.map((c) => (
                <div key={c.title} className="panel lift todo">
                  <span className={col.status === 'done' ? 'todo-title strike' : 'todo-title'}>{c.title}</span>
                  <span className="todo-meta">
                    Status <span className={`status st-${col.status}`}>{STATUS_NAME[col.status]}</span>
                  </span>
                  <span className="todo-meta">
                    Created by <b>{c.by}</b>
                  </span>
                  <span className="row gap-6">
                    <span className={`who c-${c.tint}`}>{c.who}</span>
                    <span className="pill">{c.due}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function WorkScene({ cls }: { cls: string }) {
  const [keep, setKeep] = useState<string>('B')
  return (
    <section id="work" data-scene="work" className={`scene band ${cls}`}>
      <div className="wrap stack-sm">
        <div className="split end">
          <div className="txt wide">
            <p className="lbl">08 · The work board</p>
            <h2 className="h2">From to-do to merged.</h2>
          </div>
          <div className="txt">
            <p className="lede">
              To-dos come from me, from agents, from Slack. Agents pick cards up and work in their own git worktree. I comment on the diff,
              try a few attempts side by side, keep the best one, and watch CI.
            </p>
          </div>
        </div>
        <Board />
        <div className="cols">
          <div className="win diff-win">
            <div className="winbar">
              <span className="fg strong">Changes</span>
              <span className="chip mono">
                <Glyph name="branch" size={12} weight={1.5} />
                chat/export-cursor · +18 −6
              </span>
            </div>
            <div className="mono diff">
              <div className="diff-file">src/export/cursor.ts</div>
              <div className="dl">
                <span className="muted">41 </span> const rows = await db.orders
              </div>
              <div className="dl ddel">
                <span>42 </span>- .offset(page * 10_000)
              </div>
              <div className="dl dadd">
                <span>42 </span>+ .where("id", "&gt;", cursor)
              </div>
              <div className="dl dadd">
                <span>43 </span>+ .orderBy("id")
              </div>
              <div className="review-note">
                <p>
                  <strong>me</strong> Cursor needs <span className="code">created_at</span> too, or ties break badly.
                </p>
                <span className="chip sel">Sent to Coder</span>
              </div>
              <div className="dl last">
                <span className="muted">44 </span> .limit(10_000);
              </div>
            </div>
          </div>
          <div className="col work-side">
            <div className="win pad-14 col-10">
              <p className="lbl">Parallel attempts · 3 agents</p>
              <div className="attempts">
                {ATTEMPTS.map((a) => {
                  const kept = keep === a.id
                  return (
                    <div key={a.id} className={kept ? 'attempt kept' : 'attempt'}>
                      <span className="attempt-name">
                        <span className={`dot c-${a.color}`} />
                        Attempt {a.id}
                      </span>
                      <span className="mono muted tiny">{a.stats}</span>
                      <button
                        type="button"
                        className={kept ? 'btn h34 ok-text' : 'btn h34'}
                        aria-pressed={kept}
                        onClick={() => setKeep(a.id)}
                      >
                        {kept ? 'Kept' : 'Keep this one'}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="win pad-14 col-10">
              <div className="row">
                <p className="lbl">Pull request #214</p>
                <span className="status ok-text push">ready</span>
              </div>
              <p className="small-14">Export: cursor pagination, keep created_at index</p>
              <div className="checks">
                {CHECKS.map((c) => (
                  <span key={c.name}>
                    <span className="check" style={{ animationDelay: `${c.delay}s` }} />
                    {c.name}
                    <span className="mono muted push">{c.time}</span>
                  </span>
                ))}
              </div>
              <p className="muted small">Files panel keeps every version an agent touched, with restore.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
