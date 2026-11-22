import { AgentBot, Bot } from '../Bot.tsx'
import { waveBars } from '../showcase.ts'

const BARS = waveBars(40)

export function VoiceScene({ cls }: { cls: string }) {
  return (
    <section id="voice" data-scene="voice" className={`scene ${cls}`}>
      <div className="wrap split">
        <div className="txt">
          <p className="lbl">09 · Voice and the island</p>
          <h2 className="h2">Say it. The right agent picks it up.</h2>
          <p className="lede">
            Dictate into any chat, or speak a request and let it go to whichever agent owns that work. On the desktop, a strip of agents
            sits on the screen edge and shows who's busy and who's waiting on me.
          </p>
          <ul className="facts">
            <li>Telegram and Slack channels: reply to agents and answer cards from my phone</li>
            <li>Push notifications when something needs me</li>
          </ul>
        </div>
        <div className="mock col-20">
          <div className="win pad-22 col-16">
            <div className="wave-row" aria-hidden="true">
              {BARS.map((b, i) => (
                <span key={i} className="wave" style={{ height: b.h, animationDelay: `${b.delay}s` }} />
              ))}
            </div>
            <p className="small-17">"Ask Ops if last night's backup finished, and how big it was."</p>
            <div className="row wrap-row small-13">
              <span className="muted">routed to</span>
              <span className="chip sel h28">
                <AgentBot id="ops" size={16} working />
                Ops · nightly backup
              </span>
              <span className="muted">→ "Done at 03:12. 4.2 GB, checksum matches."</span>
            </div>
          </div>
          <div className="desktop">
            <span className="lbl desktop-lbl">desktop · right screen edge</span>
            <div className="edge-strip">
              <span className="itile lg">
                <Bot zumi size={24} />
              </span>
              <span className="itile lg">
                <AgentBot id="coder" size={24} working />
              </span>
              <span className="itile lg">
                <AgentBot id="ops" size={24} working />
              </span>
              <span className="itile lg waiting">
                <AgentBot id="wordsmith" size={24} />
              </span>
            </div>
            <div className="panel waiting-note">
              <span className="strong">Wordsmith is waiting on you</span>
              <span className="muted">Approve 14 new French strings?</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
