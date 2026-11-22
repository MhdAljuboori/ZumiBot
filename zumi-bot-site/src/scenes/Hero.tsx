import { AgentBot, Bot } from '../Bot.tsx'
import { Glyph, Pointer, type GlyphName } from '../Glyph.tsx'
import { AGENTS, type AgentId } from '../showcase.ts'

function AgentRow({
  id,
  desc,
  on = false,
  working = false,
  tag
}: {
  id: AgentId
  desc: string
  on?: boolean
  working?: boolean
  tag?: string
}) {
  return (
    <div className={on ? 'agrow on' : 'agrow'}>
      <AgentBot id={id} size={30} working={working} />
      <div className="grow ell">
        <div className="agname">
          {AGENTS[id].name}
          {tag && <span className="pill tag">{tag}</span>}
        </div>
        <div className="agdesc ell">{desc}</div>
      </div>
    </div>
  )
}

const RAIL: { glyph: GlyphName; on?: boolean; badge?: number }[] = [
  { glyph: 'search' },
  { glyph: 'bell' },
  { glyph: 'agents', on: true },
  { glyph: 'routines' },
  { glyph: 'workflows' },
  { glyph: 'todos', badge: 3 },
  { glyph: 'inbox' }
]

/** The app as it opens: rail and sidebar on the canvas, a chat in the floating pane, the island on the edge. */
function AppWindow() {
  return (
    <div className="win app">
      <div className="rail">
        <span className="rail-logo">
          <Bot zumi size={24} />
        </span>
        {RAIL.map((r) => (
          <span key={r.glyph} className={r.on ? 'ricon on' : 'ricon'}>
            <Glyph name={r.glyph} size={17} />
            {r.badge !== undefined && <span className="badge">{r.badge}</span>}
          </span>
        ))}
        <span className="rail-avatar">M</span>
      </div>

      <div className="side">
        <div className="sidehead">
          <span className="side-title">Agents</span>
          <span className="pill">8</span>
          <span className="side-btns">
            <span className="sqbtn">
              <Glyph name="plus" size={12} weight={2.2} />
            </span>
            <span className="sqbtn">
              <Glyph name="search" size={12} weight={2.2} />
            </span>
          </span>
        </div>
        <div className="grouphead">TIDEPOOL</div>
        <AgentRow id="planner" desc="Splits work into cards and hands them out" />
        <AgentRow id="coder" desc="Builds features and fixes bugs in web-app" on working />
        <AgentRow id="reviewer" desc="Reads every diff before it merges" tag="CODEX" />
        <AgentRow id="ops" desc="Deploys, backups and the nightly jobs" working />
        <AgentRow id="wordsmith" desc="UI copy in English, French and Spanish" />
        <div className="grouphead">ROOMS</div>
        <div className="agrow">
          <span className="stack">
            <span>
              <AgentBot id="planner" size={16} />
            </span>
            <span>
              <AgentBot id="reviewer" size={16} />
            </span>
            <span className="more">+2</span>
          </span>
          <div className="grow ell">
            <div className="agname ell small">Launch checklist · Nov 18</div>
            <div className="agdesc">web-app</div>
          </div>
        </div>
        <div className="side-foot">
          <div className="agrow">
            <Bot zumi size={30} />
            <div className="grow ell">
              <div className="agname">Zumi Bot</div>
              <div className="agdesc ell">Built-in. Makes agents, routines and workflows</div>
            </div>
          </div>
        </div>
      </div>

      <div className="pane">
        <div className="pane-head">
          <AgentBot id="coder" size={22} />
          <strong>Coder</strong>
          <span className="muted ell">fix checkout tests</span>
          <span className="chip mono push">
            <Glyph name="branch" size={12} weight={1.5} />
            chat/fix-rounding
          </span>
          <span className="chip mono muted">$0.18</span>
        </div>
        <div className="pane-body">
          <div className="ububble h-msg">Tests fail on main since the cart refactor. Can you look?</div>
          <div className="turn">
            <AgentBot id="coder" size={28} working />
            <div className="turn-body">
              <div className="turn-who">
                <strong>Coder</strong>
                <span className="muted h-work">working…</span>
              </div>
              <div className="tool h-tool">
                <Glyph name="file" size={13} weight={1.5} />
                Read<span className="fg">src/cart/total.ts</span>
                <span className="push">48 lines</span>
              </div>
              <div className="approval h-card">
                <div className="row">
                  <span className="lbl sel">Approval</span>
                  <span className="muted small">Bash · low risk</span>
                </div>
                <p>
                  <strong>Coder</strong> wants to run <span className="code">npm test -- cart</span>
                </p>
                <div className="stacked">
                  <div className="h-ask btns">
                    <span className="btn pri h-allow">Allow</span>
                    <span className="btn">Deny</span>
                    <span className="btn dashed">Always for this chat</span>
                    <Pointer className="h-cursor" />
                  </div>
                  <div className="h-done done">
                    <Glyph name="check" size={18} weight={2.4} />
                    Allowed · ran in 3.8s
                  </div>
                </div>
              </div>
              <p className="h-r1">
                <span className="code">3 failed</span> → <span className="code">0 failed</span>. Rounding had moved into{' '}
                <span className="code">formatPrice()</span>.
              </p>
              <p className="h-r2 muted">
                I put it back in <span className="code">cartTotal()</span> and added a test for 0.1 + 0.2.
              </p>
            </div>
          </div>
          <div className="pane-foot">
            <div className="composer">
              <Glyph name="attach" size={15} />
              <span className="grow">Describe a task or ask a question</span>
              <Glyph name="mic" size={15} />
              <span className="send">
                <Glyph name="send" size={13} weight={2.6} />
              </span>
            </div>
            <div className="composer-meta">
              <span>Mode: Ask permissions</span>
              <span>Folder: web-app</span>
              <span>Opus · high</span>
            </div>
          </div>
        </div>
      </div>

      <div className="island">
        <span className="itile">
          <Bot zumi size={22} />
        </span>
        <span className="itile">
          <AgentBot id="coder" size={22} working />
        </span>
        <span className="itile">
          <AgentBot id="ops" size={22} working />
        </span>
        <span className="itile">
          <AgentBot id="wordsmith" size={22} />
        </span>
      </div>
    </div>
  )
}

export function Hero({ cls, release }: { cls: string; release: { version: string; date: string } | null }) {
  return (
    <section data-scene="hero" className={`hero ${cls}`}>
      <div className="wrap stack-lg">
        <div className="split end">
          <div className="txt hero-head">
            {release && (
              <a href="#release" className="chip release-chip">
                <span className="dot ok" />
                Latest release v{release.version}
                {release.date !== '' && ` · ${release.date}`}
              </a>
            )}
            <h1>Chat with your Claude Code agents, alone or together.</h1>
          </div>
          <div className="txt">
            <p className="lede">
              I talk to my agents one at a time or put a few in a room, then hand them schedules, workflows, my desktop and my browser.
              Every step stays in view, and nothing risky runs without my yes.
            </p>
            {release && (
              <div className="hero-cta">
                <a className="btn pri big" href="#download">
                  <Glyph name="download" size={17} weight={2.2} />
                  Download
                </a>
                <a className="hero-more" href="#server">
                  Run it on a server
                </a>
              </div>
            )}
          </div>
        </div>
        <AppWindow />
      </div>
    </section>
  )
}
