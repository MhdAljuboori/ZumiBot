import { useCallback, useRef, useState } from 'react'
import { canChoose, type RepeatableKind, type RepeatablePick } from '../state/makeRepeatable'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'
import { MenuIcon, type MenuIconName } from './MenuIcon'

const ITEMS: Record<RepeatableKind, { label: string; icon: MenuIconName }> = {
  command: { label: 'Slash command', icon: 'terminal' },
  skill: { label: 'Skill', icon: 'sparkles' },
  routine: { label: 'Routine', icon: 'clock' },
  workflow: { label: 'Workflow', icon: 'workflow' }
}

/** The kinds as menu items, then "Let Zumi Bot choose" when there is a choice: the header's menu and the sidebar's submenu. */
export function RepeatableItems({ kinds, onPick }: { kinds: readonly RepeatableKind[]; onPick: (pick: RepeatablePick) => void }) {
  return (
    <>
      {kinds.map((k) => (
        <button key={k} type="button" role="menuitem" data-testid={`make-repeatable-${k}`} onClick={() => onPick(k)}>
          <MenuIcon name={ITEMS[k].icon} />
          <span className="menu-text">{ITEMS[k].label}</span>
        </button>
      ))}
      {canChoose(kinds) && (
        <>
          <div className="menu-sep" />
          <button type="button" role="menuitem" data-testid="make-repeatable-any" onClick={() => onPick('any')}>
            <MenuIcon name="zumiBot" />
            <span className="menu-text">Let Zumi Bot choose</span>
          </button>
        </>
      )}
    </>
  )
}

/** The chat header's Make repeatable button and its menu; disabled while a reply runs, so the bar never shifts when it ends. */
export function MakeRepeatableMenu({
  kinds,
  disabled,
  onPick
}: {
  kinds: readonly RepeatableKind[]
  disabled: boolean
  onPick: (pick: RepeatablePick) => void
}) {
  // Opens downward from the header, its right edge on the button's.
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null)
  const close = useCallback(() => setPos(null), [])
  useDismiss(pos !== null, close)
  const menuRef = useRef<HTMLDivElement>(null)
  useFitInViewport(menuRef, pos)
  return (
    <>
      <button
        type="button"
        className={pos ? 'head-btn make-repeatable-btn open' : 'head-btn make-repeatable-btn'}
        data-testid="make-repeatable"
        aria-haspopup="menu"
        aria-expanded={pos !== null}
        aria-label="Make repeatable"
        data-tip={disabled ? 'Wait for the reply to finish' : 'Make repeatable'}
        disabled={disabled}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (pos) return close()
          const r = e.currentTarget.getBoundingClientRect()
          setPos({ right: window.innerWidth - r.right, top: r.bottom + 4 })
        }}
      >
        <MenuIcon name="repeat" className="glyph" />
      </button>
      {pos && (
        <div
          ref={menuRef}
          className="menu"
          role="menu"
          aria-label="Make repeatable"
          data-testid="make-repeatable-menu"
          style={{ right: pos.right, top: pos.top }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <RepeatableItems
            kinds={kinds}
            onPick={(pick) => {
              close()
              onPick(pick)
            }}
          />
        </div>
      )}
    </>
  )
}
