import { useState, type RefObject } from 'react'
import type { McpScope, McpServerInput, McpServerView } from '@zumibot/shared/extensions'
import { errorMessage } from '../errors'
import {
  emptyServerDraft,
  hasErrors,
  isPlainValue,
  isServerDirty,
  newValueRow,
  serverDraftOf,
  serverErrors,
  serverInputOf,
  showVaultPicker,
  withArgsText,
  withVaultReference,
  type ServerDraft,
  type Transport,
  type ValueRow
} from '../state/extensionForms'
import { SCOPE_LABEL } from '../state/extensionsPage'
import type { EditorHandle } from './AgentEditor'
import { Field, SaveError, useCancel, useFormGuard, useHeadingFocus } from './ExtFormParts'
import { SearchSelect } from './SearchSelect'

interface Props {
  /** The server being edited, or null for a new one. */
  view: McpServerView | null
  /** Where it may be saved. Null is the agent file mode: no scope, and every value is shown (the file holds them as typed). */
  scopes: McpScope[] | null
  /** The folder a local or project server belongs to, named under the scope. */
  folder?: string
  /** Vault API keys the agent may use: each value row then offers them, writing a reference instead of a secret. */
  vaultKeys?: Array<{ env: string; name: string }>
  /** Rejects with the sentence to show; resolving closes the form. */
  onSave: (name: string, scope: McpScope | null, input: McpServerInput) => void | Promise<void>
  onCancel: () => void
  handle?: RefObject<EditorHandle | null>
  /** Reopens the form from a fresh view, offered beside a stale or lost save's error. */
  onReload?: () => void
}

const TRANSPORTS: Array<{ value: Transport; label: string }> = [
  { value: 'stdio', label: 'Command (runs on this machine)' },
  { value: 'http', label: 'HTTP URL' },
  { value: 'sse', label: 'SSE URL' }
]

interface RowsProps {
  label: string
  rows: ValueRow[]
  onChange: (rows: ValueRow[]) => void
  showValues: boolean
  vaultKeys?: Array<{ env: string; name: string }>
  /** The From Vault picker shows (agent file mode only). */
  pickVault: boolean
  error?: string
  testId: string
  nameHint: string
}

/** Name and value rows. A stored value is never here: its row is blank with a placeholder, and blank keeps it. */
function ValueRows({ label, rows, onChange, showValues, vaultKeys, pickVault, error, testId, nameHint }: RowsProps) {
  const set = (i: number, patch: Partial<ValueRow>): void => onChange(rows.map((r, at) => (at === i ? { ...r, ...patch } : r)))
  return (
    <Field label={label} error={error}>
      <div className="ext-kv-list" data-testid={testId}>
        {rows.map((r, i) => (
          <div className="ext-kv" key={i}>
            {/* A stored row's name is fixed: renaming it would drop the value the page never saw. Remove it and add a new one. */}
            <input
              className="field vault-mono"
              aria-label={`${label}: name ${i + 1}`}
              placeholder={nameHint}
              autoComplete="off"
              spellCheck={false}
              readOnly={r.stored}
              value={r.name}
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <input
              className="field vault-mono"
              type={showValues ? 'text' : 'password'}
              aria-label={`${label}: value ${i + 1}`}
              placeholder={r.stored && r.value === '' ? 'Saved. Leave blank to keep it.' : 'Value'}
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={r.value}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            {vaultKeys && pickVault && (
              <SearchSelect
                className="field ext-kv-vault"
                aria-label={`${label}: value ${i + 1} from Vault`}
                value=""
                onChange={(v) => v !== '' && set(i, { value: withVaultReference(r.value, v) })}
              >
                <option value="">From Vault…</option>
                {vaultKeys.map((k) => (
                  <option key={k.env} value={k.env}>
                    {k.name} (${k.env})
                  </option>
                ))}
              </SearchSelect>
            )}
            <button
              type="button"
              className="btn small"
              aria-label={`Remove ${label}: row ${i + 1}`}
              onClick={() => onChange(rows.filter((_, at) => at !== i))}
            >
              Remove
            </button>
            {/* The file keeps a typed value as it is; a Vault reference keeps the secret out of it. */}
            {showValues && isPlainValue(r.value) && (
              <span className="set-hint ext-kv-plain" data-testid="ext-plain-value">
                Stored as plain text in the agent file
              </span>
            )}
          </div>
        ))}
        <div>
          <button type="button" className="btn small" data-testid={`${testId}-add`} onClick={() => onChange([...rows, newValueRow()])}>
            Add
          </button>
        </div>
      </div>
    </Field>
  )
}

/** One MCP server's form: used by Settings › Claude Code (three scopes, values hidden) and by an agent's own servers (no scope, values shown). */
export function McpServerForm(p: Props) {
  const [opened] = useState<ServerDraft>(() => {
    if (p.view) return serverDraftOf(p.view)
    return emptyServerDraft(p.scopes === null ? null : p.scopes.includes('user') ? 'user' : (p.scopes[0] ?? null))
  })
  const [draft, setDraft] = useState(opened)
  const heading = useHeadingFocus<HTMLHeadingElement>()
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const dirty = isServerDirty(draft, opened)
  const { cancel, dialog } = useCancel(dirty, p.onCancel)

  const errors = serverErrors(draft, p.scopes)
  const err = (k: string): string | undefined => (showErrors ? errors[k] : undefined)
  const set = <K extends keyof ServerDraft>(k: K, v: ServerDraft[K]): void => setDraft((d) => ({ ...d, [k]: v }))
  const showValues = p.scopes === null

  // The guard reads the latest closure at call time (useFormGuard), so these see the current draft.
  const submit = async (): Promise<boolean> => {
    const d = draft
    if (saving) return false
    if (hasErrors(serverErrors(d, p.scopes))) {
      setShowErrors(true)
      return false
    }
    setSaving(true)
    setSaveError(null)
    try {
      await p.onSave(d.name.trim(), p.scopes === null ? null : d.scope, serverInputOf(d))
      return true
    } catch (e) {
      setSaveError(errorMessage(e))
      return false
    } finally {
      setSaving(false)
    }
  }
  useFormGuard(p.handle, () => isServerDirty(draft, opened), submit)

  const editing = p.view !== null
  const scope = draft.scope

  return (
    <div data-testid="ext-server-form">
      <div className="vault-form-head">
        <button type="button" className="btn ghost small" data-testid="ext-form-back" onClick={cancel}>
          ← Back
        </button>
        <h2 className="vault-form-title" tabIndex={-1} ref={heading}>
          {editing ? 'Edit server' : 'New server'}
        </h2>
      </div>
      <div className="set-card">
        <div className="set-block vault-fields">
          <Field label="Name" error={err('name')}>
            <input
              className="field"
              aria-label="Name"
              aria-invalid={err('name') ? true : undefined}
              placeholder="my-server"
              autoComplete="off"
              spellCheck={false}
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          {p.scopes !== null && (
            <Field
              label="Save it for"
              error={err('scope')}
              hint={scope !== null && scope !== 'user' && p.folder ? `The folder is ${p.folder}.` : undefined}
            >
              {editing || p.scopes.length < 2 ? (
                <span className="set-hint" data-testid="ext-form-scope">
                  {scope === null ? '' : SCOPE_LABEL[scope]}
                </span>
              ) : (
                <SearchSelect
                  className="field"
                  aria-label="Save it for"
                  data-testid="ext-form-scope"
                  value={scope ?? ''}
                  onChange={(v) => set('scope', v as McpScope)}
                >
                  {p.scopes.map((s) => (
                    <option key={s} value={s}>
                      {SCOPE_LABEL[s]}
                    </option>
                  ))}
                </SearchSelect>
              )}
            </Field>
          )}

          <Field label="Type">
            <SearchSelect
              className="field"
              aria-label="Type"
              data-testid="ext-form-transport"
              value={draft.transport}
              onChange={(v) => set('transport', v as Transport)}
            >
              {TRANSPORTS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </SearchSelect>
          </Field>

          {draft.transport === 'stdio' ? (
            <>
              <Field label="Command" error={err('command')}>
                <input
                  className="field vault-mono"
                  aria-label="Command"
                  aria-invalid={err('command') ? true : undefined}
                  placeholder="npx"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.command}
                  onChange={(e) => set('command', e.target.value)}
                />
              </Field>
              <Field label="Arguments" error={err('args')} hint="One per line.">
                <textarea
                  className="field vault-mono"
                  aria-label="Arguments"
                  aria-invalid={err('args') ? true : undefined}
                  rows={3}
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.argsText}
                  onChange={(e) => setDraft((d) => withArgsText(d, e.target.value))}
                />
              </Field>
              <ValueRows
                label="Environment variables"
                rows={draft.env}
                onChange={(rows) => set('env', rows)}
                showValues={showValues}
                vaultKeys={p.vaultKeys}
                pickVault={showVaultPicker(p.scopes, p.vaultKeys)}
                error={err('env')}
                testId="ext-form-env"
                nameHint="NAME"
              />
            </>
          ) : (
            <>
              <Field label="URL" error={err('url')}>
                <input
                  className="field vault-mono"
                  aria-label="URL"
                  aria-invalid={err('url') ? true : undefined}
                  placeholder="https://example.com/mcp"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.url}
                  onChange={(e) => set('url', e.target.value)}
                />
              </Field>
              <ValueRows
                label="Headers"
                rows={draft.headers}
                onChange={(rows) => set('headers', rows)}
                showValues={showValues}
                vaultKeys={p.vaultKeys}
                pickVault={showVaultPicker(p.scopes, p.vaultKeys)}
                error={err('headers')}
                testId="ext-form-headers"
                nameHint="Header"
              />
            </>
          )}
          {!showValues && (
            <span className="set-hint">
              Saved values stay on this machine and are never shown here again. Leave a saved value blank to keep it.
            </span>
          )}
        </div>
      </div>

      <SaveError error={saveError} onReload={p.onReload} />
      <div className="vault-actions">
        <button type="button" className="btn primary" data-testid="ext-form-save" disabled={saving} onClick={() => void submit()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" disabled={saving} onClick={cancel}>
          Cancel
        </button>
      </div>
      {dialog}
    </div>
  )
}
