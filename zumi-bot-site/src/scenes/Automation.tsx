import type { CSSProperties, ReactNode } from 'react'
import { AgentBot } from '../Bot.tsx'
import { Glyph, type GlyphName } from '../Glyph.tsx'

const ROUTINES: { name: string; when: string; glyph: GlyphName; on: boolean; open?: boolean }[] = [
  { name: 'Morning inbox sweep', when: 'Every day at 7:30 AM · next in 6h', glyph: 'clock', on: true, open: true },
  { name: 'Dependency bump', when: 'Mondays at 9:00 AM', glyph: 'clock', on: true },
  { name: 'Deploy on merge', when: 'Webhook · push to main', glyph: 'link', on: true },
  { name: 'Spend check', when: 'Every day at 5:00 PM · off', glyph: 'clock', on: false }
]

const RUNS = [
  { when: 'Today 07:30', cost: '$0.18' },
  { when: 'Yesterday 07:30', cost: '$0.21' },
  { when: 'Mon 11:02', cost: '$0.24', manual: true }
]

// The canvas is drawn at a fixed 790 x 350 (it scrolls sideways on a phone), so nodes sit at fixed points.
const at = (left: number, top: number, d: number): CSSProperties => ({ left, top, animationDelay: `${d}s` })

function Node({
  kind,
  pos,
  tone,
  ok = true,
  children
}: {
  kind: string
  pos: CSSProperties
  tone?: 'sel' | 'err'
  ok?: boolean
  children: ReactNode
}) {
  return (
    <div className={tone ? `wfn pop ${tone}` : 'wfn pop'} style={pos}>
      <p className="lbl">{kind}</p>
      <p>{children}</p>
      {ok && <span className="ok" />}
    </div>
  )
}

const COSTS = [
  { step: 'Inbox Clerk reads', visits: '2 visits', cost: '$0.31' },
  { step: 'total > €500?', cost: '$0.0004' },
  { step: 'Ask me first', cost: '$0' },
  { step: 'POST /ledger', cost: '$0' }
]

const DAY = [
  { time: '07:30', what: 'Inbox sweep routine runs', how: 'schedule' },
  { time: '09:12', what: 'Approval waits for me', how: 'webhook · deploy' },
  { time: '11:30', what: 'PR opened, CI green', how: 'hook · after stop' },
  { time: '17:00', what: 'Spend cap check', how: 'schedule' }
]

export function AutomationScene({ cls }: { cls: string }) {
  return (
    <section id="automation" data-scene="auto" className={`scene band ${cls}`}>
      <div className="wrap stack-sm">
        <div className="split end">
          <div className="txt wide">
            <p className="lbl">06 · Automation</p>
            <h2 className="h2">Work that starts without me.</h2>
          </div>
          <div className="txt">
            <p className="lede">
              Routines send a prompt on a schedule, from a webhook, from hooks or by hand. Workflows go on a canvas with branches, loops and
              approval gates. Anything that needs me lands in one Inbox.
            </p>
          </div>
        </div>

        <div className="win flexwrap">
          <div className="routines">
            <div className="sidehead">
              <span className="side-title">Routines</span>
              <span className="pill">4</span>
            </div>
            <div className="routine-list">
              {ROUTINES.map((r) => (
                <div key={r.name} className={r.open ? 'agrow flat on' : 'agrow flat'}>
                  <span className={r.open ? 'tile sm' : 'tile sm dim'}>
                    <Glyph name={r.glyph} size={14} weight={2} />
                  </span>
                  <div className="ell">
                    <div className="agname">
                      {r.name} {r.on && <span className="ok-text">●</span>}
                    </div>
                    <div className="agdesc">{r.when}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="routine-edit">
            <div className="row wrap-row">
              <h3 className="h3-17">Morning inbox sweep</h3>
              <span className="chip push">
                <span className="dot ok" />
                On
              </span>
              <span className="btn">Run now</span>
            </div>
            <div className="card">
              <div className="cardhead">
                <span className="tile">
                  <Glyph name="calendar" />
                </span>
                <div>
                  <h3>Trigger</h3>
                  <p className="muted small">When should this routine run?</p>
                </div>
                <span className="field push">Schedule</span>
              </div>
              <div className="row wrap-row small-13">
                <span className="field">Daily</span>
                <span className="muted">on</span>
                <span className="field">Every day</span>
                <span className="muted">at</span>
                <span className="field">7:30 AM</span>
                <span className="muted">local time</span>
              </div>
            </div>
            <div className="card">
              <div className="cardhead">
                <span className="tile">
                  <Glyph name="message" />
                </span>
                <div>
                  <h3>Send prompt</h3>
                  <p className="muted small">Choose the agent and the prompt to send.</p>
                </div>
                <span className="miniseg push">
                  <span className="on">Agent</span>
                  <span>Group</span>
                </span>
              </div>
              <div className="grid-2">
                <div className="col-4">
                  <span className="lbl">Agent</span>
                  <span className="field">
                    <AgentBot id="clerk" size={18} />
                    Inbox Clerk
                  </span>
                </div>
                <div className="col-4">
                  <span className="lbl">Chat</span>
                  <span className="field ell">New chat every run</span>
                </div>
              </div>
              <div className="field prompt">
                <span>
                  <span className="cmd">/sort-inbox</span> file the invoices and flag anything from the bank
                </span>
              </div>
              <p className="muted small">
                Start with / to run an agent's command. Usage limit hit: wait, then continue · spend cap per run: $1 · missed while off: run
                once when back.
              </p>
            </div>
          </div>
          <div className="runs">
            <div className="cardhead">
              <span className="tile">
                <Glyph name="history" />
              </span>
              <div>
                <h3>Recent runs</h3>
                <p className="muted small">Latest executions</p>
              </div>
            </div>
            <div className="run-list">
              {RUNS.map((r) => (
                <div key={r.when} className="run">
                  <span className="dot ok sm" />
                  {r.when}
                  {r.manual ? <span className="pill">manual</span> : <span className="muted">done</span>}
                  <span className="pill push">{r.cost}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="win">
          <div className="winbar">
            <span className="fg strong">Invoice intake</span>
            <span className="chip">run #38 · Done</span>
            <span className="chip mono">/run-workflow invoice-intake</span>
            <span className="chip push">Canvas</span>
            <span>Audit log</span>
          </div>
          <div className="flexwrap">
            <div className="canvas-scroll">
              <div className="canvas">
                <div className="group yellow">
                  <span>Read &amp; check</span>
                </div>
                <div className="group rose">
                  <span>Pay</span>
                </div>
                <svg width="790" height="350" viewBox="0 0 790 350" aria-hidden="true" className="edges">
                  <path className="draw ok" d="M170 88 L210 88" style={{ animationDelay: '.2s' }} />
                  <path className="draw ok" d="M360 88 L400 88" style={{ animationDelay: '.5s' }} />
                  <path className="draw ok" d="M550 88 C575 88 575 48 600 48" style={{ animationDelay: '.8s' }} />
                  <path className="draw" d="M475 116 L475 180" style={{ animationDelay: '.9s' }} />
                  <path className="draw ok" d="M675 76 L675 140" style={{ animationDelay: '1.1s' }} />
                  <path className="draw" d="M285 116 L285 180" style={{ animationDelay: '.7s' }} />
                  <path className="draw" d="M210 208 C182 208 182 104 210 104" style={{ animationDelay: '1s' }} />
                  <path className="fail" d="M675 196 L675 260" />
                </svg>
                <span className="rundot" />
                <Node kind="Trigger" pos={at(20, 60, 0)}>
                  New mail · invoices
                </Node>
                <Node kind="Agent" pos={at(210, 60, 0.3)}>
                  <span className="row gap-5">
                    <AgentBot id="clerk" size={14} />
                    Inbox Clerk reads
                  </span>
                </Node>
                <Node kind="Condition" pos={at(400, 60, 0.6)}>
                  total &gt; €500?
                </Node>
                <Node kind="Approval" pos={at(600, 20, 0.9)} tone="sel">
                  Ask me first
                </Node>
                <Node kind="HTTP" pos={at(600, 140, 1.2)}>
                  <span className="mono">POST /ledger</span>
                </Node>
                <Node kind="On failure" pos={at(600, 260, 1.4)} tone="err" ok={false}>
                  Notify · Inbox
                </Node>
                <Node kind="Notify" pos={at(400, 180, 1.0)} ok={false}>
                  Slack · #finance
                </Node>
                <Node kind="Loop" pos={at(210, 180, 0.8)}>
                  each attachment
                </Node>
                <div className="sticky-note pop sky" style={at(20, 170, 1.5)}>
                  Landlord invoices skip the gate.
                </div>
                <div className="sticky-note pop mint" style={at(20, 262, 1.6)}>
                  Weekdays only. Sub-workflow "archive" runs after POST.
                </div>
              </div>
            </div>
            <div className="run-side">
              <h3>Run</h3>
              <p className="muted small">Steps that ran more than once show how many times.</p>
              <p className="lbl">Run input</p>
              <div className="field mono small">invoice-2211.pdf</div>
              <p className="lbl">Cost</p>
              <div className="costs">
                {COSTS.map((c) => (
                  <span key={c.step}>
                    <span>
                      {c.step} {c.visits && <span className="muted">{c.visits}</span>}
                    </span>
                    <span className="mono">{c.cost}</span>
                  </span>
                ))}
                <span className="total">
                  <span>Total</span>
                  <span className="mono">$0.31</span>
                </span>
              </div>
              <p className="muted tiny">Saved history with restore. Inbox collects every gate and workflow message.</p>
            </div>
          </div>
        </div>

        <div className="card day">
          <div className="row">
            <AgentBot id="ops" size={24} working />
            <h3>A day in the life of Ops</h3>
            <span className="muted small push">scroll moves the clock</span>
          </div>
          <div className="clock-track">
            <span className="needle" />
          </div>
          <div className="day-grid">
            {DAY.map((d) => (
              <div key={d.time}>
                <p className="mono small">{d.time}</p>
                <p>{d.what}</p>
                <p className="muted small">{d.how}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
