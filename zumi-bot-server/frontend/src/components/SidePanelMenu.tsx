import { useState } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { useNarrow } from '../media'
import { chatCaps } from '../state/agentEngine'
import { desktopRowShown, hasComputerUse } from '../state/sidePanel'
import { folderName } from '../state/sidebarTree'
import { useBrowser } from '../useAgentBrowser'
import { useDesktop } from '../useAgentDesktop'
import { BotIcon } from './BotIcon'
import { FolderIcon } from './FolderIcon'
import { MenuIcon } from './MenuIcon'
import { SearchSelect } from './SearchSelect'

export function GlobeIcon() {
  return (
    <svg className="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.8 1.7 2.6 3.8 2.6 6.2S9.8 12.5 8 14.2C6.2 12.5 5.4 10.4 5.4 8S6.2 3.5 8 1.8z" />
    </svg>
  )
}

/** A screen on its stand: the agent's desktop. */
export function DesktopIcon() {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.9" y="2.4" width="12.2" height="8.6" rx="1.5" />
      <path d="M8 11v2.6M5.2 13.6h5.6" strokeLinecap="round" />
    </svg>
  )
}

export function FilesIcon() {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 1.75h5l3 3v9.5H4z M9 1.75v3h3" />
    </svg>
  )
}

/** A speech bubble: the chat's side questions (btw). */
export function QuestionIcon() {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />
    </svg>
  )
}

/** A ticked box: the chat's to-dos. */
export function TodosIcon() {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
      <path d="m5.5 8.2 1.8 1.8 3.2-3.6" />
    </svg>
  )
}

/** A prompt in a window: the chat's background processes. */
export function TerminalIcon() {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.9" y="2.6" width="12.2" height="10.8" rx="2" />
      <path d="m4.8 6.4 2 1.7-2 1.7M8.6 10h2.8" />
    </svg>
  )
}

/** In the chat header while the chat's processes run: how many, and a way to them. Never the sidebar's "running". */
export function ProcessMark({ mark, onOpen }: { mark: { count: string; label: string } | null; onOpen: () => void }) {
  if (mark === null) return null
  return (
    <button
      type="button"
      className="process-mark"
      data-testid="process-mark"
      aria-label={`${mark.label}: open Processes`}
      data-tip={mark.label}
      onClick={onOpen}
    >
      <span className="process-dot running" aria-hidden="true" />
      <TerminalIcon />
      {mark.count && <span data-testid="process-mark-count">{mark.count}</span>}
    </button>
  )
}

export function AgentsIcon() {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="10" height="8" rx="2.2" />
      <path d="M8 2.2V5M6 8.6h.01M10 8.6h.01M6.3 11h3.4" />
    </svg>
  )
}

/** The window with its right column: the side panel's toggle above the chat. */
export function SidePanelIcon() {
  return (
    <svg className="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="1.9" y="2.9" width="12.2" height="10.2" rx="2" />
      <path d="M9.9 3v10" />
    </svg>
  )
}

/** Opens and closes the side panel: over the chat, or in the mobile bar on a small screen. */
export function SidePanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={open ? 'head-btn side-toggle open' : 'head-btn side-toggle'}
      data-testid="side-panel-toggle"
      aria-label={open ? 'Close side panel' : 'Open side panel'}
      aria-pressed={open}
      data-tip="Side panel"
      onClick={onToggle}
    >
      <SidePanelIcon />
    </button>
  )
}

/** In a side view's header: back to the side panel's list. */
export function SideBackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn side-back"
      data-testid="side-back"
      aria-label="Back to side panel"
      data-tip="Back"
      onClick={onBack}
    >
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
        <path d="M10 3.5 5.5 8l4.5 4.5" />
      </svg>
    </button>
  )
}

interface Props {
  chat: ChatMeta
  /** Changed files plus attachments: shown beside Open Files. */
  filesCount: number
  /** Uncommitted files in the chat's repo, beside Open Changes; null hides the row (not a repo, or its worktree folder was removed). */
  gitChanged: number | null
  onOpenChanges: () => void
  /** The chat's side questions (btw): shown beside Open Side questions. */
  sidesCount: number
  /** The chat's open to-dos: shown beside Open To-dos. */
  todosLeft: number
  /** Beside Open Dispatched agents: "N running" while any runs, else how many. */
  dispatchBadge: { text: string; live: boolean } | null
  /** Beside Open Processes: "N running" while any runs, else how many. */
  processesBadge: { text: string; live: boolean } | null
  /** The socket is down: no browser or desktop can be watched. */
  offline: boolean
  /** Who has computer use: the Desktop row is for those members only, and absent when no member has it. */
  agents: AgentSummary[]
  onOpenFiles: () => void
  onOpenSides: () => void
  onOpenTodos: () => void
  onOpenDispatch: () => void
  onOpenProcesses: () => void
  /** The member whose browser to show (a single chat: its agent). */
  onOpenBrowser: (agent: string) => void
  /** The member whose desktop to show (a single chat: its agent). */
  onOpenDesktop: (agent: string) => void
  onClose: () => void
}

const DESKTOP_OFF = 'Computer use is off for this agent'

/**
 * On a phone the row under the composer leaves out the chat's agent and folder (both locked, so it stays one line):
 * they show here instead, the folder with its whole path and a worktree's own.
 */
function ChatAbout({ chat, agents }: { chat: ChatMeta; agents: AgentSummary[] }) {
  // A room's members are in the bar over the chat.
  const agent = chat.group ? undefined : agents.find((a) => a.name === chat.agentName)
  // The built-in agent always runs in its own folder, so it shows none (as its row under the composer did).
  const showFolder = agent?.builtIn !== true
  const folder = chat.worktree?.folder ?? chat.cwd
  if (!agent && !showFolder) return null
  return (
    <div className="side-about" data-testid="side-chat-about">
      {agent && (
        <div className="side-about-line" data-testid="side-chat-agent">
          <BotIcon icon={agent.icon} color={agent.color} builtIn={agent.builtIn} working={false} size={16} />
          <span className="side-about-name">{displayName(agent.name)}</span>
        </div>
      )}
      {showFolder && (
        <div className="side-about-line" data-testid="side-chat-folder">
          <FolderIcon />
          <span className="side-about-text">
            <span className="side-about-name">{folderName(folder)}</span>
            <span className="side-about-path">{folder}</span>
            {chat.worktree && <span className="side-about-path">Worktree: {chat.cwd}</span>}
          </span>
        </div>
      )}
    </div>
  )
}

/** The side panel with nothing chosen: what it can show for this chat. */
export function SidePanelMenu({
  chat,
  filesCount,
  gitChanged,
  onOpenChanges,
  sidesCount,
  todosLeft,
  dispatchBadge,
  processesBadge,
  offline,
  agents,
  onOpenFiles,
  onOpenSides,
  onOpenTodos,
  onOpenDispatch,
  onOpenProcesses,
  onOpenBrowser,
  onOpenDesktop,
  onClose
}: Props) {
  const browser = useBrowser()
  const desktop = useDesktop()
  const members = chat.group?.members ?? [chat.agentName]
  // A row whose feature the engine lacks (Codex: desktop) is left out, not greyed. A room shows a row while any member has it.
  const caps = chatCaps(chat, agents)
  const [member, setMember] = useState('')
  const [desktopMember, setDesktopMember] = useState('')
  // A member that left the room since it was picked falls back to the first.
  const agent = members.includes(member) ? member : members[0]
  const computerUse = (name: string): boolean => hasComputerUse(name, agents)
  // No member with computer use: no Desktop row at all. Otherwise the picker starts on a member that has one.
  const showDesktop = caps.desktop && desktopRowShown(members, agents)
  const desktopAgent = members.includes(desktopMember) ? desktopMember : (members.find(computerUse) ?? members[0])
  const desktopOff = !!desktopAgent && !computerUse(desktopAgent)
  const narrow = useNarrow()
  return (
    <aside className="side-menu" data-testid="side-menu" aria-label="Side panel">
      <button
        type="button"
        className="icon-btn side-menu-close"
        data-testid="side-menu-close"
        aria-label="Close side panel"
        onClick={onClose}
      >
        ✕
      </button>
      <div className="side-menu-list">
        {narrow && <ChatAbout chat={chat} agents={agents} />}
        <div className="side-menu-row">
          <button
            type="button"
            className="side-menu-item"
            data-testid="side-open-browser"
            disabled={!agent || offline || !browser}
            onClick={() => onOpenBrowser(agent)}
          >
            <GlobeIcon />
            <span className="side-menu-label">Open Browser</span>
          </button>
          {chat.group && (
            <SearchSelect aria-label="Browser agent" value={agent} onChange={(v) => setMember(v)}>
              {members.map((name) => (
                <option key={name} value={name}>
                  {displayName(name)}
                </option>
              ))}
            </SearchSelect>
          )}
        </div>
        {showDesktop && (
          <div className="side-menu-row">
            <button
              type="button"
              className="side-menu-item"
              data-testid="side-open-desktop"
              disabled={!desktopAgent || offline || !desktop || desktopOff}
              data-tip={desktopOff ? DESKTOP_OFF : undefined}
              onClick={() => onOpenDesktop(desktopAgent)}
            >
              <DesktopIcon />
              <span className="side-menu-label">Open Desktop</span>
            </button>
            {chat.group && (
              <SearchSelect aria-label="Desktop agent" value={desktopAgent} onChange={(v) => setDesktopMember(v)}>
                {members.map((name) => (
                  <option key={name} value={name}>
                    {displayName(name)}
                  </option>
                ))}
              </SearchSelect>
            )}
          </div>
        )}
        {showDesktop && desktopOff && (
          <p className="side-menu-hint" data-testid="side-desktop-off">
            {DESKTOP_OFF}
          </p>
        )}
        {caps.files && (
          <div className="side-menu-row">
            <button type="button" className="side-menu-item" data-testid="side-open-files" onClick={onOpenFiles}>
              <FilesIcon />
              <span className="side-menu-label">Open Files</span>
              {filesCount > 0 && (
                <span className="side-menu-count" data-testid="side-files-count">
                  {filesCount}
                </span>
              )}
            </button>
          </div>
        )}
        {gitChanged !== null && (
          <div className="side-menu-row">
            <button type="button" className="side-menu-item" data-testid="side-open-changes" onClick={onOpenChanges}>
              <MenuIcon name="gitBranch" className="glyph" />
              <span className="side-menu-label">Open Changes</span>
              {gitChanged > 0 && (
                <span className="side-menu-count" data-testid="side-changes-count">
                  {gitChanged}
                </span>
              )}
            </button>
          </div>
        )}
        <div className="side-menu-row">
          <button type="button" className="side-menu-item" data-testid="side-open-todos" onClick={onOpenTodos}>
            <TodosIcon />
            <span className="side-menu-label">Open To-dos</span>
            {todosLeft > 0 && (
              <span className="side-menu-count" data-testid="side-todos-count">
                {todosLeft} left
              </span>
            )}
          </button>
        </div>
        {caps.btw && (
          <div className="side-menu-row">
            <button type="button" className="side-menu-item" data-testid="side-open-sides" onClick={onOpenSides}>
              <QuestionIcon />
              <span className="side-menu-label">Open Side questions</span>
              {sidesCount > 0 && (
                <span className="side-menu-count" data-testid="side-sides-count">
                  {sidesCount}
                </span>
              )}
            </button>
          </div>
        )}
        {caps.dispatch && (
          <div className="side-menu-row">
            <button type="button" className="side-menu-item" data-testid="side-open-dispatch" onClick={onOpenDispatch}>
              <AgentsIcon />
              <span className="side-menu-label">Open Dispatched agents</span>
              {dispatchBadge !== null && (
                <span className={`side-menu-count${dispatchBadge.live ? ' live' : ''}`} data-testid="side-dispatch-count">
                  {dispatchBadge.text}
                </span>
              )}
            </button>
          </div>
        )}
        {/* A Codex chat has no process tool; a room shows the row while any member has it, or while its list holds any. */}
        {(caps.processes || processesBadge !== null) && (
          <div className="side-menu-row">
            <button type="button" className="side-menu-item" data-testid="side-open-processes" onClick={onOpenProcesses}>
              <TerminalIcon />
              <span className="side-menu-label">Open Processes</span>
              {processesBadge !== null && (
                <span className={`side-menu-count${processesBadge.live ? ' live' : ''}`} data-testid="side-processes-count">
                  {processesBadge.text}
                </span>
              )}
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
