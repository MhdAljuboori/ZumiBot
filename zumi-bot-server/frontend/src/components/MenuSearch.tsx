import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { matchesSearch, stepFocus } from '../state/menuSearch'

const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]'

/**
 * The search box at the top of a dropdown menu. It takes focus when the menu opens and hides the menu's items (and a
 * group whose items are all hidden) that do not match. It works on the menu's DOM rather than its options, so each menu
 * keeps its own rows; a MutationObserver filters rows that render later. The arrow keys move between the box and the
 * shown items, Enter in the box picks the first one, and typing on an item goes back to the box. With `onQuery` the
 * owner filters its own options (SearchSelect) and the box only reports the query.
 */
export function MenuSearch({
  label = 'Search',
  testId = 'menu-search',
  onQuery
}: {
  label?: string
  testId?: string
  onQuery?: (query: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [empty, setEmpty] = useState(false)
  const queryRef = useRef(query)
  queryRef.current = query

  useLayoutEffect(() => {
    const menu = ref.current?.parentElement?.closest<HTMLElement>('[role="menu"], [role="listbox"]')
    if (!menu) return
    const apply = (): void => {
      const items = [...menu.querySelectorAll<HTMLElement>(ITEMS)]
      let shown = 0
      for (const el of items) {
        // An action row (Choose folder…) stays whatever the query.
        if (el.dataset.menuSearch === 'keep') continue
        const hide = !onQuery && !matchesSearch(el.textContent ?? '', queryRef.current)
        if (el.hidden !== hide) el.hidden = hide
        if (!hide) shown++
      }
      for (const g of menu.querySelectorAll<HTMLElement>('[role="group"]')) {
        const hide = g.querySelector(`:is(${ITEMS}):not([hidden])`) === null
        if (g.hidden !== hide) g.hidden = hide
      }
      // An owner that filters its own rows (SearchSelect) has none left when nothing matches.
      setEmpty(shown === 0 && (items.length > 0 || queryRef.current.trim() !== ''))
    }
    apply()
    // Rows that render later (a list that loads, a pick that re-renders) are filtered too.
    const watch = new MutationObserver(apply)
    watch.observe(menu, { childList: true, subtree: true })
    return () => watch.disconnect()
  }, [query, onQuery])

  useEffect(() => {
    const box = ref.current
    const menu = box?.parentElement?.closest<HTMLElement>('[role="menu"], [role="listbox"]')
    if (!box || !menu) return
    // The current pick stays in view, as it did when it took the focus itself.
    // Scrolled within the menu only: scrollIntoView would scroll the page too, and a page scroll closes a SearchSelect.
    const on = menu.querySelector<HTMLElement>('[aria-checked="true"]')
    if (on) {
      const top = on.getBoundingClientRect().top - menu.getBoundingClientRect().top + menu.scrollTop
      if (top + on.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = top + on.offsetHeight - menu.clientHeight
    }
    box.focus({ preventScroll: true })
    const shown = (): HTMLElement[] =>
      [...menu.querySelectorAll<HTMLElement>(ITEMS)].filter(
        (el) =>
          !el.hidden &&
          el.closest('[hidden]') === null &&
          el.getAttribute('aria-disabled') !== 'true' &&
          !(el as HTMLButtonElement).disabled
      )
    const onKey = (e: KeyboardEvent): void => {
      const items = shown()
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = stepFocus(e.target === box ? -1 : at, items.length, e.key === 'ArrowDown')
        ;(next === -1 ? box : items[next])?.focus()
        // A menu's own arrow keys (a parent's handler) would move focus a second time.
        e.preventDefault()
        e.stopPropagation()
      } else if (e.key === 'Enter' && e.target === box) {
        e.preventDefault()
        items[0]?.click()
      } else if (e.target !== box && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
        // Typing on a row goes on in the box; the key lands there once it has the focus.
        box.focus({ preventScroll: true })
      }
    }
    menu.addEventListener('keydown', onKey)
    return () => menu.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="menu-search">
      <input
        ref={ref}
        type="search"
        className="menu-search-input"
        placeholder={label}
        aria-label={label}
        data-testid={testId}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          onQuery?.(e.target.value)
        }}
        // Clicks in the box must not close the menu or reach a draggable card under it.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      />
      {empty && (
        <div className="menu-search-empty" data-testid="menu-search-empty">
          No matches
        </div>
      )}
    </div>
  )
}
