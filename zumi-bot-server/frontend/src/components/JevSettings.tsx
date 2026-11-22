import { useEffect, useState } from 'react'
import { JEV_KEY_MAX, type JevStatus, type JevSwitches } from '@zumibot/shared/jev'
import { api } from '../api'
import { errorMessage } from '../errors'
import { isNotConnected } from '../state/resync'
import { useConnected } from '../useConnected'

type Feature = Exclude<keyof JevSwitches, 'enabled'>

const FEATURES: { name: Feature; label: string; hint: string }[] = [
  {
    name: 'moderator',
    label: 'Pick who answers in group chats',
    hint: 'Settles the easy cases fast. When Jev is unsure, the moderator decides as before.'
  },
  { name: 'approvalRisk', label: 'Show a risk hint on approval cards', hint: 'Only a hint: you still answer every card yourself.' },
  { name: 'agentSuggest', label: 'Suggest an agent for a new chat', hint: 'Reads what you type before an agent is picked.' }
]

/** The OpenRouter key and Jev's switches. The key goes to the server once and is never shown again. */
export function JevSettings() {
  const [status, setStatus] = useState<JevStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  // Asked again on each reconnect; one cut off by a drop is not an error, the reconnect asks again.
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    api.jev.status().then(setStatus, (e) => {
      if (!isNotConnected(e)) setNote({ ok: false, text: errorMessage(e) })
    })
  }, [connected])

  const test = async (): Promise<void> => {
    const r = await api.jev.check()
    setNote(r.ok ? { ok: true, text: 'Jev answered. The key works.' } : { ok: false, text: r.error })
  }
  const run = (fn: () => Promise<void>) => async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }
  const saveKey = run(async () => {
    setStatus(await api.jev.setKey(key))
    setKey('')
    await test()
  })
  const removeKey = run(async () => {
    setStatus(await api.jev.setKey(null))
    setNote({ ok: true, text: 'Key removed. Jev is not used until you add one.' })
  })
  const flip = (name: keyof JevSwitches, on: boolean): void => {
    if (!status) return
    setStatus({ ...status, [name]: on })
    api.jev.setSwitches({ [name]: on }).then(setStatus, (e) => {
      // Re-read rather than roll back: another switch may have been saved since this one was flipped.
      api.jev.status().then(setStatus, () => {})
      setNote({ ok: false, text: errorMessage(e) })
    })
  }

  const enabled = status?.enabled === true
  return (
    <div data-testid="settings-jev">
      <p className="set-intro">
        Jev is a fast decision model on OpenRouter. While it is on, ZumiBot sends OpenRouter the text each decision needs: a group thread, a
        tool call, a webhook call or your new message.
      </p>
      <div className="set-card">
        <label className="set-row">
          <span className="set-text">
            <span className="set-label">Use Jev</span>
            <span className="set-hint">
              {!enabled
                ? 'Off: everything works as it did before Jev.'
                : status?.keySet
                  ? 'On.'
                  : 'On, but nothing happens until you add a key.'}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            data-testid="jev-enabled"
            checked={enabled}
            disabled={status === null}
            onChange={(e) => flip('enabled', e.target.checked)}
          />
        </label>
      </div>

      <h2 className="set-group">OpenRouter API key</h2>
      <div className="set-card">
        <div className="set-block">
          <p className="set-hint" data-testid="jev-key-state">
            {status === null ? '…' : status.keySet ? 'A key is saved.' : 'No key saved.'}
          </p>
          <form
            className="set-key"
            onSubmit={(e) => {
              e.preventDefault()
              if (key.trim()) void saveKey()
            }}
          >
            <input
              type="password"
              className="field"
              data-testid="jev-key"
              aria-label="OpenRouter API key"
              placeholder={status?.keySet ? 'Paste a new key to replace it' : 'sk-or-…'}
              autoComplete="off"
              spellCheck={false}
              maxLength={JEV_KEY_MAX}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="submit" className="btn primary" data-testid="jev-key-save" disabled={busy || !key.trim()}>
              Save
            </button>
          </form>
          {status?.keySet && (
            <div className="set-actions">
              <button type="button" className="btn small" data-testid="jev-key-test" disabled={busy} onClick={run(test)}>
                Test key
              </button>
              <button type="button" className="btn small" data-testid="jev-key-remove" disabled={busy} onClick={removeKey}>
                Remove key
              </button>
            </div>
          )}
          {note && (
            <p className={note.ok ? 'set-note' : 'set-note bad'} role="status" data-testid="jev-note">
              {note.text}
            </p>
          )}
        </div>
      </div>

      <h2 className="set-group">What Jev decides</h2>
      <div className="set-card">
        {FEATURES.map((f) => (
          <label key={f.name} className="set-row">
            <span className="set-text">
              <span className="set-label">{f.label}</span>
              <span className="set-hint">{f.hint}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              data-testid={`jev-${f.name}`}
              checked={status?.[f.name] === true}
              disabled={!enabled}
              onChange={(e) => flip(f.name, e.target.checked)}
            />
          </label>
        ))}
      </div>
      <p className="set-foot">Webhook routines can also have a condition Jev checks before each run. Set it in the routine's trigger.</p>
    </div>
  )
}
