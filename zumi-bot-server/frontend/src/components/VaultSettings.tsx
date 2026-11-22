import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { AgentSummary } from '@zumibot/shared/types'
import { CONTACT_FIELDS, FILL_FIELD_LABELS, type VaultKind, type VaultListItem, type VaultStatus } from '@zumibot/shared/vault'
import { api } from '../api'
import { errorMessage } from '../errors'
import { vaultGrantNote } from '../state/agentEngine'
import type { Provider } from '@zumibot/shared/engine'
import {
  KIND_LABELS,
  KIND_ORDER,
  agentChoices,
  deleteMessage,
  draftErrors,
  draftOf,
  emptyDraft,
  groupVault,
  hasErrors,
  inputOf,
  isDraftDirty,
  keepReveal,
  keyProblem,
  keyProblemCopy,
  rowLine,
  showLabel,
  vaultErrorText,
  type VaultDraft
} from '../state/vaultSettings'
import { useConnected } from '../useConnected'
import { useDismiss } from '../useDismiss'
import type { EditorHandle } from './AgentEditor'
import { ConfirmDialog } from './ConfirmDialog'

type RevealField = Parameters<typeof api.vault.reveal>[1]

/** A revealed value is dropped from the page after this long, so a forgotten Show does not stay on screen. */
const SHOW_MS = 30_000

const agentCount = (n: number): string => (n === 0 ? 'No agents' : n === 1 ? '1 agent' : `${n} agents`)
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

interface Editing {
  draft: VaultDraft
  /** The form as it opened, to tell whether anything changed. */
  opened: VaultDraft
}

type Dialog = { kind: 'delete' | 'reset' | 'discard'; then?: () => void } | null

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="vault-field">
      <span className="vault-label">{label}</span>
      {children}
      {hint && !error && <span className="set-hint">{hint}</span>}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

interface SecretProps {
  label: string
  value: string
  onChange: (value: string) => void
  /** The stored item, or undefined for one not saved yet. */
  itemId: string | undefined
  /** Which stored value Show and Copy fetch; null when there is none to fetch. */
  field: RevealField | null
  /** The server holds a value for this field. */
  stored: boolean
  placeholder: string
  /** Show's text for the stored value, and for text typed here. */
  showLabel?: string
  typedShowLabel?: string
  error?: string
  hint?: string
}

/**
 * A masked field that is empty on open. Show asks the server for the one stored value and holds it in this component only
 * until Hide, a timeout or unmount; Copy fetches it just for the clipboard and keeps nothing. Text typed here is shown or
 * copied as typed, with no request.
 */
function SecretField({
  label,
  value,
  onChange,
  itemId,
  field,
  stored,
  placeholder,
  showLabel: storedLabel = 'Show',
  typedShowLabel = 'Show',
  error,
  hint
}: SecretProps) {
  const [shown, setShown] = useState<string | null>(null)
  const [typedVisible, setTypedVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // A fetch that finishes after Hide or unmount is dropped, never stored; so is one that finishes after something was typed.
  const gen = useRef(0)
  const typed = useRef(value)
  typed.current = value
  useEffect(
    () => () => {
      gen.current++
    },
    []
  )
  useEffect(() => {
    if (shown === null) return
    const t = setTimeout(() => setShown(null), SHOW_MS)
    return () => clearTimeout(t)
  }, [shown])
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const canFetch = stored && itemId !== undefined && field !== null && value === ''
  const visible = shown !== null || typedVisible

  const hide = (): void => {
    gen.current++
    setShown(null)
    setTypedVisible(false)
    setBusy(false)
  }
  const fetchValue = async (): Promise<string | null> => {
    if (itemId === undefined || field === null) return null
    const g = ++gen.current
    setBusy(true)
    setNote(null)
    try {
      const v = await api.vault.reveal(itemId, field)
      return keepReveal(g, gen.current, typed.current) ? v : null
    } catch (e) {
      if (g === gen.current) setNote(vaultErrorText(errorMessage(e)))
      return null
    } finally {
      if (g === gen.current) setBusy(false)
    }
  }
  const toggle = async (): Promise<void> => {
    if (visible) return hide()
    if (value !== '') return setTypedVisible(true)
    if (!canFetch) return
    const v = await fetchValue()
    if (v !== null) setShown(v)
  }
  const copy = async (): Promise<void> => {
    // A local only: the fetched value reaches the clipboard and is not kept.
    let text: string | null = value !== '' ? value : shown
    if (text === null && canFetch) text = await fetchValue()
    if (text === null) return
    try {
      await navigator.clipboard.writeText(text)
      setNote(null)
      setCopied(true)
    } catch {
      setNote("Couldn't copy. Show the value and copy it by hand.")
    }
  }

  const hasSomething = value !== '' || canFetch || visible
  return (
    <Field label={label} error={error} hint={hint}>
      <div className="vault-secret">
        <input
          type={visible ? 'text' : 'password'}
          className="field"
          aria-label={label}
          aria-invalid={error ? true : undefined}
          placeholder={shown === null && stored && value === '' ? 'Saved. Leave blank to keep it.' : placeholder}
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          readOnly={shown !== null}
          value={shown ?? value}
          onChange={(e) => onChange(e.target.value)}
        />
        {hasSomething && (
          <>
            <button type="button" className="btn small" disabled={busy} onClick={() => void toggle()}>
              {showLabel(visible, value, { stored: storedLabel, typed: typedShowLabel })}
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </>
        )}
      </div>
      {note && (
        <span className="set-note bad" role="status">
          {note}
        </span>
      )}
    </Field>
  )
}

interface FormProps {
  draft: VaultDraft
  items: readonly VaultListItem[]
  /** Every agent that may be picked, plus any agent already on the item that has since gone. */
  agentNames: string[]
  /** Names of the Codex agents among them: an API key's grant to one carries a note. */
  agentProviders: ReadonlyMap<string, Provider>
  showErrors: boolean
  saving: boolean
  saveError: string | null
  onChange: (fn: (d: VaultDraft) => VaultDraft) => void
  onSave: () => void
  onCancel: () => void
  onDelete: () => void
  onReload: () => void
  onRemoveApproval: (site: string, frameSite: string) => void
}

function VaultForm(p: FormProps) {
  const { draft: d } = p
  const stored = d.id === undefined ? undefined : p.items.find((i) => i.id === d.id)
  const errors = draftErrors(d, p.items)
  const err = (k: string): string | undefined => (p.showErrors ? errors[k] : undefined)
  const set = <K extends keyof VaultDraft>(k: K, v: VaultDraft[K]): void => p.onChange((x) => ({ ...x, [k]: v }))
  const gone = d.id !== undefined && stored === undefined
  const stale = stored !== undefined && stored.updatedAt !== d.updatedAt
  const text = (
    k: 'name' | 'username' | 'holder' | 'env' | 'description',
    label: string,
    over: { placeholder?: string; hint?: string; mono?: boolean } = {}
  ): ReactNode => (
    <Field label={label} error={err(k)} hint={over.hint}>
      <input
        className={over.mono ? 'field vault-mono' : 'field'}
        aria-label={label}
        aria-invalid={err(k) ? true : undefined}
        placeholder={over.placeholder}
        autoComplete="off"
        spellCheck={false}
        value={d[k]}
        onChange={(e) => set(k, e.target.value)}
      />
    </Field>
  )

  return (
    <div data-testid="vault-form">
      <div className="vault-form-head">
        <button type="button" className="btn ghost small" data-testid="vault-back" onClick={p.onCancel}>
          ← All items
        </button>
        <h2 className="vault-form-title">{d.id === undefined ? `New ${KIND_LABELS[d.kind].toLowerCase()}` : KIND_LABELS[d.kind]}</h2>
      </div>

      {(gone || stale) && (
        <p className="set-note bad" role="alert" data-testid="vault-stale">
          {gone ? 'This item was deleted elsewhere.' : 'This item changed elsewhere.'}{' '}
          <button type="button" className="btn small" onClick={p.onReload}>
            {gone ? 'Close' : 'Reload'}
          </button>
        </p>
      )}

      <div className="set-card vault-card">
        <div className="set-block vault-fields">
          {text('name', 'Name', { placeholder: d.kind === 'card' ? 'Work Visa' : d.kind === 'apiKey' ? 'Azure DevOps token' : undefined })}

          {d.kind === 'login' && (
            <>
              <Field
                label="Sites"
                error={err('sites')}
                hint="One per line. The login fills only on these. *.example.com covers subdomains."
              >
                <textarea
                  className="field vault-mono"
                  aria-label="Sites"
                  aria-invalid={err('sites') ? true : undefined}
                  rows={3}
                  placeholder="github.com"
                  autoComplete="off"
                  spellCheck={false}
                  value={d.sitesText}
                  onChange={(e) => set('sitesText', e.target.value)}
                />
              </Field>
              {text('username', 'Username')}
              <SecretField
                label="Password"
                value={d.password}
                onChange={(v) => set('password', v)}
                itemId={d.id}
                field="password"
                stored={stored?.kind === 'login' && stored.hasPassword}
                placeholder="Password"
                error={err('password')}
              />
              <SecretField
                label="2FA secret"
                value={d.totp}
                onChange={(v) => set('totp', v)}
                itemId={d.id}
                field="code"
                stored={stored?.kind === 'login' && stored.hasCode && !d.clearTotp}
                placeholder="Base32 secret or otpauth:// link (optional)"
                showLabel="Show code"
                typedShowLabel="Show secret"
                error={err('totp')}
                hint={stored?.kind === 'login' && stored.hasCode ? 'Show displays the current 6-digit code, not the secret.' : undefined}
              />
              {stored?.kind === 'login' && stored.hasCode && (
                <label className="vault-check">
                  <input type="checkbox" checked={d.clearTotp} onChange={(e) => set('clearTotp', e.target.checked)} />
                  Remove the saved 2FA secret
                </label>
              )}
              <label className="vault-check" data-testid="vault-login-workflows">
                <input type="checkbox" checked={d.workflows} onChange={(e) => set('workflows', e.target.checked)} />
                Workflows may use it (email trigger)
              </label>
              {d.workflows && (
                <div className="rt-hint">
                  A workflow's email trigger that picks this login signs in to its mail server with it, read-only; the password never shows
                  in the workflow or its runs.
                </div>
              )}
            </>
          )}

          {d.kind === 'card' && (
            <>
              {text('holder', 'Name on card')}
              <SecretField
                label="Card number"
                value={d.number}
                onChange={(v) => set('number', v)}
                itemId={d.id}
                field="number"
                stored={stored !== undefined}
                placeholder="1234 5678 9012 3456"
                error={err('number')}
              />
              <div className="vault-grid">
                <SecretField
                  label="Expiry"
                  value={d.expiry}
                  onChange={(v) => set('expiry', v)}
                  itemId={d.id}
                  field="expiry"
                  stored={stored !== undefined}
                  placeholder="MM/YY"
                  error={err('expiry')}
                />
                <SecretField
                  label="Security code"
                  value={d.cvc}
                  onChange={(v) => set('cvc', v)}
                  itemId={d.id}
                  field="cvc"
                  stored={stored !== undefined}
                  placeholder="CVC"
                  error={err('cvc')}
                />
              </div>
              {errors.warning && (
                <span className="set-note warn" role="status" data-testid="vault-warning">
                  {errors.warning}
                </span>
              )}
            </>
          )}

          {d.kind === 'contact' && (
            <>
              <div className="vault-grid">
                {CONTACT_FIELDS.map((f) => (
                  <Field key={f} label={capital(FILL_FIELD_LABELS[f])}>
                    <input
                      className="field"
                      aria-label={capital(FILL_FIELD_LABELS[f])}
                      autoComplete="off"
                      spellCheck={false}
                      value={d.contact[f]}
                      onChange={(e) => p.onChange((x) => ({ ...x, contact: { ...x.contact, [f]: e.target.value } }))}
                    />
                  </Field>
                ))}
              </div>
              {err('contact') && (
                <span className="field-error" role="alert">
                  {err('contact')}
                </span>
              )}
              <span className="set-hint">Contact details are not secret: allowed agents read them.</span>
            </>
          )}

          {d.kind === 'apiKey' && (
            <>
              {text('env', 'Environment variable', {
                placeholder: 'AZURE_DEVOPS_EXT_PAT',
                mono: true,
                hint: 'Allowed agents get the key under this name, so az, gh, curl and other tools work.'
              })}
              <SecretField
                label="Key"
                value={d.value}
                onChange={(v) => set('value', v)}
                itemId={d.id}
                field="value"
                stored={stored?.kind === 'apiKey' && stored.hasValue}
                placeholder="Paste the key"
                error={err('value')}
              />
              <Field label="What it is for" error={err('description')} hint="Agents read this to know when to use the key.">
                <textarea
                  className="field"
                  aria-label="What it is for"
                  rows={2}
                  autoComplete="off"
                  value={d.description}
                  onChange={(e) => set('description', e.target.value)}
                />
              </Field>
              <label className="vault-check" data-testid="vault-workflows">
                <input type="checkbox" checked={d.workflows} onChange={(e) => set('workflows', e.target.checked)} />
                Workflow HTTP steps can use this
              </label>
              {d.workflows && (
                <div className="rt-hint">
                  A workflow's HTTP request step that picks this key sends it to that step's own host only, never shown in the run.
                </div>
              )}
            </>
          )}
        </div>

        <div className="set-block">
          <Field
            label="Agents that can use this"
            error={err('agents')}
            hint={d.agents.length === 0 ? 'None yet: no agent can use this item.' : undefined}
          >
            {p.agentNames.length === 0 ? (
              <span className="set-hint">There are no agents to pick yet.</span>
            ) : (
              <div className="vault-agents" role="group" aria-label="Agents that can use this">
                {p.agentNames.map((name) => {
                  const provider = p.agentProviders.get(name)
                  const note = vaultGrantNote(d.kind, provider ? { provider } : {})
                  return (
                    <label key={name} className="vault-check">
                      <input
                        type="checkbox"
                        data-testid={`vault-agent-${name}`}
                        checked={d.agents.includes(name)}
                        onChange={(e) => set('agents', e.target.checked ? [...d.agents, name] : d.agents.filter((a) => a !== name))}
                      />
                      {name}
                      {note && (
                        <span className="vault-check-note" data-testid={`vault-agent-note-${name}`}>
                          {note}
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            )}
          </Field>
        </div>

        {stored?.kind === 'card' && (
          <div className="set-block" data-testid="vault-approved">
            <span className="vault-label">Approved sites</span>
            {stored.approved.length === 0 ? (
              <p className="set-hint">None yet. The first use on a site asks you in the chat.</p>
            ) : (
              <ul className="vault-sites">
                {stored.approved.map((a) => (
                  <li key={`${a.site}\n${a.frameSite}`}>
                    <span className="vault-site">
                      {a.site}
                      {a.frameSite !== a.site && <span className="set-hint"> · card form on {a.frameSite}</span>}
                    </span>
                    <button type="button" className="btn small" onClick={() => p.onRemoveApproval(a.site, a.frameSite)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {p.saveError && (
        <p className="set-note bad" role="alert" data-testid="vault-error">
          {p.saveError}
        </p>
      )}
      <div className="vault-actions">
        <button type="button" className="btn primary" data-testid="vault-save" disabled={p.saving || gone} onClick={p.onSave}>
          {p.saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" disabled={p.saving} onClick={p.onCancel}>
          Cancel
        </button>
        <span className="grow" />
        {d.id !== undefined && !gone && (
          <button type="button" className="btn danger-outline" data-testid="vault-delete" disabled={p.saving} onClick={p.onDelete}>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

/** The vault: saved logins, cards, contact details and API keys, and which agents may use each. */
export function VaultSettings({ agents, handle }: { agents: AgentSummary[]; handle: RefObject<EditorHandle | null> }) {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [keyFile, setKeyFile] = useState<string | null>(null)
  const [items, setItems] = useState<VaultListItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useDismiss(menuOpen, closeMenu)

  // The newest answer wins, so a slow older one never replaces a fresh list.
  const seq = useRef(0)
  const refresh = useCallback(async (): Promise<VaultListItem[] | null> => {
    const n = ++seq.current
    try {
      const s = await api.vault.status()
      const list = keyProblem(s) ? [] : await api.vault.list()
      // The path only, and only when it is needed: a server set up with another key path must not be told the default one.
      const path = keyProblem(s) ? await api.vault.keyFile().catch(() => null) : null
      if (n !== seq.current) return null
      setKeyFile(path)
      if (keyProblem(s)) {
        // The explanation replaces any open form: one left set behind it would make the unsaved-changes guard ask about it.
        setEditing(null)
        setShowErrors(false)
        setSaveError(null)
        setDialog((d) => (d?.kind === 'reset' ? d : null))
      }
      setStatus(s)
      setItems(list)
      setLoadError(null)
      return list
    } catch (e) {
      if (n === seq.current) setLoadError(vaultErrorText(errorMessage(e)))
      return null
    }
  }, [])
  // Read again on each reconnect: a change broadcast while the socket was down is missed.
  const connected = useConnected()
  useEffect(() => {
    if (connected) void refresh()
  }, [connected, refresh])
  useEffect(() => api.vault.onChanged(() => void refresh()), [refresh])

  const editingRef = useRef(editing)
  editingRef.current = editing

  const saveDraft = async (): Promise<boolean> => {
    const cur = editingRef.current
    if (cur === null || saving) return false
    const d = cur.draft
    if (hasErrors(draftErrors(d, items ?? []))) {
      setShowErrors(true)
      return false
    }
    setSaving(true)
    setSaveError(null)
    try {
      await api.vault.save(inputOf(d), d.updatedAt)
      setEditing(null)
      setShowErrors(false)
      void refresh()
      return true
    } catch (e) {
      setSaveError(vaultErrorText(errorMessage(e)))
      return false
    } finally {
      setSaving(false)
    }
  }
  // The Settings unsaved-changes guard asks the open form through this handle, as it asks the agent and routine editors.
  const saveRef = useRef(saveDraft)
  saveRef.current = saveDraft
  useEffect(() => {
    handle.current = {
      isDirty: () => editingRef.current !== null && isDraftDirty(editingRef.current.draft, editingRef.current.opened),
      save: () => saveRef.current()
    }
    return () => {
      handle.current = null
    }
  }, [handle])

  const open = (draft: VaultDraft): void => {
    setEditing({ draft, opened: draft })
    setShowErrors(false)
    setSaveError(null)
    setNote(null)
  }
  const dirty = editing !== null && isDraftDirty(editing.draft, editing.opened)
  // Leaving a form with edits asks first.
  const leaveForm = (then: () => void): void => {
    if (dirty) setDialog({ kind: 'discard', then })
    else then()
  }
  const closeForm = (): void => {
    setEditing(null)
    setSaveError(null)
    setShowErrors(false)
  }
  const reload = async (): Promise<void> => {
    const cur = editing
    if (cur === null) return
    const list = await refresh()
    const fresh = list?.find((i) => i.id === cur.draft.id)
    if (fresh) open(draftOf(fresh))
    else if (list !== null) closeForm()
  }
  const removeApproval = async (site: string, frameSite: string): Promise<void> => {
    const cur = editing
    if (cur?.draft.id === undefined) return
    setSaveError(null)
    try {
      await api.vault.removeApproval(cur.draft.id, site, frameSite)
      const list = await refresh()
      const fresh = list?.find((i) => i.id === cur.draft.id)
      // The removal moved the stored time; the form follows it so a later save is not refused for our own change.
      if (fresh)
        setEditing((e) =>
          e ? { draft: { ...e.draft, updatedAt: fresh.updatedAt }, opened: { ...e.opened, updatedAt: fresh.updatedAt } } : e
        )
    } catch (e) {
      setSaveError(vaultErrorText(errorMessage(e)))
    }
  }
  const remove = async (): Promise<void> => {
    const id = editing?.draft.id
    if (id === undefined) return
    setBusy(true)
    try {
      await api.vault.delete(id)
      closeForm()
      void refresh()
    } catch (e) {
      setSaveError(vaultErrorText(errorMessage(e)))
    } finally {
      setBusy(false)
    }
  }
  const startNew = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      await api.vault.reset()
      await refresh()
    } catch (e) {
      setNote(vaultErrorText(errorMessage(e)))
    } finally {
      setBusy(false)
    }
  }

  const choices = agentChoices(agents)
  const editingAgents = editing?.draft.agents ?? []
  // An agent that has since gone stays listed while it is still granted, so it can be unticked.
  const agentNames = [...new Set([...choices, ...editingAgents])].sort((a, b) => a.localeCompare(b))
  const agentProviders = new Map(agents.flatMap((a) => (a.provider ? [[a.name, a.provider] as const] : [])))
  const groups = groupVault(items ?? [], query)
  const problem = keyProblem(status)

  const dialogView = (): ReactNode => {
    if (dialog === null) return null
    if (dialog.kind === 'delete') {
      return (
        <ConfirmDialog
          title="Delete item"
          message={deleteMessage(editing?.draft.id, items ?? [])}
          buttons={[
            { label: 'Delete', value: 'delete', danger: true },
            { label: 'Cancel', value: 'cancel' }
          ]}
          initialFocus="cancel"
          onResolve={(v) => {
            setDialog(null)
            if (v === 'delete') void remove()
          }}
        />
      )
    }
    if (dialog.kind === 'reset') {
      return (
        <ConfirmDialog
          title="Start a new vault"
          message="The vault file is set aside, not deleted, but its items stay unreadable without the right key. Agents lose access to them. The vault starts empty."
          buttons={[
            { label: 'Start a new vault', value: 'reset', danger: true },
            { label: 'Cancel', value: 'cancel' }
          ]}
          initialFocus="cancel"
          onResolve={(v) => {
            setDialog(null)
            if (v === 'reset') void startNew()
          }}
        />
      )
    }
    const then = dialog.then
    return (
      <ConfirmDialog
        title="Unsaved changes"
        message="This item has unsaved changes. Discard them?"
        buttons={[
          { label: 'Discard', value: 'discard', danger: true },
          { label: 'Keep editing', value: 'keep' }
        ]}
        initialFocus="keep"
        onResolve={(v) => {
          setDialog(null)
          if (v === 'discard') then?.()
        }}
      />
    )
  }

  let body: ReactNode
  if (items === null) {
    body = loadError ? (
      <p className="set-note bad" role="alert">
        {loadError}
      </p>
    ) : (
      <p className="set-hint">Loading…</p>
    )
  } else if (problem) {
    const problemCopy = keyProblemCopy(status === 'keyMissing' ? 'keyMissing' : 'keyMismatch', keyFile)
    body = (
      <div className="set-card" data-testid="vault-problem">
        <div className="set-block vault-problem">
          <p className="set-label">{problemCopy.title}</p>
          <p className="set-hint">{problemCopy.hint}</p>
          {problemCopy.path !== null && (
            <p className="set-hint vault-key-path">
              Key file: <code data-testid="vault-key-path">{problemCopy.path}</code>
            </p>
          )}
          <p className="set-hint">
            Until then agents see an empty vault and fills fail. If the key is gone for good, you can start a new vault: the old file is set
            aside, not deleted.
          </p>
          <div className="set-actions">
            <button
              type="button"
              className="btn danger-outline"
              data-testid="vault-reset"
              disabled={busy}
              onClick={() => setDialog({ kind: 'reset' })}
            >
              Start a new vault
            </button>
          </div>
          {note && (
            <p className="set-note bad" role="alert">
              {note}
            </p>
          )}
        </div>
      </div>
    )
  } else if (editing !== null) {
    body = (
      <VaultForm
        draft={editing.draft}
        items={items}
        agentNames={agentNames}
        agentProviders={agentProviders}
        showErrors={showErrors}
        saving={saving || busy}
        saveError={saveError}
        onChange={(fn) => setEditing((e) => (e ? { ...e, draft: fn(e.draft) } : e))}
        onSave={() => void saveDraft()}
        onCancel={() => leaveForm(closeForm)}
        onDelete={() => setDialog({ kind: 'delete' })}
        onReload={() => void reload()}
        onRemoveApproval={(site, frameSite) => void removeApproval(site, frameSite)}
      />
    )
  } else {
    body = (
      <>
        <div className="vault-toolbar">
          <input
            type="search"
            className="field"
            data-testid="vault-search"
            aria-label="Search the vault"
            placeholder="Search"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="vault-add">
            <button
              type="button"
              className="btn primary"
              data-testid="vault-add"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setMenuOpen((o) => !o)}
            >
              Add
            </button>
            {menuOpen && (
              <div className="menu" role="menu" onMouseDown={(e) => e.stopPropagation()}>
                {KIND_ORDER.map((k: VaultKind) => (
                  <button
                    key={k}
                    type="button"
                    role="menuitem"
                    data-testid={`vault-add-${k}`}
                    onClick={() => {
                      setMenuOpen(false)
                      open(emptyDraft(k))
                    }}
                  >
                    {KIND_LABELS[k]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {loadError && (
          <p className="set-note bad" role="alert">
            {loadError}
          </p>
        )}
        {items.length === 0 ? (
          <p className="set-hint" data-testid="vault-empty">
            Nothing saved yet. Add a login, card, contact or API key.
          </p>
        ) : groups.length === 0 ? (
          <p className="set-hint">Nothing matches.</p>
        ) : (
          groups.map((g) => (
            <section key={g.kind} data-testid={`vault-group-${g.kind}`}>
              <h2 className="set-group">{KIND_LABELS[g.kind]}</h2>
              <div className="set-card">
                {g.items.map((i) => (
                  <button key={i.id} type="button" className="vault-row" data-testid={`vault-row-${i.id}`} onClick={() => open(draftOf(i))}>
                    <span className="set-text">
                      <span className="set-label">{i.name}</span>
                      {rowLine(i) !== '' && <span className="set-hint vault-line">{rowLine(i)}</span>}
                    </span>
                    <span className="set-value">{agentCount(i.agents.length)}</span>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </>
    )
  }

  return (
    <div data-testid="settings-vault">
      <p className="set-intro">Encrypted on this server. Agents never see passwords, codes or card numbers.</p>
      {body}
      <p className="set-foot">
        Agents run as the same user as this server, so a determined agent could still read the vault files; the vault key never leaves this
        machine except through Sync.
      </p>
      {dialogView()}
    </div>
  )
}
