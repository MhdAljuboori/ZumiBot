import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode
} from 'react'
import type { CommandPick } from '@zumibot/shared/commands'
import type { SideQuestion } from '@zumibot/shared/btw'
import { displayName } from '@zumibot/shared/frontmatter'
import { PLAN_TOOL } from '@zumibot/shared/plans'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import type { EngineCaps } from '@zumibot/shared/engine'
import type { AgentSummary, ChatItem, ChatMeta } from '@zumibot/shared/types'
import { agentColor, agentInk } from '../state/bot'
import type { SendNotice } from '../state/sendNotices'
import { askLive, mentionHandles, userAuthor } from '../state/agentAsk'
import { useOnce } from '../useOnce'
import { stepChoiceFor, type ApprovalReply } from '../state/approvals'
import { resumeRow } from '../state/pause'
import {
  CONTINUE_TEXT,
  findAgent,
  isLive,
  liveActions,
  liveTail,
  liveTurns,
  memberAgents,
  missingAgent,
  pausedAtEnd,
  queuedMembers,
  threadItems,
  type LiveTurn
} from '../state/groupChat'
import {
  agentKeyAfter,
  endsInTools,
  foldTools,
  groupItems,
  withAcks,
  lastContentRow,
  rowIndexOf,
  thoughtPreview,
  type AgentBlock,
  type AgentItem,
  type MessageRow
} from '../state/messageGroups'
import { dimmedAfter, editOutcome, editStillValid, resendTarget, switchBlocked } from '../state/messageEdit'
import { toggled } from '../state/commandBubble'
import { canViewMemory, memoryLine } from '../state/memoryLine'
import { todoLines } from '../state/todoLine'
import { findReplied, replySnippet } from '../state/reply'
import { lineScroll } from '../state/unread'
import { limitNoticeText, waitingErrors } from '../state/limitNotice'
import { senderText, workflowMessages } from '../state/workflowMessage'
import { AgentIntro } from './AgentIntro'
import { BrowserActionCard } from './BrowserActionCard'
import { ItemBoundary } from './ErrorBoundary'
import { VaultApprovalCard } from './VaultApprovalCard'
import { ApprovalCard } from './ApprovalCard'
import { AskCard, AskContext, type AskEnv } from './AskCard'
import { SideAskCard } from './SideAskCard'
import { ASK_SIDE_TOOL, ASK_TOOL } from '@zumibot/shared/agentAsk'
import { PlanCard } from './PlanCard'
import { QuestionCard } from './QuestionCard'
import { SentAttachments } from './Attachments'
import { BotIcon } from './BotIcon'
import { CommandBubble, FullPrompt } from './CommandBubble'
import { HandoffCard } from './HandoffCard'
import { Markdown, MentionScope } from './Markdown'
import { MemberStack } from './MemberStack'
import { CopyActions, MessageActions, Reactions, ReplyIcon, UserMessageActions } from './MessageActions'
import { MessageEditor } from './MessageEditor'
import { SelectionMenu, useMessageSelection } from './SelectionMenu'
import { ToolRun } from './ToolRun'
import { AllowCard } from './AllowCard'
import { allowCardState, inLatestTurn } from '../state/allowBlocked'
import { UserText } from './UserText'
import { VersionSwitcher } from './VersionSwitcher'
import { SideChip } from './SideChip'
import { AppLink } from './AppLink'
import { WorkflowGlyph } from './WorkflowIcons'
import { WorkflowPrompt } from './WorkflowPrompt'
import { clearSearchHighlight, highlightSearch } from '../searchHighlight'

const AT_BOTTOM_PX = 40
// This close to the top, the page before the loaded items is asked for.
const OLDER_PX = 300

/** What can be done to a finished agent message: react to it, reply to it, resend the message above it, fork the chat there. */
export interface MessageHandlers {
  reactions: Record<string, string[]> // by message id
  onReply: (itemId: string) => void
  onReact: (itemId: string, emoji: string) => void
  /** The user message Resend on this agent message sends again; null where Resend doesn't apply or sending can't happen. */
  resendOf: (itemId: string) => string | null
  onResend: (userId: string) => void
  /** Absent where the chat's engine can't fork (the `fork` cap): no Fork button. */
  onFork?: (itemId: string) => void
  onMarkUnread: (itemId: string) => void
  onExport?: (itemId: string) => void
  /** Actions with a request on its way (`resend:<id>`, `fork:<id>`): their buttons wait. */
  busy: ReadonlySet<string>
  /** An agent-to-agent chat: nothing can be done to a message but copy it. */
  readOnly?: boolean
}

/** What a refused command's Allow card needs; absent: the group draws none. */
export interface AllowEnv {
  chat: ChatMeta
  /** The chat's items, to tell whether a refusal is in the latest turn. */
  items: readonly ChatItem[]
  /** Absent: the chat cannot be talked to, so only an already answered card shows. */
  onAllowed?: (text: string) => void
}

export interface GroupProps {
  agent: AgentSummary
  items: AgentItem[]
  /** ZumiBot's line on what the agent is about to do: the group's first bubble, with no buttons (it is no item). */
  ack?: string
  /** Streaming text and the working indicator belong to the latest group. */
  streaming: string
  showWorking: boolean
  /** The working line says the CLI is compacting the agent's context. */
  compacting?: boolean
  /** The chat is running and this group is where the agent is talking. */
  working: boolean
  /** The chat is running and this group's last tool run is its latest output. */
  thinking: boolean
  /** The agent's thinking as it streams, shown on the running tool run or the working line; '' when none comes. */
  liveThought?: string
  chatRunning: boolean
  /** The cards offer "Allow for this step": the chat is a workflow's room copy. */
  stepChoice?: boolean
  toolsOpen: boolean
  onToggleTools: () => void
  onAnswer: (requestId: string, reply: ApprovalReply, agent?: string) => void
  /** Absent: the bubbles are drawn bare, with no buttons. A room's running turn passes `liveActions`' narrower set. */
  handlers?: MessageHandlers
  /** Drawn dimmed: it follows a message being edited. */
  dimmed?: boolean
  /** The chat is a group room: the memory line names the agent. */
  room?: boolean
  /** Opens the agent's Memory in Agent Studio. */
  onViewMemory?: (agent: string) => void
  /** Opens the To-dos panel on the reply with this item id; absent: the chip is plain text. */
  onOpenTodos?: (itemId: string) => void
  allow?: AllowEnv
}

type PlainItem = Extract<AgentBlock, { kind: 'item' }>['item']

function AgentItemView({
  item,
  chatRunning,
  stepChoice,
  onAnswer,
  handlers,
  inside
}: {
  item: PlainItem
  chatRunning: boolean
  stepChoice: boolean
  onAnswer: GroupProps['onAnswer']
  handlers?: MessageHandlers
  inside?: ReactNode
}) {
  switch (item.type) {
    case 'assistant': {
      const bubble = (
        <div className="bubble assistant">
          <Markdown text={item.text} />
          {inside}
        </div>
      )
      if (!handlers) return bubble
      if (handlers.readOnly) {
        return (
          <div className="msg" data-item-id={item.id} data-testid="agent-message">
            <div className="msg-row">
              {bubble}
              <CopyActions text={item.text} />
            </div>
          </div>
        )
      }
      const reactions = handlers.reactions[item.id] ?? []
      const resendId = handlers.resendOf(item.id)
      return (
        <div className="msg" data-item-id={item.id} data-testid="agent-message">
          <div className="msg-row">
            {bubble}
            <MessageActions
              text={item.text}
              onReply={() => handlers.onReply(item.id)}
              onReact={(emoji) => handlers.onReact(item.id, emoji)}
              {...(resendId === null
                ? {}
                : { onResend: () => handlers.onResend(resendId), resendBusy: handlers.busy.has(`resend:${resendId}`) })}
              {...(handlers.onFork ? { onFork: () => handlers.onFork?.(item.id) } : {})}
              forkBusy={handlers.busy.has(`fork:${item.id}`)}
              onMarkUnread={() => handlers.onMarkUnread(item.id)}
              {...(handlers.onExport ? { onExport: () => handlers.onExport?.(item.id) } : {})}
            />
          </div>
          {reactions.length > 0 && <Reactions emojis={reactions} onToggle={(emoji) => handlers.onReact(item.id, emoji)} />}
        </div>
      )
    }
    case 'browser-action':
      return <BrowserActionCard item={item} />
    case 'vault-approval':
      return <VaultApprovalCard item={item} />
    case 'tool':
      // foldTools lets only an ask or side_question call stand alone.
      return item.name === ASK_TOOL ? <AskCard item={item} /> : item.name === ASK_SIDE_TOOL ? <SideAskCard item={item} /> : null
    case 'approval':
      return item.toolName === QUESTION_TOOL ? (
        <QuestionCard item={item} chatRunning={chatRunning} onAnswer={(id, reply) => onAnswer(id, reply, item.agent)} />
      ) : item.toolName === PLAN_TOOL ? (
        <PlanCard item={item} chatRunning={chatRunning} onAnswer={(id, reply) => onAnswer(id, reply, item.agent)} />
      ) : (
        <ApprovalCard
          item={item}
          chatRunning={chatRunning}
          stepChoice={stepChoice}
          onAnswer={(id, decision) => onAnswer(id, decision, item.agent)}
        />
      )
  }
}

/** One agent turn, chat-app style: name above, bubbles in a column, the agent's icon beside the last one. */
export function AgentGroup({
  agent,
  items,
  ack,
  streaming,
  showWorking,
  compacting = false,
  working,
  thinking,
  liveThought = '',
  chatRunning,
  stepChoice = false,
  toolsOpen,
  onToggleTools,
  onAnswer,
  handlers,
  dimmed,
  room = false,
  onViewMemory,
  onOpenTodos,
  allow
}: GroupProps) {
  // Waiting on the user's approval is not the agent working.
  const waiting = items.some(
    (i) =>
      (i.type === 'approval' && i.status === 'pending') ||
      (i.type === 'browser-action' && i.handoff.status === 'pending') ||
      (i.type === 'vault-approval' && i.request.status === 'pending')
  )
  const blocks = foldTools(items)
  const nowThinking = showWorking ? thoughtPreview(liveThought) : ''
  // The avatar tile takes the agent's color; the reply bubbles keep the color theme's, so the agent's color never
  // tints long replies.
  const tint = agent.error === null ? agentColor(agent.color) : null
  const ink = agent.error === null ? agentInk(agent.color) : null // the name is text: the fill is too pale on white
  return (
    <div
      className={['agent-turn', dimmed && 'dimmed'].filter(Boolean).join(' ')}
      data-testid="agent-turn"
      style={tint ? ({ '--agent-tint': tint } as CSSProperties) : undefined}
    >
      <div className="agent-turn-avatar" data-tip={displayName(agent.name)}>
        <BotIcon
          icon={agent.icon}
          color={agent.error === null ? agent.color : null}
          builtIn={agent.builtIn}
          working={working && !waiting}
          size={20}
        />
      </div>
      <div className="agent-turn-body">
        <div className="agent-turn-name" style={{ color: ink ?? undefined }}>
          {displayName(agent.name)}
        </div>
        {ack !== undefined && (
          <div className="bubble assistant" data-testid="ack-bubble">
            <Markdown text={ack} />
          </div>
        )}
        {blocks.map((block, i) => {
          // After the block, so a folded tools run shows it without expanding.
          const touch = block.kind === 'tools' ? block.tools.find((t) => t.memory)?.memory : block.item.memory
          const line = memoryLine(touch, room ? displayName(agent.name) : null)
          // The item that carries the touch is the reply the panel groups the new to-dos under.
          const todoItem = block.kind === 'tools' ? block.tools.find((t) => t.todos) : block.item.todos ? block.item : undefined
          const todo = todoLines(todoItem?.todos, room ? displayName(agent.name) : null)
          const todoNode =
            todoItem && (todo.chip !== null || todo.lines.length > 0) ? (
              <div className={block.kind === 'item' ? 'todo-line inside' : 'todo-line'} data-testid="todo-line">
                {todo.chip !== null &&
                  (onOpenTodos ? (
                    <button type="button" className="todo-chip" data-testid="todo-chip-open" onClick={() => onOpenTodos(todoItem.id)}>
                      {todo.chip}
                    </button>
                  ) : (
                    <span>{todo.chip}</span>
                  ))}
                {todo.lines.map((l, k) => (
                  <div key={k} data-testid="todo-change">
                    {l}
                  </div>
                ))}
              </div>
            ) : null
          // A reply's own bubble holds it; a folded tools run has no bubble, so it stays below the run.
          const inBubble = block.kind === 'item' && block.item.type === 'assistant' && todoNode !== null
          return (
            <Fragment key={`${block.key}:${i}`}>
              <ItemBoundary>
                {block.kind === 'tools' ? (
                  <>
                    <ToolRun
                      block={block}
                      thinking={thinking && i === blocks.length - 1}
                      liveThought={liveThought}
                      open={toolsOpen}
                      onToggle={onToggleTools}
                    />
                    {/* Outside the fold, so a refused command's Allow card shows without opening the run. */}
                    {allow &&
                      block.tools.map((t) => {
                        if (t.type !== 'tool' || t.name !== 'Bash' || t.blockedBy !== 'classifier') return null
                        const state = allowCardState(t, allow.chat, chatRunning, inLatestTurn(allow.items, t.id))
                        // Without a way to send the continue text only an answered card is of use.
                        if (state === 'hidden' || (state !== 'done' && !allow.onAllowed)) return null
                        return <AllowCard key={t.id} chat={allow.chat} item={t} state={state} onAllowed={allow.onAllowed ?? noop} />
                      })}
                  </>
                ) : (
                  <AgentItemView
                    item={block.item}
                    chatRunning={chatRunning}
                    stepChoice={stepChoice}
                    onAnswer={onAnswer}
                    handlers={handlers}
                    {...(inBubble ? { inside: todoNode } : {})}
                  />
                )}
              </ItemBoundary>
              {line !== null && (
                <div className="memory-line" data-testid="memory-line">
                  <span>{line}</span>
                  {canViewMemory(agent) && onViewMemory && (
                    <>
                      {' · '}
                      <button type="button" className="memory-view" data-testid="memory-view" onClick={() => onViewMemory(agent.name)}>
                        View
                      </button>
                    </>
                  )}
                </div>
              )}
              {!inBubble && todoNode}
            </Fragment>
          )
        })}
        {streaming !== '' && (
          <div className="bubble assistant" data-streaming data-testid="streaming-bubble">
            <Markdown text={streaming} live />
          </div>
        )}
        {showWorking && (
          <div className="working">
            <span className="spinner" role="status" aria-label={compacting ? 'Compacting context' : 'Reply running'} />{' '}
            {compacting ? 'Compacting…' : nowThinking !== '' ? 'Thinking…' : 'Working…'}
            {!compacting && nowThinking !== '' && (
              <span className="live-thought" data-testid="live-thought" data-tip={nowThinking}>
                {nowThinking}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** The agent message a user message replies to, above it; clicking it scrolls to that message. item: undefined when it is gone. */
function ReplyQuote({
  item,
  authorOf,
  onJump
}: {
  item: Extract<ChatItem, { type: 'assistant' }> | undefined
  authorOf: (item: Extract<ChatItem, { type: 'assistant' }>) => AgentSummary
  onJump: (itemId: string) => void
}) {
  const author = item ? authorOf(item) : null
  const tint = author && author.error === null ? agentInk(author.color) : null
  return (
    <button
      type="button"
      className="reply-quote"
      data-testid="reply-quote"
      style={tint ? ({ '--quote': tint } as CSSProperties) : undefined}
      disabled={!item}
      onClick={() => item && onJump(item.id)}
    >
      <span className="reply-quote-name">
        <ReplyIcon />
        {author ? displayName(author.name) : 'Reply'}
      </span>
      <span className="reply-quote-text">{item ? replySnippet(item.text) : 'Original message unavailable'}</span>
    </button>
  )
}

const FailedIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path className="mark" d="M8 4.5v4.25" fill="none" strokeWidth="1.7" strokeLinecap="round" />
    <circle className="mark-dot" cx="8" cy="11.4" r="1" />
  </svg>
)

/**
 * A user message's parts. One that never reached the chat is dimmed, with a warning beside it that says why on hover;
 * a touch screen has no hover, so there the reason shows under the message.
 */
function UserRow({ error, children }: { error: string | undefined; children: ReactNode }) {
  if (error === undefined) return <>{children}</>
  return (
    <>
      <div className="user-send failed" data-testid="failed-message">
        <span
          className="send-failed"
          role="img"
          aria-label="Message failed to send"
          data-tip={`Message failed to send\n${error}`}
          data-testid="send-failed"
        >
          <FailedIcon />
        </span>
        <div className="user-send-body">{children}</div>
      </div>
      <div className="send-failed-reason" aria-hidden="true">
        {error}
      </div>
    </>
  )
}

type UserMessageItem = Extract<ChatItem, { type: 'user' }>

interface UserMessageProps {
  item: UserMessageItem
  /** Its reply quote, attachments and bubble, drawn as for any user message. */
  quote: ReactNode
  attachments: ReactNode
  bubble: ReactNode
  /** Under the whole row, not beside the bubble where the actions are: a sent command's "Full prompt". Hidden while editing. */
  footer: ReactNode
  editing: boolean
  dimmed: boolean
  /** A read-only chat: Copy is the only action, and there is no version switcher. */
  readOnly: boolean
  /** Edit and Resend are left out while sending can't happen, or the engine can't resend; Copy and Fork stay (Fork too is left out where it can't fork). */
  actions: { onEdit?: () => void; onResend?: () => void; onFork?: () => void; resendBusy: boolean; forkBusy: boolean }
  editor: Omit<ComponentProps<typeof MessageEditor>, 'initial' | 'hasAttachments'>
  /** Absent where the engine can't resend (the `resend` cap): no version switcher. */
  switcher: { blocked: string | null; onStep: (index: number) => void } | null
}

/** A user message that is in the chat: its actions to the left (hover), its footer and versions underneath, or the box while it is edited. */
function UserMessage({ item, quote, attachments, bubble, footer, editing, dimmed, readOnly, actions, editor, switcher }: UserMessageProps) {
  return (
    <div className={dimmed ? 'user-msg dimmed' : 'user-msg'} data-item-id={item.id} data-testid="user-message">
      <div className="user-msg-row">
        {!editing && (readOnly ? <CopyActions text={item.text} /> : <UserMessageActions text={item.text} {...actions} />)}
        <div className="user-msg-body">
          {quote}
          {attachments}
          {editing ? <MessageEditor initial={item.text} hasAttachments={(item.attachments?.length ?? 0) > 0} {...editor} /> : bubble}
        </div>
      </div>
      {!editing && footer}
      {item.versions && !editing && !readOnly && switcher && <VersionSwitcher versions={item.versions} {...switcher} />}
    </div>
  )
}

/**
 * `onContinue` set: the row is the latest paused notice and gets the Continue pill (null: it can't send right now).
 * `waitAt`: the chat continues by itself at this time after the limit error; `onContinueNow` sends that continue at once,
 * ahead of the queued tasks (null: it can't send right now), and `onCancelResume` drops it (null: offline).
 */
function OtherRow({
  item,
  onContinue,
  onResume,
  dimmed,
  waitAt = null,
  onContinueNow = null,
  onCancelResume = null
}: {
  item: Extract<MessageRow, { kind: 'other' }>['item']
  onContinue?: (() => void) | null
  /** Set: the row is the "Paused" notice of a chat waiting for Resume (null: it can't send right now). */
  onResume?: (() => void) | null
  dimmed: boolean
  waitAt?: number | null
  onContinueNow?: (() => void) | null
  onCancelResume?: (() => void) | null
}) {
  const dim = dimmed ? ' dimmed' : ''
  // The CLI's own text ("Claude exited with code 1", or a stray stderr line) says nothing useful about a limit.
  if (item.type === 'error' && item.limit) {
    const text = limitNoticeText(item.limit, waitAt, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)
    return (
      <div
        className={`notice limit-notice${dim}`}
        data-testid="limit-notice"
        data-state={waitAt === null ? 'stopped' : 'waiting'}
        role="status"
      >
        <span>{text}</span>
        {waitAt !== null && (
          <div className="limit-actions">
            <button
              type="button"
              className="continue-pill"
              data-testid="limit-continue"
              disabled={onContinueNow === null}
              onClick={onContinueNow ?? undefined}
            >
              Continue now
            </button>
            <button
              type="button"
              className="continue-pill"
              data-testid="limit-cancel"
              disabled={onCancelResume === null}
              onClick={onCancelResume ?? undefined}
            >
              Don't continue
            </button>
          </div>
        )}
      </div>
    )
  }
  if (item.type === 'error') {
    return (
      <div className={`bubble error${dim}`} data-testid="error-bubble" role="alert">
        {item.text}
      </div>
    )
  }
  if (item.kind === 'expired' || item.kind === 'fresh') {
    return (
      <div className={`divider${dim}`} role="separator">
        <span>{item.text}</span>
      </div>
    )
  }
  // A security downgrade, so it reads as a warning, not as the grey status lines around it.
  if (item.kind === 'unguarded') {
    return (
      <div className={`notice unguarded${dim}`} data-testid="unguarded-notice" role="status">
        {item.text}
      </div>
    )
  }
  if (onResume !== undefined) {
    return (
      <div className={`notice paused${dim}`}>
        <span>{item.text}</span>
        <button
          type="button"
          className="continue-pill"
          data-testid="resume-button"
          aria-label="Resume"
          disabled={onResume === null}
          onClick={onResume ?? undefined}
        >
          Resume
        </button>
      </div>
    )
  }
  if (onContinue === undefined) return <div className={`notice${dim}`}>{item.text}</div>
  return (
    <div className={`notice paused${dim}`}>
      <span>{item.text}</span>
      <button
        type="button"
        className="continue-pill"
        data-testid="continue-button"
        disabled={onContinue === null}
        onClick={onContinue ?? undefined}
      >
        {CONTINUE_TEXT}
      </button>
    </div>
  )
}

interface Props {
  chat: ChatMeta
  /** Every agent: each agent group is drawn with its author's (a group's members, or the chat's agent). */
  agents: AgentSummary[]
  items: ChatItem[]
  sides: SideQuestion[]
  onOpenSide: (id: string) => void
  /** Nothing loaded yet: a spinner instead of the list. */
  loading: boolean
  /** Agent messages that loaded replies quote, from before the loaded items. */
  quoted: ChatItem[]
  /** The chat has items older than the loaded ones; scrolling near the top asks for them. */
  hasOlder: boolean
  loadingOlder: boolean
  /** `until`: an item the page should reach back to (a jump to an old message). */
  onLoadOlder: (until?: string) => void
  /** Messages that never reached the chat, by id: why. They stay dimmed with a warning. */
  failed: Record<string, string>
  streaming: string
  /** A room's live text per member working now. */
  streamingBy?: Record<string, string>
  /** The agent's thinking as it streams (a single chat), and a room's per member working now. */
  thought?: string
  thoughtBy?: Record<string, string>
  /** A send or stop failure shown after the stored items. */
  localError: string | null
  /** An info line after the stored items (a workflow started from the box), with a link to its run. */
  localNotice: SendNotice | null
  onOpenNotice: () => void
  onDismissNotice: () => void
  /** One open/closed state for every tool run in the chat. */
  toolsOpen: boolean
  onToolsOpenChange: (open: boolean) => void
  /** Opens an agent's Memory in Agent Studio; absent: no View link. */
  onViewMemory?: (agent: string) => void
  /** Opens the To-dos panel on the reply with this item id. */
  onOpenTodos?: (itemId: string) => void
  /** Sends the continue text once a command Auto mode refused is allowed; absent: only answered Allow cards show. */
  onAllowed?: (text: string) => void
  onDismissError: () => void
  onAnswerApproval: (requestId: string, reply: ApprovalReply, agent?: string) => void
  onReply: (itemId: string) => void
  onReact: (itemId: string, emoji: string) => void
  /** Puts text selected in an agent message into the draft as a quote. */
  onQuote: (itemId: string, selected: string) => void
  /** Asks about text selected in an agent message; null while sending can't happen (offline, no claude). */
  onExplain: ((itemId: string, selected: string) => void) | null
  /** Sends the Continue message after a pause; null while sending can't happen (offline, no claude). */
  onContinue: (() => void) | null
  /** Resumes a user-paused chat; null while sending can't happen (offline, no claude). */
  onResume: (() => void) | null
  /** Don't continue: the chat the usage limit stopped no longer continues by itself; null while offline. */
  onCancelResume: (() => void) | null
  /** Continue now: the usage limit wait's continue goes in at once; null while sending can't happen (offline, no claude). */
  onContinueNow: (() => void) | null
  /** Ids of messages sent but not yet in the chat: they get no actions. */
  pendingIds: ReadonlySet<string>
  /** Whose commands the edit box's `/` menu lists (the chat's agent, or a room's loadable members); none: no menu. */
  commandAgents?: AgentSummary[]
  /** Whom the edit box's `@` list offers, as the composer's does (a room adds `@everyone`); none: no list. */
  mentionMembers?: AgentSummary[]
  /** What the chat's engine can do (`chatCaps`): Edit, Resend and the version switcher need `resend`, Fork needs `fork`. */
  caps: Pick<EngineCaps, 'resend' | 'fork'>
  /** Each resolves when the request settles, having shown its own failure. `command` is the edit box's `/` menu pick. */
  onEdit: (itemId: string, text: string, command?: CommandPick) => Promise<void>
  onResend: (itemId: string) => Promise<void>
  onSwitchVersion: (itemId: string, index: number) => Promise<void>
  onFork: (itemId: string) => Promise<void>
  /** Marks the chat unread from this agent message, until it is next opened. */
  onMarkUnread: (itemId: string) => void
  /** Opens Export with this agent message's reply picked; absent in the island popup, which has no Export dialog. */
  onExport?: (itemId: string) => void
  /** The item the New line sits above (above the whole row holding it); null: no line. */
  newLineBefore: string | null
  /**
   * Show in chat from the Files panel: a new `n` opens the tool runs and scrolls to the item, loading older pages until
   * it is there. With `query` (a search hit) the tool runs stay as they are, and the query's words light in the message.
   */
  showRequest: { itemId: string; n: number; query?: string } | null
  /** A cloned room's handoff card: whether the room it came from is still listed, and opening it. */
  handoffSourceExists: boolean
  onOpenHandoffSource: () => void
  /** An agent-to-agent chat the user only reads: Copy is the only action, and selected text gets no Quote or Explain. */
  readOnly?: boolean
  /** What the ask cards in this chat need; absent: they show what the call itself holds. */
  asks?: AskEnv
  /** A workflow Agent step's chat: the step's name in the workflow now (undefined once gone), for its messages' sender line. */
  workflowStepName?: string
}

const NO_STREAMS: Record<string, string> = {}
const noop = (): void => {}

export function MessageList({
  chat,
  agents,
  items: allItems,
  loading,
  quoted,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  failed,
  streaming: liveText,
  streamingBy = NO_STREAMS,
  thought: liveThoughtText = '',
  thoughtBy = NO_STREAMS,
  localError,
  localNotice,
  onOpenNotice,
  onDismissNotice,
  toolsOpen,
  onToolsOpenChange,
  onViewMemory,
  onOpenTodos,
  onAllowed,
  onDismissError,
  onAnswerApproval,
  onReply,
  onReact,
  onQuote,
  onExplain,
  onContinue,
  onResume,
  onCancelResume,
  onContinueNow,
  pendingIds,
  caps,
  commandAgents,
  mentionMembers,
  onEdit,
  onResend,
  onSwitchVersion,
  onFork,
  onMarkUnread,
  onExport,
  newLineBefore,
  showRequest,
  sides,
  onOpenSide,
  handoffSourceExists,
  onOpenHandoffSource,
  readOnly = false,
  asks,
  workflowStepName
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const inFlight = chat.inFlight
  const group = chat.group ?? null
  // Keyed by the member list, not the meta's identity, which every meta push renews.
  const membersKey = group?.members.join(' ') ?? null
  // A single chat draws other agents' handles as chips too, since `@name` there asks that agent.
  const scope = useMemo(
    () => ({ members: mentionHandles(agents, chat.agentName, group?.members ?? null), agents }),
    [membersKey, chat.agentName, agents]
  )
  const askScope = useMemo(
    () => (asks ? { env: asks, agents, sourceId: chat.id, isLive: (toolId: string) => askLive(allItems, toolId, inFlight) } : null),
    [asks, agents, chat.id, allItems, inFlight]
  )
  const agentOf = (name: string): AgentSummary => findAgent(agents, name) ?? missingAgent(name)
  // A read-only chat (agent-to-agent) can be talked to by nobody: its refusals get no card.
  const allowEnv = useMemo<AllowEnv | undefined>(
    () => (readOnly ? undefined : { chat, items: allItems, ...(onAllowed ? { onAllowed } : {}) }),
    [readOnly, chat, allItems, onAllowed]
  )
  const waiting = useMemo(() => waitingErrors(chat, allItems), [chat.resume, chat.pause, allItems])
  // Messages a workflow sent (its step chat's, or a Chat step's into any chat): who sent them, and their input blocks
  // drawn as boxes.
  const workflowMsgs = useMemo(
    () => workflowMessages(chat, allItems, hasOlder, workflowStepName),
    [chat.workflow, chat.workflowTest, allItems, hasOlder, workflowStepName]
  )
  // Edit, Resend and Switch run at most once at a time per message; Fork per message too.
  const [busy, once] = useOnce()
  const [editingId, setEditingId] = useState<string | null>(null)
  // Sent commands showing their full prompt: the chip is in the bubble and the toggle under the row, so the state sits here.
  const [promptsOpen, setPromptsOpen] = useState<ReadonlySet<string>>(new Set())
  // Another tab may have switched versions and taken the message away.
  useEffect(() => {
    if (editingId !== null && !editStillValid(allItems, editingId)) setEditingId(null)
  }, [allItems, editingId])
  const [selection, clearSelection] = useMessageSelection(ref)
  const actOnSelection = (act: (itemId: string, selected: string) => void) => (): void => {
    if (!selection) return
    act(selection.itemId, selection.text)
    clearSelection()
    window.getSelection()?.removeAllRanges()
  }

  // `instant` for a search jump: its message may be thousands of pixels up, and a smooth scroll there would reach the top
  // of the loaded items on its way, whose next page would then move the list under it.
  const reveal = (el: Element, instant = false): void => {
    el.scrollIntoView({ block: 'center', behavior: instant ? 'instant' : 'smooth' })
    el.animate([{ boxShadow: '0 0 0 3px var(--ring)' }, { boxShadow: '0 0 0 3px transparent' }], { duration: 1400, easing: 'ease-in' })
  }

  // Brings a replied-to message into view and flashes its bubble.
  const jumpTo = (itemId: string): void => {
    const bubble = ref.current?.querySelector(`[data-item-id="${CSS.escape(itemId)}"] .bubble`)
    if (bubble) reveal(bubble)
  }

  // Show in chat. A request already there when the list mounted was handled on another chat's screen, so it is skipped.
  const handled = useRef(showRequest?.n ?? 0)
  const [showing, setShowing] = useState<{ id: string; query?: string } | null>(null)
  useEffect(() => {
    if (!showRequest || showRequest.n === handled.current) return
    handled.current = showRequest.n
    setShowing({ id: showRequest.itemId, ...(showRequest.query !== undefined ? { query: showRequest.query } : {}) })
    clearSearchHighlight()
    if (showRequest.query === undefined && !sides.some((q) => q.id === showRequest.itemId)) onToolsOpenChange(true)
  }, [showRequest?.n])
  // The words a search jump lit belong to this chat's screen.
  useEffect(() => () => clearSearchHighlight(), [])
  // After every render while a request waits: found, scroll to it; else ask for older pages, reaching back to it, until
  // there are none. Not while the first page loads: there is nothing to look in yet.
  useEffect(() => {
    if (showing === null || loading) return
    if (showing.query === undefined && !toolsOpen && !sides.some((q) => q.id === showing.id)) return
    const id = CSS.escape(showing.id)
    const el =
      ref.current?.querySelector(`[data-item-id="${id}"] .bubble`) ??
      ref.current?.querySelector(`[data-tool-id="${id}"], [data-item-id="${id}"], [data-side-id="${id}"]`)
    if (el) {
      setShowing(null)
      reveal(el, showing.query !== undefined)
      if (showing.query !== undefined) highlightSearch(el, showing.query)
    } else if (!hasOlder) setShowing(null)
    else if (!loadingOlder) onLoadOlder(showing.id)
  })

  // The list's first item and height as last drawn, so items added above it keep the reader's place.
  const anchor = useRef<{ first: string | undefined; height: number }>({ first: undefined, height: 0 })

  const onScroll = (): void => {
    const el = ref.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX
    if (el.scrollTop < OLDER_PX && hasOlder && !loadingOlder) onLoadOlder()
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [allItems, liveText, inFlight, localError, localNotice])

  // The first drawn list opens on its New line instead of the bottom, and sticks only if that is the bottom. Once per
  // mount: a line that shows later (the idle case) or older pages loading keep today's scrolling. Runs after the
  // effect above, so it overrides that first jump to the bottom.
  const opened = useRef(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (opened.current || loading || !el) return
    opened.current = true
    const line = el.querySelector<HTMLElement>('[data-testid="new-line"]')
    if (!line) return
    // Measured against the list, not offsetTop: the list is not the line's offsetParent.
    const lineTop = line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    const padTop = parseFloat(getComputedStyle(el).paddingTop) || 0
    const to = lineScroll({ lineTop, padTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, atBottomPx: AT_BOTTOM_PX })
    el.scrollTop = to.scrollTop
    stick.current = to.stick
  })

  // Older items went in above the ones on screen: move down by what they added, before the frame is drawn.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const first = allItems[0]?.id
    const was = anchor.current
    if (!stick.current && was.first !== undefined && first !== was.first && allItems.findIndex((i) => i.id === was.first) > 0) {
      el.scrollTop += el.scrollHeight - was.height
    }
    anchor.current = { first, height: el.scrollHeight }
  })

  // Near the top already (a short list, or a page that added little): the next page comes without a scroll.
  useEffect(() => {
    const el = ref.current
    if (el && hasOlder && !loadingOlder && el.scrollTop < OLDER_PX) onLoadOlder()
  }, [hasOlder, loadingOlder, allItems])

  // A room's rows hold its finished turns. Each running turn is one block of its own under them (below), however its
  // items interleave with other members' in the store: the backend appends a turn in one piece when it ends, which is
  // where its block already was.
  const items = group ? threadItems(allItems) : allItems
  // Single chats keep the live tail: the streaming bubble and the "Working…" line. Their agent rows carry no author (null).
  const canTail = group === null
  const streaming = canTail ? liveText : ''
  const liveThought = canTail ? liveThoughtText : ''
  // A room's running turns leave the rows, but their loaded anchors still place side chips in the thread.
  const grouped = groupItems(allItems, sides, !hasOlder).flatMap((row): MessageRow[] => {
    if (!group || row.kind === 'side') return [row]
    if (row.kind !== 'agent') return isLive(row.item) ? [] : [row]
    const shown = row.items.filter((i) => !isLive(i))
    return shown.length > 0 ? [{ ...row, items: shown }] : []
  })
  // Only a single chat's turns carry an ack line.
  const rows = group ? grouped : withAcks(grouped)
  const live = liveTurns(group ?? undefined, inFlight, allItems)
  const queued = group && inFlight ? queuedMembers(group, agents) : []
  // Buttons that send need a working connection and claude; a message still on its way or failed can't be acted on.
  const canAct = onExplain !== null
  const acts = (id: string): boolean => canAct && failed[id] === undefined && !pendingIds.has(id)
  const resend = (userId: string): void => once(`resend:${userId}`, () => onResend(userId))
  const fork = (itemId: string): void => once(`fork:${itemId}`, () => onFork(itemId))
  const handlers: MessageHandlers = {
    reactions: chat.reactions ?? {},
    onReply,
    onReact,
    resendOf: (itemId) => {
      const target = caps.resend ? resendTarget(items, itemId) : null
      return target !== null && acts(target) ? target : null
    },
    onResend: resend,
    onMarkUnread,
    busy,
    ...(caps.fork ? { onFork: fork } : {}),
    ...(onExport ? { onExport } : {}),
    ...(readOnly ? { readOnly: true } : {})
  }
  const dimmed = dimmedAfter(allItems, editingId)
  const submitEdit = (item: UserMessageItem, draft: string, pick?: CommandPick): void => {
    const outcome = editOutcome(item.text, draft, (item.attachments?.length ?? 0) > 0, pick !== undefined)
    if (outcome.kind === 'empty') return
    // Closes once the request settles (its error is shown by then); the message itself leaves when the new version replaces it.
    const done = (): void => setEditingId((cur) => (cur === item.id ? null : cur))
    if (outcome.kind === 'resend') once(`resend:${item.id}`, () => onResend(item.id).finally(done))
    else once(`edit:${item.id}`, () => onEdit(item.id, outcome.text, pick).finally(done))
  }
  const last = rows[rows.length - 1]
  const lastIsTail = last?.kind === 'agent' && last.agent === null
  // A running tool run shows its own spinner, so the separate "Working…" line waits for the next quiet spell. A compaction
  // always gets the line: it can run for a minute with nothing else moving.
  const compacting = chat.compacting === true
  const thinking = canTail && inFlight && streaming === '' && lastIsTail && endsInTools(rows) && !compacting
  const showWorking = canTail && inFlight && streaming === '' && !thinking
  const hasTail = streaming !== '' || showWorking
  // The live tail joins its author's group when that is the last one; otherwise (after a user message) it starts a new one.
  if (hasTail && !lastIsTail) rows.push({ kind: 'agent', key: agentKeyAfter(last?.key ?? null), items: [], agent: null })
  const lastIndex = rows.length - 1
  const lineAt = newLineBefore === null ? -1 : rowIndexOf(rows, newLineBefore)
  // Only the latest pause offers Continue: a message sent since (pending ones included) moves it off the end.
  const paused = !inFlight && pausedAtEnd(items)
  // A side chip asked after the pause sits below it and must not take its Continue.
  const continueAt = lastContentRow(rows)
  // The Resume pill sits on the latest "Paused" notice of a chat the user paused; the Continue pill never joins it.
  const resumeId = resumeRow(items, chat)

  // A chat with older items is not empty, even when none of its loaded ones show.
  const empty = rows.length === 0 && live.length === 0 && !localError && localNotice === null && !hasOlder
  // Content that grows after its render (a picture decoding) keeps a list that was at the bottom there.
  useEffect(() => {
    const el = ref.current
    const inner = content.current
    if (!el || !inner) return
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
      anchor.current.height = el.scrollHeight
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [empty, loading])

  if (loading) {
    return (
      <div className="messages" data-testid="message-list" ref={ref}>
        <div className="chat-loading" role="status" data-testid="chat-loading">
          <span className="spinner" aria-hidden="true" /> Loading…
        </div>
      </div>
    )
  }

  // The handoff sits above the room's first message, so it shows only once the oldest page is loaded. It is the list's
  // first child in both layouts below, so the first message sent keeps it open, and it sits outside the observed
  // content, so Show all never scrolls the room to the bottom.
  const handoff =
    group?.handoff && !hasOlder ? (
      <div className="handoff-slot">
        <HandoffCard handoff={group.handoff} sourceExists={handoffSourceExists} onOpenSource={onOpenHandoffSource} />
      </div>
    ) : null

  if (empty) {
    // A chat with no messages yet introduces its agent (a group: its members) instead of showing a blank pane.
    if (group) {
      const members = memberAgents(group.members, agents)
      return (
        <div className={handoff ? 'messages has-handoff' : 'messages'} data-testid="message-list" ref={ref} onScroll={onScroll}>
          {handoff}
          <div className="chat-intro" data-testid="chat-intro">
            <MemberStack agents={members} size={64} working={[]} max={5} />
            <h2 className="chat-intro-name">{members.map((a) => displayName(a.name)).join(', ')}</h2>
          </div>
        </div>
      )
    }
    return (
      <div className="messages" data-testid="message-list" ref={ref} onScroll={onScroll}>
        <AgentIntro agent={agentOf(chat.agentName)} />
      </div>
    )
  }

  const userMentions = { ...scope, memberAgents: group ? memberAgents(group.members, agents) : [], everyone: group !== null }

  // A room's running turn: drawn as its finished turn will be. Its finished messages get their buttons, less Fork and
  // Resend (liveActions); the text still streaming in is no item, so it has none.
  const liveHandlers = liveActions(handlers)
  const renderLive = (t: LiveTurn): ReactNode => {
    const tail = liveTail(t, streamingBy[t.agent] ?? '')
    const thought = thoughtBy[t.agent] ?? ''
    return (
      <div key={`live:${t.turn}`} className="live-turn" data-testid="live-turn" data-agent-name={t.agent} data-state={t.state}>
        <AgentGroup
          agent={agentOf(t.agent)}
          items={t.items}
          dimmed={t.items.length > 0 ? dimmed.has(t.items[0].id) : dimmed.size > 0}
          streaming={tail.streaming}
          showWorking={tail.showWorking}
          compacting={t.compacting}
          working={t.active}
          thinking={tail.thinking}
          liveThought={thought}
          chatRunning={inFlight}
          stepChoice={stepChoiceFor(chat)}
          toolsOpen={toolsOpen}
          onToggleTools={() => onToolsOpenChange(!toolsOpen)}
          onAnswer={onAnswerApproval}
          handlers={liveHandlers}
          room
          {...(onViewMemory ? { onViewMemory } : {})}
          {...(onOpenTodos ? { onOpenTodos } : {})}
        />
      </div>
    )
  }
  // While the room runs: its running turns, a placeholder while the moderator picks who answers, and who is queued.
  const roomLive =
    group && (inFlight || live.length > 0) ? (
      <div className="room-live" data-testid="room-live">
        {live.map(renderLive)}
        {inFlight && live.length === 0 && (
          <div className="room-status" role="status" data-testid="room-thinking">
            <span className="spinner" aria-hidden="true" /> Thinking…
          </div>
        )}
        {queued.length > 0 && (
          <div className="room-status room-queue" data-testid="room-queue">
            {queued.map((q, i) => {
              const a = agentOf(q.agent)
              return (
                <Fragment key={q.agent}>
                  {i > 0 && ' · '}
                  <span data-testid="queued-member" data-agent-name={q.agent}>
                    <span className="room-queue-name" style={{ color: (a.error === null && agentInk(a.color)) || undefined }}>
                      {displayName(a.name)}
                    </span>{' '}
                    {q.text}
                  </span>
                </Fragment>
              )
            })}
          </div>
        )}
      </div>
    ) : null

  const renderUser = (key: string, item: UserMessageItem): ReactNode => {
    // A message an asking agent wrote shows that agent, not "You"; one whose agent is gone shows the plain name and the default icon.
    const author = userAuthor(item)
    const from = author.kind === 'agent' ? agentOf(author.name) : null
    const workflowSender = workflowMsgs.senders.get(item.id)
    const sender = from ? (
      <div className="user-from" data-testid="user-from">
        <BotIcon icon={from.icon} color={from.error === null ? from.color : null} builtIn={from.builtIn} working={false} size={16} />
        <span className="user-from-name" style={{ color: (from.error === null && agentInk(from.color)) || undefined }}>
          {displayName(from.name)}
        </span>
      </div>
    ) : workflowSender ? (
      <div className="user-from wf-from" data-testid="wf-from">
        <WorkflowGlyph />
        {/* The run link only for a message the item itself names; a step chat has the bar over it. */}
        {workflowSender.path ? (
          <AppLink href={workflowSender.path} className="user-from-name wf-from-link" testId="wf-from-link">
            {senderText(workflowSender)}
          </AppLink>
        ) : (
          <span className="user-from-name">{senderText(workflowSender)}</span>
        )}
      </div>
    ) : null
    const reply = item.replyTo && (
      <ReplyQuote
        item={findReplied(allItems, item.replyTo) ?? findReplied(quoted, item.replyTo)}
        authorOf={(i) => agentOf(i.agent ?? chat.agentName)}
        onJump={jumpTo}
      />
    )
    const quote =
      sender || reply ? (
        <>
          {sender}
          {reply}
        </>
      ) : null

    const attachments = item.attachments && item.attachments.length > 0 && (
      <SentAttachments chatId={chat.id} attachments={item.attachments} />
    )
    const hasText = item.text.trim() !== ''
    const open = promptsOpen.has(item.id)
    const flip = (): void => setPromptsOpen((set) => toggled(set, item.id))
    const parts = workflowMsgs.parts.get(item.id)
    const bubble =
      hasText &&
      (item.command || item.todo ? (
        <CommandBubble
          text={item.text}
          command={item.command ?? null}
          todo={item.todo === true}
          agent={item.command ? findAgent(agents, item.command.agent) : undefined}
          inRoom={group !== null}
          mentions={userMentions}
          open={open}
          onToggle={flip}
        />
      ) : parts ? (
        <WorkflowPrompt parts={parts} link={chat.workflow} mentions={userMentions} {...(from ? { from: from.name } : {})} />
      ) : (
        <div className="bubble user" {...(from ? { 'data-from': from.name } : {})}>
          <UserText text={item.text} mentions={userMentions} />
        </div>
      ))
    const footer = hasText && item.command && <FullPrompt command={item.command} open={open} onToggle={flip} />
    // Never reached the chat, or still on its way: dimmed with its warning, and nothing to do to it yet.
    if (failed[item.id] !== undefined || pendingIds.has(item.id)) {
      return (
        <UserRow key={key} error={failed[item.id]}>
          {quote}
          {attachments}
          {bubble}
          {footer}
        </UserRow>
      )
    }
    return (
      <UserMessage
        key={key}
        item={item}
        quote={quote}
        attachments={attachments}
        bubble={bubble}
        footer={footer}
        editing={editingId === item.id}
        dimmed={dimmed.has(item.id)}
        readOnly={readOnly}
        actions={{
          ...(canAct && caps.resend ? { onEdit: () => setEditingId(item.id), onResend: () => resend(item.id) } : {}),
          ...(caps.fork ? { onFork: () => fork(item.id) } : {}),
          resendBusy: busy.has(`resend:${item.id}`),
          forkBusy: busy.has(`fork:${item.id}`)
        }}
        editor={{
          busy: busy.has(`edit:${item.id}`) || busy.has(`resend:${item.id}`),
          onCancel: () => setEditingId(null),
          onSend: (draft, pick) => submitEdit(item, draft, pick),
          ...(commandAgents ? { commandAgents } : {}),
          ...(mentionMembers ? { mentionMembers } : {}),
          everyone: group !== null,
          grouped: group !== null
        }}
        switcher={
          caps.resend
            ? {
                blocked: switchBlocked({ canAct, running: inFlight, switching: busy.has(`switch:${item.id}`) }),
                onStep: (index) => once(`switch:${item.id}`, () => onSwitchVersion(item.id, index))
              }
            : null
        }
      />
    )
  }

  return (
    <div className="messages" data-testid="message-list" ref={ref} onScroll={onScroll}>
      {handoff}
      {loadingOlder && (
        <div className="older-loading" role="status" aria-label="Loading earlier messages" data-testid="older-loading">
          <span className="older-loading-chip">
            <span className="spinner" aria-hidden="true" />
          </span>
        </div>
      )}
      <MentionScope.Provider value={scope}>
        <AskContext.Provider value={askScope}>
          <div className="messages-inner" ref={content}>
            {rows.map((row, i) => (
              <Fragment key={row.key}>
                {i === lineAt && (
                  <div className="divider new-line" role="separator" data-testid="new-line">
                    <span>New</span>
                  </div>
                )}
                {row.kind === 'user' ? (
                  renderUser(row.key, row.item)
                ) : row.kind === 'other' ? (
                  <OtherRow
                    key={row.key}
                    item={row.item}
                    dimmed={dimmed.has(row.item.id)}
                    {...(row.item.id === resumeId ? { onResume } : paused && i === continueAt ? { onContinue } : {})}
                    {...(chat.resume && waiting.has(row.item.id) ? { waitAt: chat.resume.at, onContinueNow, onCancelResume } : {})}
                  />
                ) : row.kind === 'side' ? (
                  <SideChip thread={row.thread} agents={agents} room={group !== null} onOpen={onOpenSide} />
                ) : (
                  <AgentGroup
                    key={row.key}
                    agent={agentOf(row.agent ?? chat.agentName)}
                    items={row.items}
                    {...(row.ack !== undefined ? { ack: row.ack } : {})}
                    dimmed={row.items.length > 0 ? dimmed.has(row.items[0].id) : dimmed.size > 0}
                    streaming={i === lastIndex ? streaming : ''}
                    showWorking={i === lastIndex && showWorking}
                    compacting={compacting}
                    working={i === lastIndex && inFlight && canTail && row.agent === null}
                    thinking={i === lastIndex && thinking}
                    liveThought={i === lastIndex ? liveThought : ''}
                    chatRunning={inFlight}
                    stepChoice={stepChoiceFor(chat)}
                    toolsOpen={toolsOpen}
                    onToggleTools={() => onToolsOpenChange(!toolsOpen)}
                    onAnswer={onAnswerApproval}
                    handlers={handlers}
                    room={chat.group !== undefined}
                    {...(onViewMemory ? { onViewMemory } : {})}
                    {...(onOpenTodos ? { onOpenTodos } : {})}
                    allow={allowEnv}
                  />
                )}
              </Fragment>
            ))}
            {roomLive}
            {localNotice && (
              <div className="notice run-started" data-testid="run-notice" role="status">
                {localNotice.text} ·{' '}
                <button type="button" className="inbox-link" data-testid="run-notice-open" onClick={onOpenNotice}>
                  Open run
                </button>
                <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismissNotice}>
                  ✕
                </button>
              </div>
            )}
            {localError && (
              <div className="bubble error" data-testid="error-bubble" role="alert">
                {localError}
                <button type="button" className="icon-btn" aria-label="Dismiss error" onClick={onDismissError}>
                  ✕
                </button>
              </div>
            )}
          </div>
        </AskContext.Provider>
      </MentionScope.Provider>
      {selection && !readOnly && (
        <SelectionMenu
          selection={selection}
          onQuote={actOnSelection(onQuote)}
          {...(onExplain ? { onExplain: actOnSelection(onExplain) } : {})}
        />
      )}
    </div>
  )
}
