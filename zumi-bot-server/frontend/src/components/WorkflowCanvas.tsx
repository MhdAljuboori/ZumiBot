// The canvas is its own lazy chunk: React Flow and its stylesheet load only when a workflow opens, never in the main
// bundle. styles/workflow-canvas.css themes it under .wf-canvas with the app's colour tokens, so light and dark follow the app.
import '@xyflow/react/dist/style.css'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge as RFEdge,
  type EdgeProps,
  type Node as RFNode,
  type NodeChange,
  type NodeProps,
  type OnConnectEnd
} from '@xyflow/react'
import type { Problem } from '@zumibot/shared/workflowGraph'
import {
  groupsOf,
  notesOf,
  stepPorts,
  type NoteColor,
  type Port,
  type RunProgress,
  type StepKind,
  type WorkflowInput
} from '@zumibot/shared/workflows'
import { useDismiss } from '../useDismiss'
import {
  addStep,
  connect,
  GRID,
  insertStep,
  moveItems,
  randomId,
  removeEdge,
  removeItems,
  STEP_LABELS,
  toFlow,
  ZOOM,
  type CollapsedGroupFlowNode,
  type FlowNode,
  type GroupFlowNode,
  type NoteFlowNode,
  type StepRunState
} from '../state/workflowCanvas'
import { lastClip } from '../state/workflowClipboard'
import {
  dropMoves,
  fieldKey,
  groupBox,
  landField,
  moveGroup,
  realConnection,
  stepOutOf,
  STEP_SIZE,
  type OpenField,
  type SizeOf
} from '../state/workflowGroupEdit'
import {
  menuItems,
  placeMenu,
  selectionForMenu,
  type MenuAction,
  type MenuFit,
  type MenuItem,
  type MenuTarget
} from '../state/workflowMenu'
import { groupRunState, progressText } from '../state/workflowRun'
import {
  applySelect,
  edgeLabel,
  fitInView,
  freeSpot,
  itemsSelection,
  panInto,
  picked,
  sameSelection,
  type ItemKind,
  type Selection
} from '../state/workflowEditor'
import { loadRecentColors, pushRecentColor, resizeNote, saveRecentColors, setNoteColor } from '../state/workflowNotes'
import { EditorIcon } from './EditorIcon'
import { Glyph } from './Sidebar'
import {
  CollapsedGroupNode,
  GroupActionsContext,
  GroupBoxNode,
  type CollapsedGroupCanvasNode,
  type GroupActions,
  type GroupBoxCanvasNode,
  type GroupField
} from './WorkflowGroups'
import { StepIcon } from './WorkflowIcons'
import { CanvasContextMenu, isMac } from './WorkflowMenu'
import { PORT_TEXT, StateMark, portTop } from './WorkflowNodeParts'
import { NoteActionsContext, NoteColorPopover, NoteNode, type NoteActions, type NoteBox, type NoteCanvasNode } from './WorkflowNotes'

export interface WorkflowCanvasProps {
  w: WorkflowInput
  problems: Problem[]
  selected: Selection | null
  onSelect: (s: Selection | null) => void
  /**
   * Applies an edit to the workflow. Absent: the canvas is read-only (a run's snapshot). `key` names what the edit came
   * from, for undo; `fresh` makes it a step of its own even after an edit with the same key (a note's editing session).
   */
  onEdit?: (change: (w: WorkflowInput) => WorkflowInput, key?: string, fresh?: boolean) => void
  /** The trigger node's one-line summary ("Manual", the schedule, "Webhook"): its config lives on the workflow. */
  triggerSummary?: string
  /** Each step's state in a run, for the run view. */
  states?: Record<string, StepRunState>
  /** How many outputs each edge carried in a run, by edge id, for the run view. */
  carried?: Record<string, number>
  /** Filled by the canvas with what the editor's keys and menus call. Absent in a run's view. */
  commands?: RefObject<CanvasCommands | null>
  /** A double-click on a step (editable canvas only): the editor selects it and moves into its inspector. */
  onStepOpen?: (id: string) => void
  /**
   * A row of the right-click menu was picked (editable canvas only; Add step is the canvas's own). `at` is the flow point
   * of the click, `selection` what it acts on, `target` what was right-clicked: a group's rows act on its id, since an
   * expanded group is never the selection.
   */
  onMenuAction?: (action: MenuAction, ctx: { at: { x: number; y: number }; selection: Selection | null; target: MenuTarget }) => void
  /** The groups shown collapsed; absent, every group shows expanded. */
  collapsed?: Set<string>
  /** A group's chevron or header (or, in a run's view, a click on a collapsed group): collapse or expand it. */
  onToggleGroup?: (id: string, collapse: boolean) => void
  /**
   * Whether text typed in an open note or group header field would change the workflow once it lands (editable canvas
   * only). It is not an edit until the field closes, but it is unsaved: a tab close or Back closes no field.
   */
  onTyping?: (pending: boolean) => void
  /** The open For each visits' progress, for the run view: the node shows `3 / 36` and the current item. */
  progress?: RunProgress[]
  /** A Room step's template room by id, for its node's one-line summary (the editor has the chats; a run's view does not). */
  roomTitle?: (id: string) => string | null
  /** A Chat step's chat title by id, the same way. */
  chatTitle?: (id: string) => string | null
}

/** What the editor asks of the canvas (zoom keys, paste at the pointer, the Add step menu, Pan mode). */
export interface CanvasCommands {
  zoomIn(): void
  zoomOut(): void
  zoomReset(): void
  fit(): void
  /** Flow coordinates of the last pointer over the canvas, null once it left. */
  pointer(): { x: number; y: number } | null
  /** Flow coordinates of the middle of the visible canvas. */
  viewCentre(): { x: number; y: number }
  /** The Add step menu: above the toolbar's button (a toggle) or, with a point in flow coordinates, around that point. */
  openAddMenu(at?: { x: number; y: number }): void
  togglePan(): void
  /** Pans just enough to bring a step (or a collapsed group) into view, at the same zoom. */
  reveal(id: string): void
  /** Opens a note's Markdown for editing (F2, Enter). */
  editNote(noteId: string): void
  /** Opens an expanded group's name or description in its header for typing (a new group, the menu). */
  editGroup(groupId: string, field: GroupField): void
  /** How big a step is drawn, for a group's box (a size that fits a step until it has been measured). */
  sizeOf(stepId: string): { width: number; height: number }
  /** Lands the text typed in an open note or group header field as its one edit, closing it, so a save reads it. */
  flushEdits(): void
}

// `free`: the out ports with no edge yet, which get n8n's stub and + in the editor.
type StepData = FlowNode['data'] & { free?: Port[]; progress?: string }
type StepFlowNode = RFNode<StepData, 'step'>
type StepFlowEdge = RFEdge<{ carried: number; bar: boolean }, 'step'>
type CanvasNode = StepFlowNode | NoteCanvasNode | GroupBoxCanvasNode | CollapsedGroupCanvasNode

const KIND_LABELS: Record<StepKind, string> = { trigger: 'Trigger', ...STEP_LABELS }
const KIND_HINTS: Record<Exclude<StepKind, 'trigger'>, string> = {
  agent: 'An agent works in a chat',
  chat: 'Posts its prompt into an existing chat',
  room: 'Posts its prompt into a fresh copy of a room',
  foreach: 'Runs an agent on each line',
  llm: 'One model call, no tools',
  condition: 'A yes or no question',
  approval: 'Waits for you',
  wait: 'Pauses for some minutes',
  notify: 'Sends you a notification',
  http: 'Calls an API, no model',
  transform: 'Picks fields out of JSON',
  workflow: 'Runs another workflow'
}
const ADD_KINDS = Object.keys(STEP_LABELS) as Exclude<StepKind, 'trigger'>[]
// Where a new step's top-left goes relative to the point asked for, so the step sits around it, not below-right of it.
const NODE_HALF = { x: 110, y: 36 }
// Roughly a node's size with its port labels: enough to tell whether a new one shows in the view.
const NODE_BOX = { w: 240, h: 84 }
// How far right of a step its port's + puts the next one: a step's width and a gap for the connector.
const NEXT_GAP = 300
const VIEW_MARGIN = 24
// Ctrl-click (Cmd on a Mac) adds an item to the selection or takes it out. The same keys pan with a left drag (n8n's
// own setting): React Flow turns `panOnDrag` on while a pan activation key is held, and its selection box is off
// whenever `panOnDrag` is true (`selectionOnDrag && panOnDrag !== true` in FlowRenderer), so a Ctrl+drag on empty
// canvas pans and a Ctrl+click on an item still multi-selects, because a press on an item goes to its drag handler,
// which stops the event before the pan sees it. Space only pans. The wheel pans (`panOnScroll`) and zooms while
// Ctrl/Cmd is held (`zoomActivationKeyCode`), which is also how a trackpad pinch arrives.
const GROUP_KEYS = ['Control', 'Meta']
const PAN_KEYS = ['Space', 'Control', 'Meta']
const ZOOM_KEYS = ['Control', 'Meta']
// A box on a plain drag, and on Shift too; a middle drag always pans. Outside the component so the arrays stay equal.
const SELECT_KEY = 'Shift'
const MIDDLE_BUTTON = [1]
const SNAP_GRID: [number, number] = [GRID, GRID]
// The same view the `1` key and the fit button give.
const FIT = { padding: 0.25, maxZoom: 1 }
const ZOOM_MS = 150

/** What the editor's + and trash buttons and the notes' controls do; absent on a read-only canvas, which shows none of them. */
interface CanvasActions extends NoteActions {
  /** An edge's +: a new step goes into that edge. */
  insert: (edgeId: string, at: { x: number; y: number }, clientX: number, clientY: number) => void
  remove: (edgeId: string) => void
  /** A free port's +: a new step connected to that port. */
  addFrom: (stepId: string, port: Port, clientX: number, clientY: number) => void
  /** The edge toolbar is outside the edge's own element: entering it keeps the edge hovered, leaving it lets go. */
  hold: (edgeId: string) => void
  release: () => void
}
const CanvasActionsContext = createContext<CanvasActions | null>(null)
// The toolbar sits on the line, but the pointer still crosses a gap between the two: hiding at once would unmount the
// toolbar before it is entered.
const EDGE_HIDE_MS = 150
const stopMouseDown = (e: ReactMouseEvent): void => e.stopPropagation()
// A press on the canvas lets go of text selected in a panel or the sidebar, as a click on plain text would. Chrome keeps
// it through a press on a step, and the editor's Ctrl+C leaves a live text selection to the browser, so a stale one
// copied that text instead of the picked steps. A press inside a field (a note being edited, the color popover's hex)
// is the field's own: dropping the selection there would break selecting its text with a drag.
const dropTextSelection = (e: ReactMouseEvent): void => {
  if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable="true"]')) return
  const s = window.getSelection()
  if (s && !s.isCollapsed) s.removeAllRanges()
}
const POP_EDGE = 8 // the gap a popover keeps to the canvas's edge
// Within this long of a header's click collapsing its group, a second click on the collapsed node is that double-click's
// (the common double-click time, Windows' default).
const DOUBLE_CLICK_MS = 500

/** A popover placed at `at` (pixels from the canvas wrapper's corner), kept inside the wrapper as its size changes. */
function Floating({ at, children }: { at: { left: number; top: number }; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = (): void => {
      const box = el.offsetParent
      if (!(box instanceof HTMLElement)) return setPos(at)
      setPos({
        left: Math.max(POP_EDGE, Math.min(at.left, box.clientWidth - el.offsetWidth - POP_EDGE)),
        top: Math.max(POP_EDGE, Math.min(at.top, box.clientHeight - el.offsetHeight - POP_EDGE))
      })
    }
    place()
    // Custom… makes it taller: placed again, so its fields never open past the canvas's bottom edge.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [at])
  return (
    <div ref={ref} className="wf-note-pop" style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>
  )
}

/**
 * The Add step menu. From the toolbar it grows up from the button (`up`); anywhere else (a port's +, a dropped
 * connection, the right-click menu) it is measured and fitted into the canvas, and scrolls when the canvas is shorter
 * than its rows.
 */
function AddStepMenu({ menu, onPick }: { menu: Menu; onPick: (kind: Exclude<StepKind, 'trigger'>) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<MenuFit | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    const box = el?.offsetParent
    if (menu.up || !el || !(box instanceof HTMLElement)) return setFit(null)
    // Its rows' full height plus the border, not the height a cap from an earlier open left it at.
    const height = el.scrollHeight + el.offsetHeight - el.clientHeight
    setFit(
      placeMenu(
        { left: menu.left, top: menu.top ?? 0 },
        { width: el.offsetWidth, height },
        { width: box.clientWidth, height: box.clientHeight },
        POP_EDGE
      )
    )
  }, [menu])
  const style: CSSProperties = menu.up
    ? { left: menu.left, bottom: menu.up.bottom, maxHeight: menu.up.maxHeight, overflowY: 'auto' }
    : fit
      ? { ...fit, overflowY: 'auto' }
      : { left: menu.left, top: menu.top }
  return (
    <div
      ref={ref}
      className="menu wf-add-menu"
      role="menu"
      aria-label="Add a step"
      data-testid="wf-add-menu"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {ADD_KINDS.map((kind) => (
        <button key={kind} type="button" role="menuitem" data-testid={`wf-add-${kind}`} onClick={() => onPick(kind)}>
          <span className="wf-add-ic">
            <StepIcon kind={kind} />
          </span>
          <span className="wf-add-text">
            <span className="wf-add-name">{STEP_LABELS[kind]}</span>
            <span className="wf-add-hint">{KIND_HINTS[kind]}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

/** The toolbar's small line icons, on the sidebar glyphs' 16px grid. */
function ToolIcon({ name }: { name: 'select' | 'pan' | 'note' }) {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'select' && <path d="M3.25 2.25l9 4.25-3.9 1.4-1.4 3.9z" />}
      {name === 'pan' && (
        <path d="M5.5 8.25V3.5a1 1 0 0 1 2 0V7M7.5 6.5V2.75a1 1 0 0 1 2 0V7M9.5 6.75V3.5a1 1 0 0 1 2 0v5.25M5.5 8.25 4.4 7a1 1 0 0 0-1.5 1.3l2.2 3.4A3.5 3.5 0 0 0 8 13.25h1.5a2.5 2.5 0 0 0 2.5-2.5V8.75" />
      )}
      {name === 'note' && <path d="M3 2.75h10v6.5l-4 4H3zM13 9.25H9v4" />}
    </svg>
  )
}

/**
 * A step on the canvas: kind icon and label, name, summary, and one handle per out port, its name just outside the
 * step (the connector runs on under it) and, in the editor, a short line and a + when nothing leaves it yet.
 */
function StepNode({ data }: NodeProps<StepFlowNode>) {
  const actions = useContext(CanvasActionsContext)
  const { step, summary, problems, state, progress } = data
  const ports = stepPorts(step)
  return (
    <div
      className="wf-node"
      data-testid="wf-node"
      data-step-id={step.id}
      data-kind={step.kind}
      data-problems={problems.length > 0 ? 'true' : 'false'}
      data-state={state?.status}
      data-tip={problems.length > 0 ? problems.join('\n') : undefined}
    >
      {step.kind !== 'trigger' && <Handle type="target" position={Position.Left} id="in" className="wf-handle wf-handle-in" />}
      <div className="wf-node-head">
        <span className="wf-node-ic">
          <StepIcon kind={step.kind} />
        </span>
        <span className="wf-node-kind">{KIND_LABELS[step.kind]}</span>
        {state && state.status !== 'idle' && <StateMark status={state.status} />}
        {state && state.visits > 1 && (
          <span className="wf-node-visits" aria-label={`${state.visits} visits`}>
            ×{state.visits}
          </span>
        )}
        {problems.length > 0 && (
          <span className="wf-node-bad" aria-label={problems.length === 1 ? '1 problem' : `${problems.length} problems`}>
            !
          </span>
        )}
      </div>
      <div className="wf-node-name">{step.name.trim() || KIND_LABELS[step.kind]}</div>
      {summary && <div className="wf-node-sum">{summary}</div>}
      {progress && (
        <div className="wf-node-progress" data-testid="wf-node-progress" data-tip={progress}>
          {progress}
        </div>
      )}
      {ports.map((port, i) => {
        const free = actions !== null && data.free?.includes(port) === true
        return (
          <Handle
            key={port}
            type="source"
            position={Position.Right}
            id={port}
            className={port === 'error' ? 'wf-handle wf-handle-error' : 'wf-handle'}
            data-testid={`wf-port-${port}`}
            style={portTop(i, ports.length)}
          >
            {(PORT_TEXT[port] || free) && (
              <span className="wf-port-tail">
                {PORT_TEXT[port] && <span className="wf-port-label">{PORT_TEXT[port]}</span>}
                {free && (
                  <>
                    <span className="wf-port-stub" aria-hidden="true" />
                    {/* Inside the handle, so its mousedown and click must not reach it: either starts a connection. */}
                    <button
                      type="button"
                      className="wf-port-add nodrag nopan"
                      data-testid={`wf-port-add-${port}`}
                      aria-label={PORT_TEXT[port] ? `Add a step after ${PORT_TEXT[port]}` : 'Add a step after this one'}
                      data-tip="Add a step"
                      onMouseDown={stopMouseDown}
                      onClick={(e) => {
                        e.stopPropagation()
                        actions.addFrom(step.id, port, e.clientX, e.clientY)
                      }}
                    >
                      <Glyph name="plus" />
                    </button>
                  </>
                )}
              </span>
            )}
          </Handle>
        )
      })}
    </div>
  )
}

// A target this far behind the port still gets a curve: a step dropped just under another reads better as an S.
const BACK_SLACK = 20
// A loop back runs this far out of the port before it turns, and this far under the lower port: a step is about 86
// tall with its ports near the middle, so the loop clears its bottom edge.
const LOOP_STUB = 32
const LOOP_DROP = 80
const LOOP_CORNER = 16
// A loop out of a named port runs on past the name before it turns down (about 6 units a letter at its size).
const loopStub = (port: string | null | undefined): number => LOOP_STUB + (PORT_TEXT[port as Port]?.length ?? 0) * 6

/**
 * A loop back as n8n routes one: out of the port, down under both steps, back along the bottom and up into the target,
 * two smooth-step runs joined at the middle of the bottom, which is also where the toolbar goes.
 */
function loopPath(sx: number, sy: number, tx: number, ty: number, stub: number): [string, number, number] {
  const midX = (sx + tx) / 2
  const midY = Math.max(sy, ty) + LOOP_DROP
  const [out] = getSmoothStepPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: Position.Right,
    targetX: midX,
    targetY: midY,
    targetPosition: Position.Right,
    borderRadius: LOOP_CORNER,
    offset: stub
  })
  const [back] = getSmoothStepPath({
    sourceX: midX,
    sourceY: midY,
    sourcePosition: Position.Left,
    targetX: tx,
    targetY: ty,
    targetPosition: Position.Left,
    borderRadius: LOOP_CORNER,
    offset: LOOP_STUB
  })
  return [`${out} ${back}`, midX, midY]
}

/**
 * A connection drawn as n8n draws one: a 2px curve with an arrowhead into the in port, a rounded loop under both steps
 * with an arrow along its bottom when it goes back, and in the editor a toolbar on hover to add a step into it or
 * remove it. Its colours come from the canvas (class and marker), which also tracks the hover.
 */
function StepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  markerEnd,
  data
}: EdgeProps<StepFlowEdge>) {
  const actions = useContext(CanvasActionsContext)
  const back = targetX < sourceX - BACK_SLACK
  const [path, labelX, labelY] = back
    ? loopPath(sourceX, sourceY, targetX, targetY, loopStub(sourceHandleId))
    : getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const bar = actions !== null && data?.bar === true
  const carried = data?.carried ?? 0
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className="wf-edge-line" />
      {back && (
        <path className="wf-edge-mid" d={`M${labelX + 4},${labelY - 4.5} L${labelX - 4},${labelY} L${labelX + 4},${labelY + 4.5} Z`} />
      )}
      {(bar || carried > 1) && (
        <EdgeLabelRenderer>
          <div
            className={`wf-edge-label nodrag nopan${bar ? '' : ' count'}`}
            data-testid={bar ? 'wf-edge-bar' : 'wf-edge-count'}
            // A count sits just above the line, as n8n's item count does; the toolbar sits on it.
            style={{ transform: `translate(-50%, ${bar ? '-50%' : 'calc(-100% - 3px)'}) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={() => actions?.hold(id)}
            onMouseLeave={() => actions?.release()}
          >
            {bar ? (
              <>
                <button
                  type="button"
                  className="wf-edge-btn"
                  data-testid="wf-edge-add"
                  aria-label="Add a step here"
                  data-tip="Add a step here"
                  onMouseDown={stopMouseDown}
                  onClick={(e) => {
                    e.stopPropagation()
                    actions.insert(id, { x: labelX, y: labelY }, e.clientX, e.clientY)
                  }}
                >
                  <Glyph name="plus" />
                </button>
                <button
                  type="button"
                  className="wf-edge-btn"
                  data-testid="wf-edge-delete"
                  aria-label="Remove connection"
                  data-tip="Remove connection"
                  onMouseDown={stopMouseDown}
                  onClick={(e) => {
                    e.stopPropagation()
                    actions.remove(id)
                  }}
                >
                  <EditorIcon name="trash" />
                </button>
              </>
            ) : (
              <span className="wf-edge-count" aria-label={`Ran ${carried} times`}>
                ×{carried}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

// Outside the component: React Flow re-registers every node and edge type when these objects change. Not React Flow's
// own 'group' type for a box: its stylesheet gives that node a padding, border, background and width of its own.
const NODE_TYPES = { step: StepNode, note: NoteNode, groupBox: GroupBoxNode, groupCollapsed: CollapsedGroupNode }
// What a node's type means to the selection; an expanded group's box is never picked.
const NODE_KIND: Record<string, ItemKind> = { step: 'step', note: 'note', groupCollapsed: 'group' }
// A drop on a step's body or a collapsed group's connects there (a note, a box or the canvas opens the Add step menu).
const DROP_TARGETS = '.react-flow__node-step, .react-flow__node-groupCollapsed'
// The box takes no pointer: a press inside it lands on the canvas (a selection box) or on a member; only its header
// takes one back (styles/workflow-canvas.css). React Flow would give it `all`, since the canvas listens for node clicks.
const BOX_STYLE = { pointerEvents: 'none' } as const
const EDGE_TYPES = { step: StepEdge }

interface Menu {
  left: number
  /** From the top, or absent when `up` anchors it above the toolbar. */
  top?: number
  /** The toolbar sits at the bottom, so its menu opens upward: distance from the canvas's bottom edge, and the room above. */
  up?: { bottom: number; maxHeight: number }
  at: { x: number; y: number }
  from?: { stepId: string; port: Port }
  /** The edge the new step goes into (its toolbar's +). */
  insert?: string
}

/** The right-click menu as the canvas holds it: where it opens (pixels from the wrapper), its rows, the click's flow point and what it acts on. */
interface ContextMenu {
  at: { left: number; top: number }
  items: MenuItem[]
  point: { x: number; y: number }
  selection: Selection | null
  target: MenuTarget
}

const NONE_COLLAPSED = new Set<string>()

function Canvas(p: WorkflowCanvasProps) {
  const rf = useReactFlow()
  const wrap = useRef<HTMLDivElement>(null)
  const editable = p.onEdit !== undefined
  // React Flow hides a node until its size is known, and a node object without `measured` is measured again; the
  // nodes are rebuilt from the workflow on every edit, so the sizes it reports are kept here and put back each time.
  const measured = useRef(new Map<string, { width: number; height: number }>())
  const [measures, remeasured] = useReducer((n: number) => n + 1, 0)
  // A group's box is drawn around its steps as they are drawn: reads the ref, so it stays the same function.
  const sizeOf = useCallback<SizeOf>((id) => measured.current.get(id) ?? STEP_SIZE, [])
  // A drag moves the nodes locally (a group moves together) and lands in the workflow once, on drop: one edit, not one
  // per mouse move or per step.
  const [drag, setDrag] = useState<Record<string, { x: number; y: number }> | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag
  const [menu, setMenu] = useState<Menu | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, closeMenu)
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null)
  const closeCtx = useCallback(() => setCtxMenu(null), [])
  // Pan mode (the toolbar's hand, H): a left drag pans. Touch is read once at mount, as a screen does not change kind.
  const [panMode, setPanMode] = useState(false)
  const [touch] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
  const pointerAt = useRef<{ x: number; y: number } | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  // A group header field open for typing (a click on the name, F2's menu row, a new group). The ref is set at once, so a
  // field's end (a blur during the same event) finds it, and an end that comes twice (flushEdits, then the unmount) lands once.
  const [naming, setNaming] = useState<{ id: string; field: GroupField } | null>(null)
  const namingRef = useRef<{ id: string; field: GroupField } | null>(null)
  // The note being edited. The ref is set at once, so the end of a session (a blur during the same event) finds it.
  const [editing, setEditing] = useState<string | null>(null)
  const editingRef = useRef<string | null>(null)
  // A resize in progress draws its box locally, as a drag does, and lands in the workflow once, on release.
  const [sizing, setSizing] = useState<{ id: string; box: NoteBox } | null>(null)
  // The color popover: which note, and where (pixels from the wrapper's corner). Recent colors are read when it opens,
  // so a color picked in another tab shows up.
  const [colorPop, setColorPop] = useState<{ id: string; at: { left: number; top: number } } | null>(null)
  const closeColors = useCallback(() => setColorPop(null), [])
  const colorPopRef = useRef(colorPop)
  colorPopRef.current = colorPop
  const [recent, setRecent] = useState<string[]>([])
  // Left drag pans on touch, in Pan mode and in a read-only view; otherwise only the middle button does (and Space or
  // Ctrl, which React Flow adds itself). A box needs the left button free, so it is off whenever the left pans.
  const leftPans = !editable || panMode || touch

  const latest = useRef(p)
  latest.current = p
  // The text typed in the open note or header field, until it lands through its end (a blur, Enter, Esc, Ctrl+S or
  // flushEdits). The editor is told whether it would change the workflow, and nothing more: only the end is an edit, so
  // one session stays one undo step.
  const openField = useRef<OpenField | null>(null)
  const typingSaid = useRef(false)
  const setOpenField = useCallback((f: OpenField | null): void => {
    openField.current = f
    const w = latest.current.w
    const pending = f !== null && landField(w, f) !== w
    if (pending === typingSaid.current) return
    typingSaid.current = pending
    latest.current.onTyping?.(pending)
  }, [])
  useEffect(
    () => () => {
      if (typingSaid.current) latest.current.onTyping?.(false)
    },
    []
  )
  // When an expanded group's header last collapsed it (see DOUBLE_CLICK_MS).
  const foldedAt = useRef<{ id: string; at: number } | null>(null)
  const justFolded = (id: string): boolean => foldedAt.current?.id === id && performance.now() - foldedAt.current.at < DOUBLE_CLICK_MS
  // The selection as last set from here: React Flow can send two select batches before the editor renders again (a box
  // drawn quickly), and the second must build on the first, not on the stale prop.
  const pickedNow = useRef(p.selected)
  pickedNow.current = p.selected
  const select = (s: Selection | null): void => {
    if (sameSelection(s, pickedNow.current)) return
    pickedNow.current = s
    latest.current.onSelect(s)
  }

  const collapsed = p.collapsed ?? NONE_COLLAPSED
  // A box follows its members while they are dragged, as they will land; the drag lands in the workflow on drop.
  const shownW = useMemo(
    () =>
      drag
        ? moveItems(
            p.w,
            Object.entries(drag).map(([id, at]) => ({ id, x: at.x, y: at.y }))
          )
        : p.w,
    [p.w, drag]
  )
  // `measures` is in the list because sizeOf reads the sizes React Flow last measured.
  const flow = useMemo(
    () => toFlow(shownW, p.problems, p.states, { collapsed, sizeOf }, p.roomTitle, p.chatTitle),
    [shownW, p.problems, p.states, collapsed, sizeOf, measures, p.roomTitle, p.chatTitle]
  )
  const used = useMemo(() => new Set(p.w.edges.map((e) => `${e.from}:${e.port}`)), [p.w.edges])
  const progressByStep = useMemo(() => new Map((p.progress ?? []).map((x) => [x.stepId, progressText(x)] as const)), [p.progress])
  const sel = p.selected
  const pickedIds = new Set(picked(sel).steps)
  const pickedNotes = new Set(picked(sel).notes)
  const pickedGroups = new Set(picked(sel).groups)
  const notes = notesOf(p.w)
  const groups = groupsOf(p.w)
  // A group an undo took away, or one collapsed meanwhile, has no header field to type in.
  const namingNow = naming !== null && groups.some((g) => g.id === naming.id) && !collapsed.has(naming.id) ? naming : null
  useEffect(() => {
    if (naming === null || namingNow !== null) return
    setNaming(null)
    if (namingRef.current?.id === naming.id && namingRef.current.field === naming.field) namingRef.current = null
    if (openField.current?.kind === 'group' && openField.current.id === naming.id) setOpenField(null)
  }, [naming, namingNow, setOpenField])
  // A note an undo took away is not being edited any more, and a redo that brings it back does not reopen it.
  const editingNow = editing !== null && notes.some((n) => n.id === editing) ? editing : null
  const popNote = colorPop ? notes.find((n) => n.id === colorPop.id) : undefined
  useEffect(() => {
    if (editing !== null && editingNow === null) {
      editingRef.current = null
      setEditing(null)
      if (openField.current?.kind === 'note' && openField.current.id === editing) setOpenField(null)
    }
  }, [editing, editingNow, setOpenField])
  useEffect(() => {
    if (colorPop && !popNote) setColorPop(null)
  }, [colorPop, popNote])
  const noteNodes: NoteCanvasNode[] = flow.nodes
    .filter((n): n is NoteFlowNode => n.type === 'note')
    .map((n) => {
      const box = sizing?.id === n.id ? sizing.box : null
      const width = box?.width ?? n.width
      const height = box?.height ?? n.height
      return {
        id: n.id,
        type: 'note',
        position: box ? { x: box.x, y: box.y } : (drag?.[n.id] ?? n.position),
        width,
        height,
        // The size is the workflow's (or the resize in progress), never a measurement: React Flow reads `measured` first,
        // and the resizer starts from it.
        measured: { width, height },
        zIndex: n.zIndex,
        data: { note: n.data.note, editable, editing: editingNow === n.id },
        selected: pickedNotes.has(n.id),
        selectable: editable,
        draggable: editable,
        connectable: false,
        deletable: false
      }
    })
  const stepNodes: StepFlowNode[] = flow.nodes
    .filter((n): n is FlowNode => n.type === 'step')
    .map((n) => ({
      ...n,
      data: {
        ...n.data,
        ...(n.data.step.kind === 'trigger' && p.triggerSummary ? { summary: p.triggerSummary } : {}),
        ...(progressByStep.has(n.id) ? { progress: progressByStep.get(n.id) } : {}),
        ...(editable ? { free: stepPorts(n.data.step).filter((port) => !used.has(`${n.id}:${port}`)) } : {})
      },
      position: drag?.[n.id] ?? n.position,
      selected: pickedIds.has(n.id),
      measured: measured.current.get(n.id),
      deletable: false,
      draggable: editable,
      connectable: editable
    }))
  const boxNodes: GroupBoxCanvasNode[] = flow.nodes
    .filter((n): n is GroupFlowNode => n.type === 'groupBox')
    .map((n) => ({
      id: n.id,
      type: 'groupBox',
      position: n.position,
      width: n.width,
      height: n.height,
      // The box is derived from its members, never measured: React Flow reads `measured` first.
      measured: { width: n.width, height: n.height },
      zIndex: n.zIndex,
      style: BOX_STYLE,
      data: {
        ...n.data,
        editable,
        renaming: namingNow?.id === n.id && namingNow.field === 'name',
        describing: namingNow?.id === n.id && namingNow.field === 'description'
      },
      selectable: false,
      draggable: false,
      connectable: false,
      deletable: false,
      focusable: false
    }))
  const foldedNodes: CollapsedGroupCanvasNode[] = flow.nodes
    .filter((n): n is CollapsedGroupFlowNode => n.type === 'groupCollapsed')
    .map((n) => ({
      id: n.id,
      type: 'groupCollapsed',
      position: drag?.[n.id] ?? n.position,
      width: n.width,
      height: n.height,
      measured: { width: n.width, height: n.height },
      data: { ...n.data, state: p.states ? groupRunState(p.states, n.data.group.steps) : null },
      selected: pickedGroups.has(n.id),
      selectable: true,
      draggable: editable,
      connectable: editable,
      deletable: false
    }))
  // In the order toFlow gives (boxes, notes, steps, collapsed groups): equal zIndexes paint in it.
  const nodes: CanvasNode[] = [...boxNodes, ...noteNodes, ...stepNodes, ...foldedNodes]
  // The hovered edge lives here, not in the edge: its colour is on the class and marker the canvas builds below.
  const [hovered, setHovered] = useState<string | null>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])
  const hold = useCallback((id: string) => {
    window.clearTimeout(hoverTimer.current)
    setHovered(id)
  }, [])
  const release = useCallback(() => {
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = window.setTimeout(() => setHovered(null), EDGE_HIDE_MS)
  }, [])
  const menuEdge = menu?.insert ?? null
  // No label on the line: the port names its branch, as in n8n. The aria label says which steps it joins.
  const edges: StepFlowEdge[] = flow.edges.map((e) => {
    const carried = p.carried?.[e.id] ?? 0
    const selected = sel?.kind === 'edge' && sel.id === e.id
    const hot = selected || e.id === hovered
    return {
      id: e.id,
      type: 'step',
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: 'in',
      data: { carried, bar: editable && (hot || e.id === menuEdge) },
      selected,
      deletable: false,
      className: `wf-edge wf-edge-${e.sourceHandle}${carried > 0 ? ' carried' : ''}${e.id === hovered ? ' hover' : ''}`,
      // The arrowhead is a marker shared by every edge of a colour, so its colour is picked here, not in the stylesheet.
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 10,
        height: 10,
        color: hot
          ? 'var(--accent)'
          : carried > 0
            ? 'var(--success)'
            : e.sourceHandle === 'error'
              ? 'var(--error)'
              : 'var(--xy-edge-stroke)'
      },
      ariaLabel: edgeLabel(p.w, e.id) ?? undefined
    }
  })

  const onNodesChange = (changes: NodeChange<CanvasNode>[]): void => {
    let sized = false
    const noteIds = new Set(notes.map((n) => n.id))
    const groupIds = new Set(groups.map((g) => g.id))
    const picks: { id: string; selected: boolean }[] = []
    const moving: Record<string, { x: number; y: number }> = {}
    const landed: { id: string; x: number; y: number }[] = []
    let dropped = false
    for (const c of changes) {
      if (c.type === 'dimensions' && c.dimensions) {
        // A note's size is the workflow's: the resizer's own changes land through its end (resizeNote), as one edit. A
        // group's node has the size its members give it.
        if (noteIds.has(c.id) || groupIds.has(c.id)) continue
        const was = measured.current.get(c.id)
        if (!was || was.width !== c.dimensions.width || was.height !== c.dimensions.height) {
          measured.current.set(c.id, c.dimensions)
          sized = true
        }
      } else if (c.type === 'select') {
        picks.push({ id: c.id, selected: c.selected })
      } else if (c.type === 'position' && editable) {
        // The resizer moves a note's top or left edge with position changes that carry no `dragging`; a drag always
        // says true or false. Its box lands on release, so these must not land as a move on every mouse move.
        if (c.dragging === undefined) continue
        if (c.dragging && c.position) {
          moving[c.id] = c.position
        } else if (!c.dragging) {
          // The drop (or an arrow key): React Flow may leave the position out of the last change of a drag.
          const at = c.position ?? dragRef.current?.[c.id]
          if (at) landed.push({ id: c.id, x: at.x, y: at.y })
          dropped = true
        }
      }
    }
    if (Object.keys(moving).length > 0) setDrag((d) => ({ ...d, ...moving }))
    // Every item of a drag in one edit: a drop sends them all in one batch (dropMoves says where each lands on the grid).
    if (landed.length > 0) {
      // A collapsed group lands as a move of every member by how far its node went, from where its box put it.
      const from = new Map(flow.nodes.filter((n) => n.type === 'groupCollapsed').map((n) => [n.id, n.position]))
      const { items, folded } = dropMoves(landed, from)
      latest.current.onEdit?.((w) => folded.reduce((out, g) => moveGroup(out, g.id, g.dx, g.dy), moveItems(w, items)))
    }
    if (dropped) setDrag(null)
    if (picks.length > 0) {
      const kindOf = (id: string): ItemKind | null => NODE_KIND[flow.nodes.find((n) => n.id === id)?.type ?? ''] ?? null
      select(applySelect(pickedNow.current, picks, kindOf))
    }
    if (sized) remeasured()
  }

  // A collapsed group's handles stand for its exit and entry steps: the edge is made between those (realConnection).
  const onConnect = (c: Connection): void => {
    const r = realConnection(latest.current.w, latest.current.collapsed ?? NONE_COLLAPSED, c)
    if (r) latest.current.onEdit?.((w) => connect(w, r.from, r.to))
  }
  const isValidConnection = (c: RFEdge | Connection): boolean => {
    const r = realConnection(latest.current.w, latest.current.collapsed ?? NONE_COLLAPSED, c)
    return r !== null && latest.current.w.steps.find((s) => s.id === r.to)?.kind !== 'trigger'
  }

  const openMenu = (clientX: number, clientY: number, at: { x: number; y: number }, from?: Menu['from'], insert?: string): void => {
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect) return
    setCtxMenu(null)
    // Where it was asked for: AddStepMenu fits it into the canvas once its size is known.
    setMenu({ left: clientX - rect.left, top: clientY - rect.top, at, from, insert })
  }

  // A group header field opens for typing. Not checked against the workflow here: a new group is in the editor's draft
  // before it reaches these props, and namingNow drops one that never shows.
  const startGroupEdit = (id: string, field: GroupField): void => {
    if (!editable) return
    setCtxMenu(null)
    setMenu(null)
    setColorPop(null)
    namingRef.current = { id, field }
    setNaming({ id, field })
    // A new session starts with nothing typed (an earlier field landed through its blur).
    setOpenField(null)
  }
  const startGroupRef = useRef(startGroupEdit)
  startGroupRef.current = startGroupEdit
  const groupActions = useMemo<GroupActions>(
    () => ({
      toggle: (id, collapse) => {
        if (collapse) foldedAt.current = { id, at: performance.now() }
        latest.current.onToggleGroup?.(id, collapse)
      },
      startEdit: (id, field) => startGroupRef.current(id, field),
      typing: (id, field, text) => {
        if (namingRef.current?.id === id && namingRef.current.field === field) setOpenField({ kind: 'group', id, field, text })
      },
      endEdit: (id, field, text) => {
        if (namingRef.current?.id !== id || namingRef.current.field !== field) return
        namingRef.current = null
        setNaming(null)
        setOpenField(null)
        if (text === null) return
        // A blank name is refused by renameGroup, so the header shows the name it had.
        const f: OpenField = { kind: 'group', id, field, text }
        latest.current.onEdit?.((w) => landField(w, f), fieldKey(f))
      }
    }),
    [setOpenField]
  )

  // A note opens for editing (a double-click, F2 or Enter, its bar or menu) and becomes the selection. Another note still
  // open is closed first through its own blur, so its text lands before this one opens.
  const startEdit = (id: string): void => {
    if (!editable || editingRef.current === id || !notesOf(latest.current.w).some((n) => n.id === id)) return
    if (editingRef.current !== null && document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setCtxMenu(null)
    setMenu(null)
    setColorPop(null)
    editingRef.current = id
    setEditing(id)
    setOpenField(null)
    select({ kind: 'note', id })
  }
  const openColorsAt = (id: string, at: { left: number; top: number }): void => {
    setCtxMenu(null)
    setMenu(null)
    setRecent(loadRecentColors())
    setColorPop({ id, at })
  }
  const pickColor = (id: string, c: NoteColor): void => {
    if (typeof c === 'string') {
      const next = pushRecentColor(recent, c)
      saveRecentColors(next)
      setRecent(next)
    }
    // Keyed, so the hex field's whole values in a row (each one applies as typed) undo as one step.
    latest.current.onEdit?.((w) => setNoteColor(w, id, c), `note:${id}:color`)
  }

  const canvasActions = useMemo<CanvasActions | null>(
    () =>
      editable
        ? {
            insert: (edgeId, at, clientX, clientY) =>
              openMenu(clientX, clientY + 14, { x: at.x - NODE_HALF.x, y: at.y - NODE_HALF.y }, undefined, edgeId),
            addFrom: (stepId, port, clientX, clientY) => {
              const s = latest.current.w.steps.find((x) => x.id === stepId)
              if (!s) return
              // The next step goes to the right, a two-port step's branches above and below its row; freeSpot moves it off others.
              // The failure path goes below the row, under any branch the step has.
              const ports = stepPorts(s).filter((p) => p !== 'error')
              const dy = port === 'error' ? 160 : ports.length > 1 ? (ports.indexOf(port) === 0 ? -70 : 70) : 0
              openMenu(clientX, clientY + 14, { x: s.x + NEXT_GAP, y: s.y + dy }, { stepId, port })
            },
            remove: (edgeId) => {
              latest.current.onEdit?.((w) => removeEdge(w, edgeId))
              const s = latest.current.selected
              if (s?.kind === 'edge' && s.id === edgeId) latest.current.onSelect(null)
            },
            hold,
            release,
            editNote: (id) => startEdit(id),
            typing: (id, text) => {
              if (editingRef.current === id) setOpenField({ kind: 'note', id, text })
            },
            endEdit: (id, text) => {
              if (editingRef.current !== id) return
              editingRef.current = null
              setEditing(null)
              setOpenField(null)
              // One session is one undo step, even right after another session on the same note.
              const f: OpenField = { kind: 'note', id, text }
              latest.current.onEdit?.((w) => landField(w, f), fieldKey(f), true)
            },
            removeNote: (id) => {
              if (editingRef.current === id) {
                editingRef.current = null
                setEditing(null)
                setOpenField(null)
              }
              latest.current.onEdit?.((w) => removeItems(w, { steps: [], notes: [id], groups: [] }))
              const was = picked(pickedNow.current)
              if (was.notes.includes(id)) select(itemsSelection({ ...was, notes: was.notes.filter((n) => n !== id) }))
            },
            resizeNote: (id, box) => {
              setSizing(null)
              latest.current.onEdit?.((w) => resizeNote(w, id, box))
            },
            sizing: (id, box) => setSizing(box ? { id, box } : null),
            openColors: (id, anchor) => {
              const rect = wrap.current?.getBoundingClientRect()
              if (!rect) return
              // A second click on the same button closes it.
              if (colorPopRef.current?.id === id) return setColorPop(null)
              openColorsAt(id, { left: anchor.left - rect.left, top: anchor.bottom - rect.top + 6 })
            }
          }
        : null,
    [editable, hold, release, setOpenField]
  ) // openMenu, startEdit, openColorsAt and select read only refs and setters

  // What flushEdits does: the open field's end, with the text it holds now (nothing typed, nothing to land).
  const flushRef = useRef<() => void>(() => undefined)
  flushRef.current = () => {
    const f = openField.current
    if (!f) return
    if (f.kind === 'note') canvasActions?.endEdit(f.id, f.text)
    else groupActions.endEdit(f.id, f.field, f.text)
  }

  // Dragging from a port onto empty canvas offers the same menu, and the new step comes connected to that port.
  const onConnectEnd: OnConnectEnd = (event, state) => {
    if (!editable || state.isValid || !state.fromNode || !state.fromHandle || state.fromHandle.type !== 'source') return
    if (state.toHandle) return // over a handle that refused the edge (the trigger's side): nothing to add
    const point = 'changedTouches' in event ? event.changedTouches[0] : event
    if (!point) return
    const fold = latest.current.collapsed ?? NONE_COLLAPSED
    const port = (state.fromHandle.id ?? 'out') as Port
    // Dragged out of a collapsed group: the new edge leaves the member that leaves it by that port.
    const fromStep = stepOutOf(latest.current.w, fold, state.fromNode.id, port)
    if (fromStep === null) return
    const from = { stepId: fromStep, port }
    // Dropped on a step's body rather than its dot: connect to that step, as a drop on its dot would; on a collapsed
    // group's, to its entry step. Not a note: nothing connects to one, and a drop over one (most of a phase's area) is a
    // drop on the canvas, so the Add step menu opens. A step drawn over a note is the element hit there, so it still
    // connects; a group's box takes no pointer, so a drop on it finds the member or the canvas under it.
    const onNode = document.elementFromPoint(point.clientX, point.clientY)?.closest<HTMLElement>(DROP_TARGETS)?.dataset.id
    if (onNode !== undefined) {
      const r = realConnection(latest.current.w, fold, { source: state.fromNode.id, sourceHandle: port, target: onNode })
      if (r) latest.current.onEdit?.((w) => connect(w, r.from, r.to))
      return
    }
    const drop = rf.screenToFlowPosition({ x: point.clientX, y: point.clientY })
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect) return
    // A drop near the edge still puts the whole step in view, so the step dragged from never has to scroll away.
    const lo = rf.screenToFlowPosition({ x: rect.left + VIEW_MARGIN, y: rect.top + VIEW_MARGIN }, { snapToGrid: false })
    const hi = rf.screenToFlowPosition({ x: rect.right - VIEW_MARGIN, y: rect.bottom - VIEW_MARGIN }, { snapToGrid: false })
    const at = fitInView({ x: drop.x, y: drop.y - NODE_HALF.y }, { left: lo.x, top: lo.y, right: hi.x, bottom: hi.y }, NODE_BOX)
    openMenu(point.clientX, point.clientY, at, from)
  }

  const centreOf = (rect: DOMRect): { x: number; y: number } =>
    rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })

  const openAddMenu = (at?: { x: number; y: number }): void => {
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect) return
    setCtxMenu(null)
    if (at) {
      // Around a point (a right-click menu's Add step): the menu opens where the point is on screen.
      const s = rf.flowToScreenPosition(at)
      return openMenu(s.x, s.y, { x: at.x - NODE_HALF.x, y: at.y - NODE_HALF.y })
    }
    if (menu) return setMenu(null)
    const c = centreOf(rect)
    const spot = { x: c.x - NODE_HALF.x, y: c.y - NODE_HALF.y }
    const button = addButton.current?.getBoundingClientRect()
    if (!button) return openMenu(rect.left + rect.width / 2, rect.top + rect.height / 2, spot)
    // The toolbar is at the bottom: the menu grows upward from the button, inside the canvas, and scrolls if the canvas is short.
    const room = button.top - rect.top - 16
    setMenu({
      left: Math.max(8, Math.min(button.left - rect.left, rect.width - 250)),
      up: { bottom: rect.bottom - button.top + 8, maxHeight: Math.max(120, room) },
      at: spot
    })
  }

  // A right-click: an item outside the picked ones is picked alone first, and one inside a group of picked steps acts on
  // the group. An expanded group's header is never picked (its box is not an item): its menu acts on its id and leaves
  // the selection as it is. The point is exact (not on the grid), so Paste and Add step land where the pointer was.
  const openContext = (e: { clientX: number; clientY: number; preventDefault(): void }, target: MenuTarget): void => {
    const rect = wrap.current?.getBoundingClientRect()
    if (!editable || !rect) return
    e.preventDefault()
    const box = target.kind === 'group' && !collapsed.has(target.id)
    const selection = box ? pickedNow.current : selectionForMenu(pickedNow.current, target)
    if (!box) select(selection)
    const t: MenuTarget =
      target.kind !== 'pane' && target.kind !== 'selection' && !box && selection?.kind === 'items' ? { kind: 'selection' } : target
    setMenu(null)
    setColorPop(null)
    setCtxMenu({
      at: { left: e.clientX - rect.left, top: e.clientY - rect.top },
      items: menuItems(latest.current.w, t, selection, { canPaste: lastClip() !== null, collapsed }),
      point: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false }),
      selection,
      target: t
    })
  }
  const pickContext = (action: MenuAction): void => {
    const c = ctxMenu
    setCtxMenu(null)
    if (!c) return
    if (action === 'addStep') return openAddMenu(c.point)
    // A note's Edit and Color are the canvas's own: its editor and the color popover live here.
    if (action === 'edit' && c.selection?.kind === 'note') return startEdit(c.selection.id)
    if (action === 'color' && c.selection?.kind === 'note') return openColorsAt(c.selection.id, c.at)
    // So are an expanded group's header fields; a collapsed group's are in its panel, which the editor focuses.
    if ((action === 'rename' || action === 'editDescription') && c.target.kind === 'group' && !collapsed.has(c.target.id)) {
      return startGroupEdit(c.target.id, action === 'rename' ? 'name' : 'description')
    }
    latest.current.onMenuAction?.(action, { at: c.point, selection: c.selection, target: c.target })
  }

  // The editor's keys reach the canvas through this object; it keeps working over re-renders because it reads refs.
  const rfRef = useRef(rf)
  rfRef.current = rf
  const addMenuRef = useRef(openAddMenu)
  addMenuRef.current = openAddMenu
  const editRef = useRef(startEdit)
  editRef.current = startEdit
  // The flow point at the middle of the visible canvas, off the grid (a note placed there snaps by its own rule).
  const centre = (): { x: number; y: number } => {
    const rect = wrap.current?.getBoundingClientRect()
    return rect
      ? rfRef.current.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, { snapToGrid: false })
      : { x: 0, y: 0 }
  }
  const centreRef = useRef(centre)
  centreRef.current = centre
  // Brings a step at `at` (flow coordinates) into the view with a short pan, at the same zoom.
  const panToBox = (at: { x: number; y: number }): void => {
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect) return
    const tl = rfRef.current.flowToScreenPosition({ x: at.x, y: at.y })
    const br = rfRef.current.flowToScreenPosition({ x: at.x + NODE_BOX.w, y: at.y + NODE_BOX.h })
    const { dx, dy } = panInto({ left: tl.x, top: tl.y, right: br.x, bottom: br.y }, rect, VIEW_MARGIN)
    if (dx !== 0 || dy !== 0) {
      const vp = rfRef.current.getViewport()
      void rfRef.current.setViewport({ x: vp.x - dx, y: vp.y - dy, zoom: vp.zoom }, { duration: 250 })
    }
  }
  const panRef = useRef(panToBox)
  panRef.current = panToBox
  const commandsRef = p.commands
  useEffect(() => {
    if (!commandsRef) return
    const c: CanvasCommands = {
      zoomIn: () => void rfRef.current.zoomIn({ duration: ZOOM_MS }),
      zoomOut: () => void rfRef.current.zoomOut({ duration: ZOOM_MS }),
      zoomReset: () => void rfRef.current.zoomTo(1, { duration: ZOOM_MS }),
      fit: () => void rfRef.current.fitView(FIT),
      pointer: () => pointerAt.current,
      viewCentre: () => centreRef.current(),
      openAddMenu: (at) => {
        if (editable) addMenuRef.current(at)
      },
      togglePan: () => {
        if (editable) setPanMode((m) => !m)
      },
      reveal: (id) => {
        const w = latest.current.w
        const st = w.steps.find((x) => x.id === id)
        if (st) return panRef.current({ x: st.x, y: st.y })
        // A collapsed group's node sits at its box's top-left.
        const g = groupsOf(w).find((x) => x.id === id)
        if (g) panRef.current(groupBox(w, g, sizeOf))
      },
      editNote: (id) => editRef.current(id),
      editGroup: (id, field) => startGroupRef.current(id, field),
      sizeOf,
      flushEdits: () => flushRef.current()
    }
    commandsRef.current = c
    return () => {
      if (commandsRef.current === c) commandsRef.current = null
    }
  }, [commandsRef, editable, sizeOf])

  const pick = (kind: Exclude<StepKind, 'trigger'>): void => {
    const m = menu
    setMenu(null)
    if (!m) return
    const id = randomId()
    const spot = freeSpot(latest.current.w, m.at)
    // The id is chosen out here so the new step can be selected; the updater may run twice (StrictMode), so it makes
    // its own generator each time: the step always gets `id`, the connecting edge a fresh one.
    latest.current.onEdit?.((w) => {
      let first = true
      const gen = (): string => (first ? ((first = false), id) : randomId())
      return m.insert !== undefined ? insertStep(w, m.insert, kind, spot, gen).w : addStep(w, kind, spot, m.from, gen).w
    })
    select({ kind: 'step', id })
    // A step pushed aside to a free slot may land past the edge of the view: pan just enough to bring it in, at the
    // same zoom, so the steps around it stay in sight.
    panToBox(spot)
  }

  return (
    <div
      ref={wrap}
      className="wf-canvas"
      data-testid="wf-canvas"
      data-pan={leftPans ? 'true' : 'false'}
      onMouseDownCapture={editable ? dropTextSelection : undefined}
      // Off the grid: what is placed at the pointer (a paste, a note) snaps by its own rule.
      onPointerMove={(e) => {
        pointerAt.current = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false })
      }}
      onPointerLeave={() => {
        pointerAt.current = null
      }}
    >
      <CanvasActionsContext.Provider value={canvasActions}>
        <NoteActionsContext.Provider value={canvasActions}>
          <GroupActionsContext.Provider value={groupActions}>
            <ReactFlow<CanvasNode, StepFlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              // React Flow picks steps itself (click, Ctrl-click, a drag's start) through select changes. A plain click on a
              // step already in a group is the one it leaves alone, and that click means "this step only".
              onNodeClick={(e, n) => {
                setCtxMenu(null)
                // A box's header answers its own clicks (it collapses); the box itself is never picked.
                if (n.type === 'groupBox') return
                // The second click of a double-click on a header: the group it collapsed stays collapsed (a run's view would open it).
                if (n.type === 'groupCollapsed' && e.detail > 1 && justFolded(n.id)) return
                // In a run a collapsed group opens on a click: its steps' visits are inside.
                if (n.type === 'groupCollapsed' && !editable) return latest.current.onToggleGroup?.(n.id, false)
                // A run's notes are not picked: a click on one is a click on the canvas.
                if (n.type === 'note' && !editable) return select(null)
                if (!editable || !(e.ctrlKey || e.metaKey))
                  select({ kind: n.type === 'note' ? 'note' : n.type === 'groupCollapsed' ? 'group' : 'step', id: n.id })
              }}
              onNodeDoubleClick={(_e, n) => {
                if (!editable || n.type === 'groupBox') return
                if (n.type === 'note') startEdit(n.id)
                // Opening a collapsed group is expanding it, as Enter does, unless a header's double-click collapsed it just now.
                else if (n.type === 'groupCollapsed') {
                  if (!justFolded(n.id)) latest.current.onToggleGroup?.(n.id, false)
                } else latest.current.onStepOpen?.(n.id)
              }}
              // A double-click on a step opens it, so it must not also zoom (a run's read-only view neither).
              zoomOnDoubleClick={false}
              // React Flow moves a focused or boxed step with the arrows; here they walk the graph (the editor's keys).
              disableKeyboardA11y={editable}
              onEdgeClick={(_e, e) => select({ kind: 'edge', id: e.id })}
              onEdgeMouseEnter={(_e, e) => hold(e.id)}
              onEdgeMouseLeave={release}
              onPaneClick={() => {
                select(null)
                setMenu(null)
                setCtxMenu(null)
              }}
              onNodeContextMenu={
                editable
                  ? (e, n) => {
                      // Inside a note being edited or a group's name the browser's own menu (spelling, paste) is the one that helps.
                      if (e.target instanceof Element && e.target.closest('textarea, input')) return
                      const kind = n.type === 'note' ? 'note' : n.type === 'groupBox' || n.type === 'groupCollapsed' ? 'group' : 'step'
                      openContext(e, { kind, id: n.id })
                    }
                  : undefined
              }
              onEdgeContextMenu={editable ? (e, edge) => openContext(e, { kind: 'edge', id: edge.id }) : undefined}
              onPaneContextMenu={editable ? (e) => openContext(e, { kind: 'pane' }) : undefined}
              onSelectionContextMenu={editable ? (e) => openContext(e, { kind: 'selection' }) : undefined}
              // The menus are placed on the screen, so they must not stay behind a pan or zoom.
              onMoveStart={() => {
                setCtxMenu(null)
                setColorPop(null)
              }}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              nodesDraggable={editable}
              nodesConnectable={editable}
              elementsSelectable
              // The editor owns Delete, Backspace and Esc: never the trigger, never while a field has focus.
              deleteKeyCode={null}
              // Pan mode has no box (the left button pans); a read-only view has no selection tools at all.
              selectionKeyCode={editable && !panMode ? SELECT_KEY : null}
              multiSelectionKeyCode={editable ? GROUP_KEYS : null}
              selectionOnDrag={editable && !leftPans}
              panOnDrag={leftPans ? true : MIDDLE_BUTTON}
              panActivationKeyCode={PAN_KEYS}
              zoomActivationKeyCode={ZOOM_KEYS}
              panOnScroll
              zoomOnScroll={false}
              snapToGrid
              snapGrid={SNAP_GRID}
              // A picked note stays under every step and edge (React Flow would lift it over them); notes have their own order.
              elevateNodesOnSelect={false}
              fitView
              fitViewOptions={FIT}
              minZoom={ZOOM.min}
              maxZoom={ZOOM.max}
            >
              <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.3} />
              <Controls showInteractive={false} fitViewOptions={FIT}>
                <ControlButton
                  data-testid="wf-zoom-reset"
                  data-tip="Reset zoom (0)"
                  aria-label="Reset zoom"
                  onClick={() => void rf.zoomTo(1, { duration: ZOOM_MS })}
                >
                  <span className="wf-zoom-one" aria-hidden="true">
                    1:1
                  </span>
                </ControlButton>
              </Controls>
              {editable && (
                <Panel position="bottom-center" className="wf-toolbar" data-testid="wf-toolbar">
                  <button
                    type="button"
                    className="wf-tool"
                    data-testid="wf-tool-select"
                    data-tip="Select"
                    aria-label="Select"
                    aria-pressed={!panMode}
                    onClick={() => setPanMode(false)}
                  >
                    <ToolIcon name="select" />
                  </button>
                  <button
                    type="button"
                    className="wf-tool"
                    data-testid="wf-tool-pan"
                    data-tip="Pan (H, or hold Space or Ctrl)"
                    aria-label="Pan"
                    aria-pressed={panMode}
                    onClick={() => setPanMode(true)}
                  >
                    <ToolIcon name="pan" />
                  </button>
                  <span className="wf-tool-sep" aria-hidden="true" />
                  {/* The pointer is on this button, so the note goes to the middle of the view instead. */}
                  <button
                    type="button"
                    className="wf-tool"
                    data-testid="wf-tool-note"
                    data-tip="Add sticky note (Shift+S)"
                    aria-label="Add sticky note"
                    onClick={() =>
                      latest.current.onMenuAction?.('addNote', { at: centre(), selection: pickedNow.current, target: { kind: 'pane' } })
                    }
                  >
                    <ToolIcon name="note" />
                  </button>
                  <span className="wf-tool-sep" aria-hidden="true" />
                  <button
                    ref={addButton}
                    type="button"
                    className="wf-tool wf-add"
                    data-testid="wf-add"
                    data-tip="Add step (N)"
                    aria-haspopup="menu"
                    aria-expanded={menu !== null && menu.from === undefined && menu.insert === undefined}
                    onMouseDown={stopMouseDown}
                    onClick={() => openAddMenu()}
                  >
                    <Glyph name="plus" />
                    Add step
                  </button>
                </Panel>
              )}
            </ReactFlow>
          </GroupActionsContext.Provider>
        </NoteActionsContext.Provider>
      </CanvasActionsContext.Provider>
      {ctxMenu && <CanvasContextMenu at={ctxMenu.at} items={ctxMenu.items} mac={isMac()} onPick={pickContext} onClose={closeCtx} />}
      {colorPop && popNote && (
        <Floating at={colorPop.at}>
          <NoteColorPopover
            key={colorPop.id}
            color={popNote.color}
            recent={recent}
            onPick={(c) => pickColor(colorPop.id, c)}
            onClose={closeColors}
          />
        </Floating>
      )}
      {menu && <AddStepMenu menu={menu} onPick={pick} />}
    </div>
  )
}

/** The React Flow canvas of a workflow, editable or read-only. The default export, so it can be `React.lazy`-loaded. */
export default function WorkflowCanvas(p: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...p} />
    </ReactFlowProvider>
  )
}
