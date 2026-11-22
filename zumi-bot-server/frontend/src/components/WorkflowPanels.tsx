import { Component, lazy, Suspense, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import type { Problem } from '@zumibot/shared/workflowGraph'
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX, type CanvasGroup, type WorkflowInput } from '@zumibot/shared/workflows'
import { generalProblems } from '../state/workflowEditor'
import { groupCountText, renameGroup, setGroupDescription } from '../state/workflowGroupEdit'

// The editor's smaller pieces: the canvas behind its lazy boundary, the banner under the top bar, and the inspectors
// for an edge, several items, a collapsed group, and nothing selected.

// React Flow loads with the first workflow opened, as its own chunk, so the main bundle does not grow by it.
const WorkflowCanvas = lazy(() => import('./WorkflowCanvas'))

/** A chunk that fails to load (offline, a deploy replaced it) would otherwise take the whole page down. */
class CanvasBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    return this.state.failed ? (
      <div className="wf-canvas wf-canvas-note" role="alert">
        The canvas could not load. Reload the page to try again.
      </div>
    ) : (
      this.props.children
    )
  }
}

/** The canvas, loaded on first use; without onEdit it is read-only (a run's snapshot). */
export function LazyCanvas(props: ComponentProps<typeof WorkflowCanvas>) {
  return (
    <CanvasBoundary>
      <Suspense fallback={<div className="wf-canvas wf-canvas-note">Loading the canvas…</div>}>
        <WorkflowCanvas {...props} />
      </Suspense>
    </CanvasBoundary>
  )
}

export type Notice = { tone: 'error' | 'warn' | 'info'; text: string; runId?: string }

/**
 * Under the top bar: problems no step carries (no node can show them), and the last save, switch or run message. A run
 * that started links to its run.
 */
export function WorkflowBanner({
  problems,
  notice,
  onOpenRun,
  onDismiss
}: {
  problems: Problem[]
  notice: Notice | null
  onOpenRun: ((runId: string) => void) | null
  onDismiss: () => void
}) {
  const general = generalProblems(problems)
  if (general.length === 0 && !notice) return null
  return (
    <div className="wf-banner" data-testid="wf-banner">
      {general.length > 0 && (
        <ul className="rt-errors" data-testid="wf-general-problems" role="alert">
          {general.map((g) => (
            <li key={g.text}>{g.text}</li>
          ))}
        </ul>
      )}
      {notice && (
        <div
          className={`wf-notice ${notice.tone}`}
          data-testid="wf-notice"
          data-tone={notice.tone}
          role={notice.tone === 'info' ? 'status' : 'alert'}
        >
          <span className="wf-notice-text">{notice.text}</span>
          {notice.runId && onOpenRun && (
            <button type="button" className="rt-insert" data-testid="wf-notice-run" onClick={() => onOpenRun(notice.runId as string)}>
              View run
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

/** The inspector for a selected edge: what it joins, and a way to remove it. */
export function EdgeInspector({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <div className="wf-inspect" data-testid="wf-edge-inspector">
      <div className="wf-inspect-head">
        <h3>Connection</h3>
      </div>
      <p className="wf-edge-text">{label}</p>
      <button type="button" className="btn wf-remove" data-testid="wf-edge-remove" onClick={onRemove}>
        Remove connection
      </button>
      <div className="rt-hint">Or press Delete.</div>
    </div>
  )
}

/**
 * The inspector for items picked together: how many, how to move them, and ways to group, ungroup or remove them. Group
 * is always there, and says which rule the picked items break while it is off; Ungroup only when they are in a group.
 */
export function SelectionInspector({
  count,
  removable,
  onRemove,
  group,
  onUngroup,
  children
}: {
  count: number
  removable: number
  onRemove: () => void
  group?: { refused: string | null; onGroup: () => void }
  onUngroup?: () => void
  children?: ReactNode
}) {
  return (
    <div className="wf-inspect" data-testid="wf-selection-inspector">
      <div className="wf-inspect-head">
        <h3>{count} items selected</h3>
      </div>
      <p className="rt-hint">
        Drag any of them to move them together. Ctrl-click (Cmd-click on a Mac) an item to add it or take it out, or click one item to edit
        it alone.
      </p>
      {(group || onUngroup) && (
        <div className="wf-group-buttons">
          {group && (
            <button
              type="button"
              className="btn"
              data-testid="wf-selection-group"
              disabled={group.refused !== null}
              data-tip={group.refused ?? 'Group (Ctrl+G)'}
              onClick={group.onGroup}
            >
              Group
            </button>
          )}
          {onUngroup && (
            <button type="button" className="btn" data-testid="wf-selection-ungroup" data-tip="Ungroup (Ctrl+Shift+G)" onClick={onUngroup}>
              Ungroup
            </button>
          )}
        </div>
      )}
      {group?.refused && (
        <div className="rt-hint" data-testid="wf-selection-group-why">
          {group.refused}
        </div>
      )}
      {children}
      {removable > 0 && (
        <button type="button" className="btn wf-remove" data-testid="wf-selection-remove" onClick={onRemove}>
          {removable === 1 ? 'Delete 1 item' : `Delete ${removable} items`}
        </button>
      )}
      <div className="rt-hint">{removable < count ? 'The trigger stays. Or press Delete.' : 'Or press Delete.'}</div>
    </div>
  )
}

/**
 * The inspector for a selected collapsed group: its name and description, what it holds, and Expand, Ungroup and Delete
 * group. A field that would be refused (a blank name) shows what was typed until focus leaves, then the stored text.
 */
export function CanvasGroupInspector(p: {
  group: CanvasGroup
  edit: (c: (w: WorkflowInput) => WorkflowInput, key?: string) => void
  onExpand: () => void
  onUngroup: () => void
  onDelete: () => void
  /** Asks for focus on a field, its text selected; `n` changes on every request. */
  focus?: { field: 'name' | 'description'; n: number }
  onFocused?: () => void
}) {
  const { group } = p
  const root = useRef<HTMLDivElement>(null)
  const [name, setName] = useState<string | null>(null)
  const [desc, setDesc] = useState<string | null>(null)
  const focusN = p.focus?.n
  useEffect(() => {
    if (!p.focus) return
    const el = root.current?.querySelector<HTMLInputElement>(
      `[data-testid="${p.focus.field === 'name' ? 'wf-canvas-group-name' : 'wf-canvas-group-desc'}"]`
    )
    if (!el) return
    p.onFocused?.()
    el.focus()
    el.select()
  }, [focusN])
  return (
    <div className="wf-inspect" ref={root} data-testid="wf-canvas-group-inspector" data-group-id={group.id}>
      <div className="wf-inspect-head">
        <h3>Group</h3>
      </div>
      <p className="rt-hint" data-testid="wf-canvas-group-count">
        {groupCountText(group.steps.length, group.notes.length)}, shown as one node.
      </p>
      <label className="rt-fieldset">
        <span className="rt-label">Name</span>
        <input
          className="rt-input"
          data-testid="wf-canvas-group-name"
          aria-label="Group name"
          maxLength={GROUP_NAME_MAX}
          value={name ?? group.name}
          onChange={(e) => {
            const v = e.target.value
            if (!v.trim()) return setName(v)
            setName(null)
            p.edit((w) => renameGroup(w, group.id, v), `group:${group.id}:name`)
          }}
          onBlur={() => setName(null)}
        />
      </label>
      <label className="rt-fieldset">
        <span className="rt-label">Description</span>
        <input
          className="rt-input"
          data-testid="wf-canvas-group-desc"
          aria-label="Group description"
          placeholder="What this part of the workflow does"
          maxLength={GROUP_DESCRIPTION_MAX}
          value={desc ?? group.description ?? ''}
          onChange={(e) => {
            const v = e.target.value
            setDesc(v.trim() ? null : v)
            p.edit((w) => setGroupDescription(w, group.id, v), `group:${group.id}:description`)
          }}
          onBlur={() => setDesc(null)}
        />
      </label>
      <div className="wf-group-buttons">
        <button type="button" className="btn" data-testid="wf-canvas-group-expand" data-tip="Expand (Alt+G)" onClick={p.onExpand}>
          Expand
        </button>
        <button type="button" className="btn" data-testid="wf-canvas-group-ungroup" data-tip="Ungroup (Ctrl+Shift+G)" onClick={p.onUngroup}>
          Ungroup
        </button>
      </div>
      <button type="button" className="btn wf-remove" data-testid="wf-canvas-group-delete" onClick={p.onDelete}>
        Delete group
      </button>
      <div className="rt-hint">Delete group removes its steps and notes too. Or press Delete.</div>
    </div>
  )
}

/** The inspector with nothing selected: how to build, and every problem, each opening its step. */
export function WorkflowOverview({
  w,
  problems,
  onSelectStep
}: {
  w: WorkflowInput
  problems: Problem[]
  onSelectStep: (id: string) => void
}) {
  const stepName = (id: string): string => w.steps.find((s) => s.id === id)?.name || 'A step'
  return (
    <div className="wf-inspect" data-testid="wf-inspector-empty">
      <div className="wf-inspect-head">
        <h3>Workflow</h3>
      </div>
      <p className="rt-hint">
        Select a step to edit it. Add step puts a new one in the middle of the view. Drag from a step's right-hand dot to another step to
        connect them, or onto empty canvas to add a connected step. To move several steps together, drag a box around them on empty canvas,
        Ctrl-click (Cmd-click on a Mac) each one, or press Ctrl+A for all.
      </p>
      {problems.length > 0 ? (
        <>
          <div className="rt-label">Problems</div>
          <ul className="wf-all-problems" data-testid="wf-all-problems">
            {problems.map((x, i) => (
              <li key={i}>
                {x.stepId === null ? (
                  x.text
                ) : (
                  <button type="button" className="rt-insert" onClick={() => onSelectStep(x.stepId as string)}>
                    {stepName(x.stepId)}: {x.text}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="rt-hint">Run workflow and turning it on wait until these are fixed. Save always works.</div>
        </>
      ) : (
        <div className="rt-hint wf-ready" data-testid="wf-ready">
          No problems: it is ready to run.
        </div>
      )}
    </div>
  )
}
