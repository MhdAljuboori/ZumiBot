import { createContext, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { attachmentUrl, isThumbnail } from '@zumibot/shared/attachments'
import { displayName } from '@zumibot/shared/frontmatter'
import {
  TODO_ANSWER_MAX,
  TODO_COMMENT_MAX,
  TODO_DESC_MAX,
  TODO_FILES,
  TODO_FILES_MAX,
  TODO_REPLY_MAX,
  TODO_STATUSES,
  TODO_TEXT_MAX,
  agentAssignee,
  commentThreads,
  liveComments,
  type TodoBoard,
  type TodoComment,
  type TodoItem,
  type TodoQuestion,
  type TodoStatus
} from '@zumibot/shared/todos'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import {
  ASSIGN_ME,
  ASSIGN_NOBODY,
  STATE_LABEL,
  answersToSend,
  commentAsks,
  type CommentAskState,
  assignValue,
  assigneeOf,
  cardHints,
  cardState,
  givableAgents,
  giveFolder,
  statusTone
} from '../state/todoCard'
import { COLUMN_LABEL, assigneeLabel, columnOf, creatorLabel } from '../state/todoBoard'
import { ageLabel } from '../state/todosPage'
import { sentItems, viewer } from '../state/viewer'
import { draftFileName, type FileOrigin } from '../state/draftFiles'
import { commentCommandMap } from '../state/commandInput'
import { startBlocked } from '@zumibot/shared/attempts'
import { giveFolder as folderOfChat } from '../state/todoCard'
import { AttachmentChip, AttachmentThumb } from './Attachments'
import { AssigneeMenu } from './TodoAssignee'
import { AttemptsDialog, TodoAttempts } from './TodoAttempts'
import { OpenPrButton, PrBox } from './PullRequest'
import { canOpenPr } from '../state/pullRequest'
import { BotIcon } from './BotIcon'
import { Markdown, MentionScope } from './Markdown'
import { TodoCommentBox } from './TodoCommentBox'
import { ConfirmDialog } from './ConfirmDialog'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { SearchSelect } from './SearchSelect'

/** What every card reads from the app. Set once by App; where it is absent, rows stay plain to-dos. */
export interface TodoCardEnv {
  agents: AgentSummary[]
  chats: ChatMeta[]
  approvals: Record<string, number>
  /** The task board, once fetched: the chat's inline card reads its card's live title and status from it. */
  board?: TodoBoard | null
  openChat(chatId: string): void
}
export const TodoCardEnvContext = createContext<TodoCardEnv | null>(null)

/** Around a set of rows: the chat whose panel lists them (null: the board), and how to fetch again after a change here. */
export interface TodoListEnv {
  chatId: string | null
  onRefresh(): void
  /** A card to show open when its row first draws. */
  openId?: string | null
}
export const TodoListContext = createContext<TodoListEnv | null>(null)

const agentName = (name: string): string => `@${displayName(name)}`

/** Small marks after the title: the card has notes, files, or questions waiting. */
export function TodoHints({ item }: { item: TodoItem }) {
  const h = cardHints(item)
  if (!h.notes && h.files === 0 && h.comments === 0) return null
  return (
    <span className="todo-hints" aria-hidden="true">
      {h.notes && (
        <svg className="todo-hint" viewBox="0 0 16 16" data-testid="todo-hint-notes">
          <path d="M3 4h10M3 8h10M3 12h6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
      {h.files > 0 && (
        <span className="todo-hint-files" data-testid="todo-hint-files">
          <svg className="todo-hint" viewBox="0 0 16 16">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M4.5 11l2.5-3 2 2 1.5-1.5 1.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          {h.files}
        </span>
      )}
      {h.comments > 0 && (
        <span className="todo-hint-files" data-testid="todo-hint-comments" data-tip={`${h.comments} comment${h.comments === 1 ? '' : 's'}`}>
          <svg className="todo-hint" viewBox="0 0 16 16">
            <path
              d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          {h.comments}
        </span>
      )}
    </span>
  )
}

type Run = (what: () => Promise<unknown>) => Promise<boolean>

const BUSY_DELAY_MS = 300

/**
 * A to-do opened as a card: its status, assignee and creator, notes and files to edit, and the agent's chat once one
 * works on it. `assignThen`: a drop on To do or In progress with nobody assigned; the picker is up, and the move follows.
 */
export function TodoCard({
  item,
  assignThen = null,
  drawer = null
}: {
  item: TodoItem
  assignThen?: TodoStatus | null
  drawer?: CardDrawerLayout | null
}) {
  const env = useContext(TodoCardEnvContext)
  const listEnv = useContext(TodoListContext)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false) // a guard, not just `disabled`: two quick clicks must not send twice
  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(busyTimer.current), [])
  if (!env || !listEnv) return null

  const run: Run = async (what) => {
    if (busyRef.current) return false
    busyRef.current = true
    // Every control dims while busy; a quick change (an assignee, a status) must not flash the others, so the dimming
    // waits a moment. busyRef already refuses a second send meanwhile.
    clearTimeout(busyTimer.current)
    busyTimer.current = setTimeout(() => setBusy(true), BUSY_DELAY_MS)
    setError(null)
    try {
      await what()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      busyRef.current = false
      clearTimeout(busyTimer.current)
      setBusy(false)
      listEnv.onRefresh() // also after a failure: the card may have moved under us
    }
  }

  // The agent's chat shows while that agent is the assignee; another assignee starts over.
  const working = item.task !== undefined && agentAssignee(item) === item.task.agent
  const canWrite = working && cardState(item, env.chats, env.approvals) !== 'gone' && item.done === null
  // In the one-column drawer the comment box sits at the foot, out of the scrolling body, so it is always in reach.
  const footBox = drawer !== null && !drawer.wide
  return (
    <div className="todo-card" data-testid="todo-card">
      {/* Two columns in the expanded drawer (the card left, comments right); elsewhere the wrappers are display: contents
          and the comments follow the card, as one column. What the agent does comes first, then what it reads. */}
      <div className="todo-card-body">
        <div className="todo-card-main">
          <CardFields item={item} env={env} run={run} busy={busy} assignThen={assignThen} showTitle={drawer !== null} />
          {working && <CardTask item={item} env={env} run={run} busy={busy} canWrite={canWrite} />}
          {item.attempts && <TodoAttempts item={item} env={env} run={run} busy={busy} />}
          {!working && !item.attempts && item.done === null && <CardAttemptsStart item={item} env={env} onRan={listEnv.onRefresh} />}
          {error && (
            <div className="side-error todo-card-error" role="alert" data-testid="todo-card-error">
              {error}
            </div>
          )}
          <CardNotes item={item} run={run} busy={busy} />
          <CardFiles item={item} run={run} busy={busy} />
        </div>
        <div className="todo-card-side">
          <CardComments item={item} env={env} run={run} busy={busy} withBox={!footBox} />
        </div>
      </div>
      {footBox && (
        <div className="todo-card-foot-box">
          <CommentBox item={item} env={env} run={run} busy={busy} />
        </div>
      )}
    </div>
  )
}

/** How the board's drawer shows a card: `wide` is the expanded two-column layout, where the comments have a column. */
export interface CardDrawerLayout {
  wide: boolean
}

/** An agent's face (its icon and color), or the user's: beside a name on the card. */
function Face({ name, env, size = 20 }: { name: string; env: TodoCardEnv; size?: number }) {
  if (name === 'user') {
    return (
      <span className="avatar todo-face-you" style={{ width: size, height: size }} aria-hidden="true">
        <svg viewBox="0 0 16 16" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)}>
          <circle cx="8" cy="5.4" r="2.9" fill="currentColor" />
          <path d="M2.6 14.2c.6-3.1 2.8-4.8 5.4-4.8s4.8 1.7 5.4 4.8z" fill="currentColor" />
        </svg>
      </span>
    )
  }
  const agent = env.agents.find((a) => a.name === name)
  return (
    <span className="todo-face" aria-hidden="true">
      <BotIcon
        icon={agent?.icon ?? null}
        color={agent && agent.error === null ? agent.color : null}
        builtIn={agent?.builtIn}
        working={false}
        size={size}
      />
    </span>
  )
}

/** Status, assignee and creator: the status picker moves the card as a drop would; the assignee opens the picker. */
function CardFields({
  item,
  env,
  run,
  busy,
  assignThen,
  showTitle
}: {
  item: TodoItem
  env: TodoCardEnv
  run: Run
  busy: boolean
  assignThen: TodoStatus | null
  showTitle: boolean
}) {
  // null: the assignee shows; 'edit': the picker is up; a status: the picker is up, and the card moves there after.
  const [picking, setPicking] = useState<TodoStatus | 'edit' | null>(assignThen)
  const [pickedAgent, setPickedAgent] = useState<string | null>(null)
  // You and Nobody take effect at once; an agent opens the form with it chosen, to confirm the folder its chat runs in.
  const pickAssignee = (who: string | null): void => {
    if (who === null || who === 'user') {
      void run(() => api.todos.assign(item.id, who, null))
      return
    }
    setPickedAgent(who)
    setPicking('edit')
  }
  const col = columnOf(item, env.chats, env.approvals)
  const state = cardState(item, env.chats, env.approvals)
  const agent = agentAssignee(item)
  const move = (to: TodoStatus): void => {
    if (to === col) return
    if ((to === 'todo' || to === 'progress') && !item.assignee) {
      setPicking(to)
      return
    }
    void run(() => api.todos.move(item.id, to))
  }
  return (
    <div className="todo-card-hero">
      <div className="todo-card-meta">
        <Face name={item.addedBy} env={env} size={18} />
        <CardCreator item={item} env={env} />
      </div>
      {showTitle && (
        <h2 className="todo-card-title" data-testid="board-drawer-title">
          <Markdown text={item.text} inline />
        </h2>
      )}
      <div className="todo-card-fields" data-testid="todo-card-fields">
        <span className="todo-card-status-wrap" data-col={col}>
          <SearchSelect
            className="field todo-card-status-select"
            data-testid="todo-card-status-select"
            value={col}
            aria-label="Status"
            disabled={busy}
            onChange={(v) => move(v as TodoStatus)}
          >
            {TODO_STATUSES.map((s) => (
              <option key={s} value={s}>
                {COLUMN_LABEL[s]}
              </option>
            ))}
          </SearchSelect>
        </span>
        {picking === null && (
          <AssigneeMenu item={item} agents={env.agents} buttonTestId="todo-card-assign" disabled={busy} onPick={pickAssignee}>
            {item.assignee ? (
              <span className="todo-person">
                <Face name={item.assignee} env={env} />
                <span data-testid="todo-card-assignee">{assigneeLabel(item.assignee)}</span>
              </span>
            ) : (
              <span className="todo-person todo-card-nobody">
                <span className="todo-face-nobody" aria-hidden="true">
                  ?
                </span>
                <span data-testid="todo-card-assignee">Nobody</span>
              </span>
            )}
          </AssigneeMenu>
        )}
        {state && (
          <span className={`todo-status ${statusTone(state)}`} data-testid="todo-card-state">
            {STATE_LABEL[state]}
          </span>
        )}
      </div>
      {picking !== null && (
        <AssignForm
          key={picking}
          item={item}
          col={col}
          env={env}
          run={run}
          busy={busy}
          then={picking === 'edit' ? null : picking}
          initial={picking === 'edit' ? pickedAgent : null}
          onClose={() => {
            setPicking(null)
            setPickedAgent(null)
          }}
        />
      )}
      {picking === null && agent && col === 'new' && (
        <p className="todo-card-hint todo-card-starts" data-testid="todo-card-starts">
          {assigneeLabel(agent)} starts when you move the card to To do.
        </p>
      )}
    </div>
  )
}

function Section({
  title,
  icon,
  count,
  className,
  actions,
  children
}: {
  title: string
  icon?: ReactNode
  count?: number
  className?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={className ? `todo-card-section ${className}` : 'todo-card-section'}>
      <div className="todo-card-head">
        {icon}
        <h4>{title}</h4>
        {count !== undefined && (
          <span className="todo-card-count" data-testid="todo-card-count">
            {count}
          </span>
        )}
        <span className="grow" />
        {actions}
      </div>
      {children}
    </section>
  )
}

/** Who made the card and where: an agent's reply in a chat (a link to it), the user in a chat, or the user on the board. */
function CardCreator({ item, env }: { item: TodoItem; env: TodoCardEnv }) {
  const chat = item.from.chatId === null ? null : (env.chats.find((c) => c.id === item.from.chatId) ?? null)
  return (
    <span className="todo-card-creator" data-testid="todo-card-creator">
      <strong>{creatorLabel(item.addedBy)}</strong>
      {item.from.chatId !== null &&
        (chat ? (
          <>
            {' '}
            in{' '}
            <button type="button" className="inbox-link" data-testid="todo-card-creator-chat" onClick={() => env.openChat(chat.id)}>
              {chat.title || 'its chat'}
            </button>
          </>
        ) : (
          <> in a deleted chat</>
        ))}
      <span className="todo-card-when" data-tip={new Date(item.from.at).toLocaleString()}>
        {' · '}
        {new Date(item.from.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {ageLabel(item.from.at, Date.now())}
      </span>
    </span>
  )
}

function CardNotes({ item, run, busy }: { item: TodoItem; run: Run; busy: boolean }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(item.text)
  const [notes, setNotes] = useState(item.description ?? '')
  const start = (): void => {
    setTitle(item.text)
    setNotes(item.description ?? '')
    setEditing(true)
  }
  const save = async (): Promise<void> => {
    if (await run(() => api.todos.edit(item.id, { text: title, description: notes }))) setEditing(false)
  }
  if (editing) {
    return (
      <Section title="Details">
        <form
          className="todo-card-edit"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <input
            className="field"
            data-testid="todo-card-title"
            value={title}
            maxLength={TODO_TEXT_MAX}
            aria-label="Title"
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="field todo-card-notes-input"
            data-testid="todo-card-notes-input"
            value={notes}
            maxLength={TODO_DESC_MAX}
            rows={6}
            placeholder="Notes for you and the agent: what to do, links, how to check it. Markdown works."
            aria-label="Notes"
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="todo-card-buttons">
            <button type="button" className="btn small" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="btn small primary" data-testid="todo-card-save" disabled={busy || title.trim() === ''}>
              Save
            </button>
          </div>
        </form>
      </Section>
    )
  }
  // With no notes the empty box is the way in (it also edits the title); with notes, Edit sits on the head.
  return (
    <Section
      title="Notes"
      actions={
        item.description ? (
          <button type="button" className="inbox-link todo-card-head-link" data-testid="todo-card-edit" onClick={start}>
            Edit
          </button>
        ) : undefined
      }
    >
      {item.description ? (
        <div className="todo-card-notes" data-testid="todo-card-notes">
          <Markdown text={item.description} images={false} />
        </div>
      ) : (
        <button type="button" className="todo-card-empty todo-card-add-notes" data-testid="todo-card-edit" onClick={start}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Add notes the agent should read first
        </button>
      )}
    </Section>
  )
}

/**
 * Comments from the user and agents, oldest first, each with its replies under it; the user edits or deletes only their
 * own. An `@agent` in the user's comment has that agent answer under it; agents hear of new ones.
 */
function CardComments({ item, env, run, busy, withBox }: { item: TodoItem; env: TodoCardEnv; run: Run; busy: boolean; withBox: boolean }) {
  const count = liveComments(item).length
  const threads = commentThreads(item)
  // The agents an @ offers: the ones a card can be given (with `bridges`), since only those answer a comment; the server refuses the rest.
  const members = useMemo(() => givableAgents(env.agents), [env.agents])
  const scope = useMemo(
    () => ({ members: env.agents.filter((a) => a.name !== ZUMI_BOT_NAME).map((a) => a.name), agents: env.agents }),
    [env.agents]
  )
  const [replying, setReplying] = useState<string | null>(null)
  const post = (text: string, replyTo: string | null): Promise<boolean> => run(() => api.todos.comment(item.id, text, replyTo))
  return (
    <Section title="Comments" count={count} className="todo-card-comments">
      <MentionScope.Provider value={scope}>
        {threads.length === 0 && (
          <div className="todo-card-empty todo-comments-empty" data-testid="todo-comments-empty">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 2.5c3.3 0 5.5 2.2 5.5 5s-2.2 5-5.5 5c-.8 0-1.6-.1-2.3-.4L2.5 13.5l.9-2.7C2.8 10 2.5 8.8 2.5 7.5c0-2.8 2.2-5 5.5-5Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
            <strong>No comments yet</strong>
            <span>
              Mention an agent with <b>@</b> below and it answers in this thread.
            </span>
          </div>
        )}
        {threads.length > 0 && (
          <ol className="todo-comments" data-testid="todo-comments">
            {threads.map(({ comment: c, replies }) => (
              <li key={c.id} className="todo-thread" data-testid="todo-thread">
                <CommentRow item={item} comment={c} env={env} run={run} busy={busy} members={members} onReply={() => setReplying(c.id)} />
                {(replies.length > 0 || replying === c.id) && (
                  <ol className="todo-replies" data-testid="todo-replies">
                    {replies.map((r) => (
                      <li key={r.id}>
                        <CommentRow
                          item={item}
                          comment={r}
                          env={env}
                          run={run}
                          busy={busy}
                          members={members}
                          onReply={() => setReplying(c.id)}
                        />
                      </li>
                    ))}
                    {replying === c.id && (
                      <li className="todo-reply-box">
                        <TodoCommentBox
                          members={members}
                          busy={busy}
                          autoFocus
                          testId="todo-reply"
                          placeholder="Reply…"
                          label="Reply"
                          submitLabel="Reply"
                          onSubmit={async (text) => {
                            const ok = await post(text, c.id)
                            if (ok) setReplying(null)
                            return ok
                          }}
                          onCancel={() => setReplying(null)}
                        />
                      </li>
                    )}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        )}
        {withBox && <CommentBox item={item} env={env} run={run} busy={busy} />}
      </MentionScope.Provider>
    </Section>
  )
}

/** The box for a new comment: under the comments, or at the drawer's foot in its one-column layout. */
function CommentBox({ item, env, run, busy }: { item: TodoItem; env: TodoCardEnv; run: Run; busy: boolean }) {
  const members = useMemo(() => givableAgents(env.agents), [env.agents])
  return (
    <TodoCommentBox
      members={members}
      busy={busy}
      placeholder={item.task ? 'Write a comment. The agent reads it on its next turn.' : 'Write a comment, or @ an agent to ask it.'}
      label="Comment"
      submitLabel="Comment"
      onSubmit={(text) => run(() => api.todos.comment(item.id, text, null))}
    />
  )
}

const ASK_LABEL: Record<CommentAskState, string> = {
  starting: 'Starting…',
  working: 'Working…',
  answered: 'Answered',
  unanswered: 'No answer yet'
}

function CommentRow({
  item,
  comment: c,
  env,
  run,
  busy,
  members,
  onReply
}: {
  item: TodoItem
  comment: TodoComment
  env: TodoCardEnv
  run: Run
  busy: boolean
  members: AgentSummary[]
  onReply(): void
}) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const mine = c.by === 'user'
  const gone = c.deletedAt !== undefined
  const asks = commentAsks(item, c, env.chats)
  // Only the user's comment runs commands; an agent's reply is plain text.
  const commands = useMemo(() => (c.by === 'user' ? commentCommandMap(c.text, members) : undefined), [c.by, c.text, members])
  return (
    <div className={`todo-comment${mine ? ' mine' : ''}`} data-testid="todo-comment" data-by={c.by} data-comment-id={c.id}>
      <Face name={c.by} env={env} size={26} />
      <div className="todo-comment-main">
        <div className="todo-comment-bubble">
          <div className="todo-comment-head">
            <strong>{c.by === 'user' ? 'You' : assigneeLabel(c.by)}</strong>
            <span className="todo-comment-time" data-tip={new Date(c.at).toLocaleString()}>
              {ageLabel(c.at, Date.now())}
            </span>
            {c.editedAt !== undefined && !gone && (
              <span className="todo-comment-time" data-tip={new Date(c.editedAt).toLocaleString()}>
                · edited
              </span>
            )}
          </div>
          {gone ? (
            <p className="todo-comment-gone">This comment was deleted.</p>
          ) : editing ? (
            <TodoCommentBox
              members={members}
              busy={busy}
              autoFocus
              initial={c.text}
              testId="todo-comment-edit"
              postTestId="todo-comment-save"
              placeholder=""
              label="Edit comment"
              submitLabel="Save"
              onSubmit={async (text) => {
                const ok = await run(() => api.todos.editComment(item.id, c.id, text))
                if (ok) setEditing(false)
                return ok
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div className="todo-comment-text">
              <Markdown text={c.text} images={false} commands={commands} />
            </div>
          )}
        </div>
        {c.routing && !gone && (
          <div className="todo-comment-asks">
            <span className="todo-comment-ask routing" role="status" data-testid="todo-comment-routing">
              <span className="spinner" aria-hidden="true" />
              <span className="todo-comment-ask-state">Picking who to ask…</span>
            </span>
          </div>
        )}
        {asks.length > 0 && (
          <div className="todo-comment-asks">
            {asks.map((a) => (
              <span key={a.agent} className={`todo-comment-ask ${a.state}`} data-testid="todo-comment-ask" data-state={a.state}>
                <Face name={a.agent} env={env} size={16} />
                <span>{agentName(a.agent)}</span>
                <span className="todo-comment-ask-state">{ASK_LABEL[a.state]}</span>
                {a.chatId && (
                  <button type="button" className="inbox-link" onClick={() => env.openChat(a.chatId!)}>
                    Open chat →
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {!gone && !editing && (
          <div className="todo-comment-actions">
            <button type="button" className="inbox-link" data-testid="todo-comment-reply" onClick={onReply}>
              Reply
            </button>
            {mine && (
              <button type="button" className="inbox-link" data-testid="todo-comment-edit" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            {mine && (
              <button
                type="button"
                className="inbox-link danger"
                data-testid="todo-comment-delete"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
      {/* On the body: the drawer is its own layer (z-index 15), so a backdrop inside it would stay in that layer, under the rail. */}
      {confirmDelete &&
        createPortal(
          <ConfirmDialog
            title="Delete this comment?"
            message="This cannot be undone."
            buttons={[
              { label: 'Cancel', value: 'cancel' },
              { label: 'Delete', value: 'delete', danger: true }
            ]}
            onResolve={(v) => {
              setConfirmDelete(false)
              if (v === 'delete') void run(() => api.todos.deleteComment(item.id, c.id))
            }}
          />,
          document.body
        )}
    </div>
  )
}

function CardFiles({ item, run, busy }: { item: TodoItem; run: Run; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const files = item.files ?? []
  const key = TODO_FILES
  const room = TODO_FILES_MAX - files.length
  const add = (picked: File[], origin: FileOrigin = 'pick'): void => {
    void run(async () => {
      if (picked.length > room) throw new Error(`A to-do holds at most ${TODO_FILES_MAX} files.`)
      const ids: string[] = []
      const now = new Date()
      for (const file of picked) {
        const r = await api.attachments.stageBytes(draftFileName(file, origin, now), new Uint8Array(await file.arrayBuffer()))
        if (!r.ok) throw new Error(r.error)
        ids.push(r.attachment.id)
      }
      if (ids.length > 0) await api.todos.edit(item.id, { addFiles: ids })
    })
  }
  const remove = (id: string): void => void run(() => api.todos.edit(item.id, { removeFiles: [id] }))
  const open = (index: number): void => viewer.open(sentItems(key, files), index)
  const [over, setOver] = useState(false)
  const forAgent = item.assignee !== 'user'
  // Dropped images are added as picked ones are; anything else in the drop is left out.
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (busy || room <= 0 || !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      setOver(false)
      if (busy || room <= 0) return
      e.preventDefault()
      const picked = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
      if (picked.length > 0) add(picked, 'drop')
    }
  }
  // The paste box takes only images; pasted text is dropped so the box stays empty.
  const pasteBox = room > 0 && (
    <input
      type="text"
      className="todo-card-paste"
      data-testid="todo-card-paste"
      placeholder="Click here and paste an image"
      aria-label="Paste an image"
      value=""
      disabled={busy}
      onChange={() => {}}
      onPaste={(e) => {
        e.preventDefault()
        const picked = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
        if (picked.length > 0) add(picked, 'paste')
      }}
    />
  )
  const pick = (): void => input.current?.click()
  const addIcon = (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
  return (
    <Section
      title="Images"
      actions={files.length > 0 && forAgent ? <span className="todo-card-head-note">The agent gets them with the task.</span> : undefined}
    >
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="todo-card-file-input"
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])]
          e.target.value = '' // the same file can be picked again
          if (picked.length > 0) add(picked)
        }}
      />
      {files.length === 0 ? (
        <button
          type="button"
          className={over ? 'todo-card-empty todo-card-drop over' : 'todo-card-empty todo-card-drop'}
          data-testid="todo-card-add-image"
          disabled={busy}
          onClick={pick}
          {...drop}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="6" cy="6.5" r="1" fill="currentColor" />
            <path d="M3 11.5l3-3 2.2 2.2 1.6-1.6 3.2 3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          <strong>Drop images here, or click to add</strong>
          {forAgent && <span>The agent gets them with the task.</span>}
        </button>
      ) : (
        <div className={over ? 'todo-card-files over' : 'todo-card-files'} data-testid="todo-card-files" {...drop}>
          {files.map((a, i) => (
            <div key={a.id} className="draft-attachment" data-testid="todo-card-file">
              {isThumbnail(a) ? (
                <AttachmentThumb url={attachmentUrl(key, a.id)} name={a.name} onOpen={() => open(i)} />
              ) : (
                <AttachmentChip name={a.name} size={a.size} onOpen={() => open(i)} />
              )}
              <button
                type="button"
                className="attach-remove"
                data-testid="todo-card-file-remove"
                aria-label={`Remove ${a.name}`}
                data-tip={`Remove ${a.name}`}
                disabled={busy}
                onClick={() => remove(a.id)}
              >
                ✕
              </button>
            </div>
          ))}
          {room > 0 && (
            <button type="button" className="todo-card-file-add" data-testid="todo-card-add-image" disabled={busy} onClick={pick}>
              {addIcon}
              <span>Add</span>
            </button>
          )}
        </div>
      )}
      {pasteBox}
    </Section>
  )
}

/**
 * Run attempts…: offered while nothing else works on the card. The folder is the card's own when it has one, else the
 * folder of the chat the card was made in; its "Isolate in worktree" state is read so the dialog can say what happens.
 */
function CardAttemptsStart({ item, env, onRan }: { item: TodoItem; env: TodoCardEnv; onRan: () => void }) {
  const [open, setOpen] = useState(false)
  const [isolated, setIsolated] = useState<boolean | undefined>(undefined)
  const creator = item.from.chatId === null ? null : (env.chats.find((c) => c.id === item.from.chatId) ?? null)
  const folder = item.folder ?? folderOfChat(creator) ?? undefined
  useEffect(() => {
    if (!open || folder === undefined) return
    let live = true
    api.app.gitFolder(folder).then(
      (g) => {
        if (live) setIsolated(g.repo && g.worktree)
      },
      () => {
        if (live) setIsolated(undefined)
      }
    )
    return () => {
      live = false
    }
  }, [open, folder])
  const blocked = startBlocked(item)
  if (blocked !== null) return null
  return (
    <div className="todo-card-attempts-start">
      <button type="button" className="btn primary todo-run-attempts" data-testid="todo-run-attempts" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
        </svg>
        Run attempts…
      </button>
      <span className="todo-card-hint">Several agents try this card at once, each in its own worktree.</span>
      {open && (
        <AttemptsDialog item={item} agents={env.agents} folder={folder} isolated={isolated} onClose={() => setOpen(false)} onRan={onRan} />
      )}
    </div>
  )
}

/** The assigned agent's work: its chat, its review and its questions. */
function CardTask({ item, env, run, busy, canWrite }: { item: TodoItem; env: TodoCardEnv; run: Run; busy: boolean; canWrite: boolean }) {
  const task = item.task!
  const state = cardState(item, env.chats, env.approvals)
  const alive = state !== 'gone'
  const done = item.done !== null
  const questions = item.questions ?? []
  const review = task.review && !done ? task.review : null
  return (
    <Section
      className="todo-card-work"
      icon={<Face name={task.agent} env={env} size={22} />}
      title={`${agentName(task.agent)}'s work`}
      actions={
        alive && (
          <button
            type="button"
            className="btn small todo-card-chat-btn"
            data-testid="todo-card-open-chat"
            onClick={() => env.openChat(task.chatId)}
          >
            Open chat →
          </button>
        )
      }
    >
      {!alive && <p className="todo-card-hint">Its chat was deleted. Move the card to To do to start again in a new chat.</p>}
      {alive && !review && questions.length === 0 && (
        <p className="todo-card-hint">{state === 'working' ? 'Working on it in its chat.' : 'Its questions and its review show here.'}</p>
      )}
      {review && (
        <div className="todo-card-review" data-testid="todo-card-review">
          <div className="todo-card-review-head">Ready for review</div>
          {review.summary && <Markdown text={review.summary} images={false} />}
          <p className="todo-card-hint">Move it to Done when you agree, or write back below.</p>
        </div>
      )}
      <CardQuestions
        questions={questions}
        editable={alive && !done}
        busy={busy}
        onSend={(answers) => run(() => api.todos.answer(item.id, answers))}
      />
      <CardPr chat={env.chats.find((c) => c.id === task.chatId)} />
      {canWrite && <CardReply item={item} run={run} busy={busy} />}
    </Section>
  )
}

/**
 * The task chat's pull request, or Open PR… while it has none. The box reads the chat's own meta, which a push keeps
 * current, so nothing here has to refetch after a refresh or a Send to agent.
 */
function CardPr({ chat }: { chat: ChatMeta | undefined }) {
  if (!chat || !canOpenPr(chat)) return null
  return (
    <div className="todo-card-pr" data-testid="todo-card-pr">
      {chat.pr ? <PrBox chat={chat} /> : <OpenPrButton chat={chat} onOpened={() => {}} />}
    </div>
  )
}

/** A line to the card's agent, sent to its chat as the user's message. */
function CardReply({ item, run, busy }: { item: TodoItem; run: Run; busy: boolean }) {
  const agent = agentName(item.task!.agent)
  const [reply, setReply] = useState('')
  const send = async (): Promise<void> => {
    const text = reply.trim()
    if (text !== '' && (await run(() => api.todos.reply(item.id, text)))) setReply('')
  }
  return (
    <form
      className="todo-card-reply"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <textarea
        className="field"
        data-testid="todo-card-reply"
        rows={1}
        value={reply}
        maxLength={TODO_REPLY_MAX}
        placeholder={`Write to ${agent}…`}
        aria-label={`Write to ${agent}`}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <button type="submit" className="btn todo-card-reply-send" data-testid="todo-card-reply-send" disabled={busy || reply.trim() === ''}>
        Send
      </button>
    </form>
  )
}

/**
 * A card's questions, the open ones answerable: one draft per question, sent together. `onSend` resolves true when the
 * drafts can go (stored); false keeps them (a failed send, or the Inbox, which holds the card until the send settles).
 */
export function CardQuestions({
  questions,
  editable,
  busy,
  onSend
}: {
  questions: readonly TodoQuestion[]
  editable: boolean
  busy: boolean
  onSend: (answers: { id: string; text: string }[]) => Promise<boolean>
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const toSend = answersToSend(questions, drafts)
  if (questions.length === 0) return null
  const send = async (): Promise<void> => {
    if (await onSend(toSend)) setDrafts({})
  }
  return (
    <>
      <ol className="todo-questions" data-testid="todo-questions">
        {questions.map((q) => (
          <Question
            key={q.id}
            q={q}
            draft={drafts[q.id] ?? ''}
            editable={editable}
            onDraft={(text) => setDrafts((d) => ({ ...d, [q.id]: text }))}
          />
        ))}
      </ol>
      {editable && questions.some((q) => q.answer === null) && (
        <div className="todo-card-buttons">
          <button
            type="button"
            className="btn small primary"
            data-testid="todo-card-send-answers"
            disabled={busy || toSend.length === 0}
            onClick={() => void send()}
          >
            {toSend.length > 1 ? `Send ${toSend.length} answers` : 'Send answer'}
          </button>
        </div>
      )}
    </>
  )
}

function Question({ q, draft, editable, onDraft }: { q: TodoQuestion; draft: string; editable: boolean; onDraft: (text: string) => void }) {
  return (
    <li className={q.answer ? 'todo-question answered' : 'todo-question'} data-testid="todo-question" data-answered={q.answer !== null}>
      <div className="todo-question-text">
        <Markdown text={q.text} images={false} />
      </div>
      {q.answer ? (
        <div className="todo-answer" data-testid="todo-answer">
          {q.answer.text}
        </div>
      ) : editable ? (
        <>
          {q.options.length > 0 && (
            <div className="todo-options">
              {q.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  className={draft === o ? 'todo-option on' : 'todo-option'}
                  data-testid="todo-option"
                  aria-pressed={draft === o}
                  onClick={() => onDraft(o)}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <textarea
            className="field"
            data-testid="todo-answer-input"
            rows={2}
            value={draft}
            maxLength={TODO_ANSWER_MAX}
            placeholder="Your answer"
            aria-label="Your answer"
            onChange={(e) => onDraft(e.target.value)}
          />
        </>
      ) : (
        <div className="todo-card-hint">Not answered.</div>
      )}
    </li>
  )
}

/**
 * Who does the card: nobody, the user, or an agent with the folder its chat runs in. Assigning starts nothing by itself:
 * an agent starts when the card is (or, with `then`, goes) in To do or In progress.
 */
function AssignForm({
  item,
  col,
  env,
  run,
  busy,
  then,
  initial = null,
  onClose
}: {
  item: TodoItem
  col: TodoStatus
  env: TodoCardEnv
  run: Run
  busy: boolean
  then: TodoStatus | null
  initial?: string | null
  onClose: () => void
}) {
  const agents = givableAgents(env.agents)
  const [value, setValue] = useState(() => {
    if (initial && agents.some((a) => a.name === initial)) return initial
    if (then) return '' // To do needs someone: nothing picked for the user yet
    const v = assignValue(item.assignee)
    return v === ASSIGN_ME || v === ASSIGN_NOBODY || agents.some((a) => a.name === v) ? v : ''
  })
  const isAgent = value !== '' && value !== ASSIGN_ME && value !== ASSIGN_NOBODY
  // The card's own folder while its agent stays; else where its chat works (a card made in a chat), else the agent's
  // new-chat folder. Keyed on the path, not the chat object, so a meta push never undoes a folder picked with Change….
  const own = isAgent && value === item.assignee ? (item.folder ?? null) : null
  const fixed = own ?? giveFolder(env.chats.find((c) => c.id === item.from.chatId) ?? null)
  const [folder, setFolder] = useState<string | null>(null)
  useEffect(() => {
    if (!isAgent) return
    if (fixed !== null) {
      setFolder(fixed)
      return
    }
    let live = true
    setFolder(null)
    api.app.newChatFolder(value).then(
      (f) => {
        if (live) setFolder(f)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [value, isAgent, fixed])
  const pick = (): void => {
    api.app.pickFolder(isAgent ? value : null).then(
      (f) => {
        if (f) setFolder(f)
      },
      () => undefined
    )
  }
  const target = then ?? col
  const starts = isAgent && (target === 'todo' || target === 'progress')
  const save = async (): Promise<void> => {
    if (value === '' || (isAgent && folder === null)) return
    const ok = await run(async () => {
      await api.todos.assign(item.id, assigneeOf(value), isAgent ? folder : null)
      if (then) await api.todos.move(item.id, then)
    })
    if (ok) onClose()
  }
  const stops = item.task !== undefined && value !== '' && assigneeOf(value) !== item.task.agent
  return (
    <form
      className="todo-give-form"
      data-testid="todo-give"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <SearchSelect className="field" data-testid="todo-give-agent" value={value} aria-label="Assign to" onChange={(v) => setValue(v)}>
        <option value="" disabled>
          Choose…
        </option>
        {!then && <option value={ASSIGN_NOBODY}>Nobody</option>}
        <option value={ASSIGN_ME}>Me</option>
        {agents.map((a) => (
          <option key={a.name} value={a.name}>
            {displayName(a.name)}
          </option>
        ))}
      </SearchSelect>
      {isAgent && (
        <div className="todo-give-folder">
          <span className="todo-give-path" data-testid="todo-give-folder" data-tip={folder ?? ''}>
            {folder ?? 'Finding a folder…'}
          </span>
          <button type="button" className="btn small" data-testid="todo-give-pick" onClick={pick}>
            Change…
          </button>
        </div>
      )}
      <p className="todo-card-hint">
        {then && <>Pick who does it: the card then moves to {COLUMN_LABEL[then]}. </>}
        {isAgent &&
          (starts
            ? 'It starts at once: a new chat gets the title, notes and images as its first message, and its questions come back here.'
            : 'It starts when you move the card to To do.')}
        {!isAgent && agents.length === 0 && 'No agent can take it yet: add one in Agents.'}
        {stops && <> Its agent stops working on the card; its chat stays.</>}
      </p>
      <div className="todo-card-buttons">
        <button type="button" className="btn small" data-testid="todo-give-cancel" onClick={onClose}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn small primary"
          data-testid="todo-give-button"
          disabled={busy || value === '' || (isAgent && folder === null)}
        >
          {then ? `Assign and move to ${COLUMN_LABEL[then]}` : 'Assign'}
        </button>
      </div>
    </form>
  )
}
