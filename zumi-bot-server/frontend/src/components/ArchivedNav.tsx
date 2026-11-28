import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { archivedLabel, archivedRows, type ArchivedRow } from '../state/archive'
import { NO_PICK, keepArchived, pickAll, pickRow, pickedShown } from '../state/archiveSelection'
import { popoutClick } from '../state/popout'
import { chatTitle } from '../state/sidebarTree'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'
import { BotIcon } from './BotIcon'
import { ConfirmDialog } from './ConfirmDialog'
import { FolderIcon } from './FolderIcon'
import { MemberStack } from './MemberStack'
import { MenuIcon } from './MenuIcon'
import { Glyph } from './Sidebar'

interface Props {
  /** On a small screen the list is a drawer; this is whether it is out. */
  open: boolean
  onClose: () => void
  /** Every chat: the list picks the archived ones. */
  chats: ChatMeta[]
  agents: AgentSummary[]
  selectedChatId: string | null
  /** A chat outside the archive waits on an approval or holds an unread reply: a mark on Back to chats. */
  pending: boolean
  unread: boolean
  onBack: () => void
  onOpenChat: (chatId: string) => void
  /** Ctrl/Cmd+click or a middle click: the chat in a window of its own. */
  onPopoutChat: (chatId: string) => void
  onUnarchive: (chatIds: string[]) => void
  onDeleteChats: (chatIds: string[]) => void
  onExportChat: (chat: ChatMeta) => void
}

// From a right-click: at the pointer. From the ⋯ button: right-aligned under it, as the sidebar's menus.
type Menu = { chat: ChatMeta; x: number; y: number; fromButton: boolean }

/** Archived chats and rooms in the sidebar's place, as Settings' list is: Back to chats returns to the sidebar. */
export function ArchivedNav(p: Props) {
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<Menu | null>(null)
  // Several chats from the ticked boxes, or one from its row menu.
  const [confirmDelete, setConfirmDelete] = useState<ChatMeta[] | null>(null)
  const [pick, setPick] = useState(NO_PICK)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, closeMenu)
  useFitInViewport(menuRef, menu)
  // The drawer coming out takes focus, as the sidebar's does.
  useEffect(() => {
    if (p.open) closeRef.current?.focus()
  }, [p.open])

  const rows = archivedRows(p.chats, p.agents, query)
  const all = query.trim() === '' ? rows : archivedRows(p.chats, p.agents, '')
  const total = all.length
  const now = Date.now()
  const shownIds = rows.map((r) => r.chat.id)
  const picked = pickedShown(pick, shownIds)
  const allIds = all.map((r) => r.chat.id).join('\n')
  // A ticked chat that left the archive (deleted, or a send brought it back) is forgotten, so it never returns ticked.
  useEffect(() => {
    const archived = allIds === '' ? [] : allIds.split('\n')
    setPick((cur) => keepArchived(cur, archived))
  }, [allIds])

  const chatsOf = (ids: readonly string[]): ChatMeta[] => all.flatMap((r) => (ids.includes(r.chat.id) ? [r.chat] : []))
  const unarchive = (ids: string[]): void => {
    setPick(NO_PICK)
    p.onUnarchive(ids)
  }
  // Esc clears the ticks first; a menu or the delete dialog takes its own Esc.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || picked.length === 0 || e.defaultPrevented) return
    if (e.target instanceof Element && e.target.closest('.menu, [role="dialog"]')) return
    e.preventDefault()
    setPick(NO_PICK)
  }

  const openMenu = (e: MouseEvent, chat: ChatMeta): void => {
    e.preventDefault()
    setMenu({ chat, x: e.clientX, y: e.clientY, fromButton: false })
  }

  const row = ({ chat, agent, members, folder }: ArchivedRow) => (
    <div key={chat.id} className={picked.includes(chat.id) ? 'archived-line picked' : 'archived-line'}>
      {/* Over the icon: ticking here never opens the chat, so a chat can be opened, read, and the rest still ticked. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={picked.includes(chat.id)}
        className="archived-check"
        data-testid="archived-check"
        aria-label={`Select ${chatTitle(chat, p.agents)}`}
        data-tip="Select (Shift-click for a range)"
        onMouseDown={(e) => {
          if (e.shiftKey) e.preventDefault() // no text selection between the two rows
        }}
        onClick={(e) => setPick((cur) => pickRow(cur, shownIds, chat.id, e.shiftKey))}
      >
        <span className="archived-box" aria-hidden="true">
          {picked.includes(chat.id) && (
            <svg viewBox="0 0 16 16">
              <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      </button>
      <button
        type="button"
        className={chat.id === p.selectedChatId ? 'row archived-row on' : 'row archived-row'}
        data-testid="archived-row"
        data-chat-id={chat.id}
        data-tip={chat.cwd}
        onClick={(e) => (popoutClick(e) ? p.onPopoutChat(chat.id) : p.onOpenChat(chat.id))}
        // A middle click fires no click, and its mousedown would start autoscroll (or paste the X selection).
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault()
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return
          e.preventDefault()
          p.onPopoutChat(chat.id)
        }}
        onContextMenu={(e) => openMenu(e, chat)}
      >
        {/* One width for an agent's icon and a room's stack, so the titles line up. */}
        <span className="archived-icon">
          {agent ? (
            <BotIcon icon={agent.icon} color={agent.color} builtIn={agent.builtIn} working={false} size={28} />
          ) : (
            <MemberStack agents={members} size={28} working={[]} max={2} />
          )}
        </span>
        <span className="agent-text">
          <span className="group-title">{chatTitle(chat, p.agents)}</span>
          <span className="agent-desc">
            {agent ? `${displayName(agent.name)} · ` : ''}
            <FolderIcon />
            {folder}
          </span>
          <span className="agent-desc archived-when">{archivedLabel(chat.archivedAt ?? 0, now)}</span>
        </span>
      </button>
      <div className="row-actions">
        <button
          type="button"
          className={menu?.chat.id === chat.id ? 'row-action more shown' : 'row-action more'}
          data-testid="archived-menu-button"
          aria-label={`${chatTitle(chat, p.agents)} options`}
          aria-haspopup="menu"
          data-tip="Options"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu(menu?.chat.id === chat.id ? null : { chat, x: r.right, y: r.bottom + 4, fromButton: true })
          }}
        >
          <Glyph name="more" />
        </button>
      </div>
    </div>
  )

  return (
    <aside
      className={p.open ? 'sidebar archived-nav open' : 'sidebar archived-nav'}
      id="sidebar"
      data-testid="archived-nav"
      onKeyDown={onKey}
    >
      <div className="sidebar-head">
        <button type="button" className="settings-back" data-testid="archived-back" onClick={p.onBack}>
          <MenuIcon name="arrowLeft" />
          Back to chats
          {p.pending && <span className="approval-badge compact" role="status" aria-label="Approval needed" data-tip="Approval needed" />}
          {!p.pending && p.unread && <span className="unread-dot" role="status" aria-label="Unread messages" data-tip="Unread messages" />}
        </button>
        <span className="grow" />
        <button
          ref={closeRef}
          type="button"
          className="head-btn nav-close"
          data-testid="nav-close"
          aria-label="Close sidebar"
          data-tip="Close sidebar"
          onClick={p.onClose}
        >
          <Glyph name="close" />
        </button>
      </div>
      <div className="archived-head">
        <h2 className="settings-title">Archived</h2>
        <span className="count-badge" aria-label={`${total} archived`}>
          {total}
        </span>
      </div>
      {total > 0 && (
        <div className="archived-search">
          <div className="search">
            <Glyph name="search" />
            <input
              className="search-input"
              type="text"
              value={query}
              placeholder="Search archived"
              aria-label="Search archived chats"
              data-testid="archived-search"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape' || query === '') return
                e.preventDefault() // the search goes first; the next Esc clears the ticks
                setQuery('')
              }}
            />
          </div>
        </div>
      )}
      {picked.length > 0 && (
        // Two lines: the sidebar's width can't hold the count, Select all and both actions on one.
        <div className="archived-bulk" role="toolbar" aria-label="Selected chats" data-testid="archived-bulk">
          <div className="archived-bulk-line">
            <span className="archived-bulk-count" data-testid="archived-bulk-count">
              {picked.length} selected
            </span>
            {picked.length < rows.length && (
              <button
                type="button"
                className="archived-bulk-all"
                data-testid="archived-select-all"
                onClick={() => setPick((cur) => pickAll(cur, shownIds))}
              >
                Select all {rows.length}
              </button>
            )}
            <span className="grow" />
            <button
              type="button"
              className="archived-bulk-clear"
              data-testid="archived-bulk-clear"
              aria-label="Clear selection"
              data-tip="Clear selection (Esc)"
              onClick={() => setPick(NO_PICK)}
            >
              <Glyph name="close" />
            </button>
          </div>
          <div className="archived-bulk-line">
            <button type="button" className="archived-bulk-btn" data-testid="archived-bulk-unarchive" onClick={() => unarchive(picked)}>
              <MenuIcon name="unarchive" />
              Unarchive
            </button>
            <button
              type="button"
              className="archived-bulk-btn danger"
              data-testid="archived-bulk-delete"
              onClick={() => setConfirmDelete(chatsOf(picked))}
            >
              <MenuIcon name="trash" />
              Delete
            </button>
          </div>
        </div>
      )}
      <nav className={picked.length > 0 ? 'agent-list archived-list picking' : 'agent-list archived-list'} aria-label="Archived chats">
        {rows.map(row)}
        {total === 0 && (
          <p className="no-matches" data-testid="archived-empty">
            Nothing archived. Right-click a chat or room to archive it.
          </p>
        )}
        {total > 0 && rows.length === 0 && <p className="no-matches">No matches</p>}
      </nav>
      {menu && (
        <div
          ref={menuRef}
          className="menu"
          role="menu"
          data-testid="archived-menu"
          style={menu.fromButton ? { left: menu.x, top: menu.y, transform: 'translateX(-100%)' } : { left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            data-testid="archived-menu-unarchive"
            onClick={() => {
              const chat = menu.chat
              setMenu(null)
              p.onUnarchive([chat.id])
            }}
          >
            <MenuIcon name="unarchive" />
            Unarchive
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="archived-menu-popout"
            onClick={() => {
              const chat = menu.chat
              setMenu(null)
              p.onPopoutChat(chat.id)
            }}
          >
            <MenuIcon name="popout" />
            Open in new window
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="archived-menu-export"
            onClick={() => {
              const chat = menu.chat
              setMenu(null)
              p.onExportChat(chat)
            }}
          >
            <MenuIcon name="download" />
            Export…
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            data-testid="archived-menu-delete"
            onClick={() => {
              setConfirmDelete([menu.chat])
              setMenu(null)
            }}
          >
            <MenuIcon name="trash" />
            Delete
          </button>
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={confirmDelete.length === 1 ? 'Delete chat?' : `Delete ${confirmDelete.length} chats?`}
          message={
            confirmDelete.length === 1
              ? `"${chatTitle(confirmDelete[0], p.agents)}" will be removed from ZumiBot. Claude's own session file is left alone.`
              : `They will be removed from ZumiBot. Claude's own session files are left alone.`
          }
          buttons={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Delete', value: 'delete', danger: true }
          ]}
          onResolve={(value) => {
            const ids = confirmDelete.map((c) => c.id)
            setConfirmDelete(null)
            if (value !== 'delete') return
            setPick((cur) => ({ ids: cur.ids.filter((id) => !ids.includes(id)), anchor: null }))
            p.onDeleteChats(ids)
          }}
        />
      )}
    </aside>
  )
}
