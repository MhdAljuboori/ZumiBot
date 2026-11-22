import { useRef, type RefObject } from 'react'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import type { SidebarSection } from '@zumibot/shared/sidebarLayout'
import type { Workflow } from '@zumibot/shared/workflows'
import type { WorkflowsState } from '../net/useWorkflows'
import { editorKey, shownWorkflow } from '../state/workflowEditor'
import type { EditorHandle } from './AgentEditor'
import { WorkflowEditor } from './WorkflowEditor'
import { WorkflowRunView } from './WorkflowRunView'

export { WorkflowsSidebar as WorkflowsNav } from './WorkflowsSidebar'

/**
 * What the Workflows mode shows, which is also its address. `fresh` marks a new, unsaved workflow's editor (its address
 * is plain `/workflows`); App takes it from a counter that only grows, so each New workflow gets an editor of its own.
 */
export interface WorkflowsRoute {
  workflowId: string | null
  runId: string | null
  /** The run's Audit log tab (only with a run). */
  audit?: boolean
  fresh?: number
}

interface ModeProps {
  route: WorkflowsRoute
  snapshot: WorkflowsState
  agents: AgentSummary[]
  /** Every chat, for a Room step's picker (the template rooms) and its node's title. */
  chats: ChatMeta[]
  /** The sidebar's sections, for a kept Room step's place. */
  sections: readonly SidebarSection[]
  /** The unsaved-changes guard's view of the editor, shared with the agent and routine editors. */
  handle: RefObject<EditorHandle | null>
  /** Goes through the guard: opens a workflow, one of its runs, or (null) the empty view. */
  onOpen: (workflowId: string | null, runId?: string | null, audit?: boolean) => void
  onNew: () => void
  onOpenChat: (chatId: string) => void
  onError: (e: unknown) => void
}

/** The Workflows main area: the editor, a run, or the empty view, by address. */
export function WorkflowsMode(p: ModeProps) {
  const { route, snapshot } = p
  // A new workflow's first save gives it an id and an address; keeping its editor's key across that keeps the editor
  // (its selection, the open inspector) instead of remounting it from the snapshot, which may not have it yet.
  const adopted = useRef<{ id: string; key: string } | null>(null)
  // A duplicate opens on its RPC answer, which may come before the push that lists it (see shownWorkflow).
  const arriving = useRef<Workflow | null>(null)
  if (arriving.current && snapshot.workflows.some((w) => w.id === arriving.current?.id)) arriving.current = null
  const openCopy = (copy: Workflow): void => {
    arriving.current = copy
    p.onOpen(copy.id)
  }

  if (route.workflowId === null) {
    const key = editorKey(route, adopted.current)
    if (key !== null) {
      // The adopted editor is not mounted while a new one shows, so its adoption has nothing left to keep.
      adopted.current = null
      return (
        <WorkflowEditor
          key={key}
          workflow={null}
          live={null}
          runs={[]}
          agents={p.agents}
          chats={p.chats}
          workflows={snapshot.workflows}
          sections={p.sections}
          handle={p.handle}
          onSaved={(w: Workflow) => {
            adopted.current = { id: w.id, key }
            p.onOpen(w.id)
          }}
          onDeleted={() => p.onOpen(null)}
          onDuplicated={openCopy}
          onOpenRun={(id, runId) => p.onOpen(id, runId)}
          onOpenChat={p.onOpenChat}
          onError={p.onError}
        />
      )
    }
    return (
      <div className="routine-placeholder wf-empty" data-testid="workflows-placeholder">
        <span>{snapshot.workflows.length > 0 ? 'Select a workflow or add a new one.' : 'No workflows yet.'}</span>
        <button type="button" className="btn primary" data-testid="workflows-new" onClick={p.onNew}>
          New workflow
        </button>
      </div>
    )
  }

  const id = route.workflowId
  const live = snapshot.workflows.find((w) => w.id === id) ?? null
  const shown = shownWorkflow(snapshot.workflows, id, arriving.current)
  const kept = adopted.current?.id === id

  if (route.runId !== null) {
    const runId = route.runId
    if (!live) {
      return (
        <div className="routine-placeholder" data-testid="workflows-placeholder">
          {snapshot.loaded ? 'This workflow was deleted.' : 'Loading…'}
        </div>
      )
    }
    return (
      <WorkflowRunView
        key={runId}
        workflowName={live.name}
        timeZone={live.timeZone}
        runId={runId}
        summary={snapshot.runs[id]?.find((r) => r.id === runId)}
        audit={route.audit === true}
        onTab={(a) => p.onOpen(id, runId, a)}
        onBack={() => p.onOpen(id)}
        onOpenChat={p.onOpenChat}
      />
    )
  }

  if (!shown && !kept) {
    return (
      <div className="routine-placeholder" data-testid="workflows-placeholder">
        {snapshot.loaded ? 'This workflow was deleted.' : 'Loading…'}
      </div>
    )
  }

  return (
    <WorkflowEditor
      key={editorKey(route, adopted.current) ?? id}
      workflow={shown}
      live={live}
      runs={snapshot.runs[id] ?? []}
      agents={p.agents}
      chats={p.chats}
      workflows={snapshot.workflows}
      sections={p.sections}
      handle={p.handle}
      onSaved={() => {}}
      onDeleted={() => {
        if (adopted.current?.id === id) adopted.current = null
        if (arriving.current?.id === id) arriving.current = null
        p.onOpen(null)
      }}
      onDuplicated={openCopy}
      onOpenRun={(wid, runId) => p.onOpen(wid, runId)}
      onOpenChat={p.onOpenChat}
      onError={p.onError}
    />
  )
}
