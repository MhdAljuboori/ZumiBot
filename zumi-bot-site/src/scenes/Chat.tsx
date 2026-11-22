import type { CSSProperties } from 'react'
import { AgentBot } from '../Bot.tsx'
import { Glyph } from '../Glyph.tsx'

const delay = (s: number): CSSProperties => ({ animationDelay: `${s}s` })

export function ChatScene({ cls }: { cls: string }) {
  return (
    <section id="chat" data-scene="chat" className={`scene band ${cls}`}>
      <div className="wrap split">
        <div className="txt sticky">
          <p className="lbl">02 · One agent, one chat</p>
          <h2 className="h2">Every step stays in view.</h2>
          <p className="lede">
            Replies stream in as they're written. Thinking, tool calls and touched files stay on the page, so I can scroll back and see
            exactly what happened.
          </p>
          <ul className="facts">
            <li>Markdown with highlighted code, KaTeX math and Mermaid diagrams</li>
            <li>Edit, resend or fork any message, with a version switcher</li>
            <li>
              <span>
                <span className="code">/btw</span> side questions open beside the thread
              </span>
            </li>
            <li>Pause and resume, search with jump-to-message, export</li>
          </ul>
        </div>
        <div className="mock">
          <div className="win">
            <div className="winbar">
              <AgentBot id="coder" size={20} working />
              <span className="fg strong">Coder</span>
              <span className="chip">Opus · high effort</span>
              <span className="push meter">
                <span>context</span>
                <span className="meter-bar">
                  <span />
                </span>
                <span className="mono">38%</span>
                <span className="chip">Compact</span>
              </span>
            </div>
            <div className="win-body thread">
              <div className="row end">
                <span className="mono muted tiny">‹ 2 / 2 ›</span>
                <div className="ububble">Why do totals drift by a cent on big carts?</div>
              </div>
              <div className="tool thought rise" style={delay(0.1)}>
                <Glyph name="chevron" size={13} weight={1.5} />
                Thought for 6s: rounding per line vs. once at the end…
              </div>
              <div className="col-6">
                <div className="tool grow-in" style={delay(0.3)}>
                  Grep<span className="fg">"toFixed" src/</span>
                  <span className="push">4 matches</span>
                </div>
                <div className="tool grow-in" style={delay(0.55)}>
                  Read<span className="fg">src/cart/total.ts</span>
                </div>
                <div className="tool grow-in" style={delay(0.8)}>
                  Edit<span className="fg">src/cart/total.ts</span>
                  <span className="push">
                    <span className="ok-text">+3</span> <span className="err-text">−2</span>
                  </span>
                </div>
              </div>
              <p>
                <span className="tok" style={delay(1.0)}>
                  Each line is rounded{' '}
                </span>
                <span className="tok" style={delay(1.1)}>
                  before summing,{' '}
                </span>
                <span className="tok" style={delay(1.2)}>
                  so the error grows{' '}
                </span>
                <span className="tok" style={delay(1.3)}>
                  with the number of lines:
                </span>
              </p>
              <div className="tok math" style={delay(1.45)}>
                <i>ε</i> = <span className="big">Σ</span>
                <sub>
                  <i>i</i>
                </sub>{' '}
                round(<i>p</i>
                <sub>
                  <i>i</i>
                </sub>
                <i>q</i>
                <sub>
                  <i>i</i>
                </sub>
                ) − round(<span className="big">Σ</span>
                <sub>
                  <i>i</i>
                </sub>{' '}
                <i>p</i>
                <sub>
                  <i>i</i>
                </sub>
                <i>q</i>
                <sub>
                  <i>i</i>
                </sub>
                ),&#160; |<i>ε</i>| ≤ <i>n</i>/2
              </div>
              <pre className="pre tok" style={delay(1.6)}>
                <span className="k">export function</span> <span className="f">cartTotal</span>(items: <span className="t">Item</span>[]):{' '}
                <span className="t">number</span> {'{'}
                {'\n  '}
                <span className="k">const</span> cents = items.<span className="f">reduce</span>((s, i) =&gt; s + i.price * i.qty,{' '}
                <span className="n">0</span>);
                {'\n  '}
                <span className="k">return</span> Math.<span className="f">round</span>(cents) / <span className="n">100</span>;{' '}
                <span className="c">{'// round once'}</span>
                {'\n}'}
              </pre>
              <div className="tok flowline" style={delay(1.8)}>
                <span className="chip">cart lines</span>
                <span className="muted">→</span>
                <span className="chip">sum cents</span>
                <span className="muted">→</span>
                <span className="chip sel">round once</span>
                <span className="muted">→</span>
                <span className="chip">formatPrice</span>
                <span className="lbl push">mermaid</span>
              </div>
              <div className="row wrap-row">
                <span className="chip">src/cart/total.ts</span>
                <span className="chip">test/cart.spec.ts</span>
                <span className="chip muted">Fork from here</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
