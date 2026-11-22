import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import { ViewerHost } from './FileViewer'
import type { CommandPick } from '@zumibot/shared/commands'
import { displayName } from '@zumibot/shared/frontmatter'
import type { IslandBridge, IslandLayout, IslandRect } from '@zumibot/shared/island'
import { slideLayout } from '@zumibot/shared/islandLayout'
import type { AgentSummary } from '@zumibot/shared/types'
import type { DraftFiles } from '../state/draftFiles'
import { folderName } from '../state/sidebarTree'
import { ISLAND_BTW_NOTICE, ISLAND_RUN_WORKFLOW_NOTICE, type IslandMarks } from '../state/island'
import type { RecentRow } from '../state/islandView'
import { useDismiss } from '../useDismiss'
import { BotIcon } from './BotIcon'
import { Composer } from './Composer'
import { DropZone } from './DropZone'

export interface IslandIcon {
  agent: AgentSummary
  marks: IslandMarks
}

export interface IslandPopup {
  agent: AgentSummary
  /** The chat's title, or "New chat" for the new-chat state. */
  title: string
  /** The chat shown, for Open in ZumiBot; null in the new-chat state. */
  chatId: string | null
  recent: RecentRow[]
  /** The chat's view, or the new-chat state. */
  body: ReactNode
}

interface Props {
  bridge: IslandBridge
  /** Where the strip and the popup sit in the window; nothing is drawn before the shell's first layout. */
  layout: IslandLayout | null
  icons: IslandIcon[]
  /** The agent whose popup is open, if any. */
  openName: string | null
  onIcon: (agentName: string) => void
  popup: IslandPopup | null
  error: string | null
  onDismissError: () => void
  onNewChat: () => void
  onPickChat: (chatId: string) => void
  onClose: () => void
  /** The voice conversation's view, in the popup's place while the desk shortcut's talk runs; null otherwise. */
  voice?: ReactNode
  onCloseVoice?: () => void
}

const place = (r: IslandRect): CSSProperties => ({ left: r.x, top: r.y, width: r.width, height: r.height })

const marksLabel = (m: IslandMarks): string =>
  [m.working && 'working', m.waiting > 0 && `${m.waiting} waiting for you`, m.unread && 'new reply'].filter(Boolean).join(', ')

/** The live marks: the spinning ring is drawn by the icon's own CSS, the count and the dot here. */
function MarkBadges({ marks }: { marks: IslandMarks }) {
  return (
    <>
      {marks.waiting > 0 && (
        <span className="island-badge" aria-hidden="true">
          {marks.waiting > 9 ? '9+' : marks.waiting}
        </span>
      )}
      {marks.waiting === 0 && marks.unread && <span className="island-dot" aria-hidden="true" />}
    </>
  )
}

/** The strip and the popup of the dynamic island, drawn at the rects the shell sends for its window. */
export function IslandView({
  bridge,
  layout,
  icons,
  openName,
  onIcon,
  popup,
  error,
  onDismissError,
  onNewChat,
  onPickChat,
  onClose,
  voice = null,
  onCloseVoice
}: Props) {
  const [menu, setMenu] = useState(false)
  const closeMenu = useCallback(() => setMenu(false), [])
  useDismiss(menu, closeMenu)
  // Another agent's popup, or none, starts with the menu shut.
  useEffect(() => setMenu(false), [openName])

  // Esc leaves the popup unless something took it first: the composer's menus (they stop it), this menu, a dialog, or the
  // reply the box cancels with it. ProseMirror marks every Esc in the box as handled, so there a handled key still counts
  // as free. What takes the key is looked for before any handler runs, since each removes what it closes.
  const voiceOpen = voice !== null
  const popupOpen = popup !== null || voiceOpen
  const closePopup = voiceOpen ? onCloseVoice : onClose
  useEffect(() => {
    if (!popupOpen) return
    const taken = new WeakSet<Event>()
    const before = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && document.querySelector('.menu, .modal-backdrop, [role="dialog"], .reply-strip')) taken.add(e)
    }
    const after = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || taken.has(e)) return
      const inBox = e.target instanceof Element && e.target.closest('.composer-input') !== null
      if (e.defaultPrevented && !inBox) return
      closePopup?.()
    }
    window.addEventListener('keydown', before, true)
    window.addEventListener('keydown', after)
    return () => {
      window.removeEventListener('keydown', before, true)
      window.removeEventListener('keydown', after)
    }
  }, [popupOpen, closePopup])

  // The strip's own background drags the island along the edge; an icon is a button and never starts one. With a track
  // (a shell whose window never moves) the page slides the strip and popup itself and tells the shell where it ended; an
  // older shell gets every move and moves its window.
  const dragging = useRef<{ pointerId: number; y: number; from: number } | null>(null)
  const slidTop = useRef<number | null>(null) // read at the end, which may come before the last slide has rendered
  const [slid, setSlid] = useState<IslandLayout | null>(null)
  // The shell's layout after the drag lands on the same pixels (slideLayout), so the page's own goes once it arrives.
  useEffect(() => {
    if (!dragging.current) setSlid(null)
  }, [layout])
  const dragEnd = (e: PointerEvent<HTMLElement>): void => {
    if (dragging.current?.pointerId !== e.pointerId) return
    dragging.current = null
    bridge.drag('end', e.screenY, slidTop.current ?? undefined)
  }

  if (!layout) return null
  const shown = slid ?? layout
  return (
    <>
      <div
        className="island-strip"
        data-testid="island-strip"
        style={place(shown.strip)}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest('button')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          // From where it is drawn: the shell's layout for the last drag may not have arrived yet.
          dragging.current = { pointerId: e.pointerId, y: e.clientY, from: shown.strip.y }
          slidTop.current = null
          bridge.drag('start', e.screenY)
        }}
        onPointerMove={(e) => {
          const d = dragging.current
          if (d?.pointerId !== e.pointerId) return
          if (!layout.track) {
            bridge.drag('move', e.screenY)
            return
          }
          // The window never moves, so clientY is true; the shell is told nothing until the end.
          const next = slideLayout({ ...layout, track: layout.track }, d.from + e.clientY - d.y)
          slidTop.current = next.strip.y
          setSlid(next)
        }}
        onPointerUp={dragEnd}
        onPointerCancel={dragEnd}
        onLostPointerCapture={dragEnd}
      >
        <div className="island-pill">
          {icons.map(({ agent, marks }) => {
            const open = agent.name === openName
            const label = marksLabel(marks)
            return (
              <button
                key={agent.name}
                type="button"
                className={['island-agent', open && 'open', marks.working && 'island-working'].filter(Boolean).join(' ')}
                data-testid="island-agent"
                data-agent-name={agent.name}
                data-working={marks.working}
                data-waiting={marks.waiting}
                data-unread={marks.unread}
                aria-pressed={open}
                aria-label={label === '' ? displayName(agent.name) : `${displayName(agent.name)}, ${label}`}
                data-tip={displayName(agent.name)}
                onClick={() => onIcon(agent.name)}
              >
                <BotIcon icon={agent.icon} color={agent.color} builtIn={agent.builtIn} working={marks.working} size={30} />
                <MarkBadges marks={marks} />
              </button>
            )
          })}
        </div>
      </div>
      {voiceOpen && !popup && shown.popup && (
        <section className="island-popup island-voice" data-testid="island-voice" style={place(shown.popup)}>
          <header className="island-head">
            <div className="island-head-text">
              <b>Voice</b>
            </div>
            <button
              type="button"
              className="icon-btn island-head-btn"
              data-testid="island-voice-close"
              aria-label="Stop and close"
              onClick={onCloseVoice}
            >
              ✕
            </button>
          </header>
          <div className="island-body">{voice}</div>
        </section>
      )}
      {popup && shown.popup && (
        <section className="island-popup" data-testid="island-popup" data-agent-name={popup.agent.name} style={place(shown.popup)}>
          <header className="island-head">
            <span className="island-head-icon">
              <BotIcon icon={popup.agent.icon} color={popup.agent.color} builtIn={popup.agent.builtIn} working={false} size={22} />
            </span>
            <div className="island-head-text">
              <b>{displayName(popup.agent.name)}</b>
              <span data-testid="island-title">{popup.title}</span>
            </div>
            <button
              type="button"
              className="icon-btn island-head-btn"
              data-testid="island-menu-open"
              aria-label="Chats and actions"
              aria-haspopup="menu"
              aria-expanded={menu}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setMenu((m) => !m)}
            >
              ⋯
            </button>
            <button type="button" className="icon-btn island-head-btn" data-testid="island-close" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </header>
          {error && (
            <div className="error-strip" role="alert">
              <span>{error}</span>
              <button type="button" className="icon-btn" aria-label="Dismiss error" onClick={onDismissError}>
                ✕
              </button>
            </div>
          )}
          <div className="island-body">{popup.body}</div>
          <ViewerHost contained />
          {menu && (
            <div className="menu island-menu" role="menu" data-testid="island-menu" onMouseDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                role="menuitem"
                data-testid="island-new-chat"
                onClick={() => {
                  setMenu(false)
                  onNewChat()
                }}
              >
                ＋ New chat
              </button>
              {popup.recent.length > 0 && <div className="menu-label">Recent chats</div>}
              {popup.recent.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  className={r.current ? 'island-recent current' : 'island-recent'}
                  data-testid="island-recent"
                  data-chat-id={r.id}
                  aria-current={r.current || undefined}
                  onClick={() => {
                    setMenu(false)
                    onPickChat(r.id)
                  }}
                >
                  <span className="island-recent-title">{r.title}</span>
                  <span className="island-recent-marks">
                    {r.marks.working && <span className="spinner" aria-label="working" />}
                    {r.marks.waiting > 0 && (
                      <span className="island-row-badge" aria-label={`${r.marks.waiting} waiting for you`}>
                        {r.marks.waiting}
                      </span>
                    )}
                    {r.marks.waiting === 0 && r.marks.unread && <span className="island-row-dot" aria-label="new reply" />}
                  </span>
                  <span className="island-recent-ago">{r.ago}</span>
                </button>
              ))}
              <div className="menu-sep" />
              <button
                type="button"
                role="menuitem"
                data-testid="island-open-main"
                onClick={() => {
                  setMenu(false)
                  bridge.openMain({ chatId: popup.chatId, live: null })
                }}
              >
                Open in ZumiBot
              </button>
            </div>
          )}
        </section>
      )}
    </>
  )
}

interface NewChatProps {
  agent: AgentSummary
  draft: string
  /** Where the first message will run, once known. */
  folder: string | null
  cliFound: boolean
  blockedReason: string | null
  /** `@` asks these agents; none for Zumi Bot, which has no ask tool. */
  askable: AgentSummary[] | undefined
  files: DraftFiles
  onDraftChange: (text: string) => void
  onSend: (text: string, pick?: CommandPick) => void
  onAddFiles: (files: File[], origin: 'paste' | 'drop') => void
  onPickFiles: () => void
  onRemoveFile: (key: string) => void
}

/** The popup's new-chat state: the agent's introduction over a message box; the first message starts an ordinary chat. */
export function IslandNewChat({
  agent,
  draft,
  folder,
  cliFound,
  blockedReason,
  askable,
  files,
  onDraftChange,
  onSend,
  onAddFiles,
  onPickFiles,
  onRemoveFile
}: NewChatProps) {
  const commandAgents = useMemo(() => [agent], [agent])
  return (
    <DropZone className="chat" testId="island-new" onFiles={(f) => onAddFiles(f, 'drop')}>
      <div className="messages">
        <div className="chat-intro">
          <BotIcon icon={agent.icon} color={agent.error === null ? agent.color : null} builtIn={agent.builtIn} working={false} size={56} />
          <h2 className="chat-intro-name">{displayName(agent.name)}</h2>
          {agent.description !== '' && <p className="chat-intro-desc">{agent.description}</p>}
        </div>
      </div>
      <Composer
        label={`Message ${displayName(agent.name)}`}
        draft={draft}
        inFlight={false}
        cliFound={cliFound}
        blockedReason={blockedReason}
        mentionMembers={askable}
        everyone={false}
        commandAgents={commandAgents}
        btw={false}
        noBtw={ISLAND_BTW_NOTICE}
        runWorkflow={false}
        noRunWorkflow={ISLAND_RUN_WORKFLOW_NOTICE}
        onDraftChange={onDraftChange}
        onSend={onSend}
        files={files}
        onAddFiles={onAddFiles}
        onPickFiles={onPickFiles}
        onRemoveFile={onRemoveFile}
        onStop={() => {}}
      >
        {folder !== null && (
          <div className="island-folder" data-testid="island-folder" data-tip={folder}>
            Runs in {folderName(folder)}
          </div>
        )}
      </Composer>
    </DropZone>
  )
}
