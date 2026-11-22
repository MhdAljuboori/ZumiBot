import { useEffect, useId, useRef, useState } from 'react'
import { Glyph } from '../Glyph.tsx'
import { EXAMPLE_ORIGIN, installSteps, originFrom } from '../serverInstall.ts'

/**
 * Copies one step's commands. Where the browser refuses (no clipboard, or no permission in an embedded view) it selects
 * the commands instead, so the reader's own copy shortcut finishes the job; the label says which happened.
 */
function CopyButton({ text, label, target }: { text: string; label: string; target: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = () => {
    const done = (s: 'done' | 'failed') => {
      setState(s)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setState('idle'), 1800)
    }
    const fallback = () => {
      const el = document.getElementById(target)
      if (el) window.getSelection()?.selectAllChildren(el)
      done('failed')
    }
    if (!navigator.clipboard) return fallback()
    navigator.clipboard.writeText(text).then(() => done('done'), fallback)
  }
  return (
    <button type="button" className="btn xs term-copy" onClick={copy} aria-label={`Copy: ${label}`}>
      <Glyph name={state === 'done' ? 'check' : 'copy'} size={13} weight={2} />
      <span aria-live="polite">{state === 'done' ? 'Copied' : state === 'failed' ? 'Selected, copy it' : 'Copy'}</span>
    </button>
  )
}

export function ServerScene({ cls, ready }: { cls: string; ready: boolean }) {
  const [typed, setTyped] = useState('')
  const fieldId = useId()
  const hintId = useId()
  const codeId = useId()
  const origin = originFrom(typed)
  const invalid = typed.trim() !== '' && origin === null
  const steps = installSteps(origin ?? EXAMPLE_ORIGIN)

  return (
    <section id="server" data-scene="server" className={`scene ${cls}`} aria-labelledby="server-h">
      <div className="wrap split">
        <div className="txt sticky">
          <p className="lbl">13 · On a server</p>
          <h2 className="h2" id="server-h">
            Or keep it on a server.
          </h2>
          <p className="lede">
            Install the server on a Linux machine, put it behind your HTTPS proxy, and open it from any browser, your phone included.
          </p>
          <ul className="facts">
            <li>Linux with systemd, and Node.js 22 or newer.</li>
            <li>The Claude Code CLI, signed in as the same user.</li>
            <li>A domain with HTTPS, through Caddy or nginx.</li>
            <li>No root: it runs as your own user, and asks before the one command that needs sudo.</li>
          </ul>
        </div>
        <div className="mock col-14">
          {ready ? (
            <>
              <div className="field-block">
                <label htmlFor={fieldId} className="lbl">
                  Your server’s address
                </label>
                <input
                  id={fieldId}
                  className="text-input mono"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={EXAMPLE_ORIGIN}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  aria-invalid={invalid}
                  aria-describedby={hintId}
                />
                <p id={hintId} className={invalid ? 'small-13 field-err' : 'small-13 muted'}>
                  {invalid ? 'Use an https address with no path, like ' + EXAMPLE_ORIGIN + '.' : 'The commands below fill it in.'}
                </p>
              </div>
              <div className="win term" data-testid="server-steps">
                <div className="winbar">
                  <span className="lights">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span>Terminal on your server</span>
                </div>
                <ol className="term-steps">
                  {steps.map((s, i) => (
                    <li key={s.title}>
                      <div className="term-step-head">
                        <span className="term-title">{s.title}</span>
                        {s.commands.length > 0 && <CopyButton text={s.commands.join('\n')} label={s.title} target={`${codeId}-${i}`} />}
                      </div>
                      {s.detail && <p className="muted">{s.detail}</p>}
                      {s.commands.length > 0 && (
                        <pre className="term-code" id={`${codeId}-${i}`}>
                          {s.commands.map((c) => (
                            <code key={c}>{c}</code>
                          ))}
                        </pre>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            </>
          ) : (
            <div className="win pad-26">
              <p className="muted" data-testid="server-soon">
                The installer arrives with the first release.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
