import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { VersionSummary } from '@zumibot/shared/definitionHistory'
import { jevActive } from '@zumibot/shared/jev'
import type { Routine, RoutineRun, WebhookCall } from '@zumibot/shared/routines'
import { fieldList } from '@zumibot/shared/routineFields'
import type { SidebarSection } from '@zumibot/shared/sidebarLayout'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import {
  draftErrors,
  draftFromRoutine,
  draftToInput,
  emptyDraft,
  isDraftDirty,
  routineCapBlocker,
  type RoutineDraft
} from '../state/routineDraft'
import { duplicateLabel } from '../state/workflowEditor'
import { useDismiss } from '../useDismiss'
import { useConnected } from '../useConnected'
import type { EditorHandle } from './AgentEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { HistoryDialog } from './HistoryDialog'
import { restoreNotice, restoredRoutine, versionTimeText } from '../state/versionHistory'
import { HowItWorks, ProblemsCard } from './HowItWorks'
import { RecentRuns } from './RecentRuns'
import { RoutineIcon } from './RoutineIcons'
import { PolicyCard } from './PolicyCard'
import { SendPromptCard } from './SendPromptCard'
import { Glyph } from './Sidebar'
import { TriggerCard } from './TriggerCard'

interface Props {
  /** The routine to edit, or null for a new one. Read once on mount (App remounts the editor per routine), except its
   *  `enabled`, which the sidebar's switch can change while the editor is open. */
  routine: Routine | null
  handle: RefObject<EditorHandle | null>
  onSaved: (saved: Routine) => void
  onDeleted: () => void
  /** Open the copy Duplicate made; the pushed snapshot may list it a moment later. */
  onDuplicated: (copy: Routine) => void
  /** Cancel on a new routine: leave the editor. */
  onClose: () => void
  onError: (e: unknown) => void
  agents: AgentSummary[]
  chats: ChatMeta[]
  /** The sidebar's sections, for a new room's place. */
  sections: readonly SidebarSection[]
  /** This routine's runs from the pushed snapshot. */
  runs: RoutineRun[]
  /** Switch to Agents and open the run's chat. */
  onOpenChat: (chatId: string) => void
}

const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone
const todayIn = (tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now())

export function RoutineEditor({
  routine,
  handle,
  onSaved,
  onDeleted,
  onDuplicated,
  onClose,
  onError,
  agents,
  chats,
  sections,
  runs,
  onOpenChat
}: Props) {
  const [baseline, setBaseline] = useState<RoutineDraft>(() => (routine ? draftFromRoutine(routine, chats) : emptyDraft(localTimeZone())))
  const [draft, setDraft] = useState<RoutineDraft>(baseline)
  const [hook, setHook] = useState<{ url: string; secret: string } | null>(null)
  const [hookError, setHookError] = useState<string | null>(null)
  const [latest, setLatest] = useState<WebhookCall | null>(routine?.trigger.kind === 'webhook' ? routine.trigger.sample : null)
  const [checking, setChecking] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  // A version picked while there are unsaved edits, waiting for the user to say they may be replaced.
  const [pendingRestore, setPendingRestore] = useState<VersionSummary | null>(null)
  const [restoreNote, setRestoreNote] = useState<string | null>(null)
  // Read once the socket is up (again after a reconnect), like the rest of the editor; a failed read shows the condition as off.
  const [jevOn, setJevOn] = useState(false)
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    api.jev.status().then(
      (s) => setJevOn(jevActive(s)),
      () => {}
    )
  }, [connected])
  const now = Date.now()

  // Async callbacks (the navigation guard, a late webhook reply) must see the latest values, not their render's.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const baselineRef = useRef(baseline)
  baselineRef.current = baseline
  const latestRef = useRef(latest)
  latestRef.current = latest
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  const insertRef = useRef<((path: string) => void) | null>(null)
  const props = useRef({ onSaved, onDeleted, onDuplicated, onClose, onError })
  props.current = { onSaved, onDeleted, onDuplicated, onClose, onError }
  const draftHookId = useRef<string | null>(null) // a webhook draft this editor made for a new routine
  const savePending = useRef(false)
  const saved = useRef(false)
  const unmounted = useRef(false)
  const hookRequest = useRef<Promise<void> | null>(null)
  const inFlightSave = useRef<Promise<Routine | null> | null>(null)
  // The time of the version a restore put in the form, until a save keeps it (and says so in the history) or Discard drops it.
  const restoredFrom = useRef<number | null>(null)

  useDismiss(menuOpen, () => setMenuOpen(false))

  // The sidebar's switch changed the saved routine: the saved state follows, and so does the draft unless the user flipped it here.
  const liveEnabled = routine?.enabled
  useEffect(() => {
    if (liveEnabled === undefined || baselineRef.current.enabled === liveEnabled) return
    const was = baselineRef.current.enabled
    setBaseline((b) => ({ ...b, enabled: liveEnabled }))
    setDraft((d) => (d.enabled === was ? { ...d, enabled: liveEnabled } : d))
  }, [liveEnabled])

  // Never drop while a save is pending or after one succeeded: the draft is then the routine's own webhook.
  const dropDraftHook = (): void => {
    const id = draftHookId.current
    if (id === null || savePending.current || saved.current) return
    draftHookId.current = null
    void api.routines.dropDraft(id).catch(() => undefined)
  }

  const edit = (change: (d: RoutineDraft) => RoutineDraft): void => {
    setDraft((d) => change(d))
    setSaveError(null)
  }

  // Webhook trigger: fetch (saved routine) or create (new routine) the URL and secret once.
  const hookRef = useRef(hook)
  hookRef.current = hook
  useEffect(() => {
    if (!connected || draft.triggerKind !== 'webhook' || hookRef.current || hookRequest.current) return
    hookRequest.current = (async () => {
      try {
        const id = draftRef.current.id
        if (id !== null) {
          const h = await api.routines.webhook(id)
          if (unmounted.current) return
          setHook({ url: h.url, secret: h.secret })
          setLatest(h.latest)
        } else {
          const d = await api.routines.draftWebhook()
          draftHookId.current = d.id
          if (unmounted.current) {
            dropDraftHook() // the editor closed while this was in flight
            return
          }
          setDraft((cur) => ({ ...cur, id: d.id }))
          setBaseline((b) => ({ ...b, id: d.id }))
          setHook({ url: d.url, secret: d.secret })
        }
        setHookError(null)
      } catch (e) {
        if (!unmounted.current) setHookError(errorMessage(e))
      } finally {
        hookRequest.current = null
      }
    })()
    // Retried only by picking the trigger again or by a reconnect, so a failing server is not hammered on every render.
  }, [draft.triggerKind, connected])

  useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
      dropDraftHook()
    }
  }, [])

  const checkCall = (): void => {
    const id = draftRef.current.id
    if (id === null) return
    setChecking(true)
    api.routines
      .webhook(id)
      .then((h) => setLatest(h.latest))
      .catch((e: unknown) => setHookError(errorMessage(e)))
      .finally(() => setChecking(false))
  }
  const newSecret = (): void => {
    const id = draftRef.current.id
    if (id === null) return
    api.routines.newSecret(id).then(
      (secret) => setHook((h) => (h ? { ...h, secret } : h)),
      (e: unknown) => setHookError(errorMessage(e))
    )
  }

  const errors = draftErrors(draft, latest !== null)
  const dirty = isDraftDirty(draft, { ...baseline, id: draft.id })
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  // As in the workflow editor: a saved routine with no edits has nothing to save; a new one can always be saved.
  const canSave = errors.length === 0 && !saving && (dirty || routine === null)

  const doSave = async (): Promise<Routine | null> => {
    const d = draftRef.current
    if (draftErrors(d, latestRef.current !== null).length > 0) {
      return null
    }
    savePending.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const from = restoredFrom.current
      const r = await api.routines.save(draftToInput(d), from !== null ? { restoredFrom: from } : undefined)
      if (restoredFrom.current === from) restoredFrom.current = null
      saved.current = true
      if (!unmounted.current) setRestoreNote(null)
      const next = draftFromRoutine(r, chatsRef.current)
      if (!unmounted.current) {
        setBaseline(next)
        setDraft(next)
      }
      props.current.onSaved(r)
      return r
    } catch (e) {
      if (!unmounted.current) setSaveError(errorMessage(e))
      return null
    } finally {
      savePending.current = false
      if (!unmounted.current) setSaving(false)
    }
  }
  const saveRoutine = (): Promise<Routine | null> => {
    if (!inFlightSave.current) inFlightSave.current = doSave().finally(() => (inFlightSave.current = null))
    return inFlightSave.current
  }
  const save = async (): Promise<boolean> => (await saveRoutine()) !== null

  useEffect(() => {
    handle.current = {
      isDirty: () => dirtyRef.current,
      save: () => (dirtyRef.current ? save() : Promise.resolve(true))
    }
    return () => {
      handle.current = null
    }
  }, [handle])

  const cancel = (): void => {
    if (routine === null) {
      dropDraftHook()
      props.current.onClose()
    } else {
      setDraft(baselineRef.current)
      setSaveError(null)
    }
  }

  const discard = (): void => {
    setMenuOpen(false)
    restoredFrom.current = null
    setRestoreNote(null)
    setDraft(baselineRef.current)
    setSaveError(null)
  }

  const loadHistory = useCallback(() => {
    const id = draftRef.current.id
    return id === null ? Promise.resolve([]) : api.routines.history(id)
  }, [])
  const closeHistory = useCallback(() => setHistoryOpen(false), [])

  // A version goes into the form; nothing is written until the user saves. The form has no undo, so unsaved edits ask first.
  const applyVersion = async (v: VersionSummary): Promise<void> => {
    const id = draftRef.current.id
    if (id === null) return
    const def = await api.routines.version(id, v.id)
    if (unmounted.current) return
    restoredFrom.current = v.savedAt
    setDraft((d) => restoredRoutine(d, def, chatsRef.current))
    setSaveError(null)
    setRestoreNote(restoreNotice(v.savedAt, Date.now()))
    setHistoryOpen(false)
  }
  const restoreVersion = async (v: VersionSummary): Promise<void> => {
    if (!dirtyRef.current) return applyVersion(v)
    setHistoryOpen(false)
    setPendingRestore(v)
  }

  const duplicate = async (): Promise<void> => {
    setMenuOpen(false)
    setDuplicating(true)
    try {
      // The server copies the saved routine, so unsaved edits (or a routine never saved) are saved first: the copy is what the user sees.
      let id = routine?.id ?? null
      if (id === null || dirtyRef.current) {
        const stored = await saveRoutine()
        if (!stored) return
        id = stored.id
      }
      props.current.onDuplicated(await api.routines.duplicate(id))
    } catch (e) {
      props.current.onError(e)
    } finally {
      if (!unmounted.current) setDuplicating(false)
    }
  }

  const runNow = (): void => {
    if (draft.id === null || routine === null) return
    setRunning(true)
    api.routines.runNow(draft.id).then(
      () => setRunning(false),
      (e: unknown) => {
        setRunning(false)
        props.current.onError(e)
      }
    )
  }

  const remove = (): void => {
    setConfirmDelete(false)
    if (routine === null) return
    api.routines.remove(routine.id).then(
      () => {
        saved.current = true // the routine is gone; its webhook goes with it
        props.current.onDeleted()
      },
      (e: unknown) => props.current.onError(e)
    )
  }

  const setKind = (k: RoutineDraft['triggerKind']): void => edit((d) => ({ ...d, triggerKind: k }))

  const insertField = (path: string): void => insertRef.current?.(path)
  const fields = draft.triggerKind === 'webhook' ? (latest ? fieldList(latest).map((f) => f.path) : []) : null
  const chatIds = new Set(chats.map((c) => c.id))

  return (
    <div
      className="rt-editor"
      data-testid="routine-editor"
      onKeyDown={(e) => {
        // Ctrl+S (Cmd+S on a Mac) saves, as in the workflow editor; the browser's own save page is never wanted here.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
          e.preventDefault()
          if (canSave) void save()
        }
      }}
    >
      <header className="rt-head">
        <input
          className="rt-name"
          data-testid="routine-name"
          aria-label="Routine name"
          placeholder="Routine name"
          maxLength={100}
          value={draft.name}
          onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))}
        />
        {dirty && routine !== null && (
          <span className="status-pill unsaved" data-testid="routine-unsaved">
            Unsaved
          </span>
        )}
        <button
          type="button"
          role="switch"
          className="rt-switch"
          data-testid="routine-enabled"
          aria-checked={draft.enabled}
          aria-label={draft.enabled ? 'On' : 'Off'}
          onClick={() => edit((d) => ({ ...d, enabled: !d.enabled }))}
        >
          <span className="rt-switch-dot" />
          <span className="rt-switch-text">{draft.enabled ? 'On' : 'Off'}</span>
        </button>
        <button type="button" className="btn" data-testid="routine-run-now" disabled={routine === null || running} onClick={runNow}>
          <RoutineIcon name="play" />
          Run now
        </button>
        {/* Cancel only where it does something: leaving a routine never saved, or putting back the saved one. */}
        {(routine === null || dirty) && (
          <button type="button" className="btn" data-testid="routine-cancel" onClick={cancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          data-testid="routine-save"
          data-tip={errors.length > 0 ? `Fix ${errors.length === 1 ? 'the problem' : `the ${errors.length} problems`} first` : 'Save (Ctrl+S)'}
          disabled={!canSave}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <span className="rt-pop-wrap" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="head-btn"
            data-testid="routine-more"
            aria-label="More"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Glyph name="more" />
          </button>
          {menuOpen && (
            <div className="rt-pop rt-pop-right menu-like">
              <button
                type="button"
                data-testid="routine-duplicate"
                disabled={saving || duplicating || ((dirty || routine === null) && errors.length > 0)}
                onClick={() => void duplicate()}
              >
                {duplicateLabel(dirty, routine !== null)}
              </button>
              <button
                type="button"
                data-testid="routine-history"
                disabled={routine === null}
                onClick={() => {
                  setMenuOpen(false)
                  setHistoryOpen(true)
                }}
              >
                History…
              </button>
              <button type="button" data-testid="routine-discard" disabled={!dirty} onClick={discard}>
                Discard changes
              </button>
              <button
                type="button"
                className="danger"
                data-testid="routine-delete"
                disabled={routine === null}
                onClick={() => {
                  setMenuOpen(false)
                  setConfirmDelete(true)
                }}
              >
                Delete
              </button>
            </div>
          )}
        </span>
      </header>

      {(saveError || (restoreNote && dirty)) && (
        <div className="wf-banner rt-banner">
          {saveError && (
            <div className="wf-notice error" role="alert">
              <span className="wf-notice-text">{saveError}</span>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setSaveError(null)}>
                ✕
              </button>
            </div>
          )}
          {restoreNote && dirty && (
            <div className="wf-notice info" data-testid="routine-restore-note" role="status">
              <span className="wf-notice-text">{restoreNote}</span>
            </div>
          )}
        </div>
      )}

      <div className="rt-body">
        <div className="rt-flow">
          <TriggerCard
            draft={draft}
            now={now}
            today={todayIn(draft.timeZone)}
            onKind={setKind}
            onSchedule={(schedule) => edit((d) => ({ ...d, schedule }))}
            webhook={{ hook, error: hookError, latest, checking, onCheck: checkCall, onNewSecret: newSecret, onInsert: insertField }}
            jevOn={jevOn}
            onCondition={(condition) => edit((d) => ({ ...d, condition }))}
          />
          <div data-testid="routine-slot-send-prompt">
            <SendPromptCard
              draft={draft}
              agents={agents}
              chats={chats}
              sections={sections}
              edit={edit}
              fields={fields}
              insertRef={insertRef}
              onError={(e) => props.current.onError(e)}
            />
          </div>
          <PolicyCard draft={draft} edit={edit} capBlocked={routineCapBlocker(draft, agents, chats)} />
        </div>
        <aside className="rt-side" data-testid="routine-slot-runs">
          {errors.length > 0 && <ProblemsCard errors={errors} />}
          {routine !== null ? (
            <RecentRuns runs={runs} now={now} timeZone={draft.timeZone} chatIds={chatIds} onOpenChat={onOpenChat} />
          ) : (
            <HowItWorks triggerKind={draft.triggerKind} />
          )}
        </aside>
      </div>

      {historyOpen && <HistoryDialog noun="routine" load={loadHistory} onRestore={restoreVersion} onClose={closeHistory} />}
      {pendingRestore && (
        <ConfirmDialog
          title="Replace your unsaved changes?"
          message={`The version from ${versionTimeText(pendingRestore.savedAt, Date.now())} goes into the form instead. Nothing is saved until you save.`}
          buttons={[
            { label: 'Restore', value: 'restore' },
            { label: 'Cancel', value: 'cancel' }
          ]}
          initialFocus="cancel"
          onResolve={(choice) => {
            const v = pendingRestore
            setPendingRestore(null)
            if (choice === 'restore') applyVersion(v).catch((e: unknown) => setSaveError(errorMessage(e)))
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete routine?"
          message={`"${draft.name || 'This routine'}" and its run history will be removed. The chats it made stay.`}
          buttons={[
            { label: 'Delete', value: 'delete', danger: true },
            { label: 'Cancel', value: 'cancel' }
          ]}
          initialFocus="cancel"
          onResolve={(v) => (v === 'delete' ? remove() : setConfirmDelete(false))}
        />
      )}
    </div>
  )
}
