import { useEffect, useState } from 'react'
import type { AgentIsolationView, IsolationStatus } from '@zumibot/shared/isolation'
import { api } from '../api'
import { errorMessage } from '../errors'
import { isNotConnected } from '../state/resync'
import { useConnected } from '../useConnected'
import { formOf, grantsOf, isolationOf, levelBlocked, sameForm, type IsolationForm } from '../state/isolationForm'

interface Props {
  /** The saved name: the server keys isolation by it. */
  agentName: string
  /** The draft's computer use switch: shown as outside the sandbox when on. */
  computerUse: boolean
}

/**
 * Agent Studio's Isolation section. Saved on its own (not in the agent file), so Zumi Bot, which edits agent files, cannot
 * lower it (governance.md Part 2).
 */
export function AgentIsolation({ agentName, computerUse }: Props) {
  const [view, setView] = useState<AgentIsolationView | null>(null)
  const [status, setStatus] = useState<IsolationStatus | null>(null)
  const [form, setForm] = useState<IsolationForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    setView(null)
    setForm(null)
    setNotice(null)
  }, [agentName])
  // Read once the socket is up, and after a reconnect while it never landed: the form is never read over. A read the socket
  // cut off is not an error.
  const connected = useConnected()
  const loaded = view !== null
  useEffect(() => {
    if (!connected || loaded) return
    let alive = true
    api.isolation.get(agentName).then(
      (v) => {
        if (alive) {
          setView(v)
          setForm(formOf(v.isolation))
          setNotice(null)
        }
      },
      (e) => {
        if (alive && !isNotConnected(e)) setNotice(errorMessage(e))
      }
    )
    return () => {
      alive = false
    }
  }, [agentName, connected, loaded])
  useEffect(() => {
    if (!connected) return
    let alive = true
    api.isolation.status().then(
      (s) => {
        if (alive) setStatus(s)
      },
      () => {}
    )
    return () => {
      alive = false
    }
  }, [connected])

  if (view === null || form === null) {
    return (
      <div className="browser-settings isolation-settings" data-testid="isolation-settings">
        <div>
          <strong>Isolation</strong>
          {notice && <p role="status">{notice}</p>}
        </div>
      </div>
    )
  }
  const saved = formOf(view.isolation)
  const dirty = !sameForm(form, saved)
  const checked = isolationOf(form)
  const reasons = {
    refused: view.refused,
    sandbox: status !== null && !status.sandbox.available ? status.sandbox.reason : null,
    container: status !== null && !status.container.available ? status.container.reason : null,
    computerUse
  }
  const blockedSandbox = levelBlocked('sandbox', reasons)
  const blockedContainer = levelBlocked('container', reasons)
  const savedBlocked = saved.level === 'off' ? null : levelBlocked(saved.level, reasons)
  const levelName = { off: 'Off', sandbox: 'Sandboxed', container: 'Container' } as const
  const patch = (p: Partial<IsolationForm>) => {
    setForm({ ...form, ...p })
    setNotice(null)
  }
  const save = () => {
    if (!checked.ok) return
    setSaving(true)
    setNotice(null)
    api.isolation
      .set(agentName, checked.isolation)
      .then(
        (v) => {
          setView(v)
          setForm(formOf(v.isolation))
          setNotice('Saved. It applies from the next turn.')
        },
        (e) => setNotice(errorMessage(e))
      )
      .finally(() => setSaving(false))
  }
  const grants = checked.ok && form.level !== 'off' ? grantsOf(checked.isolation, status?.toolchain ?? []) : null

  return (
    <div className="browser-settings isolation-settings" data-testid="isolation-settings">
      <div>
        <strong>Isolation</strong>
        <p>
          Sandboxed runs this agent&rsquo;s Bash in the OS sandbox and keeps its file tools to its own folders. Container runs the whole
          agent in its own rootless container, with only its folders mounted. Both keep web fetches to its network list. Approvals stay as
          they are.
        </p>
        {blockedSandbox && (
          <p className="desktop-missing" role="status" data-testid="isolation-unavailable">
            Sandboxed is unavailable: {blockedSandbox}
          </p>
        )}
        {blockedContainer && (
          <p className="desktop-missing" role="status" data-testid="isolation-container-unavailable">
            Container is unavailable: {blockedContainer}
          </p>
        )}
        {savedBlocked && (
          <p className="desktop-missing" role="status">
            This agent is set to {levelName[saved.level]}, so its runs are refused until that is fixed or isolation is changed.
          </p>
        )}
      </div>
      <div className="isolation-levels" role="radiogroup" aria-label="Isolation level">
        <label>
          <input
            type="radio"
            name="isolation-level"
            data-testid="isolation-off"
            checked={form.level === 'off'}
            onChange={() => patch({ level: 'off' })}
          />{' '}
          Off
        </label>
        <label>
          <input
            type="radio"
            name="isolation-level"
            data-testid="isolation-sandbox"
            checked={form.level === 'sandbox'}
            disabled={blockedSandbox !== null && saved.level !== 'sandbox'}
            onChange={() => patch({ level: 'sandbox' })}
          />{' '}
          Sandboxed
        </label>
        <label>
          <input
            type="radio"
            name="isolation-level"
            data-testid="isolation-container"
            checked={form.level === 'container'}
            disabled={blockedContainer !== null && saved.level !== 'container'}
            onChange={() => patch({ level: 'container' })}
          />{' '}
          Container
        </label>
      </div>
      {form.level !== 'off' && (
        <div className="isolation-fields">
          <label>
            <span>
              Network: hosts it may reach, one per line (<code>*.example.com</code> for sub-domains). Empty means no network.
            </span>
            <textarea
              data-testid="isolation-network"
              rows={3}
              spellCheck={false}
              value={form.network}
              onChange={(e) => patch({ network: e.target.value })}
              placeholder="registry.npmjs.org"
            />
          </label>
          <label>
            <span>
              {form.level === 'container'
                ? 'Extra folders mounted read-write, one absolute path per line'
                : 'Extra folders it may change, one absolute path per line'}
            </span>
            <textarea
              data-testid="isolation-write"
              rows={2}
              spellCheck={false}
              value={form.write}
              onChange={(e) => patch({ write: e.target.value })}
            />
          </label>
          <label>
            <span>{form.level === 'container' ? 'Extra folders mounted read-only' : 'Extra folders it may only read'}</span>
            <textarea
              data-testid="isolation-read"
              rows={2}
              spellCheck={false}
              value={form.read}
              onChange={(e) => patch({ read: e.target.value })}
            />
          </label>
          <label className="isolation-check">
            <input type="checkbox" checked={form.webSearch} onChange={(e) => patch({ webSearch: e.target.checked })} /> Allow web search
          </label>
          <label className="isolation-check">
            <input
              type="checkbox"
              data-testid="isolation-autobash"
              checked={form.autoBash}
              onChange={(e) => patch({ autoBash: e.target.checked })}
            />{' '}
            {form.level === 'container' ? 'Run Bash in the container without asking' : 'Run sandboxed Bash without asking'} (a looser
            choice: commands no longer get a card)
          </label>
          {grants && (
            <div className="isolation-grants" data-testid="isolation-grants">
              <p>
                <strong>Every run may change:</strong> {grants.change.join(' · ')}
              </p>
              <p>
                <strong>May read:</strong> {grants.read.join(' · ')}
              </p>
              <p>
                <strong>May reach:</strong> {grants.network}
              </p>
              {form.level === 'container' ? (
                <p>
                  <strong>Outside the container:</strong> the agent browser, and ZumiBot&rsquo;s own tools (to-dos, vault, asks). Its MCP
                  servers run inside, with the image&rsquo;s programs only. Your sign-in stays on the server.
                </p>
              ) : (
                <p>
                  <strong>Outside the sandbox:</strong> its MCP servers and hooks, the agent browser
                  {computerUse ? ', and computer use (on for this agent: a full desktop)' : ''}.
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {!checked.ok && (
        <p className="desktop-missing" role="alert">
          {checked.error}
        </p>
      )}
      <div className="isolation-actions">
        <button
          type="button"
          className="btn small primary"
          data-testid="isolation-save"
          disabled={!dirty || !checked.ok || saving}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save isolation'}
        </button>
        {dirty && (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setForm(saved)
              setNotice(null)
            }}
          >
            Revert
          </button>
        )}
      </div>
      {notice && (
        <p role="status" data-testid="isolation-notice">
          {notice}
        </p>
      )}
    </div>
  )
}
