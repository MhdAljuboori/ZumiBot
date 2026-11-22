import { useState, type CSSProperties } from 'react'
import { AgentBot } from '../Bot.tsx'
import { MODES, type ModeId } from '../showcase.ts'

const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` })

const OPTIONS = [
  { id: 'half', label: 'Half-up, once per order', desc: 'Round the total, not each line.' },
  { id: 'bank', label: "Banker's rounding", desc: 'Halves go to the nearest even cent.' },
  { id: 'other', label: 'Other', desc: '' }
] as const

function ModeCard({ mode }: { mode: ModeId }) {
  if (mode === 'plan')
    return (
      <div className="approval rise">
        <div className="row">
          <span className="lbl sel">Plan</span>
          <span className="muted small">nothing runs until you approve</span>
        </div>
        <ol className="plan">
          <li>
            Restore the <span className="code">orders.created_at</span> index in the migration
          </li>
          <li>Page exports by cursor, not offset</li>
          <li>Add a 50k-row test fixture and time it</li>
        </ol>
        <div className="composer slim">Feedback: skip step 3, we have a fixture…</div>
        <div className="row">
          <span className="btn pri">Approve</span>
          <span className="btn">Keep planning</span>
        </div>
      </div>
    )
  if (mode === 'edits')
    return (
      <>
        <div className="col-6">
          <div className="tool grow-in">
            Edit<span className="fg">db/migrations/0042_export.sql</span>
            <span className="push ok-text">auto-approved</span>
          </div>
          <div className="tool grow-in" style={delay(0.15)}>
            Edit<span className="fg">src/export/cursor.ts</span>
            <span className="push ok-text">auto-approved</span>
          </div>
        </div>
        <div className="approval rise" style={delay(0.35)}>
          <div className="row">
            <span className="lbl sel">Approval</span>
            <span className="status warn-text">medium risk</span>
          </div>
          <p>
            <strong>Reviewer</strong> wants to run <span className="code">npm run migrate -- --env staging</span>
          </p>
          <p className="muted small">
            Risk hint: writes to the staging database. Edits are auto-approved in this mode; commands still ask.
          </p>
          <div className="row">
            <span className="btn pri">Allow</span>
            <span className="btn">Deny</span>
          </div>
        </div>
      </>
    )
  return (
    <>
      <div className="approval rise">
        <div className="row">
          <span className="lbl sel">Approval</span>
          <span className="status ok-text">low risk</span>
        </div>
        <p>
          <strong>Reviewer</strong> wants to edit <span className="code">src/export/cursor.ts</span> <span className="muted">(+18 −6)</span>
        </p>
        <span className="remember">
          <span className="checkbox" aria-hidden="true" />
          Remember for edits in <span className="code">src/export/</span>
        </span>
        <div className="row">
          <span className="btn pri">Allow</span>
          <span className="btn">Deny</span>
        </div>
      </div>
      <div className="rise col-6" style={delay(0.3)}>
        <p className="lbl">Remembered approvals</p>
        <div className="tool">
          Edit<span className="fg">src/export/**</span>
          <span className="push">this chat</span>
        </div>
        <div className="tool">
          Bash<span className="fg">npm test*</span>
          <span className="push">always</span>
        </div>
      </div>
    </>
  )
}

/** The question card: pick an answer and send it, or skip. */
function QuestionCard() {
  const [pick, setPick] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const shown = done ? OPTIONS.filter((o) => o.id !== 'other') : OPTIONS
  return (
    <div className="win pad-14 col-8">
      <span className="ink-purple small">Reviewer</span>
      <div className={done ? 'question' : 'question waiting'}>
        <div className="row">
          <span className="tile q">?</span>
          <b className="small-14">A question for you</b>
        </div>
        <span className="qtag">ROUNDING</span>
        <p className="small-14">How should we round currency?</p>
        {shown.map((o) => (
          <button
            key={o.id}
            type="button"
            className={done && pick !== o.id ? 'option faded' : 'option'}
            aria-pressed={pick === o.id}
            disabled={done}
            onClick={() => setPick(o.id)}
          >
            <span className="radio">
              <span />
            </span>
            <span className="option-text">
              <b>{o.label}</b>
              {!done && o.desc !== '' && <span className="muted">{o.desc}</span>}
            </span>
          </button>
        ))}
        {done ? (
          <div className="row">
            <span className="small">{pick ? 'Answered' : 'Skipped'}</span>
            <button
              type="button"
              className="btn push"
              onClick={() => {
                setDone(false)
                setPick(null)
              }}
            >
              Ask again
            </button>
          </div>
        ) : (
          <div className="row wrap-row">
            <span className="muted small grow">Question 1 of 1</span>
            <button
              type="button"
              className="btn tall"
              onClick={() => {
                setPick(null)
                setDone(true)
              }}
            >
              Skip
            </button>
            <button type="button" className="btn pri tall" disabled={pick === null} onClick={() => setDone(true)}>
              Send answers
            </button>
          </div>
        )}
      </div>
      {!done && (
        <div className="row muted small">
          <AgentBot id="reviewer" size={18} working />
          <span className="spinner" aria-hidden="true" />
          Waiting for your answer…
        </div>
      )}
    </div>
  )
}

export function ControlScene({ cls }: { cls: string }) {
  const [mode, setMode] = useState<ModeId>('plan')
  const modeName = MODES.find((m) => m.id === mode)?.label ?? ''
  return (
    <section id="control" data-scene="control" className={`scene ${cls}`}>
      <div className="wrap stack-sm">
        <div className="split end">
          <div className="txt wide">
            <p className="lbl">05 · You stay in control</p>
            <h2 className="h2">Agents ask. I decide.</h2>
          </div>
          <div className="txt">
            <p className="lede">Every tool call can wait for a yes. Pick how much to trust a chat, and the cards change with it.</p>
          </div>
        </div>
        <div className="seg" role="group" aria-label="Permission mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="cols">
          <div className="win control-chat">
            <div className="winbar">
              <AgentBot id="reviewer" size={20} working />
              <span className="fg strong">Reviewer</span>
              <span className="chip sel">{modeName}</span>
              <span className="mono push">$0.42 today · cap $5</span>
            </div>
            <div className="win-body thread tall-330">
              <div className="ububble">Tighten the order export before Friday.</div>
              <ModeCard key={mode} mode={mode} />
            </div>
          </div>
          <div className="col control-side">
            <QuestionCard />
            <div className="win lift pad-16 col-8">
              <p className="lbl">Audit log</p>
              <div className="mono audit">
                <span>
                  <span className="muted">14:02</span> <span className="ok-text">allow</span> Bash npm test
                </span>
                <span>
                  <span className="muted">14:05</span> <span className="ok-text">auto</span> Edit cursor.ts
                </span>
                <span>
                  <span className="muted">14:06</span> <span className="err-text">deny</span> Bash rm -rf dist/
                </span>
                <span>
                  <span className="muted">14:09</span> <span className="warn-text">wait</span> Bash npm run migrate
                </span>
              </div>
              <p className="muted small">
                Runs sandboxed or in a container. Stops at the daily spend cap, and resumes on its own when a usage limit resets.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
