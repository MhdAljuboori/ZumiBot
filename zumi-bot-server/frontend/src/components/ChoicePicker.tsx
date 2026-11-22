import { useCallback, useRef, useState } from 'react'
import type { ChoiceView } from '../state/runPickers'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'
import { Caret } from './Caret'
import { MenuIcon } from './MenuIcon'
import { MenuSearch } from './MenuSearch'

type Menu = { left: number; top?: number; bottom?: number }

/** A picker button under the composer and its one-choice menu (the model, the mode and the effort pickers). */
export function ChoicePicker({
  view,
  note,
  disabled = false,
  className,
  testId,
  menuTestId,
  optionTestId,
  optionAttr = 'data-value',
  onPick
}: {
  view: ChoiceView
  note?: string // under the options, such as what a change costs
  disabled?: boolean
  className?: string
  testId: string
  menuTestId: string
  optionTestId: string
  optionAttr?: `data-${string}` // carries each option's value ('' = Default) for tests
  onPick: (value: string | null) => void
}) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const close = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, close)
  const menuRef = useRef<HTMLDivElement>(null)
  useFitInViewport(menuRef, menu)
  const base = ['picker', 'set', className].filter(Boolean).join(' ')
  return (
    <>
      <button
        type="button"
        className={menu ? `${base} open` : base}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        data-tip={view.title}
        disabled={disabled}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          // Under a chat the pickers sit at the bottom of the window, so the menu opens upward there.
          const up = r.top > window.innerHeight / 2
          setMenu(menu ? null : { left: r.left, ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) })
        }}
      >
        <span className="picker-text">{view.label}</span>
        <Caret />
      </button>
      {menu && (
        <div
          ref={menuRef}
          className="menu picker-menu"
          role="menu"
          data-testid={menuTestId}
          style={{ left: menu.left, top: menu.top, bottom: menu.bottom }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <MenuSearch />
          {view.options.map((o) => {
            const on = view.current === o.value
            return (
              <button
                key={o.value ?? ''}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                data-testid={optionTestId}
                {...{ [optionAttr]: o.value ?? '' }}
                onClick={() => {
                  setMenu(null)
                  onPick(o.value)
                }}
              >
                <span className="menu-text">{o.label}</span>
                {on && <MenuIcon name="check" className="menu-icon menu-current" />}
              </button>
            )
          })}
          {note && <div className="picker-menu-note">{note}</div>}
        </div>
      )}
    </>
  )
}
