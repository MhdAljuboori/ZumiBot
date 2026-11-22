import { useEffect, useState } from 'react'
import type { NotifyStatus, NotifyToggles } from '@zumibot/shared/notify'
import { api } from '../api'
import { errorMessage } from '../errors'
import { disableThisDevice, enableDesktop, enablePush, myDeviceId, shellOf } from '../net/notifyDevice'
import { pushSupport } from '../net/push'
import { deviceRowNote, lastSeenLabel, thisDeviceState } from '../state/notifications'
import { isNotConnected } from '../state/resync'
import { useConnected } from '../useConnected'

const TOGGLES: { name: keyof NotifyToggles; label: string; hint: string; testId: string }[] = [
  {
    name: 'waiting',
    label: 'Needs you',
    hint: 'An agent waits for an approval or an answer, or a spend cap paused a run.',
    testId: 'waiting'
  },
  { name: 'replied', label: 'Replied', hint: 'An agent finished its reply.', testId: 'replied' },
  { name: 'error', label: 'Reply error', hint: 'A reply ended with an error.', testId: 'error' },
  { name: 'routineFailed', label: 'A routine or workflow failed', hint: 'A routine or workflow run failed.', testId: 'routineFailed' }
]

const CHANNEL = { push: 'Push', desktop: 'Desktop app' } as const

/** This device's notification switch and toggles, plus the other devices that get notifications. */
export function NotificationsSettings() {
  const myId = myDeviceId()
  const shell = shellOf(api.desktop)
  const [status, setStatus] = useState<NotifyStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  // Asked again on each reconnect; one cut off by a drop is not an error, the reconnect asks again.
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    api.notify.status(myId).then(setStatus, (e) => {
      if (!isNotConnected(e)) setNote({ ok: false, text: errorMessage(e) })
    })
  }, [myId, connected])

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
  const enable = run(async () => {
    setStatus(await (shell === 'none' ? enablePush(api) : enableDesktop(api)))
  })
  const disable = run(async () => {
    setStatus(await disableThisDevice(api))
  })
  const test = run(async () => {
    const r = await api.notify.test(myId)
    setNote(
      r === 'sent'
        ? { ok: true, text: 'Sent. It should show on this device in a moment.' }
        : { ok: false, text: 'Nothing was sent. Enable this device first.' }
    )
  })
  const remove = (deviceId: string) =>
    run(async () => {
      await api.notify.remove(deviceId)
      // remove() answers for whichever device the server thinks this socket is on; ask for this one by id.
      setStatus(await api.notify.status(myId))
    })
  const flip = (name: keyof NotifyToggles, on: boolean): void => {
    const mine = status?.devices.find((d) => d.id === myId)
    if (!status || !mine) return
    const before = status
    const toggles = { ...mine.toggles, [name]: on }
    setStatus({ ...status, devices: status.devices.map((d) => (d.id === myId ? { ...d, toggles } : d)) })
    api.notify.setPrefs(myId, toggles).then(setStatus, (e) => {
      setStatus(before)
      setNote({ ok: false, text: errorMessage(e) })
    })
  }

  const me = status?.devices.find((d) => d.id === myId)
  const others = status?.devices.filter((d) => d.id !== myId) ?? []
  const state = status && thisDeviceState({ shell, pushAvailable: status.pushAvailable, support: pushSupport(), me })
  const now = Date.now()
  return (
    <div data-testid="settings-notifications">
      <p className="set-intro">
        Tells you when an agent needs you or finishes, even with no ZumiBot tab in front of you. Nothing is sent for the chat you are
        looking at.
      </p>

      <h2 className="set-group">This device</h2>
      <div className="set-card">
        <div className="set-row">
          <span className="set-text">
            <span className="set-label">{me?.label ?? (shell === 'none' ? 'This browser' : 'ZumiBot desktop')}</span>
            <span className="set-hint" data-testid="notify-state">
              {state ? state.text : '…'}
            </span>
          </span>
          <span className="set-actions">
            {state?.canEnable && (
              <button type="button" className="btn small primary" data-testid="notify-enable" disabled={busy} onClick={enable}>
                Enable
              </button>
            )}
            {state?.canDisable && (
              <button type="button" className="btn small" data-testid="notify-disable" disabled={busy} onClick={disable}>
                Turn off
              </button>
            )}
          </span>
        </div>
        {TOGGLES.map((t) => (
          <label key={t.name} className="set-row">
            <span className="set-text">
              <span className="set-label">{t.label}</span>
              <span className="set-hint">{t.hint}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              data-testid={`notify-toggle-${t.testId}`}
              checked={me?.toggles[t.name] ?? true}
              disabled={!me}
              onChange={(e) => flip(t.name, e.target.checked)}
            />
          </label>
        ))}
        <div className="set-row">
          <span className="set-text">
            <span className="set-label">Test</span>
            <span className="set-hint">Sends a notification to this device.</span>
          </span>
          <button type="button" className="btn small" data-testid="notify-test" disabled={busy || !me} onClick={test}>
            Send test
          </button>
        </div>
      </div>
      {note && (
        <p className={note.ok ? 'set-note' : 'set-note bad'} role="status" data-testid="notify-note">
          {note.text}
        </p>
      )}

      {others.length > 0 && (
        <>
          <h2 className="set-group">Other devices</h2>
          <ul className="set-card">
            {others.map((d) => {
              const extra = deviceRowNote(d)
              return (
                <li key={d.id} className="set-row" data-testid="notify-device-row" data-device-id={d.id}>
                  <span className="set-text">
                    <span className="set-label">{d.label}</span>
                    <span className="set-hint">
                      {CHANNEL[d.channel]} · seen {lastSeenLabel(d.lastSeenAt, now)}
                      {extra && ` · ${extra}`}
                    </span>
                  </span>
                  <button type="button" className="btn small" data-testid="notify-device-remove" disabled={busy} onClick={remove(d.id)}>
                    Remove
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
