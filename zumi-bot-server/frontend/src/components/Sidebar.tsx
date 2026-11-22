import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type TouchEvent
} from 'react'
import { ARCHIVE_RUNNING } from '@zumibot/shared/archive'
import { displayName } from '@zumibot/shared/frontmatter'
import { agentKey, emptyLayout, groupKey, SECTION_NAME_MAX, type SidebarLayout, type SidebarSection } from '@zumibot/shared/sidebarLayout'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import { SEARCH_QUERY_MAX, parseQuery, type SearchHit } from '@zumibot/shared/search'
import { isUnread } from '@zumibot/shared/unread'
import { agentHasPending } from '../state/approvals'
import { engineTag } from '../state/agentEngine'
import { agentIsWorking } from '../state/bot'
import { FOLDER_SHOWN, FOLDER_STEP, folderKey, folderRows } from '../state/folderChats'
import { workingMembers } from '../state/groupChat'
import { agentHasUnread } from '../state/unread'
import {
  addSection,
  itemKeys,
  moveItem,
  moveSection,
  removeSection,
  renameSection,
  sectionOf,
  setSectionCollapsed,
  sidebarView,
  unassignedOrder,
  type Entry,
  type Spot
} from '../state/sidebarLayout'
import { loadSet, saveSet } from '../state/storedSet'
import { isScratchRoot } from '@zumibot/shared/scratch'
import { chatTitle, flatChats, folderName, type AgentNode, type GroupRow, type NewChatFolder } from '../state/sidebarTree'
import { coarsePointer } from '../media'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'
import { BotIcon } from './BotIcon'
import { ConfirmDialog } from './ConfirmDialog'
import { FolderIcon } from './FolderIcon'
import { MemberStack } from './MemberStack'
import { MenuIcon } from './MenuIcon'
import { MessageHits } from './MessageHits'
import { api } from '../api'
import { CHANNEL_LABELS, CHANNEL_PLATFORMS, type ChannelPlatform } from '@zumibot/shared/channels'
import { errorMessage } from '../errors'
import { hitKey } from '../state/messageSearch'

const EXPANDED_KEY = 'zumibot.expandedAgents'
// A dragged agent or group carries its layout key under this type: it can move between sections.
const ITEM_TYPE = 'application/x-zumibot-item'
// A dragged section header carries the section id.
const SECTION_TYPE = 'application/x-zumibot-section'
// Holding a chat row this long on a touch screen opens its menu (iOS has no right-click).
const LONG_PRESS_MS = 500
// A finger that moves further than this is scrolling, not holding.
const LONG_PRESS_SLOP_PX = 10
const NEW_SECTION_NAME = 'New section'
const MARGIN = 8

const carries = (e: DragEvent, type: string): boolean => e.dataTransfer.types.includes(type)
const newSectionId = (): string =>
  typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/**
 * Where a dragged item lands: before the row under the pointer, or after it past the middle of its own line (an open
 * agent's chats count as after it). On a section header: into that section, first when open, last when closed. On a
 * list's empty space: last in it.
 */
function itemSpot(e: DragEvent, lists: ReadonlyMap<string, readonly string[]>, collapsed: ReadonlySet<string>): Spot | null {
  const target = e.target as Element
  const head = target.closest<HTMLElement>('[data-section-head]')
  if (head) {
    const section = head.dataset.sectionHead ?? ''
    return { section, before: collapsed.has(section) ? null : (lists.get(section)?.[0] ?? null) }
  }
  const box = target.closest<HTMLElement>('[data-section-id]')
  if (!box) return null
  const section = box.dataset.sectionId || null
  const keys = lists.get(section ?? '') ?? []
  const item = target.closest<HTMLElement>('[data-item-key]')
  const i = item ? keys.indexOf(item.dataset.itemKey ?? '') : -1
  if (!item || i === -1) return { section, before: null }
  const r = (item.querySelector(':scope > .agent-line') ?? item).getBoundingClientRect()
  return { section, before: e.clientY < r.top + r.height / 2 ? keys[i] : (keys[i + 1] ?? null) }
}

/** The section a dragged section lands before: judged by the header of the section under the pointer; null for last. */
function sectionSpot(e: DragEvent, ids: readonly string[]): string | null | undefined {
  const target = e.target as Element
  const block = target.closest<HTMLElement>('[data-section-block]')
  if (!block) return target.closest('[data-section-id=""]') ? null : undefined
  const i = ids.indexOf(block.dataset.sectionBlock ?? '')
  const r = (block.querySelector('[data-section-head]') ?? block).getBoundingClientRect()
  return e.clientY < r.top + r.height / 2 ? ids[i] : (ids[i + 1] ?? null)
}

/** What a drag in progress carries: an agent or group (its layout key), or a section. */
type Drag = { item: string; section: null } | { item: null; section: string }

type Menu =
  | { kind: 'chat'; chat: ChatMeta; x: number; y: number }
  // Anchored under the agent's ⋯ button, right edges aligned.
  | { kind: 'agent'; agent: AgentSummary; right: number; top: number }
  // The header's + menu, anchored the same way.
  | { kind: 'new'; right: number; top: number }
  | { kind: 'section'; section: SidebarSection; right: number; top: number }

export function Glyph({ name }: { name: 'plus' | 'search' | 'close' | 'more' | 'chevron' }) {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'plus' && <path d="M8 3v10M3 8h10" />}
      {name === 'search' && (
        <>
          <circle cx="7" cy="7" r="4.25" />
          <path d="M10.2 10.2L13.5 13.5" />
        </>
      )}
      {name === 'close' && <path d="M4 4l8 8M12 4l-8 8" />}
      {name === 'more' && (
        <g fill="currentColor" stroke="none">
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </g>
      )}
      {name === 'chevron' && <path d="M6 4l4 4-4 4" />}
    </svg>
  )
}

interface Props {
  /** On a small screen the sidebar is a drawer: whether it is out. */
  open: boolean
  /** Closes the drawer. */
  onClose: () => void
  agents: AgentSummary[]
  chats: ChatMeta[]
  pendingByChat: Record<string, number>
  selectedChatId: string | null
  selectedAgentPath: string | null
  /** The user's sections and order; null until it loads from the server. */
  layout: SidebarLayout | null
  onLayoutChange: (next: SidebarLayout) => void
  onNewAgent: () => void
  /** Opens the new-chat screen in group mode. */
  onNewGroup: () => void
  onOpenAgent: (filePath: string) => void
  /** A click on a valid agent row; App picks what it opens. */
  onPickAgent: (agentName: string) => void
  onNewChat: (agentName: string, folder: NewChatFolder) => void
  onDeleteAgent: (filePath: string) => void
  onOpenChat: (chatId: string) => void
  onRenameChat: (chatId: string, title: string) => void
  /** Opens the Clone room dialog for a group room. */
  onCloneRoom: (chat: ChatMeta) => void
  onDeleteChat: (chatId: string) => void
  /** Moves a chat or room to Archived; offered only while it is not running or waiting on an approval. */
  onArchiveChat: (chatId: string) => void
  onExportChat: (chat: ChatMeta) => void
  /** Every chat, archived ones too: the search's message hits name them. */
  allChats: ChatMeta[]
  /** The socket is up: the message search asks the server. */
  connected: boolean
  /** A message hit: opens its chat at that message, which the query's words light. */
  onOpenMessage: (hit: SearchHit, query: string) => void
}

export function Sidebar(p: Props) {
  const [expanded, setExpanded] = useState(() => loadSet(EXPANDED_KEY))
  // How many chats each folder lists after Show more (by folderKey); a folder not in it lists FOLDER_SHOWN.
  const [shown, setShown] = useState<Record<string, number>>({})
  const [menu, setMenu] = useState<Menu | null>(null)
  // The Move to list beside the agent or chat menu.
  const [moveOpen, setMoveOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingSection, setRenamingSection] = useState<string | null>(null)
  // Continue in Telegram's refusal (not paired, the agent not on for Telegram), shown until dismissed.
  const [channelNote, setChannelNote] = useState<{ platform: ChannelPlatform; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ChatMeta | null>(null)
  const [confirmDeleteAgent, setConfirmDeleteAgent] = useState<AgentSummary | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [openedHit, setOpenedHit] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  // Where a dragged item would land in the list; undefined while it is not over a spot.
  const [itemDrop, setItemDrop] = useState<Spot | undefined>(undefined)
  // The section a dragged section would land before (null for last); undefined while not over a spot.
  const [sectionDrop, setSectionDrop] = useState<string | null | undefined>(undefined)
  const dragTimer = useRef<number | undefined>(undefined)
  // The touch on a chat row that may become a long press; fired once its menu opened, so the tap that ends it opens nothing.
  const press = useRef<{ x: number; y: number; timer: number; fired: boolean } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  // Rows drag with a mouse; on a touch screen holding a group (or an agent's ⋯ button) opens the menu, where Move to is.
  const [canDrag] = useState(() => !coarsePointer())

  const closeMenu = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, closeMenu)
  useFitInViewport(menuRef, menu)

  useEffect(() => setMoveOpen(false), [menu])

  // The Move to list opens beside the menu, on its left when the right has no room, and is nudged inside the window.
  useLayoutEffect(() => {
    const el = subRef.current
    if (!el) return
    el.style.left = ''
    el.style.right = ''
    el.style.translate = ''
    if (el.getBoundingClientRect().right > window.innerWidth - MARGIN) {
      el.style.left = 'auto'
      el.style.right = 'calc(100% + 6px)'
    }
    const r = el.getBoundingClientRect()
    const dx = Math.max(MARGIN - r.left, Math.min(0, window.innerWidth - MARGIN - r.right))
    const dy = Math.max(MARGIN - r.top, Math.min(0, window.innerHeight - MARGIN - r.bottom))
    if (dx !== 0 || dy !== 0) el.style.translate = `${dx}px ${dy}px`
  }, [moveOpen, menu])

  // The drawer coming out takes focus, so the keyboard and screen readers land in it.
  useEffect(() => {
    if (p.open) closeRef.current?.focus()
  }, [p.open])

  const layout = p.layout ?? emptyLayout()
  const keys = itemKeys(p.agents, p.chats)
  const selectedChat = p.chats.find((chat) => chat.id === p.selectedChatId)
  const selectedChatAgent = selectedChat && !isGroup(selectedChat) ? selectedChat.agentName : null

  // Drops end the drag themselves: a row that moves on drop is a new element, so its dragend never reaches React.
  const endDrag = (): void => {
    window.clearTimeout(dragTimer.current)
    setDrag(null)
    setItemDrop(undefined)
    setSectionDrop(undefined)
  }

  const startDrag = (e: DragEvent, d: Drag): void => {
    if (d.item !== null) e.dataTransfer.setData(ITEM_TYPE, d.item)
    else e.dataTransfer.setData(SECTION_TYPE, d.section)
    e.dataTransfer.effectAllowed = 'move'
    // Chromium cancels a drag whose source moves during dragstart, and the drop areas a drag opens can move it.
    dragTimer.current = window.setTimeout(() => setDrag(d))
  }

  const dragProps = (d: Drag, enabled = true) => ({
    draggable: canDrag && enabled,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation()
      startDrag(e, d)
    },
    onDragEnd: endDrag
  })

  const setOpen = (name: string, open: boolean): void => {
    if (expanded.has(name) === open) return
    const next = new Set(expanded)
    if (open) next.add(name)
    else next.delete(name)
    saveSet(EXPANDED_KEY, next)
    setExpanded(next)
  }

  const commitRename = (chat: ChatMeta, title: string): void => {
    setRenaming(null)
    if (title.trim() !== chat.title) p.onRenameChat(chat.id, title)
  }

  const commitSectionName = (section: SidebarSection, name: string): void => {
    setRenamingSection(null)
    const next = name.trim().slice(0, SECTION_NAME_MAX)
    if (next !== '' && next !== section.name) p.onLayoutChange(renameSection(layout, section.id, next))
  }

  const closeSearch = (): void => {
    setSearching(false)
    setQuery('')
    setOpenedHit(null)
  }

  /** Moves an item from a menu: last in a section, or first among the unassigned ones (right under the sections). */
  const moveTo = (key: string, section: string | null): void => {
    setMenu(null)
    if (section !== null) return p.onLayoutChange(moveItem(layout, keys, key, { section, before: null }))
    if (sectionOf(layout, key) === null) return
    p.onLayoutChange(moveItem(layout, keys, key, { section: null, before: unassignedOrder(layout, keys).find((k) => k !== key) ?? null }))
  }

  /** A new section, named at once in its header; `key` moves into it. */
  const newSection = (key: string | null): void => {
    setMenu(null)
    const id = newSectionId()
    const added = addSection(layout, id, NEW_SECTION_NAME)
    p.onLayoutChange(key === null ? added : moveItem(added, keys, key, { section: id, before: null }))
    setRenamingSection(id)
  }

  const hasPending = (chatId: string): boolean => (p.pendingByChat[chatId] ?? 0) > 0
  // A search shows every match, so the sections stay open while it runs, and nothing moves.
  const searchActive = query.trim() !== ''
  const view = sidebarView(layout, p.agents, p.chats, query)
  const sections = searchActive ? view.sections.filter((s) => s.entries.length > 0) : view.sections
  const lists = new Map<string, string[]>([
    ['', view.unassigned.map((e) => e.key)],
    ...view.sections.map((s) => [s.section.id, s.entries.map((e) => e.key)] as [string, string[]])
  ])
  const collapsedIds = new Set(layout.sections.filter((s) => s.collapsed).map((s) => s.id))
  const entryPending = (e: Entry): boolean =>
    e.kind === 'group' ? hasPending(e.row.chat.id) : agentHasPending(p.chats, e.node.agent.name, p.pendingByChat)
  const entryUnread = (e: Entry): boolean => (e.kind === 'group' ? isUnread(e.row.chat) : agentHasUnread(p.chats, e.node.agent.name))

  const renameField = (chat: ChatMeta) => (
    <input
      key={chat.id}
      className="field rename"
      defaultValue={chat.title}
      aria-label="Chat title"
      autoFocus
      onFocus={(e) => e.target.select()}
      onBlur={() => setRenaming(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitRename(chat, e.currentTarget.value)
        else if (e.key === 'Escape') setRenaming(null)
      }}
    />
  )

  const chatStatus = (chat: ChatMeta) =>
    hasPending(chat.id) ? (
      <span className="approval-badge" role="status" data-testid="approval-badge">
        Approval needed
      </span>
    ) : // Approval badge, else spinner, else unread dot: one slot, so a row never shows two marks.
    chat.inFlight ? (
      <span className="spinner" role="status" aria-label="Reply running" />
    ) : (
      isUnread(chat) && <span className="unread-dot" role="status" aria-label="Unread" data-testid="unread-dot" />
    )

  const endPress = (): void => window.clearTimeout(press.current?.timer)

  // What every chat and group row shares: click opens, right-click (or a long press) gives the chat menu.
  const chatHandlers = (chat: ChatMeta) => ({
    'data-chat-id': chat.id,
    onClick: () => {
      if (press.current?.fired) {
        press.current = null
        return
      }
      p.onOpenChat(chat.id)
    },
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault()
      setMenu({ kind: 'chat', chat, x: e.clientX, y: e.clientY })
    },
    onTouchStart: (e: TouchEvent) => {
      endPress()
      const { clientX: x, clientY: y } = e.touches[0]
      const timer = window.setTimeout(() => {
        if (press.current) press.current.fired = true
        setMenu({ kind: 'chat', chat, x, y })
      }, LONG_PRESS_MS)
      press.current = { x, y, timer, fired: false }
    },
    onTouchMove: (e: TouchEvent) => {
      const t = e.touches[0]
      if (press.current && Math.hypot(t.clientX - press.current.x, t.clientY - press.current.y) > LONG_PRESS_SLOP_PX) endPress()
    },
    onTouchEnd: (e: TouchEvent) => {
      endPress()
      // No click, and no mousedown to close the menu just opened.
      if (press.current?.fired) e.preventDefault()
    },
    onTouchCancel: endPress
  })

  const itemClass = (key: string, section: string | null): string =>
    (drag?.item === key ? ' dragging' : '') + (itemDrop && itemDrop.section === section && itemDrop.before === key ? ' drop-before' : '')

  // A group chat: its members' icons, the title and its folder.
  const groupRow = ({ chat, members, folder }: GroupRow, section: string | null) => {
    const key = groupKey(chat.id)
    return renaming === chat.id ? (
      renameField(chat)
    ) : (
      <button
        key={chat.id}
        type="button"
        className={
          (chat.id === p.selectedChatId ? 'row group-row on' : 'row group-row') +
          (isUnread(chat) ? ' unread' : '') +
          itemClass(key, section)
        }
        data-testid="group-row"
        data-item-key={key}
        data-tip={isScratchRoot(folder) ? undefined : folder}
        {...chatHandlers(chat)}
        {...dragProps({ item: key, section: null }, !searchActive)}
      >
        <MemberStack agents={members} size={28} working={workingMembers(chat)} max={2} />
        <span className="agent-text">
          <span className="group-title">{chatTitle(chat, p.agents)}</span>
          <span className="agent-desc">
            <FolderIcon />
            {folderName(folder)}
          </span>
        </span>
        {chatStatus(chat)}
      </button>
    )
  }

  const chatRow = (chat: ChatMeta) =>
    renaming === chat.id ? (
      renameField(chat)
    ) : (
      <button
        key={chat.id}
        type="button"
        className={(chat.id === p.selectedChatId ? 'row chat-item on' : 'row chat-item') + (isUnread(chat) ? ' unread' : '')}
        data-testid="chat-row"
        {...chatHandlers(chat)}
      >
        {chat.channel && (
          <svg
            className="voice-mark"
            viewBox="0 0 16 16"
            role="img"
            aria-label={`Linked to ${CHANNEL_LABELS[chat.channel.platform]}`}
            data-testid="channel-mark"
            data-platform={chat.channel.platform}
            data-tip={`Linked to ${CHANNEL_LABELS[chat.channel.platform]}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          >
            <path d="M14.25 2.25 1.75 7.1l4.1 1.5 1.6 4.9 2.3-2.75 3.05 2.25z" />
            <path d="m5.85 8.6 8.4-6.35" />
          </svg>
        )}
        {chat.voice && (
          <svg
            className="voice-mark"
            viewBox="0 0 16 16"
            role="img"
            aria-label="Voice chat"
            data-testid="voice-mark"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
            <path d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2" />
          </svg>
        )}
        {chat.worktree && (
          <svg
            className="branch-mark"
            viewBox="0 0 24 24"
            role="img"
            aria-label={`Branch ${chat.worktree.branch}`}
            data-testid="chat-row-branch"
            data-tip={chat.worktree.branch}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3v12" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        )}
        <span className="row-text">{chatTitle(chat, p.agents)}</span>
        {chatStatus(chat)}
      </button>
    )

  // A chat the user must not lose behind Show more: the open one, one being renamed, running, waiting or unread.
  const inSight = (chat: ChatMeta): boolean =>
    chat.id === p.selectedChatId || chat.id === renaming || chat.inFlight || hasPending(chat.id) || isUnread(chat)

  // A folder's chats, the newest few first, then Show more (Show less once all are listed); a search lists every match.
  const folderChats = (key: string, chats: ChatMeta[], label: string) => {
    const { rows, hidden, less } = folderRows(chats, searchActive ? 'all' : (shown[key] ?? FOLDER_SHOWN), inSight)
    return (
      <div className="folder-chats">
        {rows.map(chatRow)}
        {(hidden > 0 || less) && (
          <button
            type="button"
            className="row folder-more"
            data-testid="folder-more"
            aria-label={hidden > 0 ? `Show more chats in ${label}` : `Show fewer chats in ${label}`}
            data-tip={hidden > 0 ? `${hidden} more` : undefined}
            onClick={() =>
              setShown(({ [key]: was, ...rest }) => (hidden > 0 ? { ...rest, [key]: (was ?? FOLDER_SHOWN) + FOLDER_STEP } : rest))
            }
          >
            {hidden > 0 ? 'Show more' : 'Show less'}
          </button>
        )}
      </div>
    )
  }

  const leaving = (e: DragEvent<HTMLElement>): boolean => {
    // dragleave also fires when crossing into a child, so only leaving the box counts.
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom
  }
  // The sections and the unassigned list take a dragged agent, group or section header.
  const dragOverList = (e: DragEvent): void => {
    if (carries(e, SECTION_TYPE)) {
      const spot = sectionSpot(
        e,
        layout.sections.map((s) => s.id)
      )
      if (spot === undefined) return setSectionDrop(undefined)
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (spot !== sectionDrop) setSectionDrop(spot)
      return
    }
    if (!carries(e, ITEM_TYPE)) return
    const spot = itemSpot(e, lists, collapsedIds)
    if (!spot) return setItemDrop(undefined)
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (spot.section !== itemDrop?.section || spot.before !== itemDrop.before) setItemDrop(spot)
  }
  const listDropProps = {
    onDragEnter: dragOverList,
    onDragOver: dragOverList,
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!leaving(e)) return
      setItemDrop(undefined)
      setSectionDrop(undefined)
    },
    onDrop: (e: DragEvent) => {
      if (carries(e, SECTION_TYPE)) {
        const spot = sectionSpot(
          e,
          layout.sections.map((s) => s.id)
        )
        if (spot === undefined) return
        e.preventDefault()
        p.onLayoutChange(moveSection(layout, e.dataTransfer.getData(SECTION_TYPE), spot))
        return endDrag()
      }
      if (!carries(e, ITEM_TYPE)) return
      const spot = itemSpot(e, lists, collapsedIds)
      if (!spot) return
      e.preventDefault()
      const next = moveItem(layout, keys, e.dataTransfer.getData(ITEM_TYPE), spot)
      if (next !== layout) p.onLayoutChange(next)
      endDrag()
    }
  }

  const agentBlock = ({ agent, folders, forceOpen }: AgentNode, section: string | null) => {
    const valid = agent.error === null
    const open = valid && (forceOpen || expanded.has(agent.name))
    const selected = agent.filePath === p.selectedAgentPath || (!open && agent.name === selectedChatAgent)
    const key = agentKey(agent.name)
    return (
      <div key={agent.filePath} className={'agent-block' + itemClass(key, section)} data-item-key={key}>
        <div className={selected ? 'agent-line on' : 'agent-line'}>
          <button
            type="button"
            className={valid && folders.length > 0 ? 'row agent has-toggle' : 'row agent'}
            data-testid="agent-row"
            data-agent-name={agent.name}
            data-built-in={agent.builtIn ? 'true' : undefined}
            data-tip={agent.error ?? agent.description}
            onClick={() => {
              if (!valid) {
                if (!agent.builtIn) p.onOpenAgent(agent.filePath)
                return
              }
              setOpen(agent.name, true)
              p.onPickAgent(agent.name)
            }}
            {...dragProps({ item: key, section: null }, !searchActive)}
          >
            <BotIcon
              icon={agent.icon}
              color={valid ? agent.color : null}
              builtIn={agent.builtIn}
              working={agentIsWorking(agent, p.chats, p.pendingByChat)}
              size={32}
            />
            {/* Unread sits on the icon, the approval badge at the row's end: same blue, so the place tells them apart. */}
            {!open && !agentHasPending(p.chats, agent.name, p.pendingByChat) && agentHasUnread(p.chats, agent.name) && (
              <span className="unread-dot" role="status" aria-label="Unread chats" data-tip="Unread chats" data-testid="agent-unread-dot" />
            )}
            <span className="agent-text">
              <span className="agent-name">
                {displayName(agent.name)}
                {engineTag(agent) && (
                  <span className="agent-engine-tag" data-testid="agent-engine-tag">
                    {engineTag(agent)}
                  </span>
                )}
              </span>
              {(agent.error ?? agent.description) !== '' && (
                <span className={valid ? 'agent-desc' : 'agent-desc error'}>{agent.error ?? agent.description}</span>
              )}
            </span>
            {!valid && <span aria-label="Agent file has an error">⚠</span>}
            {!open && agentHasPending(p.chats, agent.name, p.pendingByChat) && (
              <span
                className="approval-badge compact"
                role="status"
                aria-label="Approval needed"
                data-tip="Approval needed"
                data-testid="agent-approval-badge"
              />
            )}
          </button>
          <div className="row-actions">
            <button
              type="button"
              className={menu?.kind === 'agent' && menu.agent.filePath === agent.filePath ? 'row-action more shown' : 'row-action more'}
              data-testid="agent-menu-button"
              aria-label={`${displayName(agent.name)} options`}
              aria-haspopup="menu"
              data-tip="Options"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu(
                  menu?.kind === 'agent' && menu.agent.filePath === agent.filePath
                    ? null
                    : { kind: 'agent', agent, right: r.right, top: r.bottom + 4 }
                )
              }}
            >
              <Glyph name="more" />
            </button>
            {valid && folders.length > 0 && (
              <button
                type="button"
                className={open ? 'row-action chevron open' : 'row-action chevron'}
                data-testid="agent-toggle"
                aria-expanded={open}
                aria-label={open ? `Collapse ${displayName(agent.name)}` : `Expand ${displayName(agent.name)}`}
                disabled={forceOpen}
                onClick={() => setOpen(agent.name, !open)}
              >
                <Glyph name="chevron" />
              </button>
            )}
          </div>
        </div>
        {open && folders.length > 0 && (
          <div className="agent-children">
            {/* The built-in agent always runs in its own folder, so its chats sit straight under it. So do an agent's
                chats that all share one folder: a header naming it would be a third level for nothing (the chat's folder
                chip still names it). The wrapper stays, for its data-cwd and Show more. */}
            {agent.builtIn
              ? folderChats(folderKey(agent.name, ''), flatChats(folders), displayName(agent.name))
              : folders.length === 1
                ? folders.map((folder) => (
                    <div key={folder.cwd} className="folder single" data-testid="folder" data-cwd={folder.cwd}>
                      {folderChats(folderKey(agent.name, folder.cwd), folder.chats, folder.name)}
                    </div>
                  ))
                : folders.map((folder) => (
                    <div key={folder.cwd} className="folder" data-testid="folder" data-cwd={folder.cwd}>
                      <div className="folder-line">
                        <span className="folder-label" data-tip={isScratchRoot(folder.cwd) ? undefined : folder.cwd}>
                          <FolderIcon />
                          {folder.name}
                        </span>
                        <button
                          type="button"
                          className="row-action add"
                          data-testid="folder-new-chat"
                          aria-label={`New chat in ${folder.name}`}
                          data-tip={isScratchRoot(folder.cwd) ? 'New chat with no folder' : `New chat in ${folder.cwd}`}
                          onClick={() => p.onNewChat(agent.name, isScratchRoot(folder.cwd) ? 'none' : { cwd: folder.cwd })}
                        >
                          <Glyph name="plus" />
                        </button>
                      </div>
                      {folder.chats.length > 0 && folderChats(folderKey(agent.name, folder.cwd), folder.chats, folder.name)}
                    </div>
                  ))}
          </div>
        )}
      </div>
    )
  }

  const entryRow = (e: Entry, section: string | null) => (e.kind === 'agent' ? agentBlock(e.node, section) : groupRow(e.row, section))

  const itemsList = (entries: Entry[], section: string | null, empty: string | null) => (
    <div
      className={itemDrop?.section === section && itemDrop.before === null ? 'section-items drop-end' : 'section-items'}
      data-section-id={section ?? ''}
      data-testid={section === null ? 'unassigned-items' : 'section-items'}
    >
      {entries.map((e) => entryRow(e, section))}
      {entries.length === 0 && empty !== null && <p className="section-empty">{empty}</p>}
    </div>
  )

  const sectionBlock = ({ section, entries }: { section: SidebarSection; entries: Entry[] }) => {
    const open = searchActive || !section.collapsed
    const into = itemDrop?.section === section.id && !open
    return (
      <div
        key={section.id}
        className={
          'sidebar-section user-section' +
          (drag?.section === section.id ? ' dragging' : '') +
          (sectionDrop === section.id ? ' drop-before' : '')
        }
        data-testid="user-section"
        data-section-block={section.id}
        role="group"
        aria-label={section.name}
      >
        <div
          className={into ? 'section-head drop-into' : 'section-head'}
          data-section-head={section.id}
          {...dragProps({ item: null, section: section.id }, !searchActive && renamingSection !== section.id)}
        >
          {renamingSection === section.id ? (
            <input
              className="field rename section-rename"
              defaultValue={section.name}
              maxLength={SECTION_NAME_MAX}
              aria-label="Section name"
              data-testid="section-rename"
              autoFocus
              onFocus={(e) => e.target.select()}
              onBlur={(e) => commitSectionName(section, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitSectionName(section, e.currentTarget.value)
                else if (e.key === 'Escape') setRenamingSection(null)
              }}
            />
          ) : (
            <>
              <h3 className="section-label">
                <button
                  type="button"
                  className={open ? 'section-toggle open' : 'section-toggle'}
                  data-testid="section-toggle"
                  aria-expanded={open}
                  disabled={searchActive}
                  onClick={() => p.onLayoutChange(setSectionCollapsed(layout, section.id, open))}
                >
                  <span className="section-name">{section.name}</span>
                  {!open && entries.some(entryPending) ? (
                    <span
                      className="approval-badge compact"
                      role="status"
                      aria-label="Approval needed"
                      data-tip="Approval needed"
                      data-testid="section-approval-badge"
                    />
                  ) : (
                    !open &&
                    entries.some(entryUnread) && (
                      <span
                        className="unread-dot"
                        role="status"
                        aria-label="Unread chats"
                        data-tip="Unread chats"
                        data-testid="section-unread-dot"
                      />
                    )
                  )}
                  <Glyph name="chevron" />
                </button>
              </h3>
              <button
                type="button"
                className={menu?.kind === 'section' && menu.section.id === section.id ? 'row-action more shown' : 'row-action more'}
                data-testid="section-menu-button"
                aria-label={`${section.name} options`}
                aria-haspopup="menu"
                data-tip="Options"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setMenu(
                    menu?.kind === 'section' && menu.section.id === section.id
                      ? null
                      : { kind: 'section', section, right: r.right, top: r.bottom + 4 }
                  )
                }}
              >
                <Glyph name="more" />
              </button>
            </>
          )}
        </div>
        {open && itemsList(entries, section.id, 'Drag agents or groups here')}
      </div>
    )
  }

  // Move to › and the list beside it, for an agent or a group chat.
  const moveToItem = (key: string) => {
    const current = sectionOf(layout, key)
    const dest = (id: string | null, label: string) => (
      <button
        key={id ?? ''}
        type="button"
        role="menuitemradio"
        aria-checked={current === id}
        data-testid="move-to-option"
        onClick={() => moveTo(key, id)}
      >
        <MenuIcon name={id === null ? 'inbox' : 'folder'} />
        <span className="menu-text">{label}</span>
        {current === id && <MenuIcon name="check" className="menu-icon menu-current" />}
      </button>
    )
    return (
      <div className="has-sub">
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={moveOpen}
          className={moveOpen ? 'sub-toggle open' : 'sub-toggle'}
          data-testid="menu-move-to"
          // Hovering already opened it, so a click never closes it again.
          onMouseEnter={() => setMoveOpen(true)}
          onClick={() => setMoveOpen(true)}
        >
          <MenuIcon name="folder" />
          Move to
          <Glyph name="chevron" />
        </button>
        {moveOpen && (
          <div ref={subRef} className="menu submenu" role="menu" data-testid="move-to-menu">
            {dest(null, 'Unassigned')}
            {layout.sections.map((s) => dest(s.id, s.name))}
            <div className="menu-sep" />
            <button type="button" role="menuitem" data-testid="move-to-new-section" onClick={() => newSection(key)}>
              <MenuIcon name="folderPlus" />
              New section
            </button>
          </div>
        )}
      </div>
    )
  }

  // Hovering another item closes the Move to list.
  const menuHover = (e: MouseEvent): void => {
    if (moveOpen && !(e.target as Element).closest('.has-sub')) setMoveOpen(false)
  }

  const nothing = sections.length === 0 && view.unassigned.length === 0

  return (
    <aside className={p.open ? 'sidebar open' : 'sidebar'} id="sidebar">
      <div className="sidebar-head">
        {searching ? (
          <div className="search">
            <Glyph name="search" />
            <input
              className="search-input"
              data-testid="search-input"
              type="text"
              value={query}
              maxLength={SEARCH_QUERY_MAX}
              placeholder="Search agents, chats and messages"
              aria-label="Search agents, chats and messages"
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') closeSearch()
              }}
            />
            <button type="button" className="search-close" aria-label="Close search" onClick={closeSearch}>
              <Glyph name="close" />
            </button>
          </div>
        ) : (
          <>
            <h2 className="sidebar-title">Agents</h2>
            <span className="count-badge" aria-label={`${p.agents.length} agents`}>
              {p.agents.length}
            </span>
            <span className="grow" />
            <button
              type="button"
              className={menu?.kind === 'new' ? 'head-btn open' : 'head-btn'}
              data-testid="new-agent"
              aria-label="New"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'new'}
              data-tip="New agent, group chat or section"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMenu(menu?.kind === 'new' ? null : { kind: 'new', right: r.right, top: r.bottom + 4 })
              }}
            >
              <Glyph name="plus" />
            </button>
            <button
              type="button"
              className="head-btn"
              data-testid="search-button"
              aria-label="Search agents, chats and messages"
              data-tip="Search agents, chats and messages"
              onClick={() => setSearching(true)}
            >
              <Glyph name="search" />
            </button>
          </>
        )}
        {/* Only on a small screen, where the sidebar is a drawer. */}
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
      <nav className={drag?.item ? 'agent-list moving' : 'agent-list'} aria-label="Agents">
        <div className="layout-list" {...listDropProps}>
          {sections.length > 0 && (
            <div className={sectionDrop === null ? 'user-sections drop-end' : 'user-sections'}>{sections.map(sectionBlock)}</div>
          )}
          {(view.unassigned.length > 0 || drag?.item || drag?.section) && (
            <>
              {sections.length > 0 && <div className="list-divider" role="separator" />}
              {itemsList(view.unassigned, null, drag?.item && view.unassigned.length === 0 ? 'Drop here for no section' : null)}
            </>
          )}
        </div>
        {nothing && searchActive && <p className="no-matches">No agents or chats match</p>}
        {searchActive && parseQuery(query) !== null && (
          <MessageHits
            query={query}
            chats={p.allChats}
            agents={p.agents}
            connected={p.connected}
            openedKey={openedHit !== null && openedHit.startsWith(`${p.selectedChatId}/`) ? openedHit : null}
            onOpen={(hit) => {
              setOpenedHit(hitKey(hit))
              p.onOpenMessage(hit, query)
            }}
          />
        )}
      </nav>
      {menu && (
        <div
          ref={menuRef}
          className="menu"
          role="menu"
          data-testid={menu.kind === 'new' ? 'new-menu' : menu.kind === 'section' ? 'section-menu' : undefined}
          style={menu.kind === 'chat' ? { left: menu.x, top: menu.y } : { left: menu.right, top: menu.top, transform: 'translateX(-100%)' }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseOver={menuHover}
        >
          {menu.kind === 'new' ? (
            <>
              <button
                type="button"
                role="menuitem"
                autoFocus
                data-testid="new-menu-agent"
                onClick={() => {
                  setMenu(null)
                  p.onNewAgent()
                }}
              >
                <MenuIcon name="bot" />
                New agent
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="new-menu-group"
                onClick={() => {
                  setMenu(null)
                  p.onNewGroup()
                }}
              >
                <MenuIcon name="users" />
                New group chat
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="new-menu-section"
                disabled={p.layout === null}
                onClick={() => newSection(null)}
              >
                <MenuIcon name="folderPlus" />
                New section
              </button>
            </>
          ) : menu.kind === 'section' ? (
            <>
              <button
                type="button"
                role="menuitem"
                autoFocus
                data-testid="section-menu-rename"
                onClick={() => {
                  setRenamingSection(menu.section.id)
                  setMenu(null)
                }}
              >
                <MenuIcon name="pencil" />
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                data-testid="section-menu-delete"
                data-tip="Its agents and groups move out of it; nothing is deleted"
                onClick={() => {
                  setMenu(null)
                  p.onLayoutChange(removeSection(layout, keys, menu.section.id))
                }}
              >
                <MenuIcon name="trash" />
                Delete section
              </button>
            </>
          ) : menu.kind === 'chat' ? (
            <>
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={() => {
                  setRenaming(menu.chat.id)
                  setMenu(null)
                }}
              >
                <MenuIcon name="pencil" />
                Rename
              </button>
              {menu.chat.group && (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="chat-menu-clone"
                  onClick={() => {
                    const chat = menu.chat
                    setMenu(null)
                    p.onCloneRoom(chat)
                  }}
                >
                  <MenuIcon name="copy" />
                  Clone room…
                </button>
              )}
              {menu.chat.group && p.layout !== null && moveToItem(groupKey(menu.chat.id))}
              <button
                type="button"
                role="menuitem"
                data-testid="chat-menu-export"
                onClick={() => {
                  const chat = menu.chat
                  setMenu(null)
                  p.onExportChat(chat)
                }}
              >
                <MenuIcon name="download" />
                Export…
              </button>
              {CHANNEL_PLATFORMS.map((platform) => {
                const linked = menu.chat.channel?.platform === platform
                return (
                  <button
                    key={platform}
                    type="button"
                    role="menuitem"
                    data-testid={platform === 'telegram' ? 'chat-menu-channel' : `chat-menu-channel-${platform}`}
                    onClick={() => {
                      const chat = menu.chat
                      setMenu(null)
                      const done = linked ? api.channels.unlink(chat.id) : api.channels.link(chat.id, platform)
                      done.catch((e) => setChannelNote({ platform, text: errorMessage(e) }))
                    }}
                  >
                    <MenuIcon name="messagePlus" />
                    {linked ? `Stop continuing in ${CHANNEL_LABELS[platform]}` : `Continue in ${CHANNEL_LABELS[platform]}`}
                  </button>
                )
              })}
              <button
                type="button"
                role="menuitem"
                data-testid="chat-menu-archive"
                // A running chat may hold a card to answer, so it stays in sight until its reply ends.
                disabled={menu.chat.inFlight || hasPending(menu.chat.id)}
                data-tip={menu.chat.inFlight || hasPending(menu.chat.id) ? ARCHIVE_RUNNING : undefined}
                onClick={() => {
                  const chat = menu.chat
                  setMenu(null)
                  p.onArchiveChat(chat.id)
                }}
              >
                <MenuIcon name="archive" />
                Archive
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setConfirmDelete(menu.chat)
                  setMenu(null)
                }}
              >
                <MenuIcon name="trash" />
                Delete
              </button>
            </>
          ) : (
            <>
              {menu.agent.error === null && (
                <button
                  type="button"
                  role="menuitem"
                  autoFocus
                  data-testid="agent-menu-new-chat"
                  onClick={() => {
                    setOpen(menu.agent.name, true)
                    p.onNewChat(menu.agent.name, 'pick')
                    setMenu(null)
                  }}
                >
                  <MenuIcon name="messagePlus" />
                  New chat
                </button>
              )}
              {p.layout !== null && moveToItem(agentKey(menu.agent.name))}
              {!menu.agent.builtIn && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    autoFocus={menu.agent.error !== null}
                    data-testid="agent-menu-edit"
                    onClick={() => {
                      p.onOpenAgent(menu.agent.filePath)
                      setMenu(null)
                    }}
                  >
                    <MenuIcon name="squarePen" />
                    Edit agent
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    data-testid="agent-menu-delete"
                    onClick={() => {
                      setConfirmDeleteAgent(menu.agent)
                      setMenu(null)
                    }}
                  >
                    <MenuIcon name="trash" />
                    Delete agent
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {channelNote !== null && (
        <ConfirmDialog
          title={`Can't continue in ${CHANNEL_LABELS[channelNote.platform]}`}
          message={channelNote.text}
          buttons={[{ label: 'OK', value: 'ok' }]}
          onResolve={() => setChannelNote(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete chat?"
          message={`"${chatTitle(confirmDelete, p.agents)}" will be removed from ZumiBot. Claude's own session file is left alone.`}
          buttons={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Delete', value: 'delete', danger: true }
          ]}
          onResolve={(value) => {
            const chat = confirmDelete
            setConfirmDelete(null)
            // The server drops a group's place in the sidebar.
            if (value === 'delete') p.onDeleteChat(chat.id)
          }}
        />
      )}
      {confirmDeleteAgent && (
        <ConfirmDialog
          title={`Delete ${displayName(confirmDeleteAgent.name)}?`}
          message="The agent file moves to the Trash, where you can restore it. Its chats stay in ZumiBot but are hidden while the agent is gone."
          buttons={[
            { label: 'Cancel', value: 'cancel' },
            { label: 'Delete agent', value: 'delete', danger: true }
          ]}
          onResolve={(value) => {
            const agent = confirmDeleteAgent
            setConfirmDeleteAgent(null)
            if (value === 'delete') p.onDeleteAgent(agent.filePath)
          }}
        />
      )}
    </aside>
  )
}
