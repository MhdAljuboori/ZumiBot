import { AgentBot } from '../Bot.tsx'
import { Glyph, Pointer } from '../Glyph.tsx'

const AUDIT = [
  { what: 'LCP', value: '2.1 s', verdict: 'good', tone: 'ok-text' },
  { what: 'console', value: '3 errors', verdict: 'fix', tone: 'err-text' },
  { what: 'a11y', value: '2 images without alt', verdict: 'check', tone: 'warn-text' },
  { what: 'network', value: '1 request 404s', verdict: 'fix', tone: 'err-text' }
]

const VAULT_DOTS = 14

export function MachineScene({ cls }: { cls: string }) {
  return (
    <section id="machine" data-scene="machine" className={`scene ${cls}`}>
      <div className="wrap stack-md">
        <div className="split end">
          <div className="txt wide">
            <p className="lbl">07 · Hands on the machine</p>
            <h2 className="h2">It can use my computer. It never sees my passwords.</h2>
          </div>
          <div className="txt">
            <p className="lede">
              Agents see the screen and click through desktop apps, audit pages in a browser, and fill logins from an encrypted vault. The
              transcript only says which entry was used.
            </p>
          </div>
        </div>
        <div className="cols">
          <div className="win desk-win">
            <div className="winbar">
              <span className="fg strong">Computer use</span>
              <span className="chip">Ops · desktop</span>
            </div>
            <div className="flexwrap">
              <div className="desk">
                <div className="panel ledger">
                  <div className="ledger-head">Ledger · Q3</div>
                  <div className="ledger-grid mono">
                    <span>Jul</span>
                    <span>€4,120</span>
                    <span>ok</span>
                    <span>Aug</span>
                    <span>€3,980</span>
                    <span>ok</span>
                    <span>Sep</span>
                    <span>€5,310</span>
                    <span>ok</span>
                  </div>
                  <span className="btn xs">Export CSV</span>
                </div>
                <div className="agentcur">
                  <Pointer className="cursor-svg" fill="var(--agent-orange)" />
                  <span className="cur-tag">
                    <AgentBot id="ops" size={14} working />
                    Ops
                  </span>
                </div>
              </div>
              <div className="mono transcript">
                <span className="muted">transcript</span>
                <span>screenshot 1440×900</span>
                <span>click "Export CSV" (612, 418)</span>
                <span>type q3-ledger.csv</span>
                <span>key Enter</span>
                <span className="ok-text">saved to ~/Reports</span>
              </div>
            </div>
          </div>
          <div className="win audit-win">
            <div className="winbar">
              <span className="fg strong">Browser audit</span>
              <span className="chip mono">staging.tidepool.test</span>
            </div>
            <div className="win-body col-8">
              {AUDIT.map((a, i) => (
                <div key={a.what} className="tool rise" style={{ animationDelay: `${i * 0.15}s` }}>
                  {a.what}
                  <span className="fg">{a.value}</span>
                  <span className={`push ${a.tone}`}>{a.verdict}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="win">
          <div className="winbar">
            <span className="fg strong">Vault fill</span>
            <Glyph name="lock" size={13} weight={2} />
            <span>encrypted on this machine</span>
          </div>
          <div className="flexwrap">
            <div className="vault-form">
              <p className="strong">Sign in to billing.tidepool.test</p>
              <div className="col-4">
                <span className="muted small">Email</span>
                <div className="panel input">ops@tidepool.test</div>
              </div>
              <div className="col-4">
                <span className="muted small">Password</span>
                <div className="panel input secret">
                  {Array.from({ length: VAULT_DOTS }, (_, i) => (
                    <span key={i} className="vdot" style={{ animationDelay: `${(0.6 + i * 0.09).toFixed(2)}s` }}>
                      •
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="vault-side">
              <p className="lbl">What Ops sees</p>
              <div className="tool">
                browser_fill<span className="fg">#email</span>
              </div>
              <div className="tool">
                vault_fill<span className="fg">#password</span>
                <span className="push ok-text">filled from vault</span>
              </div>
              <p className="muted small-13">
                Entry: "billing login". The secret goes straight into the field and never enters the model's context. Cards and API keys
                work the same way.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
