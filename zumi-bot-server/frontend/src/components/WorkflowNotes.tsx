import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { NodeResizer, type Node as RFNode, type NodeProps, type OnResize, type OnResizeEnd } from '@xyflow/react'
import { NOTE_MAX_SIDE, NOTE_MIN, NOTE_TEXT_MAX, type Note, type NoteColor } from '@zumibot/shared/workflows'
import { GRID } from '../state/workflowCanvas'
import { hexInput, NOTE_COLOR_NAMES, noteColorName, noteInk } from '../state/workflowNotes'
import { EditorIcon } from './EditorIcon'
import { Markdown } from './Markdown'

// A sticky note on the workflow canvas, and its color popover. The note is a React Flow node drawn under every step and
// edge (its zIndex comes from toFlow); its text, color and box live in the workflow, and every change goes through the
// canvas's note actions, each one edit.

export type NoteNodeData = { note: Note; editable: boolean; editing: boolean }
export type NoteCanvasNode = RFNode<NoteNodeData, 'note'>
export type NoteBox = { x: number; y: number; width: number; height: number }

/** What a note asks of the canvas; absent on a read-only canvas, which draws notes with no controls. */
export interface NoteActions {
  editNote: (id: string) => void
  /** The text as typed so far in an open session, not an edit yet: unsaved all the same, and a save lands it first. */
  typing: (id: string, text: string) => void
  /** The editing session ended (Esc, a click outside): its text lands as one edit. */
  endEdit: (id: string, text: string) => void
  removeNote: (id: string) => void
  /** A resize ended: the box lands as one edit, clamped and on the grid. */
  resizeNote: (id: string, box: NoteBox) => void
  /** A resize in progress: the canvas draws the box locally until it ends (null). */
  sizing: (id: string, box: NoteBox | null) => void
  /** The hover bar's Color button: the popover opens under it. */
  openColors: (id: string, anchor: DOMRect) => void
}
export const NoteActionsContext = createContext<NoteActions | null>(null)

const PRESETS = [1, 2, 3, 4, 5, 6, 7] as const
// What the browser's color dialog starts on for a note with a preset color: a sticky-note yellow.
const PICKER_START = '#ffd54f'
// The smallest box on the grid, so a resize never shows a size that resizeNote then moves.
const MIN = { width: Math.ceil(NOTE_MIN.width / GRID) * GRID, height: Math.ceil(NOTE_MIN.height / GRID) * GRID }
const stop = (e: ReactMouseEvent): void => e.stopPropagation()

/** A preset reads its fill from the theme tokens; a custom color fills as picked, with a border and ink that suit it. */
function colorLook(color: NoteColor): { className: string; style?: CSSProperties } {
  if (typeof color === 'number') return { className: 'wf-note' }
  return {
    className: `wf-note custom ink-${noteInk(color)}`,
    // The fill stays as picked in both themes (as n8n's does); only the border leans toward the theme.
    style: {
      background: color,
      '--note-border': `light-dark(color-mix(in srgb, ${color} 70%, black), color-mix(in srgb, ${color} 70%, white))`
    } as CSSProperties
  }
}

function PencilIcon() {
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
      <path d="M10.5 2.75l2.75 2.75-7.5 7.5H3v-2.75zM9 4.25l2.75 2.75" />
    </svg>
  )
}

/**
 * The note's Markdown, scrolling when it is longer than the box. The wheel pans the canvas over a note whose text fits
 * (a big phase note must not block panning); over one that overflows it scrolls the text, unless Ctrl or Cmd zooms.
 */
function NoteBody({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    // The box (a resize) and the text (a diagram or a font drawn late) both change what fits.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => ro?.disconnect()
  }, [text])
  useEffect(() => {
    const el = ref.current
    if (!el || !overflows) return
    // Native and on the body, so it runs before React Flow's wheel handler on the pane above it; React's own onWheel
    // would run after (it listens at the root).
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => el.removeEventListener('wheel', onWheel)
  }, [overflows])
  return (
    <div ref={ref} className="wf-note-body">
      <Markdown text={text} images={false} />
    </div>
  )
}

/** The Markdown source over the same box. Esc, a click outside or Ctrl+S ends the session, and its text is saved once. */
function NoteEditor({ text, onTyping, onDone }: { text: string; onTyping: (text: string) => void; onDone: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState(text)
  // Esc ends the session and then the textarea's unmount may blur it too: the text must land once.
  const done = useRef(false)
  const finish = (): void => {
    if (done.current) return
    done.current = true
    onDone(ref.current?.value ?? value)
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // The textarea sits in React Flow's moved viewport: focusing must not scroll the canvas's wrapper.
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])
  return (
    <textarea
      ref={ref}
      className="wf-note-text nodrag nopan nowheel"
      data-testid="wf-note-input"
      aria-label="Note text (Markdown)"
      spellCheck
      maxLength={NOTE_TEXT_MAX}
      value={value}
      onChange={(e) => {
        setValue(e.target.value)
        onTyping(e.target.value)
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Esc is the note's: the editor's own Esc (clear the selection) listens on the window.
          e.preventDefault()
          e.stopPropagation()
          finish()
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
          // The text lands before the editor's Ctrl+S (on the window, after this) reads the draft, so the save holds it.
          finish()
        }
      }}
    />
  )
}

/** A sticky note: Markdown in a colored box, with a hover bar, a resizer and an editor in the workflow editor only. */
export function NoteNode({ id, data, selected }: NodeProps<NoteCanvasNode>) {
  const actions = useContext(NoteActionsContext)
  const { note, editable, editing } = data
  const live = editable && actions !== null
  const look = colorLook(note.color)
  // Stable, so the resize controls are not rebuilt on every render of a drag.
  const onResize = useCallback<OnResize>(
    (_e, p) => actions?.sizing(id, { x: p.x, y: p.y, width: p.width, height: p.height }),
    [actions, id]
  )
  const onResizeEnd = useCallback<OnResizeEnd>(
    (_e, p) => actions?.resizeNote(id, { x: p.x, y: p.y, width: p.width, height: p.height }),
    [actions, id]
  )
  return (
    <>
      <div className={look.className} style={look.style} data-testid="wf-note" data-note-id={note.id} data-color={String(note.color)}>
        {editing && live ? (
          <NoteEditor
            text={note.text}
            onTyping={(text) => actions.typing(note.id, text)}
            onDone={(text) => actions.endEdit(note.id, text)}
          />
        ) : (
          <NoteBody text={note.text} />
        )}
        {live && !editing && (
          <div className="wf-note-bar nodrag nopan" data-testid="wf-note-bar">
            {/* Each click stays here: the note's own click handler would pick it again after a Delete took it away. */}
            <button
              type="button"
              className="wf-note-btn"
              data-testid="wf-note-edit"
              aria-label="Edit note"
              data-tip="Edit (Enter)"
              onMouseDown={stop}
              onClick={(e) => {
                e.stopPropagation()
                actions.editNote(note.id)
              }}
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              className="wf-note-btn"
              data-testid="wf-note-color"
              aria-label={`Color: ${noteColorName(note.color)}`}
              data-tip="Color"
              aria-haspopup="dialog"
              onMouseDown={stop}
              onClick={(e) => {
                e.stopPropagation()
                actions.openColors(note.id, e.currentTarget.getBoundingClientRect())
              }}
            >
              <span
                className="wf-note-dot"
                style={
                  typeof note.color === 'number'
                    ? { background: `var(--note-${note.color})`, borderColor: `var(--note-${note.color}-border)` }
                    : { background: note.color }
                }
              />
            </button>
            <button
              type="button"
              className="wf-note-btn danger"
              data-testid="wf-note-delete"
              aria-label="Delete note"
              data-tip="Delete (Del)"
              onMouseDown={stop}
              onClick={(e) => {
                e.stopPropagation()
                actions.removeNote(note.id)
              }}
            >
              <EditorIcon name="trash" />
            </button>
          </div>
        )}
      </div>
      {/* After the box, so its grips paint over the fill (the hover bar stays above them, see styles/workflow-notes.css). */}
      {live && (
        <NodeResizer
          isVisible={selected && !editing}
          minWidth={MIN.width}
          minHeight={MIN.height}
          maxWidth={NOTE_MAX_SIDE}
          maxHeight={NOTE_MAX_SIDE}
          handleClassName="wf-note-grip"
          lineClassName="wf-note-line"
          onResize={onResize}
          onResizeEnd={onResizeEnd}
        />
      )}
    </>
  )
}

/**
 * The color picker: the 7 presets, the recent custom colors, then Custom… with the browser's color input and a hex field.
 * A preset or a recent color applies and closes; a custom one applies as soon as it is whole and the popover stays, so
 * it can be tuned. It closes on Esc or a press outside it.
 */
export function NoteColorPopover({
  color,
  recent,
  onPick,
  onClose
}: {
  color: NoteColor
  recent: string[]
  onPick: (c: NoteColor) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const [custom, setCustom] = useState(false)
  const [hex, setHex] = useState(typeof color === 'string' ? color : '')
  const latest = useRef({ onPick, onClose })
  latest.current = { onPick, onClose }

  useEffect(() => {
    // Not useDismiss: the browser's color dialog blurs the window, and closing then would drop the color picked in it.
    const onDown = (e: MouseEvent): void => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) latest.current.onClose()
    }
    // Capture, so the editor's Esc (clear the selection) never sees the one that closes this.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      latest.current.onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  // The color input fires `input` on every move inside the browser's dialog; only its `change` (the dialog closing on a
  // color) is a pick, so dragging in it is one edit and one recent color, not dozens. React's onChange is `input` here.
  useEffect(() => {
    const el = picker.current
    if (!el) return
    const onChange = (): void => {
      const h = hexInput(el.value)
      if (!h) return
      setHex(h)
      latest.current.onPick(h)
    }
    el.addEventListener('change', onChange)
    return () => el.removeEventListener('change', onChange)
  }, [custom])

  const pickAndClose = (c: NoteColor): void => {
    onPick(c)
    onClose()
  }
  const typed = hexInput(hex)
  return (
    <div
      ref={ref}
      className="wf-note-colors"
      role="dialog"
      aria-label="Note color"
      data-testid="wf-note-colors"
      onMouseDown={stop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="wf-note-swatches" role="group" aria-label="Colors">
        {PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            className="wf-note-swatch"
            data-testid={`wf-note-swatch-${n}`}
            aria-label={NOTE_COLOR_NAMES[n]}
            data-tip={NOTE_COLOR_NAMES[n]}
            aria-pressed={color === n}
            style={{ background: `var(--note-${n})`, borderColor: `var(--note-${n}-border)` }}
            onClick={() => pickAndClose(n)}
          />
        ))}
      </div>
      {recent.length > 0 && (
        <div className="wf-note-swatches" role="group" aria-label="Recent colors" data-testid="wf-note-recents">
          {recent.map((c) => (
            <button
              key={c}
              type="button"
              className="wf-note-swatch"
              data-testid="wf-note-recent"
              aria-label={c}
              data-tip={c}
              aria-pressed={color === c}
              style={{ background: c }}
              onClick={() => pickAndClose(c as NoteColor)}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        className="wf-note-custom-toggle"
        data-testid="wf-note-custom"
        aria-expanded={custom}
        onClick={() => setCustom((o) => !o)}
      >
        Custom…
      </button>
      {custom && (
        <div className="wf-note-custom">
          <input
            ref={picker}
            type="color"
            className="wf-note-picker"
            data-testid="wf-note-picker"
            aria-label="Pick a color"
            value={typed ?? (typeof color === 'string' ? color : PICKER_START)}
            // Shows the color in the hex field as the dialog moves; it applies on `change` (above).
            onChange={(e) => setHex(e.target.value)}
          />
          <input
            type="text"
            className="rt-input wf-note-hex"
            data-testid="wf-note-hex"
            aria-label="Hex color"
            placeholder="#rrggbb"
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            value={hex}
            aria-invalid={hex.trim() !== '' && typed === null}
            onChange={(e) => {
              const text = e.target.value
              setHex(text)
              // Applied once it is a whole color: every keystroke before that is not one yet.
              const h = hexInput(text)
              if (h) onPick(h)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed) {
                e.preventDefault()
                onClose()
              }
            }}
          />
        </div>
      )}
    </div>
  )
}
