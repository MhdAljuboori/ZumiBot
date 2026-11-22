import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { filterOptions, selectedLabel, type SelectOption } from '../state/menuSearch'
import { Caret } from './Caret'
import { MenuIcon } from './MenuIcon'
import { MenuSearch } from './MenuSearch'

type Place = { left: number; minWidth: number; maxHeight: number; top?: number; bottom?: number }

const GAP = 4
const MARGIN = 8
const MAX_HEIGHT = 320

/** The text of an option's children, as a native select shows it. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/** The `<option>`s (inside `<optgroup>`s, fragments and arrays too) a select was given, in order. */
function optionsOf(children: ReactNode, group?: string): SelectOption[] {
  const out: SelectOption[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    const el = child as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; label?: string }>
    if (el.type === Fragment) out.push(...optionsOf(el.props.children, group))
    else if (el.type === 'optgroup') out.push(...optionsOf(el.props.children, el.props.label))
    else if (el.type === 'option') {
      const label = textOf(el.props.children)
      out.push({
        value: el.props.value === undefined ? label : String(el.props.value),
        label,
        disabled: el.props.disabled === true,
        ...(group ? { group } : {})
      })
    }
  })
  return out
}

/**
 * A dropdown in place of a native `<select>`, with a search box that takes focus when it opens. It takes the same
 * `<option>`/`<optgroup>` children; `onChange` gets the picked value. The button carries the test id and `data-value`
 * (the current value), and each option `data-testid="select-option"` and `data-value`, for the e2e suites.
 */
export function SearchSelect({
  value,
  onChange,
  children,
  className,
  disabled = false,
  id,
  title,
  'aria-label': ariaLabel,
  'data-testid': testId
}: {
  value: string | number
  onChange: (value: string) => void
  children: ReactNode
  className?: string
  disabled?: boolean
  id?: string
  title?: string
  'aria-label'?: string
  'data-testid'?: string
}) {
  const current = String(value)
  const options = optionsOf(children)
  const [place, setPlace] = useState<Place | null>(null)
  const [query, setQuery] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = useCallback((refocus = false) => {
    setPlace(null)
    setQuery('')
    if (refocus) button.current?.focus({ preventScroll: true })
  }, [])

  // Where the menu goes for the button's spot now: below it, or above when there is clearly more room there.
  const measure = useCallback((): Place | null => {
    const r = button.current?.getBoundingClientRect()
    if (!r) return null
    const below = window.innerHeight - r.bottom - GAP - MARGIN
    const above = r.top - GAP - MARGIN
    const up = below < 200 && above > below
    return {
      left: r.left,
      minWidth: r.width,
      maxHeight: Math.min(MAX_HEIGHT, up ? above : below),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP })
    }
  }, [])

  const isOpen = place !== null
  useEffect(() => {
    if (!isOpen) return
    const outside = (e: Event): void => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !button.current?.contains(t)) close()
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Ours first: a panel or dialog under the menu must not close too.
      e.stopPropagation()
      e.preventDefault()
      close(true)
    }
    // It follows its button when the page under it scrolls (a drawer scrolling a form into view), and closes once the
    // button has left the window.
    const moved = (e: Event): void => {
      if (menu.current?.contains(e.target as Node)) return
      const r = button.current?.getBoundingClientRect()
      if (!r || r.bottom < 0 || r.top > window.innerHeight) close()
      else setPlace(measure())
    }
    const dismiss = (): void => close()
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', esc, true)
    window.addEventListener('scroll', moved, true)
    window.addEventListener('resize', moved)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('mousedown', outside, true)
      document.removeEventListener('keydown', esc, true)
      window.removeEventListener('scroll', moved, true)
      window.removeEventListener('resize', moved)
      window.removeEventListener('blur', dismiss)
    }
  }, [isOpen, close, measure])

  // Nudged back inside the window when the button sits near an edge.
  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return
    el.style.translate = ''
    const r = el.getBoundingClientRect()
    const dx = Math.max(MARGIN - r.left, Math.min(0, window.innerWidth - MARGIN - r.right))
    if (dx !== 0) el.style.translate = `${dx}px 0`
  }, [place])

  const open = (): void => setPlace(measure())

  const pick = (o: SelectOption): void => {
    if (o.disabled) return
    close(true)
    if (o.value !== current) onChange(o.value)
  }

  const shown = filterOptions(options, query)
  let lastGroup: string | undefined
  return (
    <>
      <button
        ref={button}
        type="button"
        id={id}
        className={['search-select', className, place && 'open'].filter(Boolean).join(' ')}
        data-testid={testId}
        data-value={current}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={place !== null}
        data-tip={title}
        disabled={disabled}
        // A press must not start dragging a card under it or close a menu it sits in.
        draggable={false}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          if (place) close()
          else open()
        }}
        onKeyDown={(e) => {
          if (!place && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            open()
          }
        }}
      >
        <span className="search-select-text">{selectedLabel(options, current)}</span>
        <Caret />
      </button>
      {place &&
        createPortal(
          <div
            ref={menu}
            className="menu picker-menu search-select-menu"
            role="listbox"
            aria-label={ariaLabel}
            data-testid={testId ? `${testId}-menu` : undefined}
            style={{ left: place.left, top: place.top, bottom: place.bottom, minWidth: place.minWidth, maxHeight: place.maxHeight }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <MenuSearch onQuery={setQuery} />
            {shown.map((o, i) => {
              const on = o.value === current
              const heading = o.group !== undefined && o.group !== lastGroup ? o.group : null
              lastGroup = o.group
              return (
                <Fragment key={`${o.group ?? ''}\u0000${o.value}\u0000${i}`}>
                  {heading !== null && (
                    <div className="menu-label" aria-hidden="true">
                      {heading}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    aria-checked={on}
                    aria-disabled={o.disabled}
                    disabled={o.disabled}
                    data-testid="select-option"
                    data-value={o.value}
                    onClick={() => pick(o)}
                  >
                    <span className="menu-text">{o.label}</span>
                    {on && <MenuIcon name="check" className="menu-icon menu-current" />}
                  </button>
                </Fragment>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}
