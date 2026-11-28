import { useEffect, useRef, useState } from 'react'
import type { PopoutBridge } from '@zumibot/shared/popout'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { memberAgents, workingMembers } from '../state/groupChat'
import { cssColorToHex } from '../state/popout'
import { pathFor } from '../state/route'
import { chatTitle } from '../state/sidebarTree'
import { BotIcon } from './BotIcon'
import { MemberStack } from './MemberStack'
import { MenuIcon } from './MenuIcon'
import { ProcessMark, SidePanelToggle } from './SidePanelMenu'

// The first painted background up from the header: the header itself is see-through over the pane.
function backgroundOf(el: HTMLElement | null): string | null {
  for (let at = el; at; at = at.parentElement) {
    const hex = cssColorToHex(getComputedStyle(at).backgroundColor)
    if (hex) return hex
  }
  return null
}

/**
 * A popout window's title bar: which chat it is, its process mark and side panel toggle, and on the desktop Open in main
 * window and Pin on top. It spans the chat and the side panel, and the shell draws its window buttons over its end, so
 * the band is also the window's drag handle.
 */
export function PopoutHeader({
  chat,
  agents,
  sideOpen,
  onToggleSide,
  processMark,
  onOpenProcesses,
  bridge,
  colorKey
}: {
  chat: ChatMeta | null
  agents: AgentSummary[]
  sideOpen: boolean
  onToggleSide: () => void
  processMark: { count: string; label: string } | null
  onOpenProcesses: () => void
  /** The shell's popout bridge; null in a browser popup, which has its own window frame. */
  bridge: PopoutBridge | null
  /** Changes with the theme and accent, so the window buttons are recoloured to match. */
  colorKey: string
}) {
  const ref = useRef<HTMLElement>(null)
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    if (!bridge) return
    const send = (): void => {
      const el = ref.current
      if (!el) return
      const bg = backgroundOf(el)
      const fg = cssColorToHex(getComputedStyle(el).color)
      if (bg && fg) bridge.setTitleBarColors(bg, fg)
    }
    // After App's own effects have put the new theme and accent on the page (a parent's effects run after a child's).
    const frame = requestAnimationFrame(send)
    // The system theme can flip with no change here.
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    dark.addEventListener('change', send)
    return () => {
      cancelAnimationFrame(frame)
      dark.removeEventListener('change', send)
    }
  }, [bridge, colorKey])

  const agent = chat && !chat.group ? (agents.find((a) => a.name === chat.agentName) ?? null) : null
  const icon = chat?.group ? (
    <MemberStack agents={memberAgents(chat.group.members, agents)} size={22} working={workingMembers(chat)} max={3} />
  ) : agent ? (
    <BotIcon icon={agent.icon} color={agent.error === null ? agent.color : null} builtIn={agent.builtIn} working={false} size={22} />
  ) : null
  const title = chat ? chatTitle(chat, agents) : 'ZumiBot'

  return (
    <header ref={ref} className={bridge ? 'popout-head popout-head-shell' : 'popout-head'} data-testid="popout-head">
      <div className="chat-title">
        {icon}
        <h1 className="chat-title-text" data-tip={title}>
          {title}
        </h1>
      </div>
      {chat && (
        <>
          <ProcessMark mark={processMark} onOpen={onOpenProcesses} />
          <SidePanelToggle open={sideOpen} onToggle={onToggleSide} />
        </>
      )}
      {bridge && (
        <>
          <button
            type="button"
            className="head-btn popout-btn"
            data-testid="popout-open-main"
            aria-label="Open in main window"
            data-tip="Open in main window"
            onClick={() => bridge.openMain(chat ? pathFor(chat.id) : null)}
          >
            <MenuIcon name="popin" className="glyph" />
          </button>
          <button
            type="button"
            className={pinned ? 'head-btn popout-btn open' : 'head-btn popout-btn'}
            data-testid="popout-pin"
            aria-label={pinned ? 'Stop keeping on top' : 'Keep on top'}
            aria-pressed={pinned}
            data-tip={pinned ? 'Stop keeping on top' : 'Keep on top'}
            onClick={() => void bridge.pin(!pinned).then(setPinned, () => {})}
          >
            <MenuIcon name="pin" className="glyph" />
          </button>
        </>
      )}
    </header>
  )
}

/** What a popout shows when its chat was deleted, or never existed. */
export function PopoutGone() {
  return (
    <div className="routine-placeholder" data-testid="popout-gone">
      <p>This chat is gone.</p>
      <button type="button" className="btn" data-testid="popout-close" onClick={() => window.close()}>
        Close window
      </button>
    </div>
  )
}
