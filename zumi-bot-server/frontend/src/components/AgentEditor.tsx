import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useDismiss } from '../useDismiss'
import { useConnected } from '../useConnected'
import { isNotConnected } from '../state/resync'
import { Glyph } from './Sidebar'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { displayName, parseAgent } from '@zumibot/shared/frontmatter'
import type { CodexInfo } from '@zumibot/shared/engine'
import type { SaveAgentResult } from '@zumibot/shared/types'
import { useBrowser } from '../useAgentBrowser'
import { api } from '../api'
import { errorMessage } from '../errors'
import {
  editBody,
  editFields,
  editRaw,
  forTextarea,
  initEditor,
  isDirty,
  markSaved,
  needsSave,
  saveErrors,
  setMode,
  type EditorState
} from '../state/editorState'
import { CODEX_INFO_FALLBACK, engineOfFields } from '../state/agentEngine'
import { confirmedFor, confirmedLaunchName, confirmPending, launchCompare, studioCards, type ConfirmedLaunch } from '../state/acpCard'
import { LaunchCompareNote } from './AcpCard'
import { AgentForm } from './AgentForm'
import { BotIcon } from './BotIcon'
import { AgentDesktop } from './AgentDesktop'
import { AgentIsolation } from './AgentIsolation'
import { joinGuards } from '../state/formGuards'
import { AgentLoadout } from './AgentLoadout'
import { AgentMemory } from './AgentMemory'
import { RememberedApprovals } from './RememberedApprovals'
import { ConfirmDialog } from './ConfirmDialog'
import { EditorIcon } from './EditorIcon'

export type SavedAgent = Extract<SaveAgentResult, { ok: true }>

/** What App needs from the open editor to guard navigation. */
export interface EditorHandle {
  isDirty(): boolean
  /** Saves like the toolbar does; true when nothing is left unsaved. */
  save(): Promise<boolean>
}

interface Props {
  /** The file to open. Read once on mount: later renames are tracked inside the editor, and App remounts it per navigation. */
  filePath: string | null
  handle: RefObject<EditorHandle | null>
  onSaved: (saved: SavedAgent) => void
  onDeleted: () => void
  onError: (e: unknown) => void
  /** Scroll the Memory section into view on open (App sets it for a memory link). */
  focusMemory?: boolean
  /** Opens Settings › Connectors, through App's unsaved-changes guard. */
  onOpenConnectors?: () => void
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

const STATUS_LABELS = { saved: 'Saved', unsaved: 'Unsaved changes', new: 'New' } as const

export function AgentEditor({ filePath, handle, onSaved, onDeleted, onError, focusMemory, onOpenConnectors }: Props) {
  const browser = useBrowser()
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [browserNotice, setBrowserNotice] = useState<string | null>(null)
  const [state, setState] = useState<EditorState | null>(() => (filePath === null ? initEditor(null, null) : null))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false) // a save was refused: show the validation errors live
  const [aguiDraftError, setAguiDraftError] = useState<string | null>(null) // the remote card's problem with its draft
  const [diskCopy, setDiskCopy] = useState<string | null>(null) // newer content on disk than the user's base
  const [goneOnDisk, setGoneOnDisk] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The header's More menu, anchored under its button from the window's right edge.
  const [moreMenu, setMoreMenu] = useState<{ right: number; top: number } | null>(null)
  const closeMoreMenu = useCallback(() => setMoreMenu(null), [])
  useDismiss(moreMenu !== null, closeMoreMenu)
  // Asked once on open; a failed lookup leaves Codex pickable (the server refuses a missing CLI itself).
  const [codexInfo, setCodexInfo] = useState<CodexInfo>(CODEX_INFO_FALLBACK)
  // The launch (ACP's or a remote agent's, by the form's engine) Save confirmed on this machine for the saved name; undefined while unknown (or for another engine).
  const [loadedLaunch, setLoadedLaunch] = useState<ConfirmedLaunch | undefined>(undefined)

  // Async callbacks (disk events, the close flow) must see the latest state and props, not their render's.
  const stateRef = useRef(state)
  const props = useRef({ onSaved, onDeleted, onError })
  props.current = { onSaved, onDeleted, onError }
  const diskRequest = useRef(0)
  const keptDisk = useRef<string | null>(null) // disk content the user chose to keep their edits over
  const inFlightSave = useRef<Promise<boolean> | null>(null)
  const confirming = useRef(false)
  // An open own-server or own-hook sub-form of the loadout card: its draft is not in the file yet, so the guard asks it too.
  const subForms = useRef<EditorHandle | null>(null)
  const trashing = useRef(false)
  const unmounted = useRef(false) // a save can finish after the user navigated away

  const commit = (next: EditorState): void => {
    stateRef.current = next
    setState(next)
  }
  const edit = (change: (s: EditorState) => EditorState): void => {
    if (stateRef.current) commit(change(stateRef.current))
  }

  const dirty = state !== null && isDirty(state)

  // The saved agent's name while the form's engine is ACP or remote, whose confirmed launch Agent Studio shows; asked again after
  // every Save (one that only confirms leaves the file's text as it was).
  const [saves, setSaves] = useState(0)
  const savedFile = state !== null && state.filePath !== null ? parseAgent(state.baseRaw) : null
  const formEngine = engineOfFields(state?.parsed.ok ? state.parsed.fields : null)
  const launchName = confirmedLaunchName(formEngine, savedFile?.ok ? savedFile.fields.name : null)
  useEffect(() => {
    setLoadedLaunch(undefined)
    if (launchName === null) return
    let live = true
    const ask = formEngine === 'ag-ui' ? api.agents.aguiLaunch(launchName) : api.agents.acpLaunch(launchName)
    ask.then(
      (launch) => live && setLoadedLaunch({ engine: formEngine, launch }),
      () => {}
    )
    return () => {
      live = false
    }
  }, [launchName, formEngine, state?.baseRaw, saves])
  // What was loaded counts only for the engine it was asked for: an old answer never shows for the engine the form just flipped to.
  const confirmedLaunch = confirmedFor(formEngine, loadedLaunch)
  // Only while the form and the saved file are on the same engine: the confirmed launch asked for is the form engine's.
  const pending =
    engineOfFields(savedFile?.ok ? savedFile.fields : null) === formEngine &&
    confirmPending(confirmedLaunch, savedFile?.ok ? savedFile.fields : null)
  confirming.current = pending

  // Read once the socket is up, and after a reconnect while it never landed; a loaded form is never read over. A read the
  // socket cut off is not an error: the reconnect reads again.
  const connected = useConnected()
  useEffect(() => {
    if (filePath === null || !connected || stateRef.current !== null) return
    let cancelled = false
    api.agents.read(filePath).then(
      (raw) => {
        if (cancelled) return
        setLoadError(null)
        commit(initEditor(filePath, raw))
      },
      (e: unknown) => {
        if (!cancelled && !isNotConnected(e)) setLoadError(errorMessage(e))
      }
    )
    return () => {
      cancelled = true
    }
  }, [connected])

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    api.codexInfo().then(
      (info) => {
        if (!cancelled) setCodexInfo(info)
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [connected])

  useEffect(() => {
    unmounted.current = false // StrictMode re-runs effects after a simulated unmount
    return () => {
      unmounted.current = true
    }
  }, [])

  useEffect(() => {
    api.app.setEditorDirty(dirty)
    return () => api.app.setEditorDirty(false)
  }, [dirty])

  // `confirm`: the toolbar's own Save, the only one that may save an unedited file to confirm its launch (never a close guard).
  const save = (confirm = false): Promise<boolean> => {
    if (inFlightSave.current) return inFlightSave.current
    const run = async (): Promise<boolean> => {
      const s = stateRef.current
      // A launch to confirm is a reason to save the file as it is (it changed outside Agent Studio), on the user's own press.
      if (!s || (!needsSave(s) && !(confirm && confirming.current))) return true
      setSaveError(null)
      if (saveErrors(s).length > 0) {
        setAttempted(true)
        return false
      }
      // Our own write triggers a disk event; reads started before it must not apply stale content afterwards.
      diskRequest.current++
      setSaving(true)
      try {
        const result = await api.agents.save(s.filePath, s.raw)
        if (!result.ok) {
          setSaveError(result.error)
          return false
        }
        // Edits typed while the save was in flight stay dirty: only what was written becomes the base.
        const saved = markSaved(s, result.filePath)
        commit({ ...stateRef.current!, filePath: saved.filePath, baseRaw: saved.baseRaw })
        setAttempted(false)
        setDiskCopy(null)
        setGoneOnDisk(false)
        keptDisk.current = null
        if (!unmounted.current) {
          setSaves((n) => n + 1)
          props.current.onSaved(result)
        }
        return true
      } catch (e) {
        setSaveError(errorMessage(e))
        return false
      } finally {
        diskRequest.current++
        setSaving(false)
      }
    }
    const p = run().finally(() => {
      inFlightSave.current = null
    })
    inFlightSave.current = p
    return p
  }

  // A sub-form's Save puts its draft into the fields first, then the file is saved with it.
  const saveAll = async (): Promise<boolean> => ((await joinGuards(() => [subForms.current]).save()) ? save() : false)

  useEffect(() => {
    handle.current = {
      isDirty: () => (stateRef.current !== null && isDirty(stateRef.current)) || subForms.current?.isDirty() === true,
      save: saveAll
    }
    return () => {
      handle.current = null
    }
  }, []) // `save` only touches refs and stable setters, so the first render's copy stays valid

  useEffect(() => api.app.onSaveBeforeClose(() => saveAll()), [])

  useEffect(() => {
    const checkDisk = async (): Promise<void> => {
      const before = stateRef.current
      if (!before || before.filePath === null || inFlightSave.current || trashing.current) return
      const request = ++diskRequest.current
      let disk: string
      try {
        disk = await api.agents.read(before.filePath)
      } catch (e) {
        if (request !== diskRequest.current) return
        if (/ENOENT/.test(errorMessage(e))) setGoneOnDisk(true)
        else props.current.onError(e)
        return
      }
      const now = stateRef.current
      if (request !== diskRequest.current || !now || now.filePath !== before.filePath) return
      setGoneOnDisk(false)
      if (disk === now.baseRaw) {
        setDiskCopy(null)
      } else if (!isDirty(now)) {
        setDiskCopy(null)
        commit(setMode(initEditor(now.filePath, disk), now.mode))
      } else if (disk !== keptDisk.current) {
        setDiskCopy(disk)
      }
    }
    return api.agents.onChanged(() => void checkDisk())
  }, [])

  const reloadFromDisk = (): void => {
    const s = stateRef.current
    if (!s || diskCopy === null) return
    commit(setMode(initEditor(s.filePath, diskCopy), s.mode))
    setDiskCopy(null)
    setSaveError(null)
    setAttempted(false)
  }

  const trash = async (): Promise<void> => {
    const path = stateRef.current?.filePath
    if (!path || trashing.current) return
    trashing.current = true
    try {
      await api.agents.trash(path)
    } catch (e) {
      trashing.current = false
      props.current.onError(e)
      return
    }
    props.current.onDeleted()
  }

  if (loadError !== null)
    return (
      <p className="empty" role="alert">
        Could not open this agent: {loadError}
      </p>
    )
  if (!state) return null

  const errors = !state.parsed.ok || attempted ? saveErrors(state, aguiDraftError) : []
  const fields = state.parsed.ok ? state.parsed.fields : null
  const title = fields ? displayName(fields.name) : state.filePath ? displayName(baseName(state.filePath)) : 'New agent'
  // Rules are keyed by the saved name, not an unsaved rename in the form.
  const savedParse = savedFile
  const savedEngine = engineOfFields(savedParse?.ok ? savedParse.fields : null)
  const savedName = savedParse?.ok ? savedParse.fields.name : null
  const status = dirty ? 'unsaved' : state.filePath === null ? 'new' : 'saved'
  // Memory, the desktop and the browser follow the form's engine, as the form's own cards do.
  const cards = studioCards(engineOfFields(fields))
  // Save confirms whatever launch the file holds, so the Raw view shows the comparison the protocol cards show in the form.
  const rawCompare = !state.parsed.ok
    ? null
    : cards.acp && state.parsed.acpEditable
      ? launchCompare(confirmedLaunch, state.parsed.fields.acp)
      : cards.agui && state.parsed.aguiEditable
        ? launchCompare(confirmedLaunch, state.parsed.fields.agui)
        : null

  return (
    <section className="editor">
      <header className="editor-bar">
        <div className="editor-avatar">
          <BotIcon icon={fields?.icon ?? null} color={fields?.color ?? null} working={false} size={30} />
        </div>
        <div className="editor-heading">
          <div className="editor-crumb">
            Agent Studio <span aria-hidden="true">/</span>
            <span className={`status-pill ${status}`}>{STATUS_LABELS[status]}</span>
          </div>
          <h2 className="editor-title">{title}</h2>
        </div>
        <div className="editor-actions">
          <div className="seg" role="group" aria-label="Editor view">
            <button
              type="button"
              aria-pressed={state.mode === 'form'}
              disabled={!state.parsed.ok}
              data-tip={state.parsed.ok ? undefined : state.parsed.error}
              onClick={() => edit((s) => setMode(s, 'form'))}
            >
              <EditorIcon name="sliders" />
              Form
            </button>
            <button type="button" aria-pressed={state.mode === 'raw'} onClick={() => edit((s) => setMode(s, 'raw'))}>
              <EditorIcon name="code" />
              Raw / YAML
            </button>
          </div>
          <span className="bar-sep" />
          <button
            type="button"
            className="btn ghost"
            data-tip="Revert"
            disabled={saving || state.raw === state.baseRaw}
            onClick={() => {
              edit((s) => setMode(initEditor(s.filePath, s.baseRaw), s.mode))
              setSaveError(null)
              setAttempted(false)
            }}
          >
            <EditorIcon name="revert" />
            <span className="btn-label">Revert</span>
          </button>
          {/* Delete lives behind More: a red button beside Save drew the eye as much as Save did, a slip away from it. */}
          {state.filePath !== null && (
            <button
              type="button"
              className="btn ghost editor-more"
              data-testid="editor-more"
              aria-label="More actions"
              data-tip="More actions"
              aria-haspopup="menu"
              aria-expanded={moreMenu !== null}
              disabled={saving}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMoreMenu(moreMenu ? null : { right: window.innerWidth - r.right, top: r.bottom + 4 })
              }}
            >
              <Glyph name="more" />
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={(!needsSave(state) && !pending) || saving}
            data-tip={pending && !needsSave(state) ? 'Save to confirm this launch on this machine' : undefined}
            onClick={() => void save(true)}
          >
            <EditorIcon name="save" />
            Save changes
          </button>
        </div>
        {moreMenu && (
          <div
            className="menu"
            role="menu"
            data-testid="editor-more-menu"
            style={{ right: moreMenu.right, top: moreMenu.top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="danger"
              data-testid="editor-delete"
              autoFocus
              onClick={() => {
                setMoreMenu(null)
                setConfirmDelete(true)
              }}
            >
              Delete agent
            </button>
          </div>
        )}
      </header>

      {goneOnDisk && (
        <div className="editor-note" role="status">
          This file was deleted on disk.
        </div>
      )}
      {diskCopy !== null && (
        <div className="editor-note" role="status">
          <span>This file changed on disk.</span>
          <span className="grow" />
          <button type="button" className="btn small" onClick={reloadFromDisk}>
            Reload from disk
          </button>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              keptDisk.current = diskCopy
              setDiskCopy(null)
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      {(errors.length > 0 || saveError) && (
        <div className="editor-errors" role="alert">
          {[...errors, ...(saveError ? [saveError] : [])].map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      {/* One scroll for the form and the sections under it, so they never take the form's height. */}
      <div className="editor-scroll">
        {state.mode === 'form' && state.parsed.ok ? (
          <AgentForm
            fields={state.parsed.fields}
            body={state.parsed.body}
            onFields={(patch) => edit((s) => editFields(s, patch))}
            onBody={(body) => edit((s) => editBody(s, body))}
            codexInfo={codexInfo}
            acpEditable={state.parsed.acpEditable}
            savedAcp={
              savedFile?.ok ? { name: savedFile.fields.name, provider: savedFile.fields.provider, acp: savedFile.fields.acp } : null
            }
            aguiEditable={state.parsed.aguiEditable}
            savedAgui={
              savedFile?.ok ? { name: savedFile.fields.name, provider: savedFile.fields.provider, agui: savedFile.fields.agui } : null
            }
            confirmedLaunch={confirmedLaunch}
            onAguiDraftError={setAguiDraftError}
          />
        ) : (
          <>
            {rawCompare && <LaunchCompareNote compare={rawCompare} className="raw-compare" />}
            <textarea
              className="field raw-editor"
              aria-label="Raw agent file"
              spellCheck={false}
              value={forTextarea(state.raw)}
              onChange={(e) => edit((s) => editRaw(s, e.target.value))}
            />
          </>
        )}

        {/* What the saved agent loads, with the switches for the draft. Zumi Bot and Codex agents get the view only. */}
        {state.filePath !== null && savedName !== null && studioCards(savedName === ZUMI_BOT_NAME ? 'claude' : savedEngine).loadout && (
          <AgentLoadout
            agentName={savedName}
            fields={state.parsed.ok ? state.parsed.fields : null}
            savedFields={savedParse?.ok ? savedParse.fields : null}
            onFields={(patch) => edit((s) => editFields(s, patch))}
            readOnly={savedName === ZUMI_BOT_NAME || savedEngine !== 'claude'}
            formHandle={subForms}
            onOpenConnectors={onOpenConnectors}
            engine={savedName === ZUMI_BOT_NAME ? 'claude' : savedEngine}
          />
        )}

        {/* Memory and the desktop only for an engine with those caps (not Codex): the form's note says so. */}
        {state.filePath !== null && savedName !== null && cards.memory && (
          <AgentMemory
            agentName={savedName}
            fields={state.parsed.ok ? state.parsed.fields : null}
            onFields={(patch) => edit((s) => editFields(s, patch))}
            focus={focusMemory === true}
          />
        )}

        {state.filePath !== null && savedName !== null && <RememberedApprovals agentName={savedName} />}

        {state.filePath !== null && savedName !== null && cards.browser && (
          <div className="browser-settings">
            <div>
              <strong>Agent browser</strong>
              <p>Cookies and website data stay with this agent on this server.</p>
            </div>
            <button type="button" className="btn small" disabled={clearing} onClick={() => browser?.open({ agent: savedName })}>
              Open Browser
            </button>
            <button type="button" className="btn small danger-outline" disabled={clearing} onClick={() => setConfirmClear(true)}>
              {clearing ? 'Clearing…' : 'Clear browser data'}
            </button>
            {browserNotice && <p role="status">{browserNotice}</p>}
          </div>
        )}

        {/* Zumi Bot never gets a desktop, whatever its file says. */}
        {state.filePath !== null && savedName !== null && savedName !== ZUMI_BOT_NAME && cards.desktop && (
          <AgentDesktop
            agentName={savedName}
            fields={state.parsed.ok ? state.parsed.fields : null}
            onFields={(patch) => edit((s) => editFields(s, patch))}
          />
        )}

        {state.filePath !== null && savedName !== null && (
          <AgentIsolation agentName={savedName} computerUse={fields?.computerUse === true} />
        )}
      </div>
      {confirmClear && savedName !== null && (
        <ConfirmDialog
          title="Clear browser data?"
          message={`This closes ${displayName(savedName)}’s browser and removes its cookies, sign-ins and website storage on this server.`}
          buttons={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Clear browser data', value: 'clear', danger: true }
          ]}
          onResolve={(choice) => {
            setConfirmClear(false)
            if (choice !== 'clear') return
            setClearing(true)
            setBrowserNotice(null)
            api.browsers
              .clear(savedName)
              .then(
                () => {
                  browser?.forget(savedName)
                  setBrowserNotice('Browser data cleared.')
                },
                (e) => setBrowserNotice(errorMessage(e))
              )
              .finally(() => setClearing(false))
          }}
        />
      )}

      {confirmDelete && state.filePath !== null && (
        <ConfirmDialog
          title={`Move ${baseName(state.filePath)} to Trash?`}
          message="You can restore it from the Trash."
          buttons={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Move to Trash', value: 'trash', danger: true }
          ]}
          onResolve={(value) => {
            setConfirmDelete(false)
            if (value === 'trash') void trash()
          }}
        />
      )}
    </section>
  )
}
