import { useEffect, useRef, useState } from 'react'
import { AGUI_STUDIO_TEXT, AGUI_TEXT, type AguiLaunch, type AguiTestResult } from '@zumibot/shared/agui'
import { EXT_TEXT } from '@zumibot/shared/extensions'
import type { Provider } from '@zumibot/shared/engine'
import type { AgentFields } from '@zumibot/shared/frontmatter'
import type { VaultListItem } from '@zumibot/shared/vault'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useConnected } from '../useConnected'
import { launchCompare } from '../state/acpCard'
import {
  aguiDraftError,
  aguiTestBlocked,
  aguiTestKey,
  aguiTestRows,
  editAguiDraft,
  keyChoices,
  keyOptionLabel,
  olderChatsNote,
  remoteNotice,
  shownAguiDraft,
  type AguiDraft
} from '../state/aguiCard'
import { LaunchCompareNote } from './AcpCard'
import { EditorIcon } from './EditorIcon'
import { SearchSelect } from './SearchSelect'

export interface SavedAgui {
  name: string
  provider: Provider | null
  agui: AguiLaunch | null
}

interface Props {
  fields: AgentFields
  onFields: (patch: Partial<AgentFields>) => void
  /** False when the file's `agui:` did not parse: the card says why and edits nothing (the Raw view fixes it). */
  aguiEditable: boolean
  /** The saved file (null for a new agent): Test checks its endpoint, and the Vault grants are keyed by its name. */
  saved: SavedAgui | null
  /** The endpoint Save confirmed on this machine; undefined while it is not known. */
  confirmed: AguiLaunch | null | undefined
  /** The draft's problem as the card names it (null for none, and once the card is gone), for the editor's error list. */
  onDraftError?: (error: string | null) => void
}

/** Agent Studio's remote agent card: Endpoint, Auth key, Auth header, the remote notice, the confirmed launch beside the current one, and Test. */
export function AguiCard({ fields, onFields, aguiEditable, saved, confirmed, onDraftError }: Props) {
  const [draft, setDraft] = useState<AguiDraft | null>(null)
  const [vaultItems, setVaultItems] = useState<VaultListItem[]>([])
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AguiTestResult | null>(null)
  const savedName = saved?.name ?? null
  const testKey = aguiTestKey(saved)
  // The saved launch now, for a Test answer that comes back after a Save.
  const latestKey = useRef(testKey)
  latestKey.current = testKey

  // The API keys granted to the saved agent, for Auth key: env names only. A locked or empty vault offers none.
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

  const shown = shownAguiDraft(draft, fields.agui)
  const edit = (patch: Partial<AguiDraft>): void => {
    const next = editAguiDraft(shown, patch)
    setDraft(next.draft)
    onFields({ agui: next.agui })
  }
  const error = aguiEditable ? aguiDraftError(shown) : null
  // The form holds no launch while the draft is invalid, so Save's list would only say one is required: it names this instead.
  useEffect(() => {
    onDraftError?.(error)
  }, [error, onDraftError])
  useEffect(() => () => onDraftError?.(null), [onDraftError])
  const choices = keyChoices(vaultItems, savedName, shown.authKey)
  const compare = aguiEditable ? launchCompare(confirmed, fields.agui) : null
  const blocked = aguiTestBlocked(saved, fields)
  const notice = aguiEditable ? remoteNotice(fields.agui) : null
  const older = olderChatsNote(saved, fields)

  const test = async (): Promise<void> => {
    if (savedName === null) return
    const pressed = testKey
    setTesting(true)
    setResult(null)
    let r: AguiTestResult
    try {
      r = await api.agents.testAgui(savedName)
    } catch (e) {
      r = { error: errorMessage(e) }
    } finally {
      setTesting(false)
    }
    // A Save of another launch while it ran: the answer is about a launch the card no longer shows.
    if (latestKey.current === pressed) setResult(r)
  }

  return (
    <section className="card" aria-labelledby="card-agui" data-testid="agui-card">
      <header className="card-head">
        <EditorIcon name="terminal" />
        <h3 className="card-title" id="card-agui">
          {AGUI_STUDIO_TEXT.title}
        </h3>
        <span className="card-meta">{AGUI_STUDIO_TEXT.meta}</span>
      </header>

      {notice !== null && (
        <p className="card-note" role="status" data-testid="agui-remote">
          {notice}
        </p>
      )}
      {older !== null && (
        <p className="card-note" role="status" data-testid="agui-older-chats">
          {older}
        </p>
      )}

      {!aguiEditable ? (
        <p className="field-error" role="alert" data-testid="agui-unreadable">
          {AGUI_TEXT.launchUnreadable}
        </p>
      ) : (
        <>
          <div className="form-field">
            <label className="lbl" htmlFor="agui-endpoint">
              {AGUI_STUDIO_TEXT.endpointLabel}
            </label>
            <input
              id="agui-endpoint"
              className="field mono"
              spellCheck={false}
              placeholder={AGUI_STUDIO_TEXT.endpointPlaceholder}
              value={shown.endpoint}
              aria-invalid={error === AGUI_TEXT.endpointRequired || error === AGUI_TEXT.endpointInvalid}
              data-testid="agui-endpoint"
              onChange={(e) => edit({ endpoint: e.target.value })}
            />
            <div className="hint">{AGUI_STUDIO_TEXT.endpointHint}</div>
          </div>
          <div className="form-field">
            <label className="lbl" htmlFor="agui-key">
              {AGUI_STUDIO_TEXT.keyLabel}
            </label>
            <SearchSelect
              id="agui-key"
              className="field mono"
              value={shown.authKey ?? ''}
              data-testid="agui-key"
              onChange={(v) => edit({ authKey: v === '' ? null : v })}
            >
              <option value="">{AGUI_STUDIO_TEXT.keyNone}</option>
              {choices.map((c) => (
                <option key={c.env} value={c.env}>
                  {keyOptionLabel(c)}
                </option>
              ))}
            </SearchSelect>
            {choices.length === 0 && <div className="hint">{AGUI_STUDIO_TEXT.noKeys}</div>}
          </div>
          <div className="form-field">
            <label className="lbl" htmlFor="agui-header">
              {AGUI_STUDIO_TEXT.headerLabel}
            </label>
            <input
              id="agui-header"
              className="field mono"
              spellCheck={false}
              placeholder={AGUI_STUDIO_TEXT.headerPlaceholder}
              value={shown.authHeader}
              data-testid="agui-header"
              onChange={(e) => edit({ authHeader: e.target.value })}
            />
            <div className="hint">{AGUI_STUDIO_TEXT.header}</div>
          </div>
          {error && (
            <div className="field-error" role="alert" data-testid="agui-error">
              {error}
            </div>
          )}
          {compare && <LaunchCompareNote compare={compare} />}
        </>
      )}

      <div className="acp-test">
        <button
          type="button"
          className="btn small"
          disabled={blocked !== null || testing}
          data-testid="agui-test"
          onClick={() => void test()}
        >
          {testing ? AGUI_STUDIO_TEXT.testing : AGUI_STUDIO_TEXT.test}
        </button>
        <span className="hint">{blocked ?? AGUI_STUDIO_TEXT.testNote}</span>
      </div>
      {result !== null &&
        ('error' in result ? (
          <p className="set-note bad" role="alert" data-testid="agui-test-error">
            {result.error}
          </p>
        ) : (
          <dl className="acp-result" data-testid="agui-test-result">
            {aguiTestRows(result).map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        ))}

      <p className="card-note">
        {AGUI_STUDIO_TEXT.unused} {EXT_TEXT.aguiUnsupported}
      </p>
    </section>
  )
}
