import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useFitInViewport } from '../useFitInViewport'

/** Text selected inside one finished agent message (or one file preview). */
export interface MessageSelection {
  /** The message's id; '' inside a file preview, which belongs to no message. */
  itemId: string
  text: string
  rect: DOMRect
  /** First and last `data-row` index the selection touches (a file preview's lines), else null. */
  rows: [number, number] | null
}

// Keyboard and touch selections settle without a mouseup: read them once they stop changing for this long.
const SETTLE_MS = 250

// Only finished messages are wrapped in a [data-item-id] row; the working tray's bubbles are still being written.
const BUBBLE = '[data-item-id] .bubble.assistant'

const elementOf = (node: Node | null): Element | null => (node instanceof Element ? node : (node?.parentElement ?? null))

const containerOf = (node: Node | null, scope: string): Element | null => elementOf(node)?.closest(scope) ?? null

function rowOf(node: Node): number | null {
  const n = Number(elementOf(node)?.closest<HTMLElement>('[data-row]')?.dataset.row)
  return Number.isInteger(n) ? n : null
}

/**
 * The `data-row` indexes of the range's two ends. An end at the very start of a row holds none of its text (a triple
 * click ends there), so it counts as the row before.
 */
function rowsOf(range: Range): [number, number] | null {
  const a = rowOf(range.startContainer)
  let b = rowOf(range.endContainer)
  if (a === null || b === null) return null
  if (range.endOffset === 0 && b > a) b -= 1
  return [a, b]
}

/** The selection, when it starts and ends in the same `scope` element inside `root` and that part is on screen. */
function readSelection(root: HTMLElement, scope: string): MessageSelection | null {
  const s = window.getSelection()
  if (!s || s.isCollapsed || s.rangeCount === 0) return null
  const bubble = containerOf(s.anchorNode, scope)
  if (!bubble || bubble !== containerOf(s.focusNode, scope) || !root.contains(bubble)) return null
  const itemId = bubble.closest<HTMLElement>('[data-item-id]')?.dataset.itemId
  // A message's text is trimmed; a file's keeps its indentation, so only blank lines at the start and any end space go.
  const text =
    scope === BUBBLE
      ? s.toString().trim()
      : s
          .toString()
          .replace(/^(?:[ \t]*\n)+/, '')
          .trimEnd()
  if ((!itemId && scope === BUBBLE) || text.trim() === '') return null
  const range = s.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  // Scrolled out of the list: the menu would float over the header or the composer.
  const box = root.getBoundingClientRect()
  if (rect.bottom < box.top || rect.top > box.bottom) return null
  return { itemId: itemId ?? '', text, rect, rows: rowsOf(range) }
}

const same = (a: MessageSelection | null, b: MessageSelection | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.itemId === b.itemId &&
    a.text === b.text &&
    a.rect.top === b.rect.top &&
    a.rect.left === b.rect.left &&
    a.rows?.[0] === b.rows?.[0] &&
    a.rows?.[1] === b.rows?.[1])

/**
 * The text selected inside `root`, or null: by default inside one finished agent message, else inside one element
 * matching `scope`. One listener set for the whole list: hidden while a mouse drag is still selecting, shown on its
 * mouseup, and kept beside the text as the list scrolls. Esc hides it.
 */
export function useMessageSelection(root: RefObject<HTMLElement | null>, scope: string = BUBBLE): [MessageSelection | null, () => void] {
  const [found, setFound] = useState<MessageSelection | null>(null)
  const clear = useCallback(() => setFound(null), [])

  useEffect(() => {
    let pressing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // The same object when nothing moved, so the list does not render again.
    const fresh = (prev: MessageSelection | null): MessageSelection | null => {
      const el = root.current
      const next = el ? readSelection(el, scope) : null
      return same(prev, next) ? prev : next
    }
    const read = (): void => {
      clearTimeout(timer)
      setFound(fresh)
    }
    const onDown = (e: MouseEvent): void => {
      if (e.button === 0) pressing = true
    }
    const onUp = (): void => {
      pressing = false
      read()
    }
    const onChange = (): void => {
      clearTimeout(timer)
      if (pressing) setFound(null)
      else timer = setTimeout(read, SETTLE_MS)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFound(null)
    }
    // Only an open menu follows the scroll; a hidden one stays hidden.
    const onMove = (): void => setFound((prev) => prev && fresh(prev))
    document.addEventListener('mousedown', onDown)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('selectionchange', onChange)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('selectionchange', onChange)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [root, scope])

  return [found, clear]
}

function QuoteIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3.5v9M6 5h7M6 8h7M6 11h4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ExplainIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6.4 6.4a1.65 1.65 0 1 1 2.3 1.5c-.45.2-.7.55-.7 1.05v.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.1" r="0.8" fill="currentColor" />
    </svg>
  )
}

function CommentIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

interface Props {
  selection: MessageSelection
  onQuote: () => void
  /** Absent while nothing can be sent (offline, no claude): Quote only. */
  onExplain?: () => void
  /** Absent outside a diff with line numbers: a review comment needs a line range to pin itself to. */
  onComment?: () => void
}

/** The menu over selected text: quote it into the draft, ask the agent to explain it, or comment on a diff's lines. */
export function SelectionMenu({ selection, onQuote, onExplain, onComment }: Props) {
  const { rect } = selection
  const ref = useRef<HTMLDivElement>(null)
  useFitInViewport(ref, selection)
  // Centred above the selection, unless it is too close to the top of the window.
  const place = rect.top > 56 ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }
  return (
    <div
      ref={ref}
      className="menu selection-menu"
      role="toolbar"
      aria-label="Selected text"
      data-testid="selection-menu"
      style={{ left: rect.left + rect.width / 2, ...place }}
      // Keeps the selection: a press on the menu must not clear what its buttons act on.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" data-testid="selection-quote" onClick={onQuote}>
        <QuoteIcon />
        Quote
      </button>
      {onExplain && (
        <button type="button" data-testid="selection-explain" onClick={onExplain}>
          <ExplainIcon />
          Explain
        </button>
      )}
      {onComment && (
        <button type="button" data-testid="selection-comment" onClick={onComment}>
          <CommentIcon />
          Comment
        </button>
      )}
    </div>
  )
}
