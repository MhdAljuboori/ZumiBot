import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommandPick } from '@zumibot/shared/commands'
import { engineCaps, engineOfAgent, type CodexInfo } from '@zumibot/shared/engine'
import { isChatMode, isEffort } from '@zumibot/shared/chatRun'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { api } from '../api'
import { askableAgents } from '../state/agentAsk'
import { cliMissing } from '../state/agentEngine'
import { modelPicker, newChatModelSource } from '../state/commandModel'
import { effortPicker, modePicker } from '../state/runPickers'
import { SUGGEST_DEBOUNCE_MS, suggestQuery } from '../state/agentSuggest'
import type { DraftFiles } from '../state/draftFiles'
import { GROUP_LABEL, GROUP_PLACEHOLDER, memberAgents, membersLabel } from '../state/groupChat'
import { NO_FOLDER_LABEL } from '@zumibot/shared/scratch'
import {
  NEW_CHAT_RUN_WORKFLOW_NOTICE,
  NEW_CHAT_LATER_NOTICE,
  groupBlockedReason,
  newChatTarget,
  parentPath,
  recentFolders,
  type NewChatDraft
} from '../state/newChat'
import { folderName } from '../state/sidebarTree'
import { useNarrow } from '../media'
import { useFitRow } from '../useFitRow'
import { useEngineCommands } from '../net/useEngineCommands'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'
import { AgentIntro } from './AgentIntro'
import { BotIcon } from './BotIcon'
import { Caret } from './Caret'
import { RemoteChip } from './RemoteChip'
import { OFFLINE_REASON } from './ConnectionBar'
import { Composer } from './Composer'
import { DropZone } from './DropZone'
import { FolderIcon } from './FolderIcon'
import { MenuIcon } from './MenuIcon'
import { MenuSearch } from './MenuSearch'
import { MemberStack } from './MemberStack'
import { MembersMenu } from './MembersMenu'
import { ModelPicker } from './ModelPicker'
import { ChoicePicker } from './ChoicePicker'
import { RoleChip } from './RoleMenu'
import { RunPicker } from './RunPicker'

const PROMPT = 'Describe a task or ask a question'

type Menu = { kind: 'agent' | 'members' | 'folder'; left: number; top?: number; bottom?: number }

interface Props {
  agents: AgentSummary[]
  chats: ChatMeta[]
  draft: NewChatDraft
  /** The agent start screen: the picked agent's intro above a bottom composer, the way an empty chat looks. */
  intro?: boolean
  claudeFound: boolean
  /** What Codex reports here; undefined until it answers. A Codex agent's first message waits on codex, never on claude. */
  codexInfo?: CodexInfo
  /** The socket is down: sending waits for the reconnect. */
  offline: boolean
  onDraftChange: (draft: NewChatDraft) => void
  /** Opens the system folder dialog; App stores the answer in the draft. */
  onChooseFolder: () => void
  /** The picked folder's git state, from the server: whether it is in a repo and whether its repo's worktree toggle is on. null until known. */
  git: { repo: boolean; worktree: boolean } | null
  /** Saves the toggle for the folder's repo at once; it is a remembered setting, not draft state. */
  onToggleWorktree: (on: boolean) => void
  /**
   * `text` is the composer's own, newer than `draft.text` when a dictation inserted it just before its held send.
   * `pick` is the composer's `/` menu pick, when the text still starts with it.
   */
  onSend: (text: string, pick?: CommandPick) => void
  files: DraftFiles
  onAddFiles: (files: File[], origin: 'paste' | 'drop') => void
  onPickFiles: () => void
  onRemoveFile: (key: string) => void
}

/**
 * The no-chat-open screen: a composer whose Send starts a chat once an agent and a folder are picked.
 * In group mode the agent picker becomes the members picker, and Send starts a group chat.
 */
export function NewChatView({
  agents,
  chats,
  draft,
  intro = false,
  claudeFound,
  codexInfo,
  offline,
  onDraftChange,
  onChooseFolder,
  git,
  onToggleWorktree,
  onSend,
  files,
  onAddFiles,
  onPickFiles,
  onRemoveFile
}: Props) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, closeMenu)
  const menuRef = useRef<HTMLDivElement>(null)
  useFitInViewport(menuRef, menu)

  const group = draft.mode === 'group'
  const pickable = agents.filter((a) => a.error === null)
  const agent = group ? undefined : pickable.find((a) => a.name === draft.agentName)
  const draftMembers = draft.members
  // Stable references: the Composer repaints its colours whenever these change.
  const members = useMemo(() => (group ? memberAgents(draftMembers, agents) : []), [group, draftMembers, agents])
  const loadable = useMemo(() => members.filter((a) => a.error === null), [members])
  const singleAgents = useMemo(() => (agent ? [agent] : undefined), [agent])
  // The picked agent's own engine rows; a null folder is the scratch one, which the server maps to home.
  const engineCommands = useEngineCommands(agent ? agent.name : null, draft.cwd)
  // A single chat's `@` asks another agent, from its first message on; Zumi Bot has no ask tool, so no menu there.
  const agentName = agent?.name
  const agentBuiltIn = agent?.builtIn === true
  const askable = useMemo(
    () => (agentName !== undefined && !agentBuiltIn ? askableAgents(agents, agentName) : undefined),
    [agents, agentName, agentBuiltIn]
  )
  // A built-in agent always runs in its own folder, so it needs no folder and shows no folder picker.
  const folderSet = agent?.builtIn === true || draft.cwd !== null
  // The picked agent's engine decides which CLI the first message needs; a room's moderator needs claude, whatever its members run on.
  const engine = group ? 'claude' : engineOfAgent(agent)
  const missingCli = cliMissing(engine, claudeFound, codexInfo)
  const blockedReason = offline
    ? OFFLINE_REASON
    : missingCli !== null
      ? missingCli
      : group
        ? groupBlockedReason(draft, agents)
        : newChatTarget(draft, agents) !== null
          ? null
          : 'Pick an agent first'
  const folders = recentFolders(agents, chats)
  // The first message starts the session, so the picker previews any command's model; a pick here becomes the chat's.
  const modelView = group ? null : modelPicker(newChatModelSource(draft.model), agent, draft.text, codexInfo?.models)
  // Picks here become the new chat's own before its first message, so a chat can start in Plan mode.
  const modeView = group || !agent ? null : modePicker(engineOfAgent(agent), draft)
  const effortView = group || !agent ? null : effortPicker(engineOfAgent(agent), draft)
  const introAgent = intro ? agent : undefined
  const narrow = useNarrow()
  // A narrow pane on a wide window (sidebar open, a small window) merges the run pickers too, as on a phone, and the
  // row keeps to one line there with its labels cut to fit (`.pickers.compact`).
  const fit = useFitRow(!narrow)
  const compact = narrow || fit.compact
  // On an agent's start screen its intro and the "Message <agent>" placeholder already name it, so a compact row
  // gives the agent chip's room to the run and folder chips: just its icon (the name stays in the DOM, hidden).
  const agentIconOnly = compact && introAgent !== undefined

  // Jev's pick for the message typed so far, asked after a pause in typing. The server answers null while Jev is off.
  const query = suggestQuery(draft, agents)
  // Kept with the text it answers: a pick for older text must not be offered for what is typed now.
  const [suggested, setSuggested] = useState<{ query: string; agent: string | null } | null>(null)
  useEffect(() => {
    if (query === null) return
    let live = true
    const t = setTimeout(() => {
      api.jev.suggestAgent(query).then(
        (agent) => {
          if (live) setSuggested({ query, agent })
        },
        () => {}
      )
    }, SUGGEST_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query])
  const suggestion = suggested === null || suggested.query !== query ? undefined : pickable.find((a) => a.name === suggested.agent)

  const toggle = (kind: Menu['kind'], button: HTMLElement): void => {
    const r = button.getBoundingClientRect()
    // Under an intro the pickers sit at the bottom of the window, so menus open upward.
    const at = introAgent ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }
    setMenu(menu?.kind === kind ? null : { kind, left: r.left, ...at })
  }
  const choose = (change: Partial<NewChatDraft>): void => {
    setMenu(null)
    onDraftChange({ ...draft, ...change })
  }

  return (
    <DropZone className={introAgent ? 'chat' : 'new-chat'} testId="new-chat" onFiles={(f) => onAddFiles(f, 'drop')}>
      {introAgent && (
        <div className="messages">
          <AgentIntro agent={introAgent} />
        </div>
      )}
      {!introAgent && (
        <div className="new-chat-hello" aria-hidden="true">
          <BotIcon icon={null} color={null} builtIn working={false} size={44} />
          <p className="new-chat-hello-title">{group ? 'Who should join the room?' : 'What are we building today?'}</p>
        </div>
      )}
      <Composer
        label={introAgent ? `Message ${displayName(introAgent.name)}` : group ? GROUP_LABEL : PROMPT}
        placeholder={introAgent ? undefined : group ? GROUP_PLACEHOLDER : PROMPT}
        draft={draft.text}
        inFlight={false}
        cliFound={missingCli === null}
        blockedReason={blockedReason}
        mentionMembers={group ? loadable : askable}
        everyone={group}
        commandAgents={group ? loadable : singleAgents}
        engineCommands={engineCommands}
        btw={engineCaps(engine).btw}
        runWorkflow={false}
        noRunWorkflow={NEW_CHAT_RUN_WORKFLOW_NOTICE}
        noLater={NEW_CHAT_LATER_NOTICE}
        onDraftChange={(text) => onDraftChange({ ...draft, text })}
        onSend={onSend}
        files={files}
        onAddFiles={onAddFiles}
        onPickFiles={onPickFiles}
        onRemoveFile={onRemoveFile}
        onStop={() => {}}
      >
        <div ref={fit.ref} className={compact ? 'pickers compact' : 'pickers'}>
          {group ? (
            <button
              type="button"
              className={['picker', members.length > 0 && 'set', menu?.kind === 'members' && 'open'].filter(Boolean).join(' ')}
              data-testid="new-chat-members"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'members'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => toggle('members', e.currentTarget)}
            >
              {members.length > 0 ? (
                <MemberStack agents={members} size={20} working={[]} max={3} />
              ) : (
                <BotIcon icon={null} color={null} working={false} size={16} />
              )}
              <span className="picker-text">{draft.members.length > 0 ? membersLabel(draft.members.length) : 'Select agents'}</span>
              <Caret />
            </button>
          ) : (
            <button
              type="button"
              className={['picker', agent && 'set', menu?.kind === 'agent' && 'open', agentIconOnly && 'icon-only']
                .filter(Boolean)
                .join(' ')}
              data-testid="new-chat-agent"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'agent'}
              aria-label={agentIconOnly && introAgent ? displayName(introAgent.name) : undefined}
              data-tip={agentIconOnly && introAgent ? displayName(introAgent.name) : undefined}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => toggle('agent', e.currentTarget)}
            >
              <BotIcon icon={agent?.icon ?? null} color={agent?.color ?? null} builtIn={agent?.builtIn} working={false} size={16} />
              <span className="picker-text">{agent ? displayName(agent.name) : 'Select agent'}</span>
              <Caret />
            </button>
          )}
          {/* A room has no remote member, so only a single chat's agent can carry the chip. */}
          <RemoteChip agent={agent} />
          {/* One chip on a phone or a narrow pane, as under an open chat, so the row fits beside the agent and folder. */}
          {compact ? (
            <RunPicker
              model={modelView}
              mode={modeView}
              effort={effortView}
              testId="new-chat-run"
              onModel={(model) => onDraftChange({ ...draft, model: model ?? undefined })}
              onMode={(v) => onDraftChange({ ...draft, permissionMode: isChatMode(v) ? v : undefined })}
              onEffort={(v) => onDraftChange({ ...draft, effort: isEffort(v) ? v : undefined })}
            />
          ) : (
            <>
              {modelView && (
                <ModelPicker
                  view={modelView}
                  testId="new-chat-model"
                  onPick={(model) => onDraftChange({ ...draft, model: model ?? undefined })}
                />
              )}
              {modeView && (
                <ChoicePicker
                  view={modeView}
                  testId="new-chat-mode"
                  menuTestId="chat-mode-menu"
                  optionTestId="chat-mode-option"
                  onPick={(v) => onDraftChange({ ...draft, permissionMode: isChatMode(v) ? v : undefined })}
                />
              )}
              {effortView && (
                <ChoicePicker
                  view={effortView}
                  testId="new-chat-effort"
                  menuTestId="chat-effort-menu"
                  optionTestId="chat-effort-option"
                  onPick={(v) => onDraftChange({ ...draft, effort: isEffort(v) ? v : undefined })}
                />
              )}
            </>
          )}
          {suggestion && (
            <button
              type="button"
              className="picker suggest"
              data-testid="new-chat-suggestion"
              data-agent-name={suggestion.name}
              data-tip="Jev's pick for this message. Click to use it."
              onClick={() => choose({ agentName: suggestion.name })}
            >
              <BotIcon icon={suggestion.icon} color={suggestion.color} builtIn={suggestion.builtIn} working={false} size={16} />
              <span className="picker-text">Use {displayName(suggestion.name)}?</span>
            </button>
          )}
          {!agent?.builtIn && (
            <button
              type="button"
              className={['picker', folderSet && 'set', menu?.kind === 'folder' && 'open'].filter(Boolean).join(' ')}
              data-testid="new-chat-folder"
              aria-haspopup="menu"
              aria-expanded={menu?.kind === 'folder'}
              data-tip={draft.cwd ?? undefined}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => toggle('folder', e.currentTarget)}
            >
              <FolderIcon />
              <span className="picker-text">{draft.cwd !== null ? folderName(draft.cwd) : NO_FOLDER_LABEL}</span>
              {git?.worktree && draft.cwd !== null && (
                <MenuIcon name="gitBranch" className="menu-icon git-icon" data-testid="new-chat-folder-worktree" />
              )}
              <Caret />
            </button>
          )}
          {group && <RoleChip role={draft.role} onSave={(role) => onDraftChange({ ...draft, role })} />}
        </div>
      </Composer>
      {menu && (
        <div
          ref={menuRef}
          className="menu picker-menu"
          role="menu"
          style={{ left: menu.left, top: menu.top, bottom: menu.bottom }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <MenuSearch />
          {menu.kind === 'members' ? (
            <MembersMenu
              agents={agents}
              selected={draft.members}
              disabled={false}
              keepMinimum={false}
              optionTestId="new-chat-member-option"
              onChange={(next) => onDraftChange({ ...draft, members: next })}
            />
          ) : menu.kind === 'agent' ? (
            pickable.map((a) => (
              <button
                key={a.filePath}
                type="button"
                role="menuitem"
                data-testid="new-chat-agent-option"
                data-agent-name={a.name}
                onClick={() => choose({ agentName: a.name })}
              >
                <BotIcon icon={a.icon} color={a.color} builtIn={a.builtIn} working={false} size={18} />
                <span className="picker-text">{displayName(a.name)}</span>
              </button>
            ))
          ) : (
            <>
              {folders.length > 0 && (
                <>
                  <div className="menu-label">Recent</div>
                  {folders.map((cwd) => (
                    <button
                      key={cwd}
                      type="button"
                      role="menuitem"
                      data-tip={cwd}
                      data-testid="new-chat-folder-option"
                      data-cwd={cwd}
                      onClick={() => choose({ cwd })}
                    >
                      <FolderIcon />
                      <span className="picker-text">{folderName(cwd)}</span>
                      <span className="folder-path">{parentPath(cwd)}</span>
                    </button>
                  ))}
                  <div className="menu-sep" role="separator" />
                </>
              )}
              {draft.cwd !== null && (
                <button
                  type="button"
                  role="menuitem"
                  data-menu-search="keep"
                  data-testid="new-chat-no-folder"
                  data-tip="Runs in a fresh folder of its own"
                  onClick={() => choose({ cwd: null })}
                >
                  <MenuIcon name="folder" />
                  {NO_FOLDER_LABEL}
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                data-menu-search="keep"
                data-testid="new-chat-choose-folder"
                onClick={() => {
                  setMenu(null)
                  onChooseFolder()
                }}
              >
                <MenuIcon name="folderOpen" />
                Choose folder…
              </button>
              {draft.cwd !== null && !agent?.builtIn && (
                <>
                  <div className="menu-sep" role="separator" />
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    className="member-option worktree-option"
                    aria-checked={git?.worktree === true}
                    data-menu-search="keep"
                    disabled={!git?.repo}
                    data-tip={git?.repo === false ? 'Not a git repository' : undefined}
                    data-testid="new-chat-worktree"
                    onClick={() => onToggleWorktree(git?.worktree !== true)}
                  >
                    <span className="check" aria-hidden="true">
                      {git?.worktree === true && (
                        <svg viewBox="0 0 16 16">
                          <path
                            d="M3.5 8.5l3 3 6-7"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </span>
                    <span>Isolate in worktree — runs on its own branch next to the repo</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </DropZone>
  )
}
