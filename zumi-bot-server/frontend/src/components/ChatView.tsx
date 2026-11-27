import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApprovalReply } from '../state/approvals'
import type { ChatViewState } from '../state/chatView'
import type { DraftFiles } from '../state/draftFiles'
import { isSending, type PendingSend } from '../state/pendingSends'
import { replyOptionsOf } from '../state/replyOptions'
import { useSuggestedRepliesOn } from '../useSuggestedReplies'
import { sentTexts } from '../state/promptHistory'
import {
  GROUP_LABEL,
  GROUP_PLACEHOLDER,
  findAgent,
  memberAgents,
  membersLabel,
  missingAgent,
  threadItems,
  workingMembers
} from '../state/groupChat'
import { findReplied, withQuote } from '../state/reply'
import { chatTitle, folderName } from '../state/sidebarTree'
import { loadSet, saveSet } from '../state/storedSet'
import { chatEngine, type CodexInfo } from '@zumibot/shared/engine'
import { isChatMode, isEffort, type ChatMode, type Effort } from '@zumibot/shared/chatRun'
import { pauseControl } from '../state/pause'
import { TRAYS_KEY, tasksHeld, type TrayName } from '../state/tasks'
import { takesSteers, type SendHow } from '../state/sendKeys'
import { visibleTasks } from '../state/runBlocks'
import { newLineItem, sinceOnChange, sinceOnOpen } from '../state/unread'
import { useDismiss } from '../useDismiss'
import { useFitInViewport } from '../useFitInViewport'
import type { CommandPick } from '@zumibot/shared/commands'
import type { SideQuestion } from '@zumibot/shared/btw'
import { ISLAND_BTW_NOTICE, ISLAND_RUN_WORKFLOW_NOTICE } from '../state/island'
import { offersRunWorkflow, type SendNotice } from '../state/sendNotices'
import { routeSend } from '../state/sideQuestions'
import { askableAgents } from '../state/agentAsk'
import { displayName } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta, GitStatus, GroupInfo } from '@zumibot/shared/types'
import { BotIcon } from './BotIcon'
import { Caret } from './Caret'
import { EngineInfo } from './EngineInfo'
import { RemoteChip } from './RemoteChip'
import { OFFLINE_REASON } from './ConnectionBar'
import { AskedBar } from './AskedBar'
import { GitChip } from './GitChip'
import { PrChip } from './PullRequest'
import { worktreeArchiveLine } from '../state/gitStatus'
import { WorkflowChatBar } from './WorkflowChatBar'
import type { AskEnv } from './AskCard'
import { Composer } from './Composer'
import { CostChip } from './CostChip'
import { chatModelSource, modelPicker } from '../state/commandModel'
import { effortPicker, modePicker } from '../state/runPickers'
import { ColdNotice } from './ColdNotice'
import { ContextMeter } from './ContextMeter'
import { DropZone } from './DropZone'
import { FolderIcon } from './FolderIcon'
import { MemberStack } from './MemberStack'
import { MemberList } from './MembersMenu'
import { MenuIcon } from './MenuIcon'
import { MessageList } from './MessageList'
import { ModelPicker } from './ModelPicker'
import { ChoicePicker } from './ChoicePicker'
import { RunPicker } from './RunPicker'
import { RoleChip } from './RoleMenu'
import { ProcessMark, SidePanelToggle } from './SidePanelMenu'
import { useNarrow } from '../media'
import { useFitRow } from '../useFitRow'
import { useEngineCommands } from '../net/useEngineCommands'
import { coldNoticeShown } from '../state/contextMeter'
import { chatCaps, cliMissing, missingFeaturesTitle, roomMissingFeaturesTitle } from '../state/agentEngine'
import { TasksTray } from './TasksTray'
import { ReplyOptions } from './ReplyOptions'
import { PausingLine } from './PausingLine'

interface Props {
  chat: ChatMeta
  agents: AgentSummary[]
  /** A single chat's agent; null for a group chat. */
  agent: AgentSummary | null
  state: ChatViewState
  /** An older page of the history is on its way. */
  loadingOlder: boolean
  onLoadOlder: (until?: string) => void
  /** Messages sent but not yet in the items, shown after them as sent; a failed one is marked. */
  pending: PendingSend[]
  draft: string
  /** The last send or stop failure for this chat; App owns it so it survives switching chats. */
  sendError: string | null
  /** The info line after a `/run-workflow` start; cleared by the chat's next send. */
  sendNotice: SendNotice | null
  onOpenSendNotice: () => void
  onDismissSendNotice: () => void
  /** Whether the chat's tool runs are open; App owns it so it survives switching chats. */
  toolsOpen: boolean
  claudeFound: boolean
  /** The workflows `/run-workflow ` lists in the box. */
  workflows: readonly { id: string; name: string }[]
  /** What Codex reports here; undefined until it answers. A Codex chat's composer waits on codex, never on claude. */
  codexInfo?: CodexInfo
  /** The socket is down: sending waits for the reconnect. */
  offline: boolean
  onDraftChange: (text: string) => void
  onToolsOpenChange: (open: boolean) => void
  /** Opens an agent's Memory in Agent Studio. */
  onViewMemory: (agent: string) => void
  /** Opens the To-dos panel on the reply with this item id. */
  onOpenTodos: (itemId: string) => void
  onSend: (text: string, pick?: CommandPick, workflowId?: string, how?: SendHow) => void
  /** Sends the Continue message after the members paused, leaving the draft as it is. */
  onContinue: () => void
  files: DraftFiles
  onAddFiles: (files: File[], origin: 'paste' | 'drop') => void
  onPickFiles: () => void
  onRemoveFile: (key: string) => void
  onStop: () => void
  /** Asks the server to pause the running reply, and to continue a paused chat. */
  onPause: () => void
  onResume: () => void
  /** The dispatched agents still running in this chat, for the pausing line; 0 when not known. */
  runningAgents?: number
  onDismissError: () => void
  onAnswerApproval: (requestId: string, reply: ApprovalReply, agent?: string) => void
  /** A group chat's role text was saved. */
  onSetRole: (role: string) => void
  /** The id of the agent message the next message replies to, or null. */
  replyTo: string | null
  onReplyChange: (itemId: string | null) => void
  onReact: (itemId: string, emoji: string) => void
  /** Sends a question about part of an agent message: the selected text quoted, replying to that message. */
  onExplain: (itemId: string, selected: string) => void
  /** Each resolves once the request settles; a failure is shown through the chat's send error. */
  onEdit: (itemId: string, text: string, command?: CommandPick) => Promise<void>
  onResend: (itemId: string) => Promise<void>
  onSwitchVersion: (itemId: string, index: number) => Promise<void>
  /** Opens the new chat the fork made. */
  onFork: (itemId: string) => Promise<void>
  onMarkUnread: (itemId: string) => void
  /** Opens Export with an agent message's reply picked. */
  onExportReply: (itemId: string) => void
  /** Removes a queued message before it is sent; resolves false when that failed. */
  onDropTask: (taskId: string) => Promise<boolean>
  /** Sends a queued message now; offered only while the queue holds its tasks (a paused group, or a held chat). */
  onSendTask: (taskId: string) => Promise<boolean>
  /** Compacts the agent's context (a room: the member's); a failure is shown through the chat's send error. */
  onCompact: (note: string, agent?: string) => void
  /** A single chat back on its agent's own model (a command had started it on another). */
  /** A model picked by hand for this chat; null = back to the agent's own, where commands may set one. */
  onSetModel: (model: string | null) => void
  onSetPermissionMode: (mode: ChatMode | null) => void
  onSetEffort: (effort: Effort | null) => void
  /** Don't continue: a chat the usage limit stopped stays stopped at the reset, its tasks held; a failure shows as the send error. */
  onCancelResume: () => void
  /** Continue now: the usage limit wait's continue goes in at once, ahead of the queued tasks; a failure shows as the send error. */
  onContinueNow: () => void
  /** Opens the Usage page filtered to this chat. */
  onOpenUsage: () => void
  /** The side panel (its list, Files, side questions or the browser) is on screen; the icon above the chat opens and closes it. */
  sideOpen: boolean
  onToggleSide: () => void
  /** The chat's running background processes, as the header's mark shows them (null: none, so no mark). */
  processMark?: { count: string; label: string } | null
  onOpenProcesses?: () => void
  /** The chat's side questions: their chips sit in the list; the side panel's list opens their view. */
  sides: SideQuestion[]
  onOpenSide: (id: string) => void
  /** A room: opens the Clone room dialog. */
  onCloneRoom: () => void
  /** A cloned room's handoff card: whether the room it came from is still listed, and opening it. */
  handoffSourceExists: boolean
  onOpenHandoffSource: () => void
  /** An asked chat (another agent started it): whether the chat it was asked from is still listed, and opening it. */
  askedSourceExists: boolean
  onOpenAskedSource: () => void
  /** A workflow Agent step's chat: the step's name in the workflow now (undefined once gone), and opening the run. */
  workflowStepName: string | undefined
  /** Sends the continue text after the user allowed a command Auto mode refused. */
  onAllowed?: (text: string) => void
  /** Sends a suggested reply's text alone: the draft, its files and its reply quote stay in the box. */
  onPickReply: (text: string) => void
  onOpenWorkflowRun: () => void
  /** What the ask cards in the chat need: the asked chats, their live cards, answering and opening them. */
  asks: AskEnv
  /** The chat is in Archived: a note over it says so, with Unarchive. Sending a message brings it back by itself. */
  archived: boolean
  onUnarchive: () => void
  /** Show in chat from the Files panel, To-dos or Side questions, or a search hit (with its query). */
  showRequest: { itemId: string; n: number; query?: string } | null
  /** Bumped by App when it put a quote in the draft: the composer takes the caret. */
  focusRequest: number
  /** The chat's branch and uncommitted count for the git chip (App reads it, the side panel's list shows it too); null hides the chip. */
  git: GitStatus | null
  /** The side panel shows this chat's Changes: the git chip reads pressed, and a click closes it again. */
  changesOpen: boolean
  onToggleChanges: () => void
  /**
   * The island's popup: the chat as a quick exchange. No top bar, side chips, to-dos links, memory link, pickers row,
   * cold notice or workflow bar; the history, older pages and the New line stay.
   */
  compact?: boolean
}

// Stable, so the island's list does not see a new array on every render.
const NO_SIDES: SideQuestion[] = []

/** The picked folder, and for a worktree chat the folder it really runs in. */
const folderTitle = (chat: ChatMeta): string => (chat.worktree ? `${chat.worktree.folder}\nWorktree: ${chat.cwd}` : chat.cwd)

/** The chat's folder, locked. A compact row keeps only its icon; the name and the whole path stay in its title. */
function FolderChip({ chat, iconOnly }: { chat: ChatMeta; iconOnly: boolean }) {
  return (
    <button
      type="button"
      className="picker set"
      data-testid="chat-folder"
      disabled
      data-tip={folderTitle(chat)}
      aria-label={iconOnly ? `Folder: ${folderName(chat.worktree?.folder ?? chat.cwd)}` : undefined}
    >
      <FolderIcon />
      {!iconOnly && <span className="picker-text">{folderName(chat.worktree?.folder ?? chat.cwd)}</span>}
    </button>
  )
}

/** The group's members picker (opens a read-only list of who is in the group) and its locked folder. */
function GroupPickers({
  chat,
  group,
  agents,
  working,
  onSetRole,
  meter,
  cost,
  gitChip
}: {
  chat: ChatMeta
  group: GroupInfo
  agents: AgentSummary[]
  working: readonly string[]
  onSetRole: (role: string) => void
  meter: ReactNode
  cost: ReactNode
  gitChip: ReactNode
}) {
  // Opens upward: the pickers sit at the bottom of the window.
  const [menu, setMenu] = useState<{ left: number; bottom: number } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  useDismiss(menu !== null, closeMenu)
  const menuRef = useRef<HTMLDivElement>(null)
  useFitInViewport(menuRef, menu)
  // On a phone the locked folder is in the side panel, so the row keeps to one line; a narrow pane keeps its icon.
  const narrow = useNarrow()
  const fit = useFitRow(!narrow)
  return (
    <>
      <div ref={fit.ref} className={fit.compact ? 'pickers one-line compact' : 'pickers one-line'}>
        <button
          type="button"
          className={menu ? 'picker set members-picker open' : 'picker set members-picker'}
          data-testid="chat-members"
          aria-expanded={menu !== null}
          data-tip="Members"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu(menu ? null : { left: r.left, bottom: window.innerHeight - r.top + 4 })
          }}
        >
          <MemberStack agents={memberAgents(group.members, agents)} size={20} working={working} max={3} />
          <span className="picker-text">{membersLabel(group.members.length)}</span>
          <Caret />
        </button>
        {!narrow && <FolderChip chat={chat} iconOnly={fit.compact} />}
        <EngineInfo text={roomMissingFeaturesTitle(chatCaps(chat, agents))} />
        {gitChip}
        <RoleChip role={group.role} onSave={onSetRole} />
        <span className="pickers-end">
          {meter}
          {cost}
        </span>
      </div>
      {menu && (
        <div
          ref={menuRef}
          className="menu picker-menu"
          style={{ left: menu.left, bottom: menu.bottom }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <MemberList agents={agents} members={group.members} working={working} />
        </div>
      )}
    </>
  )
}

export function ChatView({
  chat,
  agents,
  agent,
  state,
  loadingOlder,
  onLoadOlder,
  pending,
  draft,
  sendError,
  sendNotice,
  onOpenSendNotice,
  onDismissSendNotice,
  toolsOpen,
  claudeFound,
  workflows,
  codexInfo,
  offline,
  onDraftChange,
  onToolsOpenChange,
  onViewMemory,
  onOpenTodos,
  onSend,
  onContinue,
  files,
  onAddFiles,
  onPickFiles,
  onRemoveFile,
  onStop,
  onPause,
  onResume,
  runningAgents = 0,
  onDismissError,
  onAnswerApproval,
  onSetRole,
  replyTo,
  onReplyChange,
  onReact,
  onExplain,
  onEdit,
  onResend,
  onSwitchVersion,
  onFork,
  onMarkUnread,
  onExportReply,
  onDropTask,
  onSendTask,
  onCompact,
  onSetModel,
  onSetPermissionMode,
  onSetEffort,
  onCancelResume,
  onContinueNow,
  onOpenUsage,
  sideOpen,
  onToggleSide,
  processMark = null,
  onOpenProcesses,
  sides,
  onOpenSide,
  onCloneRoom,
  handoffSourceExists,
  onOpenHandoffSource,
  askedSourceExists,
  onOpenAskedSource,
  workflowStepName,
  onAllowed,
  onPickReply,
  onOpenWorkflowRun,
  asks,
  archived,
  onUnarchive,
  showRequest,
  focusRequest: externalFocus,
  git,
  changesOpen,
  onToggleChanges,
  compact = false
}: Props) {
  // The row over the chat names it (its agent or members, then its title) and holds the side panel's icon: Files and the
  // browser are chosen inside the panel. On a small screen the mobile bar (App) does both, so this row shows only for
  // the archived note there: a row of its own would cost a line.
  const narrow = useNarrow()
  // The row under the composer goes compact when its full layout would not fit: on a phone, or a narrow pane.
  const fit = useFitRow(!narrow && !compact)
  const short = narrow || fit.compact
  // Only the pickers row shows it, and the island's popup has none.
  const gitChip = (
    <>
      <GitChip status={git} worktree={chat.worktree} open={changesOpen} onToggle={onToggleChanges} />
      <PrChip pr={chat.pr} />
    </>
  )
  const archiveLine = archived ? worktreeArchiveLine(chat.worktree) : null
  const archivedNote = archived && (
    <div className="archived-note" role="status" data-testid="archived-note">
      <MenuIcon name="archive" />
      <span className="archived-note-text">
        {chat.asked
          ? `Archived. A new ask from @${displayName(chat.asked.by)} brings it back.`
          : 'Archived. Sending a message brings it back.'}
        {archiveLine !== null && (
          <span className="archived-worktree" data-testid="archived-worktree">
            {archiveLine}
          </span>
        )}
      </span>
      <button type="button" className="archived-unarchive" data-testid="archived-unarchive" onClick={onUnarchive}>
        Unarchive
      </button>
    </div>
  )
  const title = chatTitle(chat, agents)
  const titleIcon = chat.group ? (
    <MemberStack agents={memberAgents(chat.group.members, agents)} size={22} working={workingMembers(chat)} max={3} />
  ) : agent ? (
    <BotIcon icon={agent.icon} color={agent.error === null ? agent.color : null} builtIn={agent.builtIn} working={false} size={22} />
  ) : null
  const top = narrow ? (
    archivedNote && <div className="chat-top">{archivedNote}</div>
  ) : (
    <>
      <div className="chat-top">
        <div className="chat-title" data-testid="chat-title">
          {titleIcon}
          <h1 className="chat-title-text" data-tip={title}>
            {title}
          </h1>
        </div>
        {!compact && onOpenProcesses && <ProcessMark mark={processMark} onOpen={onOpenProcesses} />}
        <SidePanelToggle open={sideOpen} onToggle={onToggleSide} />
      </div>
      {archivedNote && <div className="chat-top">{archivedNote}</div>}
    </>
  )
  // The trays the user collapsed: remembered per browser, the same in every chat.
  const [collapsed, setCollapsed] = useState(() => loadSet(TRAYS_KEY))
  const toggleTray = (tray: TrayName): void => {
    const next = new Set(collapsed)
    if (!next.delete(tray)) next.add(tray)
    saveSet(TRAYS_KEY, next)
    setCollapsed(next)
  }
  // Quoting puts the selected text in the draft, after what is typed, replies to its message and moves the caret there.
  const [ownFocus, setOwnFocus] = useState(0)
  // App's bumps count from when this view opened, so a quote put in another chat's draft does not focus this one.
  const firstFocus = useRef(externalFocus)
  const focusRequest = ownFocus + (externalFocus - firstFocus.current)
  const quote = (itemId: string, selected: string): void => {
    onReplyChange(itemId)
    onDraftChange(withQuote(draft, selected))
    setOwnFocus((n) => n + 1)
  }
  // Where the New line starts. Held, not derived from the meta: the server's read lands a moment after the open and
  // must not move it. The view remounts per chat, so leaving the chat drops it.
  const [since, setSince] = useState(() => sinceOnOpen(chat))
  const prevChat = useRef(chat)
  useEffect(() => {
    const prev = prevChat.current
    prevChat.current = chat
    if (prev !== chat) setSince((s) => sinceOnChange(s, prev, chat))
  }, [chat])
  // Anything the user sends puts them past the line: Edit, Resend and Send now too, or the line would land on the reply
  // they asked for. Switching versions, forking (another chat), compacting and answering a card send nothing.
  const send = (text: string, pick?: CommandPick, workflowId?: string, how?: SendHow): void => {
    if (routeSend(text).kind === 'send') setSince(null)
    onSend(text, pick, workflowId, how)
  }
  const continueChat = (): void => {
    setSince(null)
    onContinue()
  }
  const resumeChat = (): void => {
    setSince(null)
    onResume()
  }
  const explain = (itemId: string, selected: string): void => {
    setSince(null)
    onExplain(itemId, selected)
  }
  const edit = (itemId: string, text: string, command?: CommandPick): Promise<void> => {
    setSince(null)
    return onEdit(itemId, text, command)
  }
  const resend = (itemId: string): Promise<void> => {
    setSince(null)
    return onResend(itemId)
  }
  const sendTask = (taskId: string): Promise<boolean> => {
    setSince(null)
    return onSendTask(taskId)
  }
  // The card shows while the user types, so a pick must not take their draft with it.
  const pickReply = (text: string): void => {
    setSince(null)
    onPickReply(text)
  }
  // What this chat's engine can do: what it cannot (a Codex feature a later probe turned off) is left out. A room's engine is its
  // moderator's (Claude); its controls follow its members' engines (chatCaps).
  const engine = chatEngine(chat, agents)
  const caps = chatCaps(chat, agents)
  // The chat's own CLI: codex for a Codex chat, claude for every other.
  const missingCli = cliMissing(engine, claudeFound, codexInfo)
  const cliFound = missingCli === null
  const replied = findReplied(state.items, replyTo)
  const author = replied?.agent ?? chat.agentName
  const reply = replied ? { id: replied.id, agent: findAgent(agents, author) ?? missingAgent(author), text: replied.text } : null
  // A single chat runs from the moment its message is sent, not from when the server says so: no gap to see.
  const running = chat.inFlight || (!chat.group && isSending(pending))
  const repliesOn = useSuggestedRepliesOn()
  // A room's send is pending until the server says it runs: counted here so a clicked option hides at once there too.
  const offered = replyOptionsOf({
    on: repliesOn,
    suggested: chat.suggested,
    lastItemId: state.items.at(-1)?.id ?? null,
    running: running || isSending(pending),
    draftEmpty: draft.trim() === '' && files.files.length === 0 && replyTo === null
  })
  const suggestion = offered && 'placeholder' in offered ? offered.placeholder : undefined
  const failed = Object.fromEntries(pending.flatMap((p) => (p.error === null ? [] : [[p.item.id, p.error]])))
  const history = sentTexts([...state.items, ...pending.map((p) => p.item)], chat.tasks)
  // Stable references: the Composer repaints its colours whenever these change, and a streaming delta re-renders this view.
  // Room order; a member that failed to load can be neither mentioned nor asked for a command.
  const roomMembers = chat.group?.members
  const loadable = useMemo(
    () => (roomMembers ? memberAgents(roomMembers, agents).filter((a) => a.error === null) : []),
    [roomMembers, agents]
  )
  const singleAgents = useMemo(() => (agent ? [agent] : undefined), [agent])
  // Engine rows only for a single chat's own composer (a room and the island's popup have none).
  const engineCommands = useEngineCommands(chat.group || compact ? null : chat.agentName, chat.cwd)
  // A single chat's `@` asks another agent: the same list a room uses, without the chat's own agent.
  const selfName = chat.agentName
  const askable = useMemo(() => askableAgents(agents, selfName), [agents, selfName])
  const listItems = pending.length === 0 ? state.items : [...state.items, ...pending.map((p) => p.item)]
  // Under the reply that asked, in the thread's scroll: pinned over the box it hid the reply on a phone's short screen.
  const replyButtons = offered && 'buttons' in offered && (
    <ReplyOptions
      options={offered.buttons}
      question={offered.question}
      summary={offered.summary}
      disabled={offline || !cliFound}
      onPick={pickReply}
    />
  )
  const list = (
    <MessageList
      chat={running === chat.inFlight ? chat : { ...chat, inFlight: running }}
      agents={agents}
      items={listItems}
      sides={compact ? NO_SIDES : sides}
      onOpenSide={onOpenSide}
      loading={state.start === null && pending.length === 0}
      quoted={state.quoted}
      hasOlder={(state.start ?? 0) > 0}
      loadingOlder={loadingOlder}
      onLoadOlder={onLoadOlder}
      failed={failed}
      streaming={state.streaming}
      streamingBy={state.streamingBy}
      thought={state.thought}
      thoughtBy={state.thoughtBy}
      localError={sendError}
      localNotice={sendNotice}
      onOpenNotice={onOpenSendNotice}
      onDismissNotice={onDismissSendNotice}
      toolsOpen={toolsOpen}
      onToolsOpenChange={onToolsOpenChange}
      // Memory is an Agent Studio view, so the popup offers no link to it.
      {...(compact ? {} : { onViewMemory })}
      // The page lists the chat's to-dos above the box, so a reply's chip there opens nothing.
      {...(compact ? {} : { onOpenTodos })}
      onDismissError={onDismissError}
      onAnswerApproval={onAnswerApproval}
      onReply={onReplyChange}
      onReact={onReact}
      onQuote={quote}
      // Nothing can be sent in an asked chat, so there is nothing to explain or continue.
      onExplain={offline || !cliFound || chat.asked ? null : explain}
      onContinue={offline || !cliFound || chat.asked ? null : continueChat}
      onResume={offline || !cliFound || chat.asked ? null : resumeChat}
      onCancelResume={offline ? null : onCancelResume}
      onContinueNow={offline || !cliFound || chat.asked ? null : onContinueNow}
      pendingIds={new Set(pending.map((p) => p.item.id))}
      caps={caps}
      commandAgents={chat.group ? loadable : singleAgents}
      mentionMembers={chat.group ? loadable : askable}
      onEdit={edit}
      onResend={resend}
      onSwitchVersion={onSwitchVersion}
      onFork={onFork}
      onMarkUnread={onMarkUnread}
      {...(compact ? {} : { onExport: onExportReply })}
      // A room's running turns are drawn after its finished ones and move when they end, so the line is looked for among those.
      newLineBefore={newLineItem(chat.group ? threadItems(state.items) : state.items, since, (state.start ?? 0) > 0)}
      showRequest={showRequest}
      handoffSourceExists={handoffSourceExists}
      onOpenHandoffSource={onOpenHandoffSource}
      asks={asks}
      workflowStepName={workflowStepName}
      {...(offline || !cliFound || chat.asked || !onAllowed ? {} : { onAllowed })}
      {...(chat.asked ? { readOnly: true } : {})}
      afterItems={replyButtons}
    />
  )
  // The page's box has no top bar, nor pickers under its composer (below): the page's own head names the chat.
  const shownTop = compact ? null : top
  // Send now only where the queue holds its tasks (a paused group, or a chat an edit or resend held); everywhere else it sends them itself.
  // A Run's result waiting to go is the agent's, never a row of the user's. Memoized: the tray re-checks focus on a new list.
  const shownTasks = useMemo(() => visibleTasks(chat.tasks), [chat.tasks])
  // Messages written into the running reply that it has not read yet: drawn above the tasks, which go after the reply.
  const steering = chat.steering ?? []
  const tasksTray = (shownTasks.length > 0 || steering.length > 0) && (
    <TasksTray
      tasks={shownTasks}
      steering={steering}
      open={!collapsed.has('tasks')}
      onToggle={() => toggleTray('tasks')}
      onDrop={onDropTask}
      onSend={tasksHeld(chat, state.items) && !offline && cliFound ? sendTask : null}
    />
  )

  // Compacting is its own run: it waits for the reply, like an edit would not.
  const meter = (
    <ContextMeter
      chat={chat}
      agents={agents}
      blockedReason={running ? 'Wait for the reply to finish' : offline ? OFFLINE_REASON : missingCli}
      onCompact={onCompact}
      engine={engine}
      {...(chat.group ? { onCloneRoom } : {})}
    />
  )

  const cost = <CostChip chatId={chat.id} room={chat.group !== undefined} onOpenUsage={onOpenUsage} />
  const modelView = modelPicker(chatModelSource(chat), agent ?? undefined, draft, codexInfo?.models)
  // A single chat's own; a room's members run on their agents' defaults.
  const modeView = agent && !chat.group ? modePicker(engine, chat) : null
  const effortView = agent && !chat.group ? effortPicker(engine, chat) : null
  const cold = compact ? null : (
    <ColdNotice
      chat={chat}
      agents={agents}
      cacheCools={coldNoticeShown(engine)}
      blockedReason={offline ? OFFLINE_REASON : missingCli}
      onCompact={onCompact}
    />
  )

  // Another agent started this chat: the user reads it, with no composer, drafts or tray.
  if (chat.asked) {
    return (
      <div className="chat">
        {shownTop}
        {list}
        <AskedBar
          asked={chat.asked}
          agentName={chat.agentName}
          agents={agents}
          sourceExists={askedSourceExists}
          onOpenSource={onOpenAskedSource}
        />
      </div>
    )
  }

  const group = chat.group
  if (group) {
    // Every member taking a turn bobs; its turn in the thread shows whether it waits on the user.
    const working = workingMembers(chat)
    return (
      <DropZone className="chat" onFiles={(f) => onAddFiles(f, 'drop')}>
        {shownTop}
        {chat.workflow && !compact && <WorkflowChatBar link={chat.workflow} stepName={workflowStepName} onOpen={onOpenWorkflowRun} />}
        {list}
        {cold}
        {chat.pause === 'pausing' && chat.inFlight && <PausingLine running={runningAgents} />}
        {/* Right over the box: the queued messages read as what goes next from it. */}
        {tasksTray}
        <Composer
          label={GROUP_LABEL}
          placeholder={GROUP_PLACEHOLDER}
          suggestion={suggestion}
          draft={draft}
          inFlight={chat.inFlight}
          cliFound={cliFound}
          blockedReason={offline ? OFFLINE_REASON : missingCli}
          allowSendWhileRunning
          mentionMembers={loadable}
          commandAgents={loadable}
          btw={caps.btw && !compact}
          noBtw={compact ? ISLAND_BTW_NOTICE : undefined}
          runWorkflow={offersRunWorkflow({ compact })}
          workflows={workflows}
          noRunWorkflow={compact ? ISLAND_RUN_WORKFLOW_NOTICE : undefined}
          onDraftChange={onDraftChange}
          onSend={send}
          files={files}
          onAddFiles={onAddFiles}
          onPickFiles={onPickFiles}
          onRemoveFile={onRemoveFile}
          onStop={onStop}
          pause={pauseControl(chat, caps)}
          onPause={onPause}
          reply={reply}
          onCancelReply={() => onReplyChange(null)}
          focusRequest={focusRequest}
          history={history}
        >
          {!compact && (
            <GroupPickers
              chat={chat}
              group={group}
              agents={agents}
              working={working}
              onSetRole={onSetRole}
              meter={meter}
              cost={cost}
              gitChip={gitChip}
            />
          )}
        </Composer>
      </DropZone>
    )
  }

  if (!agent) return null
  return (
    <DropZone className="chat" onFiles={(f) => onAddFiles(f, 'drop')}>
      {shownTop}
      {chat.workflow && !compact && <WorkflowChatBar link={chat.workflow} stepName={workflowStepName} onOpen={onOpenWorkflowRun} />}
      {list}
      {cold}
      {chat.pause === 'pausing' && chat.inFlight && <PausingLine running={runningAgents} />}
      {tasksTray}
      <Composer
        label={`Message ${displayName(agent.name)}`}
        suggestion={suggestion}
        draft={draft}
        inFlight={running}
        cliFound={cliFound}
        blockedReason={offline ? OFFLINE_REASON : missingCli}
        allowSendWhileRunning
        steers={takesSteers(chat, engine)}
        mentionMembers={askable}
        everyone={false}
        commandAgents={singleAgents}
        engineCommands={engineCommands}
        btw={caps.btw && !compact}
        noBtw={compact ? ISLAND_BTW_NOTICE : undefined}
        runWorkflow={offersRunWorkflow({ compact })}
        workflows={workflows}
        noRunWorkflow={compact ? ISLAND_RUN_WORKFLOW_NOTICE : undefined}
        onDraftChange={onDraftChange}
        onSend={send}
        files={files}
        onAddFiles={onAddFiles}
        onPickFiles={onPickFiles}
        onRemoveFile={onRemoveFile}
        onStop={onStop}
        pause={pauseControl(chat, caps)}
        onPause={onPause}
        reply={reply}
        onCancelReply={() => onReplyChange(null)}
        focusRequest={focusRequest}
        history={history}
      >
        {/* The new-chat pickers, locked: a chat keeps the agent and folder it started with.
            The built-in agent always runs in its own folder, so it shows no folder. */}
        {/* On a phone the row keeps to one line: the agent and folder move to the side panel (the bar shows the agent's
            icon), and the model, mode and effort share one chip. A compact row on a wide window (sidebar or side panel
            open, a small window) shares that chip too, drops the agent (the title row and the placeholder name it) and
            keeps the folder's icon. */}
        {!compact && (
          <div ref={fit.ref} className={fit.compact ? 'pickers one-line compact' : 'pickers one-line'}>
            {!short && (
              <button type="button" className="picker set" data-testid="chat-agent" disabled>
                <BotIcon icon={agent.icon} color={agent.color} builtIn={agent.builtIn} working={false} size={16} />
                <span className="picker-text">{displayName(agent.name)}</span>
              </button>
            )}
            {/* After the (wide-only) agent label, so a narrow row has it too. */}
            <EngineInfo text={missingFeaturesTitle(engine, caps)} />
            <RemoteChip agent={agent} />
            {short ? (
              <RunPicker
                model={modelView}
                mode={modeView}
                effort={effortView}
                disabled={offline}
                testId="chat-run"
                onModel={onSetModel}
                onMode={(v) => onSetPermissionMode(isChatMode(v) ? v : null)}
                onEffort={(v) => onSetEffort(isEffort(v) ? v : null)}
              />
            ) : (
              <>
                {modelView && <ModelPicker view={modelView} disabled={offline} testId="chat-model" onPick={onSetModel} />}
                {modeView && (
                  <ChoicePicker
                    view={modeView}
                    disabled={offline}
                    testId="chat-mode"
                    menuTestId="chat-mode-menu"
                    optionTestId="chat-mode-option"
                    onPick={(v) => onSetPermissionMode(isChatMode(v) ? v : null)}
                  />
                )}
                {effortView && (
                  <ChoicePicker
                    view={effortView}
                    disabled={offline}
                    testId="chat-effort"
                    menuTestId="chat-effort-menu"
                    optionTestId="chat-effort-option"
                    onPick={(v) => onSetEffort(isEffort(v) ? v : null)}
                  />
                )}
              </>
            )}
            {!agent.builtIn && !narrow && <FolderChip chat={chat} iconOnly={fit.compact} />}
            {gitChip}
            <span className="pickers-end">
              {meter}
              {cost}
            </span>
          </div>
        )}
      </Composer>
    </DropZone>
  )
}
