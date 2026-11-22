import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import { isAsked } from '@zumibot/shared/agentAsk'
import { displayName } from '@zumibot/shared/frontmatter'
import { ROUTINE_CHAT_TITLE_MAX, defaultRunTitle } from '@zumibot/shared/routines'
import type { SidebarSection } from '@zumibot/shared/sidebarLayout'
import { ROLE_MAX_CHARS, isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import { api } from '../api'
import { memberAgents, membersLabel } from '../state/groupChat'
import { keepPick } from '../state/commandInput'
import { promptCommandAgents, shownSection, type RoutineDraft } from '../state/routineDraft'
import { folderName } from '../state/sidebarTree'
import { useDismiss } from '../useDismiss'
import { Caret } from './Caret'
import { FolderIcon } from './FolderIcon'
import { MemberStack } from './MemberStack'
import { MembersMenu } from './MembersMenu'
import { PromptField } from './PromptField'
import { CardHead, RoutineIcon } from './RoutineIcons'
import { MenuSearch } from './MenuSearch'
import { SearchSelect } from './SearchSelect'

interface Props {
  draft: RoutineDraft
  agents: AgentSummary[]
  chats: ChatMeta[]
  /** The sidebar's sections, where a new room can be placed. */
  sections: readonly SidebarSection[]
  edit: (change: (d: RoutineDraft) => RoutineDraft) => void
  /** Field paths of the webhook's test call; null when the trigger is not a webhook. */
  fields: string[] | null
  insertRef: RefObject<((path: string) => void) | null>
  onError: (e: unknown) => void
}

const byRecent = (a: ChatMeta, b: ChatMeta): number => b.updatedAt - a.updatedAt

export function SendPromptCard({ draft, agents, chats, sections, edit, fields, insertRef, onError }: Props) {
  const [membersOpen, setMembersOpen] = useState(false)
  const [promptTall, setPromptTall] = useState(false)
  const closeMembers = useCallback(() => setMembersOpen(false), [])
  useDismiss(membersOpen, closeMembers)
  // A default folder fetched for a pick the user has since changed must not land.
  const folderRequest = useRef(0)

  const group = draft.targetKind === 'group'
  const pickable = agents.filter((a) => a.error === null)
  const agent = agents.find((a) => a.name === draft.agent)
  const existing = draft.chatChoice !== 'new'
  const agentChats = chats.filter((c) => !isGroup(c) && !isAsked(c) && c.agentName === draft.agent).sort(byRecent)
  const groupChats = chats.filter(isGroup).sort(byRecent)
  const choices = group ? groupChats : agentChats
  const missingChat = existing && !choices.some((c) => c.id === draft.chatChoice)
  const members = memberAgents(draft.groupMembers, agents)
  // A built-in agent runs in its own folder, so it gets none to pick.
  const showFolder = !existing && !(agent?.builtIn === true && !group)
  // Memoized: a new list each render would repaint the prompt's editor each render.
  const { targetKind, agent: agentName, groupMembers, chatChoice } = draft
  const commandTarget = useMemo(
    () => promptCommandAgents({ targetKind, agent: agentName, groupMembers, chatChoice }, agents, chats),
    [targetKind, agentName, groupMembers, chatChoice, agents, chats]
  )
  const hasCommands = commandTarget.agents.some((a) => a.error === null && (a.commands ?? []).length > 0)

  const defaultFolder = (lookup: Promise<string | null>, keep: (d: RoutineDraft) => boolean): void => {
    const request = ++folderRequest.current
    lookup.then((cwd) => {
      if (request !== folderRequest.current || cwd === null) return
      edit((d) => (keep(d) ? { ...d, cwd } : d))
    }, onError)
  }

  const setKind = (kind: RoutineDraft['targetKind']): void => {
    if (kind === draft.targetKind) return
    edit((d) => ({ ...d, targetKind: kind, chatChoice: 'new', cwd: '' }))
    if (kind === 'group') defaultFolder(api.app.lastGroupFolder(), (d) => d.targetKind === 'group' && d.cwd === '')
    else if (draft.agent) pickAgent(draft.agent)
  }

  const pickAgent = (name: string): void => {
    edit((d) => ({ ...d, agent: name, chatChoice: 'new', cwd: '' }))
    if (name) defaultFolder(api.app.lastFolder(name), (d) => d.agent === name && d.cwd === '')
  }

  const chooseFolder = (): void => {
    api.app.pickFolder(group ? null : draft.agent || null).then((cwd) => {
      if (cwd === null) return
      folderRequest.current++
      edit((d) => ({ ...d, cwd }))
    }, onError)
  }

  return (
    <section className="rt-card" data-testid="send-prompt-card">
      <CardHead icon="chat" title="Send prompt" subtitle="Choose the agent and the prompt to send.">
        <div className="rt-seg" role="group" aria-label="Send to" data-testid="target-kind">
          {(['agent', 'group'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={draft.targetKind === k} data-testid={`target-kind-${k}`} onClick={() => setKind(k)}>
              {k === 'agent' ? 'Agent' : 'Group'}
            </button>
          ))}
        </div>
      </CardHead>

      <div className="rt-grid">
        {!group && (
          <label className="rt-fieldset">
            <span className="rt-label">Agent</span>
            <span className="rt-sel">
              <RoutineIcon name="agent" />
              <SearchSelect className="rt-select" data-testid="target-agent" value={draft.agent} onChange={(v) => pickAgent(v)}>
                <option value="">Select agent</option>
                {draft.agent && !pickable.some((a) => a.name === draft.agent) && (
                  <option value={draft.agent}>{draft.agent} (not found)</option>
                )}
                {pickable.map((a) => (
                  <option key={a.filePath} value={a.name}>
                    {displayName(a.name)}
                  </option>
                ))}
              </SearchSelect>
            </span>
          </label>
        )}
        <label className="rt-fieldset">
          <span className="rt-label">Chat</span>
          <span className="rt-sel">
            <RoutineIcon name="chat" />
            <SearchSelect
              className="rt-select"
              data-testid="target-chat"
              value={draft.chatChoice}
              disabled={!group && !draft.agent}
              onChange={(v) => {
                const value = v
                edit((d) => ({ ...d, chatChoice: value }))
              }}
            >
              <option value="new">{group ? 'New group chat every run' : 'New chat every run'}</option>
              {missingChat && <option value={draft.chatChoice}>Chat not found</option>}
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </SearchSelect>
          </span>
        </label>
      </div>

      {!existing && (
        <div className="rt-grid">
          <label className="rt-fieldset">
            <span className="rt-label">Chat title</span>
            <input
              className="rt-input rt-chat-title"
              data-testid="target-title"
              maxLength={ROUTINE_CHAT_TITLE_MAX}
              placeholder={defaultRunTitle(draft.name.trim() || 'Routine name', draft.timeZone, Date.now())}
              value={draft.chatTitle}
              onChange={(e) => {
                const chatTitle = e.target.value
                edit((d) => ({ ...d, chatTitle }))
              }}
            />
          </label>
          {group && (
            <label className="rt-fieldset">
              <span className="rt-label">Section</span>
              <span className="rt-sel">
                <RoutineIcon name="section" />
                <SearchSelect
                  className="rt-select"
                  data-testid="target-section"
                  value={shownSection(draft.section, sections)}
                  onChange={(v) => {
                    const section = v
                    edit((d) => ({ ...d, section }))
                  }}
                >
                  <option value="">Outside sections</option>
                  {sections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || 'Untitled section'}
                    </option>
                  ))}
                </SearchSelect>
              </span>
            </label>
          )}
        </div>
      )}

      {group && !existing && (
        <>
          <div className="rt-grid">
            <div className="rt-fieldset">
              <span className="rt-label">Members</span>
              <span className="rt-pop-wrap" onMouseDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="rt-pill rt-pick"
                  data-testid="target-members"
                  aria-haspopup="menu"
                  aria-expanded={membersOpen}
                  onClick={() => setMembersOpen((o) => !o)}
                >
                  {members.length > 0 && <MemberStack agents={members} size={18} working={[]} max={3} />}
                  <span>{draft.groupMembers.length > 0 ? membersLabel(draft.groupMembers.length) : 'Select agents'}</span>
                  <Caret />
                </button>
                {membersOpen && (
                  <div className="menu rt-members-menu" role="menu">
                    <MenuSearch />
                    <MembersMenu
                      agents={agents}
                      selected={draft.groupMembers}
                      disabled={false}
                      keepMinimum={false}
                      optionTestId="target-member-option"
                      onChange={(next) => edit((d) => ({ ...d, groupMembers: next }))}
                    />
                  </div>
                )}
              </span>
            </div>
          </div>
          <label className="rt-fieldset">
            <span className="rt-label">Rules</span>
            <textarea
              className="rt-input rt-role"
              data-testid="target-role"
              rows={3}
              maxLength={ROLE_MAX_CHARS}
              placeholder="How this team works. Every agent and the moderator read it."
              value={draft.role}
              onChange={(e) => edit((d) => ({ ...d, role: e.target.value }))}
            />
          </label>
        </>
      )}

      {showFolder && (
        <div className="rt-fieldset">
          <span className="rt-label">Folder</span>
          <button
            type="button"
            className="rt-pill rt-pick"
            data-testid="target-folder"
            data-tip={draft.cwd || undefined}
            onClick={chooseFolder}
          >
            <FolderIcon />
            <span>{draft.cwd ? folderName(draft.cwd) : 'Choose folder'}</span>
          </button>
          <span className="rt-hint rt-folder-hint">The folder the agent works in.</span>
        </div>
      )}

      <div className="rt-fieldset">
        <span className="rt-label">Prompt</span>
        {/* Chips exist only for webhook routines; switching the trigger remounts the editor in the other mode. */}
        <div className={promptTall ? 'rt-prompt-wrap tall' : 'rt-prompt-wrap'}>
          <PromptField
            key={fields === null ? 'plain' : 'chips'}
            value={draft.prompt}
            onChange={(prompt) => edit((d) => ({ ...d, prompt, command: keepPick(prompt, d.command) }))}
            fields={fields}
            insertRef={insertRef}
            commandAgents={commandTarget.agents}
            grouped={commandTarget.grouped}
            pick={keepPick(draft.prompt, draft.command)}
            onPick={(command) => edit((d) => ({ ...d, command }))}
          />
          <button
            type="button"
            className="rt-prompt-expand"
            data-testid="prompt-expand"
            aria-pressed={promptTall}
            aria-label={promptTall ? 'Shrink prompt' : 'Expand prompt'}
            data-tip={promptTall ? 'Shrink prompt' : 'Expand prompt'}
            onClick={() => setPromptTall((t) => !t)}
          >
            <RoutineIcon name="expand" />
          </button>
        </div>
        {fields !== null && <div className="rt-hint">Type {'{{'} to insert a field from the test call, or use Insert above.</div>}
        {hasCommands && (
          <div className="rt-hint" data-testid="prompt-command-hint">
            Start with / to run an agent's command.
          </div>
        )}
      </div>
    </section>
  )
}
