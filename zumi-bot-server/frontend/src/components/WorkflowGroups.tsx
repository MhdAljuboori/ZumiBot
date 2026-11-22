import { createContext, useContext, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { Handle, Position, useUpdateNodeInternals, type Node as RFNode, type NodeProps } from '@xyflow/react'
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX, type CanvasGroup, type Port } from '@zumibot/shared/workflows'
import type { StepRunState } from '../state/workflowCanvas'
import { groupCountText } from '../state/workflowGroupEdit'
import { Glyph } from './Sidebar'
import { PORT_TEXT, StateMark, portTop } from './WorkflowNodeParts'

// A canvas group, expanded (a box drawn under its members, its header the only part that takes the pointer) or collapsed
// (one node in the flow, with the group's input and the ports its edges leave by). The group lives in the workflow; its
// collapse state is the editor's (or the run view's), and every change goes through the canvas's group actions.

export type GroupField = 'name' | 'description'

/** What a group's nodes ask of the canvas. Toggling works on a read-only canvas too (a run's view); editing does not. */
export interface GroupActions {
  toggle: (id: string, collapse: boolean) => void
  /** A header field opens for typing. */
  startEdit: (id: string, field: GroupField) => void
  /** Its text as typed so far, not an edit yet: unsaved all the same, and a save lands it first. */
  typing: (id: string, field: GroupField, text: string) => void
  /** The field closed: its text lands as one edit, or nothing does (null, Esc). */
  endEdit: (id: string, field: GroupField, text: string | null) => void
}
export const GroupActionsContext = createContext<GroupActions | null>(null)

export type GroupBoxData = { group: CanvasGroup; broken: string | null; editable: boolean; renaming: boolean; describing: boolean }
export type GroupBoxCanvasNode = RFNode<GroupBoxData, 'groupBox'>
export type CollapsedGroupData = {
  group: CanvasGroup
  ports: Port[]
  hasInput: boolean
  state?: StepRunState['status'] | null
  counts: { steps: number; notes: number }
  broken: string | null
}
export type CollapsedGroupCanvasNode = RFNode<CollapsedGroupData, 'groupCollapsed'>

const stop = (e: ReactMouseEvent): void => e.stopPropagation()

function InfoIcon() {
  return (
    <svg className="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.25v3.5M8 5.1v.01" />
    </svg>
  )
}

/**
 * A header field being typed in, its text selected at first. Enter or a click outside lands it, Esc drops it; Ctrl+S
 * lands it first, so the save that follows holds it. Its keys stay here: the editor's Enter and Esc listen on the window.
 */
function HeadField({
  value,
  max,
  label,
  testId,
  className,
  onTyping,
  onDone
}: {
  value: string
  max: number
  label: string
  testId: string
  className: string
  onTyping: (text: string) => void
  onDone: (text: string | null) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  // Enter ends the field and its unmount may blur it too: the text must land once.
  const done = useRef(false)
  const finish = (text: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(text)
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // The field sits in React Flow's moved viewport: focusing must not scroll the canvas's wrapper.
    el.focus({ preventScroll: true })
    el.select()
  }, [])
  return (
    <input
      ref={ref}
      className={`${className} nodrag nopan`}
      data-testid={testId}
      aria-label={label}
      defaultValue={value}
      maxLength={max}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onTyping(e.target.value)}
      onBlur={() => finish(ref.current?.value ?? value)}
      // A click in the field is not a click on the header, which would collapse the group.
      onClick={stop}
      onDoubleClick={stop}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(e.key === 'Enter' ? e.currentTarget.value : null)
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
          finish(e.currentTarget.value)
        }
      }}
    />
  )
}

/**
 * An expanded group: a box around its members, drawn under them (toFlow's zIndex), never picked or dragged. Its header
 * collapses it on a click, and in the editor its name and description open for typing on a click of their own. A group
 * that breaks a rule says why: the save will ungroup it.
 */
export function GroupBoxNode({ data }: NodeProps<GroupBoxCanvasNode>) {
  const actions = useContext(GroupActionsContext)
  const { group, broken, editable, renaming, describing } = data
  const live = editable && actions !== null
  const collapse = (): void => actions?.toggle(group.id, true)
  const open =
    (field: GroupField) =>
    (e: ReactMouseEvent): void => {
      e.stopPropagation()
      actions?.startEdit(group.id, field)
    }
  return (
    <div className="wf-group" data-testid="wf-group" data-group-id={group.id} data-broken={broken !== null ? 'true' : 'false'}>
      <div className="wf-group-head" data-testid="wf-group-head" onClick={collapse}>
        <button
          type="button"
          className="wf-group-toggle"
          data-testid="wf-group-toggle"
          aria-label={`Collapse ${group.name}`}
          aria-expanded
          data-tip="Collapse (Shift+Alt+G)"
          onClick={(e) => {
            e.stopPropagation()
            collapse()
          }}
        >
          <Glyph name="chevron" />
        </button>
        <div className="wf-group-titles">
          {renaming && live ? (
            <HeadField
              value={group.name}
              max={GROUP_NAME_MAX}
              label="Group name"
              testId="wf-group-name-input"
              className="wf-group-name-input"
              onTyping={(t) => actions.typing(group.id, 'name', t)}
              onDone={(t) => actions.endEdit(group.id, 'name', t)}
            />
          ) : (
            <span
              className="wf-group-name"
              data-testid="wf-group-name"
              data-tip={live ? 'Rename (F2)' : undefined}
              onClick={live ? open('name') : undefined}
            >
              {group.name}
            </span>
          )}
          {describing && live ? (
            <HeadField
              value={group.description ?? ''}
              max={GROUP_DESCRIPTION_MAX}
              label="Group description"
              testId="wf-group-desc-input"
              className="wf-group-desc-input"
              onTyping={(t) => actions.typing(group.id, 'description', t)}
              onDone={(t) => actions.endEdit(group.id, 'description', t)}
            />
          ) : group.description ? (
            <span
              className="wf-group-desc"
              data-testid="wf-group-desc"
              data-tip={group.description}
              onClick={live ? open('description') : undefined}
            >
              {group.description}
            </span>
          ) : live ? (
            <button type="button" className="wf-group-desc empty" data-testid="wf-group-desc" onClick={open('description')}>
              Add description
            </button>
          ) : null}
          {broken !== null && (
            <span className="wf-group-warn" data-testid="wf-group-warn" data-tip={broken}>
              Will be ungrouped on save: {broken}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A collapsed group: one node about a step's size standing for its members, picked and dragged like a step. It takes
 * edges in through one input when the group has an entry, and sends them on from the ports they leave the group by,
 * named as on a step; in a run it shows one mark for its steps' states. The chevron expands it. One that breaks a rule
 * is outlined red and says why on hover, as the box does in its header.
 */
export function CollapsedGroupNode({ id, data }: NodeProps<CollapsedGroupCanvasNode>) {
  const actions = useContext(GroupActionsContext)
  const { group, ports, hasInput, state, counts, broken } = data
  const mark = state && state !== 'idle' ? state : null
  // React Flow measures a node's handles again only when its size changes, and this node's never does: an input that
  // appears (a first edge in, an undo) or a port that goes or moves would keep its edges on the old handles, or draw
  // none. So a change in the handle set asks for a fresh measure. Not on mount: React Flow measures a new node itself,
  // and any measure resolves the canvas's first fit (whatever the hook asks), which would then fit before the steps
  // were measured.
  const updateHandles = useUpdateNodeInternals()
  const handleSet = `${hasInput}:${ports.join(',')}`
  const measuredSet = useRef(handleSet)
  useEffect(() => {
    if (measuredSet.current === handleSet) return
    measuredSet.current = handleSet
    updateHandles(id)
  }, [id, handleSet, updateHandles])
  return (
    <div
      className="wf-group-collapsed"
      data-testid="wf-group-collapsed"
      data-group-id={group.id}
      data-state={mark ?? undefined}
      data-broken={broken !== null ? 'true' : 'false'}
      data-tip={broken !== null ? `Will be ungrouped on save: ${broken}` : undefined}
    >
      {hasInput && <Handle type="target" position={Position.Left} id="in" className="wf-handle wf-handle-in" />}
      <div className="wf-gc-head">
        <button
          type="button"
          className="wf-group-toggle nodrag"
          data-testid="wf-group-toggle"
          aria-label={`Expand ${group.name}`}
          aria-expanded={false}
          data-tip="Expand (Alt+G)"
          onClick={(e) => {
            e.stopPropagation()
            actions?.toggle(group.id, false)
          }}
        >
          <Glyph name="chevron" />
        </button>
        <span className="wf-gc-name" data-testid="wf-group-name">
          {group.name}
        </span>
        {group.description && (
          <span className="wf-gc-info" data-testid="wf-group-info" role="img" aria-label={group.description} data-tip={group.description}>
            <InfoIcon />
          </span>
        )}
        {mark && <StateMark status={mark} />}
      </div>
      <div className="wf-gc-count" data-testid="wf-group-count">
        {groupCountText(counts.steps, counts.notes)}
      </div>
      {ports.map((port, i) => (
        <Handle
          key={port}
          type="source"
          position={Position.Right}
          id={port}
          className="wf-handle"
          data-testid={`wf-port-${port}`}
          style={portTop(i, ports.length)}
        >
          {PORT_TEXT[port] && (
            <span className="wf-port-tail">
              <span className="wf-port-label">{PORT_TEXT[port]}</span>
            </span>
          )}
        </Handle>
      ))}
    </div>
  )
}
