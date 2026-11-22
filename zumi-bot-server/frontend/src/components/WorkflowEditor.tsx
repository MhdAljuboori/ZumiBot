import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { jevActive } from '@zumibot/shared/jev'
import type { WebhookCall } from '@zumibot/shared/routines'
import { problemsOf } from '@zumibot/shared/workflowGraph'
import { GROUP_RULE_TEXT, brokenGroups, dropBrokenGroups } from '@zumibot/shared/workflowGroups'
import type { SidebarSection } from '@zumibot/shared/sidebarLayout'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import {
  NOTE_DEFAULT,
  groupsOf,
  type Workflow,
  type WorkflowInput,
  type WorkflowRunSummary,
  type WorkflowTrigger
} from '@zumibot/shared/workflows'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useNarrow } from '../media'
import { chatStepTitle } from '../state/workflowChat'
import { roomTitleOf } from '../state/workflowRoom'
import { useDismiss } from '../useDismiss'
import { useConnected } from '../useConnected'
import { dirty as isDirty, newWorkflow, removeEdge, removeItems, removeStep, snap } from '../state/workflowCanvas'
import {
  adoptClean,
  adoptSaved,
  duplicateLabel,
  edgeLabel,
  isTypingTarget,
  itemsSelection,
  picked,
  pickedCount,
  pruneSelection,
  refusalText,
  removableCount,
  saveNotice,
  savedChange,
  selectAllItems,
  templateFields,
  toInput,
  workflowCapBlocker,
  type Selection
} from '../state/workflowEditor'
import { emptyHistory, record, redo, undo, type History } from '../state/workflowHistory'
import { clipText, copyClip, lastClip, parseClip, pasteClip, setLastClip, type Clip } from '../state/workflowClipboard'
import {
  deleteGroup,
  expandPush,
  groupRefusal,
  groupsOfPicked,
  groupsToToggle,
  loadCollapsed,
  makeGroup,
  saveCollapsed,
  STEP_SIZE,
  ungroup,
  ungroupNotice,
  visibleItem,
  visiblePicked,
  withCollapsed
} from '../state/workflowGroupEdit'
import { canvasKey } from '../state/workflowKeys'
import type { MenuAction, MenuTarget } from '../state/workflowMenu'
import { navTarget, reachAll } from '../state/workflowNav'
import { addNote } from '../state/workflowNotes'
import { triggerSummary } from '../state/workflows'
import { phoneSteps } from '../state/workflowPhone'
import type { EditorHandle } from './AgentEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { HistoryDialog } from './HistoryDialog'
import { restoreNotice, restoredWorkflow } from '../state/versionHistory'
import type { VersionSummary } from '@zumibot/shared/definitionHistory'
import { RoutineIcon } from './RoutineIcons'
import { RunWorkflowDialog } from './RunWorkflowDialog'
import { Glyph } from './Sidebar'
import { StepInspector } from './StepInspector'
import { TriggerInspector } from './TriggerInspector'
import type { CanvasCommands } from './WorkflowCanvas'
import { StepIcon } from './WorkflowIcons'
import { WorkflowRunRow } from './WorkflowsSidebar'
import {
  CanvasGroupInspector,
  EdgeInspector,
  SelectionInspector,
  LazyCanvas,
  WorkflowBanner,
  WorkflowOverview,
  type Notice
} from './WorkflowPanels'

interface Props {
  /** The workflow to edit, or null for a new one. Read once on mount: WorkflowsMode remounts the editor per workflow. */
  workflow: Workflow | null
  /** The pushed snapshot's copy of it: its on/off switch can change elsewhere (the sidebar, another tab, a spent "once"). */
  live: Workflow | null
  runs: WorkflowRunSummary[]
  agents: AgentSummary[]
  /** Every chat, for a Room step's picker and its node's title. */
  chats: ChatMeta[]
  /** Every saved workflow, for a Sub-workflow step's picker. */
  workflows: Workflow[]
  /** The sidebar's sections, where a kept Room step's room can be placed. */
  sections: readonly SidebarSection[]
  handle: RefObject<EditorHandle | null>
  onSaved: (saved: Workflow) => void
  onDeleted: () => void
  /** A copy was made: open it. */
  onDuplicated: (copy: Workflow) => void
  onOpenRun: (workflowId: string, runId: string) => void
  onOpenChat: (chatId: string) => void
  onError: (e: unknown) => void
}

const localTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone
const todayIn = (tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now())
const NAME_MAX = 100 // the server's cap (NAME_MAX in workflowInput.ts)
// Held down, these would act again on every repeat: N or H flips the menu or the mode, Shift+S piles up notes, Ctrl+G
// tries the same group again.
const NO_REPEAT = new Set<string>(['addStep', 'panMode', 'addNote', 'group', 'ungroup'])

export function WorkflowEditor(p: Props) {
  const narrow = useNarrow()
  // A stable function while the chats are, so the canvas's node data is not rebuilt on every render.
  const roomTitle = useCallback((id: string): string | null => roomTitleOf(id, p.chats), [p.chats])
  const chatTitle = useCallback((id: string): string | null => chatStepTitle(id, p.chats, p.agents), [p.chats, p.agents])
  const [baseline, setBaseline] = useState<WorkflowInput>(() => (p.workflow ? toInput(p.workflow) : newWorkflow(localTimeZone())))
  const [draft, setDraft] = useState<WorkflowInput>(baseline)
  const [selected, setSelected] = useState<Selection | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const [runOpen, setRunOpen] = useState(false)
  const [runInput, setRunInput] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [hook, setHook] = useState<{ url: string; secret: string } | null>(null)
  const [hookError, setHookError] = useState<string | null>(null)
  const [latest, setLatest] = useState<WebhookCall | null>(p.workflow?.trigger.kind === 'webhook' ? p.workflow.trigger.sample : null)
  const [checking, setChecking] = useState(false)
  // A request to focus the selected step's inspector; `n` is new each time, so asking twice refocuses.
  const [focus, setFocus] = useState<{ field: 'name' | 'first'; n: number } | null>(null)
  // The same for the selected collapsed group's panel (F2, the menu's Rename or Edit description).
  const [groupFocus, setGroupFocus] = useState<{ field: 'name' | 'description'; n: number } | null>(null)
  const focusCount = useRef(0)
  // Which groups this device shows collapsed: a view preference, so never an edit (no undo step, not unsaved), kept per
  // workflow in localStorage. A workflow never saved holds it here until its first save gives it an id.
  const [collapsed, setCollapsedState] = useState<Set<string>>(() => loadCollapsed(p.workflow?.id ?? null))
  // What each trigger kind held before a switch, for this editor's life (TriggerInspector unmounts with the selection).
  const earlier = useRef<Partial<Record<WorkflowTrigger['kind'], WorkflowTrigger>>>({})
  const root = useRef<HTMLDivElement>(null)
  // The canvas fills it with its zoom, pan and Add step menu, for the keys below.
  const canvas = useRef<CanvasCommands | null>(null)
  // Read once the socket is up (again after a reconnect), like the routine editor; a failed read shows the condition as off.
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

  const problems = useMemo(() => problemsOf(draft, p.agents, ZUMI_BOT_NAME), [draft, p.agents])
  const changed = isDirty(draft, baseline)
  // Text typed in an open note or group header field that would change the workflow (the canvas says): no edit until
  // the field closes, but unsaved all the same, since a tab close or Back closes no field and would drop it silently.
  const [typing, setTypingState] = useState(false)
  const unsaved = changed || typing

  // Async callbacks (a save, the key handler, the navigation guard) must see the latest values, not their render's.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const baselineRef = useRef(baseline)
  baselineRef.current = baseline
  const problemsRef = useRef(problems)
  problemsRef.current = problems
  const changedRef = useRef(changed)
  changedRef.current = changed
  // Set by the canvas as it says so, not at render: the guards ask between a keystroke and its render.
  const typingRef = useRef(false)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  const modalRef = useRef(false)
  modalRef.current = runOpen || confirmDelete || historyOpen
  const agentsRef = useRef(p.agents)
  agentsRef.current = p.agents
  const props = useRef(p)
  props.current = p
  // Undo and redo. A ref, since edits chain within one tick and the key handler reads it; an edit re-renders by its draft.
  const historyRef = useRef<History>(emptyHistory)
  const unmounted = useRef(false)
  const deleted = useRef(false)
  const inFlightSave = useRef<Promise<Workflow | null> | null>(null)
  // A hook reservation is not a saved workflow: keep it out of undo history and saved-only controls.
  const draftHookId = useRef<string | null>(null)
  const hookRequest = useRef<Promise<void> | null>(null)
  const savePending = useRef(false)
  // The time of the version a restore put in the draft, until a save keeps it (and says so in the history) or Discard drops it.
  const restoredFrom = useRef<number | null>(null)

  const dropDraftHook = (): void => {
    const id = draftHookId.current
    if (id === null || savePending.current) return
    draftHookId.current = null
    void api.workflows.dropDraft(id).catch(() => undefined)
  }

  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useDismiss(menuOpen, closeMenu)
  const onTyping = useCallback((on: boolean): void => {
    typingRef.current = on
    setTypingState(on)
  }, [])

  // An edit makes an earlier warning or error stale; a "Run started" note stays until dismissed. It reads the draft ref and
  // writes it at once, so two edits in one tick chain; `key` names a text field, whose typing undoes as one step. `fresh`
  // starts a step of its own even right after an edit with the same key: a note's editing session lands as one edit.
  const edit = useCallback((change: (w: WorkflowInput) => WorkflowInput, key?: string, fresh = false): void => {
    const was = draftRef.current
    const next = change(was)
    if (next === was) return
    draftRef.current = next
    const h = fresh ? { ...historyRef.current, last: null } : historyRef.current
    historyRef.current = record(h, was, next, key ?? null, Date.now())
    setDraft(next)
    setNotice((n) => (n && n.tone !== 'info' ? null : n))
  }, [])

  // A step back or forward; what the restored workflow no longer has leaves the selection.
  const stepHistory = useCallback((back: boolean): void => {
    const r = (back ? undo : redo)(historyRef.current, draftRef.current)
    if (!r) return
    historyRef.current = r.h
    draftRef.current = r.w
    setDraft(r.w)
    setSelected((s) => pruneSelection(s, r.w, collapsedRef.current))
    setNotice((n) => (n && n.tone !== 'info' ? null : n))
  }, [])

  // What a collapse hides leaves the selection, and an expanded group cannot stay picked.
  const setCollapsed = useCallback((next: Set<string>): void => {
    if (next === collapsedRef.current) return
    collapsedRef.current = next
    setCollapsedState(next)
    saveCollapsed(draftRef.current.id, next)
    setSelected((s) => pruneSelection(s, draftRef.current, next))
  }, [])

  // Collapses or expands these groups. Expanding pushes aside what the opened boxes now cover, all in one edit (one undo
  // step), each box pushed while the groups after it are still collapsed, so a later one clears an earlier one too.
  const foldGroups = useCallback(
    (ids: string[], collapse: boolean): void => {
      const was = collapsedRef.current
      const known = new Set(groupsOf(draftRef.current).map((g) => g.id))
      const next = withCollapsed(
        was,
        ids.filter((id) => known.has(id)),
        collapse
      )
      if (next === was) return
      if (!collapse) {
        const sizeOf = (id: string): { width: number; height: number } => canvas.current?.sizeOf(id) ?? STEP_SIZE
        edit((d) => {
          const shut = new Set(was)
          let out = d
          for (const id of ids) if (shut.delete(id)) out = expandPush(out, id, sizeOf, shut)
          return out
        })
      }
      setCollapsed(next)
    },
    [edit, setCollapsed]
  )

  // Groups the picked items (Ctrl+G, the menus, the selection panel). The new group's name opens for typing in its
  // header, nothing picked; a selection that breaks a rule says which.
  const groupPicked = useCallback(
    (sel: Selection | null): void => {
      if (sel === null) return setNotice({ tone: 'warn', text: GROUP_RULE_TEXT['too-few'] })
      const out: { id?: string; error?: string } = {}
      edit((d) => {
        const r = makeGroup(d, picked(sel))
        if ('error' in r) {
          out.error = r.error
          return d
        }
        out.id = r.groupId
        return r.w
      })
      if (out.error !== undefined) return setNotice({ tone: 'warn', text: out.error })
      if (out.id === undefined) return
      setSelected(null)
      canvas.current?.editGroup(out.id, 'name')
    },
    [edit]
  )

  // The members stay where they are; a picked collapsed group that went leaves the selection.
  const ungroupIds = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0) return
      edit((d) => ungroup(d, ids))
      setSelected((s) => pruneSelection(s, draftRef.current, collapsedRef.current))
    },
    [edit]
  )

  const removeGroup = useCallback(
    (id: string): void => {
      edit((d) => deleteGroup(d, id))
      setSelected((s) => pruneSelection(s, draftRef.current, collapsedRef.current))
    },
    [edit]
  )

  useEffect(() => {
    unmounted.current = false // StrictMode re-runs effects after a simulated unmount
    return () => {
      unmounted.current = true
      dropDraftHook()
    }
  }, [])

  // The switch changed elsewhere: the saved state follows, and so does the draft unless the user flipped it here.
  const liveEnabled = p.live?.enabled
  useEffect(() => {
    if (liveEnabled === undefined || baselineRef.current.enabled === liveEnabled) return
    const was = baselineRef.current.enabled
    setBaseline((b) => ({ ...b, enabled: liveEnabled }))
    setDraft((d) => (d.enabled === was ? { ...d, enabled: liveEnabled } : d))
  }, [liveEnabled])

  // The saved workflow changed elsewhere (a rule saved from a card): a draft with no edits takes it wholesale, so the
  // next Save does not take the change back; one with edits keeps them and gains the added rules (see savedChange).
  // `savedAt` is the newest saved state this editor has seen, its own saves included.
  const savedAt = useRef(p.workflow?.updatedAt ?? 0)
  const liveUpdatedAt = p.live?.updatedAt
  useEffect(() => {
    const live = props.current.live
    if (!live || live.id !== draftRef.current.id) return
    const unsavedEdits = changedRef.current || typingRef.current
    const act = savedChange({
      saving: inFlightSave.current !== null,
      seenAt: savedAt.current,
      liveUpdatedAt: live.updatedAt,
      dirty: unsavedEdits
    })
    if (act === 'wait' || act === 'seen') return
    savedAt.current = live.updatedAt
    const next = act === 'merge' ? adoptSaved(draftRef.current, baselineRef.current, live) : adoptClean(live)
    // The steps changed under the undo stack's drafts, so it starts over, as after Discard.
    historyRef.current = emptyHistory
    draftRef.current = next.draft
    baselineRef.current = next.baseline
    changedRef.current = isDirty(next.draft, next.baseline)
    setBaseline(next.baseline)
    setDraft(next.draft)
    // A picked step the saved workflow no longer has is gone.
    if (act === 'replace') setSelected((sel) => pruneSelection(sel, next.draft, collapsedRef.current))
  }, [liveUpdatedAt])

  // New workflows can receive test calls before their first save, just like routines.
  const triggerKind = draft.trigger.kind
  const workflowId = draft.id
  const readWebhook = async (id: string) => {
    const reply = await api.workflows.webhook(id).then(
      (h) => ({ hook: h }),
      (error: unknown) => ({ error })
    )
    const savedId = draftRef.current.id
    // Even a failed read can belong to a reservation discarded by a first save while it was in flight.
    if (savedId !== null && savedId !== id) return api.workflows.webhook(savedId)
    if ('error' in reply) throw reply.error
    return reply.hook
  }
  const loadWebhook = (): Promise<void> => {
    if (hookRequest.current) return hookRequest.current
    const request = (async () => {
      const id = draftRef.current.id ?? draftHookId.current
      if (id !== null) {
        const h = await readWebhook(id)
        if (unmounted.current) return
        setHook({ url: h.url, secret: h.secret })
        setLatest(h.latest)
      } else {
        const h = await api.workflows.draftWebhook()
        const savedId = draftRef.current.id
        // A first save can finish while this reservation is in flight (the trigger changed during Save).
        if (savedId !== null) {
          await api.workflows.dropDraft(h.id)
          if (unmounted.current) return
          const savedHook = await api.workflows.webhook(savedId)
          if (unmounted.current) return
          setHook({ url: savedHook.url, secret: savedHook.secret })
          setLatest(savedHook.latest)
          setHookError(null)
          return
        }
        draftHookId.current = h.id
        if (unmounted.current) {
          dropDraftHook()
          return
        }
        setHook({ url: h.url, secret: h.secret })
      }
      setHookError(null)
    })()
    hookRequest.current = request.finally(() => {
      hookRequest.current = null
    })
    return hookRequest.current
  }
  useEffect(() => {
    if (triggerKind !== 'webhook') return
    void loadWebhook().catch((e: unknown) => {
      if (!unmounted.current) setHookError(errorMessage(e))
    })
  }, [triggerKind, workflowId])

  const checkCall = (): void => {
    const id = draftRef.current.id ?? draftHookId.current
    if (id === null) return
    setChecking(true)
    api.workflows
      .webhook(id)
      .then((h) => {
        setLatest(h.latest)
        setHookError(null)
      })
      .catch((e: unknown) => setHookError(errorMessage(e)))
      .finally(() => setChecking(false))
  }
  const newSecret = (): void => {
    const id = draftRef.current.id ?? draftHookId.current
    if (id === null) return
    api.workflows.newSecret(id).then(
      (secret) => setHook((h) => (h ? { ...h, secret } : h)),
      (e: unknown) => setHookError(errorMessage(e))
    )
  }

  // Lands what an open note or group header field holds (closing it, as a click away does), so the draft has what the
  // user typed; true when there is then something to save. Reads the refs, not `changed`, which is a render behind.
  const settle = (): boolean => {
    canvas.current?.flushEdits()
    return isDirty(draftRef.current, baselineRef.current)
  }

  const doSave = async (): Promise<Workflow | null> => {
    canvas.current?.flushEdits()
    const d = draftRef.current
    if (!d.name.trim()) {
      setNotice({ tone: 'error', text: 'Give the workflow a name before saving.' })
      return null
    }
    // A group an edit broke is ungrouped here, as the server would do it anyway, and the notice says which and why.
    const dropped = brokenGroups(d)
    savePending.current = true
    setSaving(true)
    try {
      // Wait for a reservation in flight so Save keeps the URL already being shown.
      if (hookRequest.current) await hookRequest.current
      else if (d.id === null && d.trigger.kind === 'webhook' && draftHookId.current === null) await loadWebhook()
      const from = restoredFrom.current
      const input = { ...(dropped.length > 0 ? dropBrokenGroups(d) : d), id: d.id ?? draftHookId.current }
      const w = await api.workflows.save(input, from !== null ? { restoredFrom: from } : undefined)
      const unusedHookId = draftHookId.current
      draftHookId.current = null // the saved workflow now owns it
      if (unusedHookId !== null && unusedHookId !== w.id) {
        void api.workflows.dropDraft(unusedHookId).catch(() => undefined)
        if (!unmounted.current) {
          setHook(null)
          setLatest(null)
        }
      }
      if (restoredFrom.current === from) restoredFrom.current = null
      const next = toInput(w)
      savedAt.current = Math.max(savedAt.current, w.updatedAt)
      // That ungrouping is not undoable: the saved workflow is the new base, as after Discard.
      if (dropped.length > 0) historyRef.current = emptyHistory
      // The first save gives the workflow an id to keep its collapse state under.
      if (d.id === null) saveCollapsed(w.id, collapsedRef.current)
      // Typing that landed while the save was in flight stays, still unsaved.
      const cur = draftRef.current === d ? next : { ...draftRef.current, id: w.id }
      if (!unmounted.current) {
        setBaseline(next)
        setDraft((c) => (c === d ? next : { ...c, id: w.id }))
        // A picked collapsed group the save ungrouped is gone.
        if (dropped.length > 0) setSelected((s) => pruneSelection(s, cur, collapsedRef.current))
        const text = [ungroupNotice(dropped), saveNotice(d.enabled, w, problemsOf(d, agentsRef.current, ZUMI_BOT_NAME))]
          .filter((t) => t !== null)
          .join(' ')
        setNotice(text ? { tone: 'warn', text } : null)
      }
      // onSaved may move to the new address through the unsaved-changes guard before React renders the save, so the
      // refs the guard reads are brought up to date here.
      draftRef.current = cur
      baselineRef.current = next
      changedRef.current = isDirty(cur, next)
      props.current.onSaved(w)
      return w
    } catch (e) {
      if (!unmounted.current) setNotice({ tone: 'error', text: errorMessage(e) })
      return null
    } finally {
      savePending.current = false
      if (unmounted.current) dropDraftHook()
      if (!unmounted.current) setSaving(false)
    }
  }
  const save = (): Promise<Workflow | null> => {
    if (!inFlightSave.current) inFlightSave.current = doSave().finally(() => (inFlightSave.current = null))
    return inFlightSave.current
  }

  useEffect(() => {
    p.handle.current = {
      isDirty: () => !deleted.current && (changedRef.current || typingRef.current),
      save: () => (settle() ? save().then((w) => w !== null) : Promise.resolve(true))
    }
    return () => {
      p.handle.current = null
    }
  }, [p.handle]) // save only reads refs and stable setters

  // The browser asks before a reload with unsaved edits; the desktop shell saves before it closes.
  useEffect(() => {
    api.app.setEditorDirty(unsaved)
    return () => api.app.setEditorDirty(false)
  }, [unsaved])
  useEffect(() => api.app.onSaveBeforeClose(() => (settle() ? save().then((w) => w !== null) : Promise.resolve(true))), [])

  // The clip pasted (or duplicated) as one edit, the pasted steps picked; a refusal is shown, nothing changes. `atPointer`
  // puts it where the pointer is over the canvas, on the grid (a point, where the menu's Paste was clicked); with no pointer
  // there, or for a duplicate, it lands 40 px off its source.
  const pasteInto = useCallback(
    (clip: Clip, atPointer: boolean | { x: number; y: number } = false): void => {
      let result: Selection | null = null
      let error: string | null = null
      const pt = typeof atPointer === 'object' ? atPointer : atPointer ? (canvas.current?.pointer() ?? null) : null
      const at = pt ? { x: snap(pt.x), y: snap(pt.y) } : null
      edit((d) => {
        const r = pasteClip(d, clip, at)
        if ('error' in r) {
          error = r.error
          return d
        }
        result = r.picked
        return r.w
      })
      if (error !== null) return setNotice({ tone: 'error', text: error })
      if (result !== null) setSelected(result)
    },
    [edit]
  )

  // What copy and cut do once the clip is made, for the keys and the menu alike: remember it for the menu's Paste, and
  // for a cut take the steps out.
  const finishCopy = useCallback(
    (clip: Clip, cut: boolean): void => {
      setLastClip(clip)
      if (cut) {
        edit((d) =>
          removeItems(d, { steps: clip.steps.map((s) => s.id), notes: clip.notes.map((n) => n.id), groups: clip.groups.map((g) => g.id) })
        )
        setSelected(null)
      }
    },
    [edit]
  )
  // The picked steps and notes (an edge, one) go; the trigger stays.
  const removePicked = useCallback(
    (sel: Selection): void => {
      edit((d) => (sel.kind === 'edge' ? removeEdge(d, sel.id) : removeItems(d, picked(sel))))
      setSelected(null)
    },
    [edit]
  )

  // Copy, cut and paste are the canvas's only when focus is on it: a field's own selection, the sidebar's and a dialog's
  // keep the browser's behaviour, and text that is not a clip is not ours (no preventDefault).
  useEffect(() => {
    const ours = (): boolean => {
      if (modalRef.current) return false
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      if (isTypingTarget(active)) return false
      return !(active && active !== document.body && !root.current?.contains(active))
    }
    const onCopy = (e: ClipboardEvent): void => {
      if (e.defaultPrevented || !ours() || !e.clipboardData) return
      if (window.getSelection()?.toString()) return // text selected in a panel: the browser copies it
      const clip = copyClip(draftRef.current, selectedRef.current, collapsedRef.current)
      if (!clip) return
      e.clipboardData.setData('text/plain', clipText(clip))
      e.preventDefault()
      finishCopy(clip, e.type === 'cut')
    }
    const onPaste = (e: ClipboardEvent): void => {
      if (e.defaultPrevented || !ours() || !e.clipboardData) return
      const clip = parseClip(e.clipboardData.getData('text/plain'))
      if (!clip) return
      e.preventDefault()
      pasteInto(clip, true)
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [finishCopy, pasteInto]) // both are stable

  const askFocus = useCallback((field: 'name' | 'first'): void => setFocus({ field, n: ++focusCount.current }), [])
  const askGroupFocus = useCallback((field: 'name' | 'description'): void => setGroupFocus({ field, n: ++focusCount.current }), [])

  // A default note centred on the point (Shift+S at the pointer, the menu where it opened, the toolbar in the view's
  // middle), on the grid, and picked; it is not opened for editing, as in n8n. Past the cap the notice says so.
  const addNoteAt = useCallback(
    (p: { x: number; y: number }): void => {
      const out: { id?: string; error?: string } = {}
      edit((d) => {
        const r = addNote(d, { x: p.x - NOTE_DEFAULT.width / 2, y: p.y - NOTE_DEFAULT.height / 2 })
        if ('error' in r) {
          out.error = r.error
          return d
        }
        out.id = r.noteId
        return r.w
      })
      if (out.error !== undefined) return setNotice({ tone: 'error', text: out.error })
      if (out.id !== undefined) setSelected({ kind: 'note', id: out.id })
    },
    [edit]
  )

  // Selects one step and brings it into view.
  const goTo = useCallback((id: string): void => {
    setSelected({ kind: 'step', id })
    canvas.current?.reveal(id)
  }, [])

  // A double-click on a step selects it and moves into its inspector, as Enter does.
  const openStep = useCallback(
    (id: string): void => {
      goTo(id)
      askFocus('first')
    },
    [goTo, askFocus]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (modalRef.current || e.defaultPrevented) return
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const act = canvasKey(e, isTypingTarget(active), selectedRef.current !== null)
      if (act === null) return
      if (act === 'save') {
        e.preventDefault()
        if (settle() || draftRef.current.id === null) void save()
        return
      }
      // The other keys are for the canvas: a key pressed in the sidebar or the rail is not.
      if (active && active !== document.body && !root.current?.contains(active)) return
      const view = canvas.current
      if (e.repeat && NO_REPEAT.has(act)) return e.preventDefault()
      switch (act) {
        case 'zoomIn':
          e.preventDefault()
          return view?.zoomIn()
        case 'zoomOut':
          e.preventDefault()
          return view?.zoomOut()
        case 'zoomReset':
          e.preventDefault()
          return view?.zoomReset()
        case 'fit':
          e.preventDefault()
          return view?.fit()
        case 'addStep':
          e.preventDefault()
          return view?.openAddMenu()
        case 'addNote':
          e.preventDefault()
          if (view) addNoteAt(view.pointer() ?? view.viewCentre())
          return
        case 'panMode':
          e.preventDefault()
          return view?.togglePan()
        case 'run':
          e.preventDefault()
          return setRunOpen(true) // the header's Run button; the dialog is where it checks
        // Ctrl+G and Ctrl+Shift+G are the browser's find next and previous otherwise.
        case 'group':
          e.preventDefault()
          return groupPicked(selectedRef.current)
        case 'ungroup':
          e.preventDefault()
          return ungroupIds(groupsOfPicked(draftRef.current, picked(selectedRef.current)))
        case 'expand':
        case 'collapse':
          e.preventDefault()
          return foldGroups(groupsToToggle(draftRef.current, selectedRef.current), act === 'collapse')
      }
      if (act === 'next' || act === 'prev' || act === 'up' || act === 'down' || act === 'allNext' || act === 'allPrev') {
        // From the one selected step or the last picked; from nothing it picks the trigger. A note, an edge or a group
        // alone has no place in the graph to walk from, so the arrow does nothing.
        const sel = selectedRef.current
        const steps = picked(sel).steps
        if (sel !== null && steps.length === 0) return
        const w = draftRef.current
        const from = sel === null ? null : steps[steps.length - 1]
        const dir = act === 'allNext' ? 'next' : act === 'allPrev' ? 'prev' : act
        const to = navTarget(w, from, dir)
        if (to === null) return
        e.preventDefault()
        // A step a collapsed group hides is never picked: the group is, in its place.
        const fold = collapsedRef.current
        const shown = visibleItem(w, fold, to)
        if ((act === 'allNext' || act === 'allPrev') && from !== null) {
          // Shift+Right/Left adds everything downstream/upstream to the picked steps, the last one being the new end.
          const more = reachAll(w, from, dir as 'next' | 'prev')
          setSelected(itemsSelection(visiblePicked(w, fold, [...steps, ...more.filter((id) => !steps.includes(id))])))
          canvas.current?.reveal(shown)
          return
        }
        if (shown !== to) {
          setSelected({ kind: 'group', id: shown })
          canvas.current?.reveal(shown)
          return
        }
        goTo(to)
        return
      }
      if (act === 'rename' || act === 'open') {
        const sel = selectedRef.current
        // Several items or an edge have no one inspector to enter; a note opens its editor for both keys, and a collapsed
        // group is renamed in its panel or opened (expanded).
        if (sel?.kind !== 'step' && sel?.kind !== 'note' && sel?.kind !== 'group') return
        // Enter on a focused button (Remove step, a toolbar tool) is that button's click, not this.
        if (active?.closest('button, a, summary, [role="menuitem"]')) return
        // Also keeps the Enter from reaching the note's textarea, which has focus by the time the key would type.
        e.preventDefault()
        if (sel.kind === 'note') return view?.editNote(sel.id)
        if (sel.kind === 'group') return act === 'open' ? foldGroups([sel.id], false) : askGroupFocus('name')
        askFocus(act === 'rename' ? 'name' : 'first')
        return
      }
      if (act === 'undo' || act === 'redo') {
        e.preventDefault()
        return stepHistory(act === 'undo')
      }
      if (act === 'duplicate') {
        e.preventDefault() // Ctrl+D would bookmark the page
        const clip = copyClip(draftRef.current, selectedRef.current, collapsedRef.current)
        if (clip) pasteInto(clip) // the system clipboard stays as it was
        return
      }
      if (act === 'selectAll') {
        e.preventDefault()
        return setSelected(selectAllItems(draftRef.current, collapsedRef.current))
      }
      const sel = selectedRef.current
      if (!sel) return
      if (act === 'clear') return setSelected(null)
      // A collapsed group goes with its members (what shows is what goes); the trigger never goes.
      if (sel.kind === 'step' && draftRef.current.steps.find((s) => s.id === sel.id)?.kind === 'trigger') return
      e.preventDefault()
      // Several items go all at once, the trigger aside.
      removePicked(sel)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [edit, stepHistory, pasteInto, goTo, askFocus, askGroupFocus, removePicked, addNoteAt, groupPicked, ungroupIds, foldGroups]) // all stable

  // A row of the canvas's right-click menu, run with the code the keys use. The canvas has already picked what the click
  // was on, and says so in `selection` (the editor's own state has not rendered it yet).
  const onMenuAction = useCallback(
    (action: MenuAction, c: { at: { x: number; y: number }; selection: Selection | null; target: MenuTarget }): void => {
      const sel = c.selection
      // A group's rows act on the group right-clicked: an expanded one is never the selection.
      const t = c.target
      const group = t.kind === 'group' ? (groupsOf(draftRef.current).find((g) => g.id === t.id) ?? null) : null
      // What stands for the whole group: the collapsed node, or the members of an expanded one.
      const whole = (g: NonNullable<typeof group>): Selection | null =>
        collapsedRef.current.has(g.id) ? { kind: 'group', id: g.id } : itemsSelection({ steps: g.steps, notes: g.notes })
      const copyOut = (s: Selection | null, cut: boolean): void => {
        const clip = copyClip(draftRef.current, s, collapsedRef.current)
        if (!clip) return
        // The system clipboard too, so a paste in another tab works; a browser that refuses leaves Ctrl+V as the way.
        void navigator.clipboard?.writeText(clipText(clip)).catch(() => undefined)
        finishCopy(clip, cut)
      }
      switch (action) {
        case 'open':
        case 'rename':
        case 'editDescription':
          // An expanded group's header fields are the canvas's; a collapsed one's are in its panel.
          if (group) {
            setSelected({ kind: 'group', id: group.id })
            return askGroupFocus(action === 'rename' ? 'name' : 'description')
          }
          if (sel?.kind !== 'step' || action === 'editDescription') return
          goTo(sel.id)
          return askFocus(action === 'rename' ? 'name' : 'first')
        case 'copy':
        case 'cut':
          return copyOut(sel, action === 'cut')
        case 'copyGroup':
          if (group) copyOut(whole(group), false)
          return
        case 'duplicate': {
          const clip = copyClip(draftRef.current, sel, collapsedRef.current)
          if (clip) pasteInto(clip)
          return
        }
        case 'group':
          return groupPicked(sel)
        case 'ungroup':
          return ungroupIds(group ? [group.id] : groupsOfPicked(draftRef.current, picked(sel)))
        case 'collapse':
        case 'expand':
          if (group) foldGroups([group.id], action === 'collapse')
          return
        case 'expandAll':
        case 'collapseAll':
          return foldGroups(
            groupsOf(draftRef.current).map((g) => g.id),
            action === 'collapseAll'
          )
        case 'selectGroup':
          if (group) setSelected(whole(group))
          return
        case 'deleteGroup':
          if (group) removeGroup(group.id)
          return
        case 'delete':
          if (sel && sel.kind !== 'edge') removePicked(sel)
          return
        // An edge's one row, as Delete does on a picked edge.
        case 'removeEdge':
          if (t.kind === 'edge') removePicked({ kind: 'edge', id: t.id })
          return
        case 'paste': {
          const clip = lastClip()
          if (clip) pasteInto(clip, { x: c.at.x, y: c.at.y })
          return
        }
        case 'selectAll':
          return setSelected(selectAllItems(draftRef.current, collapsedRef.current))
        case 'fit':
          return canvas.current?.fit()
        // The exact point of the click (the toolbar's button sends the view's middle).
        case 'addNote':
          return addNoteAt(c.at)
        // A note's Edit and Color are the canvas's own.
        default:
          return
      }
    },
    [goTo, askFocus, askGroupFocus, pasteInto, finishCopy, removePicked, addNoteAt, groupPicked, ungroupIds, foldGroups, removeGroup]
  )

  const toggleEnabled = (): void => {
    // Turning on refuses while there are problems, as the server would on save; turning off always works.
    if (!draft.enabled && problems.length > 0) {
      setNotice({ tone: 'error', text: "Fix this workflow's problems before turning it on." })
      return
    }
    edit((d) => ({ ...d, enabled: !d.enabled }))
  }

  // The phone has no Save, so its switch applies at once.
  const toggleNow = (): void => {
    const id = draft.id
    if (id === null || switching) return
    setSwitching(true)
    api.workflows
      .setEnabled(id, !baseline.enabled)
      .then(
        (w) => {
          if (unmounted.current) return
          setBaseline((b) => ({ ...b, enabled: w.enabled }))
          setDraft((d) => ({ ...d, enabled: w.enabled }))
          setNotice(null)
        },
        (e: unknown) => {
          if (!unmounted.current) setNotice({ tone: 'error', text: refusalText(errorMessage(e), problemsRef.current, changedRef.current) })
        }
      )
      .finally(() => {
        if (!unmounted.current) setSwitching(false)
      })
  }

  const startRun = async (input: string): Promise<void> => {
    setRunOpen(false)
    setRunInput(input)
    let id = draftRef.current.id
    if (id === null || settle()) {
      const saved = await save()
      if (!saved) return
      id = saved.id
    }
    try {
      const r = await api.workflows.run(id, input === '' ? undefined : input)
      if (!unmounted.current) setNotice({ tone: 'info', text: 'Run started.', runId: r.id })
    } catch (e) {
      if (!unmounted.current) setNotice({ tone: 'error', text: refusalText(errorMessage(e), problemsRef.current, false) })
    }
  }

  const discard = (): void => {
    setMenuOpen(false)
    restoredFrom.current = null
    historyRef.current = emptyHistory
    draftRef.current = baselineRef.current
    setDraft(baselineRef.current)
    setSelected(null)
    setNotice(null)
  }

  const loadHistory = useCallback(() => {
    const id = draftRef.current.id
    return id === null ? Promise.resolve([]) : api.workflows.history(id)
  }, [])
  const closeHistory = useCallback(() => setHistoryOpen(false), [])

  // A version goes into the draft as one undoable edit; nothing is written until the user saves.
  const restoreVersion = async (v: VersionSummary): Promise<void> => {
    const id = draftRef.current.id
    if (id === null) return
    const def = await api.workflows.version(id, v.id)
    if (unmounted.current) return
    canvas.current?.flushEdits()
    edit((w) => restoredWorkflow(w, def, latest), undefined, true)
    restoredFrom.current = v.savedAt
    setSelected(null)
    setHistoryOpen(false)
    setNotice({ tone: 'info', text: restoreNotice(v.savedAt, Date.now()) })
  }

  const duplicate = async (): Promise<void> => {
    setMenuOpen(false)
    setDuplicating(true)
    try {
      // The server copies the saved workflow, so unsaved edits are saved first (as Run does): the copy is what the user sees.
      let id = draftRef.current.id
      if (id === null || settle()) {
        const saved = await save()
        if (!saved) return
        id = saved.id
      }
      props.current.onDuplicated(await api.workflows.duplicate(id))
    } catch (e) {
      if (!unmounted.current) setNotice({ tone: 'error', text: errorMessage(e) })
    } finally {
      if (!unmounted.current) setDuplicating(false)
    }
  }

  const remove = (): void => {
    setConfirmDelete(false)
    const id = draftRef.current.id
    if (id === null) return
    api.workflows.remove(id).then(
      () => {
        deleted.current = true // its edits went with it: leaving must not ask to save them
        props.current.onDeleted()
      },
      (e: unknown) => props.current.onError(e)
    )
  }

  const banner = (
    <WorkflowBanner
      problems={problems}
      notice={notice}
      onOpenRun={draft.id === null ? null : (runId) => props.current.onOpenRun(draft.id as string, runId)}
      onDismiss={() => setNotice(null)}
    />
  )

  const runDialog = runOpen && (
    <RunWorkflowDialog
      trigger={draft.trigger.kind}
      hasSample={latest !== null}
      willSave={draft.id === null || unsaved}
      problems={problems.length}
      initialInput={runInput}
      onRun={(input) => void startRun(input)}
      onClose={() => setRunOpen(false)}
    />
  )

  if (narrow) {
    const phoneList = phoneSteps(draft)
    const phoneRuns = [...p.runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10)
    return (
      <div className="wf-editor wf-phone" ref={root} data-testid="workflow-editor">
        <header className="rt-head">
          <h2 className="wf-phone-name">{draft.name}</h2>
        </header>
        <div className="wf-phone-body">
          <div className="wf-phone-sub">{triggerSummary(draft.trigger, draft.timeZone)}</div>
          <div className="wf-phone-actions">
            <button
              type="button"
              role="switch"
              className="rt-switch"
              data-testid="wf-enabled"
              aria-checked={baseline.enabled}
              aria-label={baseline.enabled ? 'On' : 'Off'}
              disabled={draft.id === null || switching}
              onClick={toggleNow}
            >
              <span className="rt-switch-dot" />
              <span className="rt-switch-text">{baseline.enabled ? 'On' : 'Off'}</span>
            </button>
            <button type="button" className="btn" data-testid="wf-run" disabled={draft.id === null} onClick={() => setRunOpen(true)}>
              <RoutineIcon name="play" />
              Run workflow
            </button>
          </div>
          {banner}
          <section className="wf-phone-section" aria-labelledby="wf-phone-steps">
            <h3 className="rt-label" id="wf-phone-steps">
              Steps
            </h3>
            {phoneList.length > 0 ? (
              <ol className="wf-phone-steps" data-testid="wf-phone-steps">
                {phoneList.map((s) => (
                  <li key={s.id} className="wf-phone-step" data-testid="wf-phone-step" data-step-id={s.id}>
                    <span className="wf-phone-step-ic">
                      <StepIcon kind={s.kind} />
                    </span>
                    <span className="wf-phone-step-text">
                      <span className="wf-phone-step-name">{s.name}</span>
                      <span className="wf-phone-step-sub">{s.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="rt-hint">No steps yet.</p>
            )}
          </section>
          {draft.id !== null && (
            <section className="wf-phone-section" aria-labelledby="wf-phone-runs">
              <h3 className="rt-label" id="wf-phone-runs">
                Recent runs
              </h3>
              {phoneRuns.length > 0 ? (
                <ul className="wf-phone-runs" data-testid="wf-phone-runs">
                  {phoneRuns.map((run) => (
                    <li key={run.id}>
                      <WorkflowRunRow
                        run={run}
                        now={now}
                        timeZone={draft.timeZone}
                        onOpen={() => p.onOpenRun(draft.id as string, run.id)}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rt-hint">No runs yet.</p>
              )}
            </section>
          )}
          <p className="wf-phone-note" data-testid="wf-phone-note">
            Change steps on a larger screen.
          </p>
        </div>
        {runDialog}
      </div>
    )
  }

  const selStep = selected?.kind === 'step' ? draft.steps.find((s) => s.id === selected.id) : undefined
  const selEdge = selected?.kind === 'edge' ? edgeLabel(draft, selected.id) : null
  // Counted from what the draft still has, so an id an edit took away never inflates "N items selected".
  const live = selected?.kind === 'items' ? pruneSelection(selected, draft, collapsed) : null
  const several = live ? picked(live) : null
  const selGroup = selected?.kind === 'group' && collapsed.has(selected.id) ? groupsOf(draft).find((g) => g.id === selected.id) : undefined

  let inspector: ReactNode
  if (selStep) {
    inspector = (
      <StepInspector
        key={selStep.id}
        draft={draftHookId.current ? { ...draft, id: draft.id ?? draftHookId.current } : draft}
        step={selStep}
        problems={problems.filter((x) => x.stepId === selStep.id).map((x) => x.text)}
        agents={p.agents}
        chats={p.chats}
        workflows={p.workflows}
        sections={p.sections}
        fields={templateFields(draft, selStep.id, latest)}
        edit={edit}
        runs={p.runs}
        onRemove={() => {
          edit((d) => removeStep(d, selStep.id))
          setSelected(null)
        }}
        onOpenChat={p.onOpenChat}
        onError={p.onError}
        focus={focus ?? undefined}
        onFocused={() => setFocus(null)}
        triggerPanel={
          <TriggerInspector
            w={draft}
            edit={edit}
            earlier={earlier.current}
            webhook={{ hook, error: hookError, latest, checking, onCheck: checkCall, onNewSecret: newSecret }}
            now={now}
            today={todayIn(draft.timeZone)}
            onError={p.onError}
            jevOn={jevOn}
            capBlocked={workflowCapBlocker(draft, p.agents, p.chats)}
          />
        }
      />
    )
  } else if (several && pickedCount(several) > 1) {
    const items = several
    const owners = groupsOfPicked(draft, items)
    inspector = (
      <SelectionInspector
        count={pickedCount(several)}
        removable={removableCount(draft, items)}
        onRemove={() => {
          edit((d) => removeItems(d, items))
          setSelected(null)
        }}
        group={{ refused: groupRefusal(draft, items), onGroup: () => groupPicked(live) }}
        onUngroup={owners.length > 0 ? () => ungroupIds(owners) : undefined}
      />
    )
  } else if (selGroup) {
    const id = selGroup.id
    inspector = (
      <CanvasGroupInspector
        key={id}
        group={selGroup}
        edit={edit}
        focus={groupFocus ?? undefined}
        onFocused={() => setGroupFocus(null)}
        onExpand={() => foldGroups([id], false)}
        onUngroup={() => ungroupIds([id])}
        onDelete={() => removeGroup(id)}
      />
    )
  } else if (selected?.kind === 'edge' && selEdge !== null) {
    const edgeId = selected.id
    inspector = (
      <EdgeInspector
        label={selEdge}
        onRemove={() => {
          edit((d) => removeEdge(d, edgeId))
          setSelected(null)
        }}
      />
    )
  } else {
    inspector = <WorkflowOverview w={draft} problems={problems} onSelectStep={(id) => setSelected({ kind: 'step', id })} />
  }

  return (
    <div className="wf-editor" ref={root} data-testid="workflow-editor">
      <header className="rt-head wf-head">
        <input
          className="rt-name"
          data-testid="workflow-name"
          aria-label="Workflow name"
          placeholder="Workflow name"
          maxLength={NAME_MAX}
          value={draft.name}
          onChange={(e) => {
            const name = e.target.value
            edit((d) => ({ ...d, name }), 'workflow:name')
          }}
        />
        {unsaved && (
          <span className="status-pill unsaved" data-testid="wf-unsaved">
            Unsaved
          </span>
        )}
        <button
          type="button"
          role="switch"
          className="rt-switch"
          data-testid="wf-enabled"
          aria-checked={draft.enabled}
          aria-label={draft.enabled ? 'On' : 'Off'}
          onClick={toggleEnabled}
        >
          <span className="rt-switch-dot" />
          <span className="rt-switch-text">{draft.enabled ? 'On' : 'Off'}</span>
        </button>
        <button type="button" className="btn" data-testid="wf-run" onClick={() => setRunOpen(true)}>
          <RoutineIcon name="play" />
          Run workflow
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="wf-save"
          data-tip="Save (Ctrl+S)"
          disabled={saving || (!unsaved && draft.id !== null)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <span className="rt-pop-wrap" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="head-btn"
            data-testid="wf-more"
            aria-label="More"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Glyph name="more" />
          </button>
          {menuOpen && (
            <div className="rt-pop rt-pop-right menu-like">
              <button type="button" data-testid="wf-duplicate" disabled={saving || duplicating} onClick={() => void duplicate()}>
                {duplicateLabel(unsaved, draft.id !== null)}
              </button>
              <button
                type="button"
                data-testid="wf-history"
                disabled={draft.id === null}
                onClick={() => {
                  setMenuOpen(false)
                  setHistoryOpen(true)
                }}
              >
                History…
              </button>
              <button type="button" data-testid="wf-discard" disabled={!unsaved} onClick={discard}>
                Discard changes
              </button>
              <button
                type="button"
                className="danger"
                data-testid="wf-delete"
                disabled={draft.id === null}
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
      {banner}
      <div className="wf-body">
        <LazyCanvas
          w={draft}
          problems={problems}
          selected={selected}
          onSelect={setSelected}
          onEdit={edit}
          commands={canvas}
          onStepOpen={openStep}
          onMenuAction={onMenuAction}
          collapsed={collapsed}
          onToggleGroup={(id, collapse) => foldGroups([id], collapse)}
          onTyping={onTyping}
          triggerSummary={triggerSummary(draft.trigger, draft.timeZone)}
          roomTitle={roomTitle}
          chatTitle={chatTitle}
        />
        <aside className="wf-inspector" data-testid="wf-inspector">
          {inspector}
        </aside>
      </div>
      {runDialog}
      {historyOpen && <HistoryDialog noun="workflow" load={loadHistory} onRestore={restoreVersion} onClose={closeHistory} />}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete workflow?"
          message={`"${draft.name || 'This workflow'}" and its run history will be removed. Its unfinished runs stop first. The chats it made stay.`}
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
