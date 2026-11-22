import { useEffect, useRef, useState } from 'react'
import { ACP_STUDIO_TEXT, ACP_TEXT, type AcpLaunch, type AcpTestResult } from '@zumibot/shared/acp'
import type { Provider } from '@zumibot/shared/engine'
import { EXT_TEXT } from '@zumibot/shared/extensions'
import type { AgentFields } from '@zumibot/shared/frontmatter'
import type { VaultListItem } from '@zumibot/shared/vault'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useConnected } from '../useConnected'
import {
  acpDraftError,
  acpTestBlocked,
  acpTestKey,
  acpTestRows,
  editAcpDraft,
  launchCompare,
  shownAcpDraft,
  signInKeyChoices,
  toggleSignInKey,
  type AcpDraft,
  type LaunchCompare
} from '../state/acpCard'
import { EditorIcon } from './EditorIcon'

export interface SavedAcp {
  name: string
  provider: Provider | null
  acp: AcpLaunch | null
}

interface Props {
  fields: AgentFields
  onFields: (patch: Partial<AgentFields>) => void
  /** False when the file's `acp:` did not parse: the card says why and edits nothing (the Raw view fixes it). */
  acpEditable: boolean
  /** The saved file (null for a new agent): Test runs its launch, and the Vault grants are keyed by its name. */
  saved: SavedAcp | null
  /** The launch Save confirmed on this machine; undefined while it is not known. */
  confirmed: AcpLaunch | null | undefined
}

/** Agent Studio's ACP card: Command, Arguments, Sign-in keys, the confirmed launch beside the current one, and Test. */
export function AcpCard({ fields, onFields, acpEditable, saved, confirmed }: Props) {
  const [draft, setDraft] = useState<AcpDraft | null>(null)
  const [vaultItems, setVaultItems] = useState<VaultListItem[]>([])
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AcpTestResult | null>(null)
  const savedName = saved?.name ?? null
  const testKey = acpTestKey(saved)
  // The saved launch now, for a Test answer that comes back after a Save.
  const latestKey = useRef(testKey)
  latestKey.current = testKey

  // The API keys granted to the saved agent, for Sign-in keys: env names only. A locked or empty vault offers none.
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    let live = true
    const load = (): void => {
      api.vault.list().then(
        (items) => live && setVaultItems(items),
        () => live && setVaultItems([])
      )
    }
    load()
    const off = api.vault.onChanged(load)
    return () => {
      live = false
      off()
    }
  }, [connected])

  // A result answers the launch it tested; a Save of another one clears it.
  useEffect(() => setResult(null), [testKey])

  const shown = shownAcpDraft(draft, fields.acp)
  const edit = (patch: Partial<AcpDraft>): void => {
    const next = editAcpDraft(shown, patch)
    setDraft(next.draft)
    onFields({ acp: next.acp })
  }
  const error = acpEditable ? acpDraftError(shown) : null
  const choices = signInKeyChoices(vaultItems, savedName, shown.authEnv)
  const compare = acpEditable ? launchCompare(confirmed, fields.acp) : null
  const blocked = acpTestBlocked(saved, fields)

  const test = async (): Promise<void> => {
    if (savedName === null) return
    const pressed = testKey
    setTesting(true)
    setResult(null)
    let r: AcpTestResult
    try {
      r = await api.agents.testAcp(savedName)
    } catch (e) {
      r = { error: errorMessage(e) }
    } finally {
      setTesting(false)
    }
    // A Save of another launch while it ran: the answer is about a launch the card no longer shows.
    if (latestKey.current === pressed) setResult(r)
  }

  return (
    <section className="card" aria-labelledby="card-acp" data-testid="acp-card">
      <header className="card-head">
        <EditorIcon name="terminal" />
        <h3 className="card-title" id="card-acp">
          ACP agent
        </h3>
        <span className="card-meta">Agent Client Protocol</span>
      </header>

      {!acpEditable ? (
        <p className="field-error" role="alert" data-testid="acp-unreadable">
          {ACP_TEXT.launchUnreadable}
        </p>
      ) : (
        <>
          <div className="form-field">
            <label className="lbl" htmlFor="acp-command">
              Command
            </label>
            <input
              id="acp-command"
              className="field mono"
              spellCheck={false}
              placeholder="gemini"
              value={shown.command}
              aria-invalid={error === ACP_TEXT.commandRequired || error === ACP_TEXT.commandInvalid}
              data-testid="acp-command"
              onChange={(e) => edit({ command: e.target.value })}
            />
            <div className="hint">A name found on this machine's PATH, or an absolute path.</div>
          </div>
          <div className="form-field">
            <label className="lbl" htmlFor="acp-args">
              Arguments
            </label>
            <textarea
              id="acp-args"
              className="field mono"
              rows={3}
              spellCheck={false}
              placeholder="--acp"
              value={shown.argsText}
              data-testid="acp-args"
              onChange={(e) => edit({ argsText: e.target.value })}
            />
            <div className="hint">One per line. {ACP_STUDIO_TEXT.args}</div>
          </div>
          {error && (
            <div className="field-error" role="alert" data-testid="acp-error">
              {error}
            </div>
          )}
          <div className="form-field">
            <div className="lbl" id="acp-keys-label">
              Sign-in keys
            </div>
            {choices.length === 0 ? (
              <div className="hint">{ACP_STUDIO_TEXT.noKeys}</div>
            ) : (
              <div className="acp-keys" role="group" aria-labelledby="acp-keys-label" data-testid="acp-keys">
                {choices.map((c) => (
                  <label key={c.env} className="acp-key">
                    <input
                      type="checkbox"
                      checked={c.picked}
                      onChange={(e) => edit({ authEnv: toggleSignInKey(shown.authEnv, c.env, e.target.checked) })}
                    />
                    <span className="mono">{c.env}</span>
                    {c.name !== null && <span className="acp-key-name">{c.name}</span>}
                    {!c.granted && <span className="field-error">{ACP_STUDIO_TEXT.notGranted}</span>}
                  </label>
                ))}
              </div>
            )}
            <div className="hint">{ACP_STUDIO_TEXT.signIn}</div>
          </div>
          {compare && <LaunchCompareNote compare={compare} />}
        </>
      )}

      <div className="acp-test">
        <button
          type="button"
          className="btn small"
          disabled={blocked !== null || testing}
          data-testid="acp-test"
          onClick={() => void test()}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <span className="hint">{blocked ?? ACP_STUDIO_TEXT.testNote}</span>
      </div>
      {result !== null &&
        ('error' in result ? (
          <p className="set-note bad" role="alert" data-testid="acp-test-error">
            {result.error}
          </p>
        ) : (
          <dl className="acp-result" data-testid="acp-test-result">
            {acpTestRows(result).map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        ))}

      <p className="card-note">{ACP_STUDIO_TEXT.asks}</p>
      <p className="card-note">
        {ACP_STUDIO_TEXT.unused} {EXT_TEXT.acpUnsupported}
      </p>
    </section>
  )
}

/** The launch confirmed on this machine beside the one Save confirms (`launchCompare`): in the ACP card, and over the Raw view. */
export function LaunchCompareNote({ compare, className }: { compare: LaunchCompare; className?: string }) {
  return (
    <div className={className ? `acp-compare ${className}` : 'acp-compare'} role="status" data-testid="acp-compare">
      <p>{compare.note}</p>
      <dl>
        <dt>{ACP_STUDIO_TEXT.confirmed}</dt>
        <dd className="mono">{compare.confirmed ?? 'None'}</dd>
        <dt>{ACP_STUDIO_TEXT.current}</dt>
        <dd className="mono">{compare.current}</dd>
      </dl>
    </div>
  )
}
