import { useCallback, useRef, useState } from 'react'
import type { ModelPicker as ModelView } from '../state/commandModel'
import { runSummary, type ChoiceView } from '../state/runPickers'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'
import { Caret } from './Caret'
import { MenuIcon } from './MenuIcon'
import { MenuSearch } from './MenuSearch'
import { modelChoice, modelNote } from './ModelPicker'

type Menu = { left: number; top?: number; bottom?: number; maxHeight: number }

interface Group {
  key: string
  heading: string
  view: ChoiceView
  note?: string
  optionTestId: string
  optionAttr: `data-${string}`
  onPick: (value: string | null) => void
}

// Taller than a single picker's menu: three lists in one. Capped by the room beside the chip, so it scrolls, not overlaps.
const MAX_HEIGHT = 560
const GAP = 4
const MARGIN = 8

/**
 * On a phone, the model, mode and effort pickers as one chip with all three lists in its menu, so the row under the
 * composer stays on one line. The options keep the separate pickers' test ids and data attributes.
 */
export function RunPicker({
  model,
  mode,
  effort,
  disabled = false,
  testId,
  onModel,
  onMode,
  onEffort
}: {
  model: ModelView | null
  mode: ChoiceView | null
  effort: ChoiceView | null
  disabled?: boolean
  testId: string
  onModel: (model: string | null) => void
  onMode: (value: string | null) => void
  onEffort: (value: string | null) => void
}) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const close = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, close)
  const menuRef = useRef<HTMLDivElement>(null)
  useFitInViewport(menuRef, menu)
  const groups: Group[] = []
  if (model)
    groups.push({
      key: 'model',
      heading: 'Model',
      view: modelChoice(model),
      note: modelNote(model),
      optionTestId: 'chat-model-option',
      optionAttr: 'data-model',
      onPick: onModel
    })
  if (mode)
    groups.push({ key: 'mode', heading: 'Mode', view: mode, optionTestId: 'chat-mode-option', optionAttr: 'data-value', onPick: onMode })
  if (effort)
    groups.push({
      key: 'effort',
      heading: 'Effort',
      view: effort,
      optionTestId: 'chat-effort-option',
      optionAttr: 'data-value',
      onPick: onEffort
    })
  if (groups.length === 0) return null
  const summary = runSummary(model, mode, effort)
  return (
    <>
      <button
        type="button"
        className={menu ? 'picker set run-picker open' : 'picker set run-picker'}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={`Model, mode and effort: ${summary}`}
        data-tip="Model, mode and effort"
        disabled={disabled}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          // Under a chat the pickers sit at the bottom of the window, so the menu opens upward there.
          const up = r.top > window.innerHeight / 2
          const room = (up ? r.top : window.innerHeight - r.bottom) - GAP - MARGIN
          const at = up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }
          setMenu(menu ? null : { left: r.left, ...at, maxHeight: Math.min(MAX_HEIGHT, room) })
        }}
      >
        <MenuIcon name="sliders" className="menu-icon run-icon" />
        <span className="picker-text">{summary}</span>
        <Caret />
      </button>
      {menu && (
        <div
          ref={menuRef}
          className="menu picker-menu run-menu"
          role="menu"
          data-testid={`${testId}-menu`}
          style={{ left: menu.left, top: menu.top, bottom: menu.bottom, maxHeight: menu.maxHeight }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <MenuSearch />
          {groups.map((g, i) => (
            <div key={g.key} role="group" aria-label={g.heading}>
              {i > 0 && <div className="menu-sep" />}
              <div className="menu-label" aria-hidden="true">
                {g.heading}
              </div>
              {g.view.options.map((o) => {
                const on = g.view.current === o.value
                return (
                  <button
                    key={o.value ?? ''}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    data-testid={g.optionTestId}
                    {...{ [g.optionAttr]: o.value ?? '' }}
                    onClick={() => {
                      setMenu(null)
                      g.onPick(o.value)
                    }}
                  >
                    <span className="menu-text">{o.label}</span>
                    {on && <MenuIcon name="check" className="menu-icon menu-current" />}
                  </button>
                )
              })}
              {g.note && <div className="picker-menu-note">{g.note}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
