import { useRef, useState, type RefObject } from 'react'
import type { Loadout } from '@zumibot/shared/extensions'
import type { AgentFields } from '@zumibot/shared/frontmatter'
import { blockNoteOf } from '../state/extensions'
import {
  ownHookRows,
  ownHookSeed,
  ownServerRows,
  ownServerSeed,
  removeOwnHook,
  removeOwnServer,
  saveOwnHook,
  saveOwnServer,
  type OwnHookRow
} from '../state/agentLoadout'
import { oneLine } from '../state/extensionsPage'
import type { EditorHandle } from './AgentEditor'
import { useReturnFocus } from './ExtFormParts'
import { HookForm } from './HookForm'
import { McpServerForm } from './McpServerForm'

interface Props {
  fields: AgentFields
  /** The saved agent's loadout: it says which own servers were not started and which names clash. */
  loadout: Loadout | null
  /** Vault API keys granted to this agent, for the From Vault picker. */
  vaultKeys: Array<{ env: string; name: string }>
  onFields: (patch: Partial<AgentFields>) => void
  /** The open sub-form, for Agent Studio's unsaved-changes guard: leaving with a draft here asks first. */
  handle?: RefObject<EditorHandle | null>
}

// `n` makes every open a new form, so no draft carries over from another.
type ServerForm = { n: number; edit: string | null }
type HookFormState = { n: number; row: OwnHookRow | null }

/**
 * The agent's own `mcpServers` (the CLI's subagent key, which ZumiBot also applies to the agent's own runs). The forms are the
 * Settings page's, in the agent file mode: values shown, no scope. A save goes into the draft through `onFields`; the editor's own
 * Save writes the file. A block the editor could not read whole is kept in the file and shows only its note, no editing.
 */
export function OwnServersCard({ fields, loadout, vaultKeys, onFields, handle }: Props) {
  const [form, setForm] = useState<ServerForm | null>(null)
  const seq = useRef(0)
  const box = useRef<HTMLDivElement | null>(null)
  const focus = useReturnFocus(box)
  const note = blockNoteOf(fields, 'mcpServers')
  const rows = ownServerRows(fields, loadout)
  const entry = form?.edit != null ? fields.mcpServers?.entries.find((e) => e.name === form.edit) : undefined
  const open = (edit: string | null): void => {
    focus.remember()
    setForm({ n: ++seq.current, edit })
  }
  const close = (): void => {
    setForm(null)
    focus.restore()
  }

  if (form !== null && !note) {
    const edit = form.edit
    const inline = entry && entry.def !== null ? { ...entry, def: entry.def } : null
    return (
      <div className="al-sub" data-testid="agent-own-servers" ref={box}>
        <McpServerForm
          key={form.n}
          view={inline ? ownServerSeed(inline) : null}
          scopes={null}
          vaultKeys={vaultKeys}
          handle={handle}
          onCancel={close}
          onSave={(name, _scope, input) => {
            const r = saveOwnServer(fields, edit, name, input)
            // The form shows a rejection's message and stays open.
            if (!r.ok) throw new Error(r.error)
            onFields(r.patch)
            close()
          }}
        />
      </div>
    )
  }

  return (
    <div className="al-sub" data-testid="agent-own-servers" ref={box}>
      <div className="al-sub-head">
        <h4 className="al-sub-title">This agent's own servers</h4>
        <span className="grow" />
        {!note && (
          <button type="button" className="btn small" data-testid="agent-own-server-add" onClick={() => open(null)}>
            Add server
          </button>
        )}
      </div>
      {note ? (
        <p className="ext-note" data-testid="agent-own-note">
          {note} Edit it in the Raw view.
        </p>
      ) : (
        <>
          <p className="ext-note">Servers only this agent loads. They are saved in its file.</p>
          {vaultKeys.length === 0 && (
            <p className="ext-note">
              To keep a secret out of the file, grant a Vault API key to this agent in Settings › Vault, then pick it with From Vault.
            </p>
          )}
          {rows.length === 0 ? (
            <p className="ext-note" data-testid="agent-own-empty">
              None yet.
            </p>
          ) : (
            <div className="set-card">
              {rows.map((r) => (
                <div className="ext-row" key={r.name} data-testid="agent-own-server" data-name={r.name}>
                  <div className="ext-row-main">
                    <span className="set-label ext-name">{r.name}</span>
                    <span className="ext-tag">{r.detail}</span>
                    <span className="grow" />
                    <span className="set-actions">
                      {r.inline && (
                        <button
                          type="button"
                          className="btn small"
                          data-testid="agent-own-server-edit"
                          aria-label={`Edit ${r.name}`}
                          onClick={() => open(r.name)}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn small danger-outline"
                        data-testid="agent-own-server-remove"
                        aria-label={`Remove ${r.name}`}
                        onClick={() => {
                          const res = removeOwnServer(fields, r.name)
                          if (res.ok) onFields(res.patch)
                        }}
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                  {r.note && (
                    <p className="ext-note warn" data-testid="agent-own-server-note">
                      {r.note}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** The agent's own `hooks` (settings.json format). Only command hooks are written here; any other shape keeps the whole block read-only. */
export function OwnHooksCard({ fields, onFields, handle }: Pick<Props, 'fields' | 'onFields' | 'handle'>) {
  const [form, setForm] = useState<HookFormState | null>(null)
  const seq = useRef(0)
  const box = useRef<HTMLDivElement | null>(null)
  const focus = useReturnFocus(box)
  const note = blockNoteOf(fields, 'hooks')
  const rows = ownHookRows(fields)
  const open = (row: OwnHookRow | null): void => {
    focus.remember()
    setForm({ n: ++seq.current, row })
  }
  const close = (): void => {
    setForm(null)
    focus.restore()
  }

  if (form !== null && !note) {
    return (
      <div className="al-sub" data-testid="agent-own-hooks" ref={box}>
        <HookForm
          key={form.n}
          value={form.row ? ownHookSeed(form.row) : null}
          files={null}
          handle={handle}
          onCancel={close}
          onSave={(_file, input) => {
            const r = saveOwnHook(fields, input)
            // The form shows a rejection's message and stays open.
            if (!r.ok) throw new Error(r.error)
            onFields(r.patch)
            close()
          }}
        />
      </div>
    )
  }

  return (
    <div className="al-sub" data-testid="agent-own-hooks" ref={box}>
      <div className="al-sub-head">
        <h4 className="al-sub-title">This agent's own hooks</h4>
        <span className="grow" />
        {!note && (
          <button type="button" className="btn small" data-testid="agent-own-hook-add" onClick={() => open(null)}>
            Add hook
          </button>
        )}
      </div>
      {note ? (
        <p className="ext-note" data-testid="agent-own-note">
          {note} Edit it in the Raw view.
        </p>
      ) : (
        <>
          <p className="ext-note">Commands that run for this agent only, on top of your own hooks.</p>
          {rows.length === 0 ? (
            <p className="ext-note" data-testid="agent-own-empty">
              None yet.
            </p>
          ) : (
            <div className="set-card">
              {rows.map((r) => (
                <div className="ext-row" key={`${r.event}:${r.group}:${r.hook}`} data-testid="agent-own-hook" data-name={r.event}>
                  <div className="ext-row-main">
                    <span className="set-label ext-name">{r.event}</span>
                    <span className="ext-tag">{r.matcher === '' ? 'Every tool' : r.matcher}</span>
                    {r.timeout !== null && <span className="ext-tag">{r.timeout} s</span>}
                    <span className="grow" />
                    <span className="set-actions">
                      <button
                        type="button"
                        className="btn small"
                        data-testid="agent-own-hook-edit"
                        aria-label={`Edit the ${r.event} hook`}
                        onClick={() => open(r)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn small danger-outline"
                        data-testid="agent-own-hook-remove"
                        aria-label={`Remove the ${r.event} hook`}
                        onClick={() => {
                          const res = removeOwnHook(fields, r.event, { group: r.group, hook: r.hook })
                          if (res.ok) onFields(res.patch)
                        }}
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                  <code className="ext-code">{oneLine(r.command)}</code>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
