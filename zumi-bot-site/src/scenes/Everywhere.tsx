import { AgentBot, Bot } from '../Bot.tsx'
import { Glyph } from '../Glyph.tsx'

function Exchange() {
  return (
    <>
      <div className="ububble">Is the nightly backup done?</div>
      <div className="say">
        <AgentBot id="ops" size={20} />
        <p>
          <strong>Ops</strong> Done at 03:12. 4.2 GB, checksum matches.
        </p>
      </div>
    </>
  )
}

export function EverywhereScene({ cls }: { cls: string }) {
  return (
    <section id="everywhere" data-scene="everywhere" className={`scene band ${cls}`}>
      <div className="wrap stack-md">
        <div className="split end">
          <div className="txt wide">
            <p className="lbl">10 · Everywhere</p>
            <h2 className="h2">Same chat on the laptop, the phone and the desk.</h2>
          </div>
          <div className="txt">
            <p className="lede">
              Any browser through my own server, the phone as an installable app, or the desktop app with a tray that starts at login. PC
              and server stay in sync, behind two-factor sign-in.
            </p>
          </div>
        </div>
        <div className="devices">
          <div className="win lift browser">
            <div className="winbar">
              <div className="lights">
                <span />
                <span />
                <span />
              </div>
              <span className="panel mono url">bot.my-server.test/chat/backup</span>
            </div>
            <div className="win-body col-10">
              <Exchange />
              <span className="mono muted tiny">synced · just now</span>
            </div>
          </div>
          <div className="phone lift">
            <div className="phone-screen">
              <p className="phone-title">
                <AgentBot id="ops" size={18} />
                nightly backup
              </p>
              <div className="ububble">Is the nightly backup done?</div>
              <p>
                <strong>Ops</strong> Done at 03:12. 4.2 GB, checksum matches.
              </p>
              <div className="composer slim push-down">
                <span className="grow">Message</span>
                <span className="send sm">
                  <Glyph name="send" size={12} weight={2.6} />
                </span>
              </div>
            </div>
          </div>
          <div className="win lift desktop-app">
            <div className="winbar">
              <div className="lights">
                <span />
                <span />
                <span />
              </div>
              <Bot zumi size={16} />
              <span>ZumiBot</span>
              <span className="mono push tiny">desktop · tray</span>
            </div>
            <div className="desk-body">
              <div className="rail narrow">
                <AgentBot id="ops" size={20} />
                <AgentBot id="planner" size={20} />
                <AgentBot id="coder" size={20} />
              </div>
              <div className="pane-lite col-10">
                <div className="ububble">Is the nightly backup done?</div>
                <p>
                  <strong>Ops</strong> Done at 03:12. 4.2 GB, checksum matches.
                </p>
                <span className="mono muted tiny">synced · just now</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
