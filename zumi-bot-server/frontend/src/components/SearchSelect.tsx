import { Children, Fragment, isValidElement, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { filterOptions, selectedLabel, type SelectOption } from '../state/menuSearch'
import { Caret } from './Caret'
import { MenuIcon } from './MenuIcon'
import { MenuSearch } from './MenuSearch'
import { useAnchoredMenu } from '../useAnchoredMenu'

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
  const [query, setQuery] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const { place, open: show, close } = useAnchoredMenu(button, menu)
  // Each open starts with an empty search.
  const open = (): void => {
    setQuery('')
    show()
  }

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
