import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { SearchHit } from '@zumibot/shared/search'
import type { AgentSummary } from '@zumibot/shared/types'
import { useMessageSearch } from '../net/useMessageSearch'
import {
  PALETTE_HITS,
  messageQuery,
  moveActive,
  paletteItems,
  paletteSections,
  type PaletteIcon,
  type PaletteItem,
  type PaletteSources,
  type PaletteTarget
} from '../state/commandPalette'
import { findAgent, memberAgents } from '../state/groupChat'
import { hitKey, hitRows, segments, statusText, type HitRow } from '../state/messageSearch'
import { BotIcon } from './BotIcon'
import { MemberStack } from './MemberStack'
import { MenuIcon, type MenuIconName } from './MenuIcon'
import { RailGlyph, type RailGlyphName } from './Rail'

interface Props {
  sources: PaletteSources
  connected: boolean
  onPick: (target: PaletteTarget) => void
  onPickMessage: (hit: SearchHit, query: string) => void
  onClose: () => void
}

type Entry = { kind: 'item'; item: PaletteItem } | { kind: 'hit'; row: HitRow }

const PAGE = 5

function Icon({ icon, agents }: { icon: PaletteIcon; agents: AgentSummary[] }) {
  if (icon.kind === 'agent') {
    const a = findAgent(agents, icon.name)
    return (
      <BotIcon
        icon={a?.icon ?? null}
        color={a && a.error === null ? a.color : null}
        builtIn={a?.builtIn ?? false}
        working={false}
        size={22}
      />
    )
  }
  if (icon.kind === 'room') return <MemberStack agents={memberAgents(icon.members, agents)} size={22} working={[]} max={2} />
  if (icon.name.startsWith('rail:')) return <RailGlyph name={icon.name.slice(5) as RailGlyphName} className="palette-glyph" />
  return <MenuIcon name={icon.name as MenuIconName} className="palette-glyph" />
}

const optionId = (i: number): string => `palette-option-${i}`

/**
 * Ctrl+K: one box to go anywhere, a chat, an agent, a routine, a workflow, a view or a Settings section, or to create
 * one, and the message search's first hits under them. The keyboard stays in the box: arrows move, Enter opens, Esc
 * closes and gives focus back.
 */
export function CommandPalette({ sources, connected, onPick, onPickMessage, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  // Where focus goes back to when the palette is closed without going anywhere.
  const before = useRef<Element | null>(document.activeElement)
  const items = useMemo(() => paletteItems(sources), [sources])
  const sections = useMemo(() => paletteSections(items, query), [items, query])
  const search = useMessageSearch(messageQuery(query), connected)
  const hits = useMemo(
    () => hitRows(search.hits, sources.chats, Date.now(), sources.agents).slice(0, PALETTE_HITS),
    [search.hits, sources.chats, sources.agents]
  )
  const entries = useMemo<Entry[]>(
    () => [
      ...sections.flatMap((s) => s.items.map((item): Entry => ({ kind: 'item', item }))),
      ...hits.map((row): Entry => ({ kind: 'hit', row }))
    ],
    [sections, hits]
  )
  const current = entries.length === 0 ? -1 : Math.min(Math.max(active, 0), entries.length - 1)

  // A new query starts at its best match.
  useEffect(() => setActive(0), [query])
  useLayoutEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, entries])

  const close = (): void => {
    if (before.current instanceof HTMLElement) before.current.focus()
    onClose()
  }
  const pick = (i: number): void => {
    const e = entries[i]
    if (!e) return
    if (e.kind === 'item') onPick(e.item.target)
    else onPickMessage(e.row.hit, query.trim())
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    const n = entries.length
    const step = (delta: number): void => {
      e.preventDefault()
      setActive(moveActive(current, delta, n))
    }
    if (e.key === 'ArrowDown') step(1)
    else if (e.key === 'ArrowUp') step(-1)
    else if (e.key === 'PageDown') {
      e.preventDefault()
      if (n > 0) setActive(Math.min(n - 1, Math.max(current, 0) + PAGE))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      if (n > 0) setActive(Math.max(0, current - PAGE))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(current)
    } else if (e.key === 'Escape') {
      // Before Settings' own Esc, which would leave them.
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab')
      e.preventDefault() // the box is the palette's only stop
    else if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      // Ctrl+K again closes, giving focus back as Esc does; App's own listener must not toggle it open again.
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  let index = 0
  const option = (key: string, i: number, body: ReactNode, extra: Record<string, string> = {}) => (
    <div
      key={key}
      id={optionId(i)}
      role="option"
      aria-selected={i === current}
      data-active={i === current}
      className={i === current ? 'palette-option on' : 'palette-option'}
      onMouseMove={() => i !== current && setActive(i)}
      onMouseDown={(e) => e.preventDefault()} // the box keeps focus
      onClick={() => pick(i)}
      {...extra}
    >
      {body}
    </div>
  )
  const messageStatus = messageQuery(query) === '' ? '' : statusText(search.result, search.loading, search.failed)
  const nothing = entries.length === 0 && query.trim() !== '' && !search.loading

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Go to" data-testid="palette">
        <div className="palette-search">
          <svg className="palette-search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            className="palette-input"
            data-testid="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-label="Go to a chat, agent, routine, workflow or setting, or search messages"
            placeholder="Go to a chat, agent, routine, workflow or setting…"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        <div id="palette-list" className="palette-list" role="listbox" aria-label="Places" ref={listRef}>
          {sections.map((s) => (
            <div key={s.group} role="group" aria-label={s.title} className="palette-group" data-testid="palette-group" data-group={s.group}>
              <div className="palette-heading" aria-hidden="true">
                {s.title}
              </div>
              {s.items.map((item) => {
                const i = index++
                return option(
                  item.key,
                  i,
                  <>
                    <span className="palette-icon">
                      <Icon icon={item.icon} agents={sources.agents as AgentSummary[]} />
                    </span>
                    <span className="palette-text">
                      <span className="palette-label">{item.label}</span>
                      {item.detail && <span className="palette-detail">{item.detail}</span>}
                    </span>
                    {item.tag && <span className="palette-tag">{item.tag}</span>}
                  </>,
                  { 'data-testid': 'palette-item', 'data-key': item.key }
                )
              })}
            </div>
          ))}
          {messageQuery(query) !== '' && (
            <div role="group" aria-label="Messages" className="palette-group" data-testid="palette-group" data-group="messages">
              <div className="palette-heading palette-heading-row" aria-hidden="true">
                <span>Messages</span>
                <span className="palette-status" data-testid="palette-messages-status">
                  {messageStatus}
                </span>
              </div>
              {hits.map((row) => {
                const i = index++
                return option(
                  hitKey(row.hit),
                  i,
                  <>
                    <span className="palette-icon">
                      {row.agent ? (
                        <Icon icon={{ kind: 'agent', name: row.agent }} agents={sources.agents as AgentSummary[]} />
                      ) : (
                        <MenuIcon name="user" className="palette-glyph" />
                      )}
                    </span>
                    <span className="palette-text">
                      <span className="palette-label">
                        {row.title}
                        <span className="palette-when"> · {row.when}</span>
                      </span>
                      <span className="palette-detail palette-snippet">
                        {row.who}:{' '}
                        {segments(row.hit.snippet, row.hit.marks).map((x, k) =>
                          x.mark ? <mark key={k}>{x.text}</mark> : <span key={k}>{x.text}</span>
                        )}
                      </span>
                    </span>
                    {row.archived && <span className="palette-tag">Archived</span>}
                  </>,
                  { 'data-testid': 'palette-hit', 'data-chat-id': row.hit.chatId, 'data-hit-item': row.hit.itemId }
                )
              })}
            </div>
          )}
          {nothing && (
            <p className="palette-empty" data-testid="palette-empty">
              Nothing matches “{query.trim()}”.
            </p>
          )}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
