import type { KeepWarmSettings } from './keepWarm'
import type { Provider } from './engine'
import type { ConnectorId } from './connectors'
import type { ChatMode, Effort } from './chatRun'
import type { SideQuestion } from './btw'
import type { CommandPick, CommandSummary, SentCommand } from './commands'
import type { DesktopBridge } from './desktop'
import type { MemoryInput, MemoryList, MemoryTouch } from './memory'
import type { PauseState } from './pause'
import type { AgentCapStatus, CapPause } from './spendCaps'
import type { TodoBoard, TodoEditPatch, TodoItem, TodoStatus, TodoTaskLink, TodoTouch } from './todos'
import type { DispatchEntry, DispatchSummary } from './dispatch'
import type { ProcessInfo, ProcessLogRead } from './processes'
import type { NotifyChannel, NotifyPayload, NotifyState, NotifyStatus, NotifyToggles, SubscriptionInput } from './notify'
import type { RoutineDef, SaveMeta, VersionSummary, WorkflowDef } from './definitionHistory'
import type { Routine, RoutineInput, RoutineRun, RoutinesSnapshot, WebhookCall } from './routines'
import type { SidebarLayout } from './sidebarLayout'
import type { InboxMessages, WorkflowApproval } from './inbox'
import type { Port, Workflow, WorkflowInput, WorkflowRun, WorkflowRunSummary, WorkflowsSnapshot, WorkflowTrigger } from './workflows'

export interface AgentSummary {
  filePath: string
  name: string
  description: string
  color: string | null
  icon: string | null
  error: string | null
  builtIn: boolean
  commands?: CommandSummary[] // valid ones only; absent = none
  memory?: string // raw `memory:` scope; absent = off
  memoryLimit?: number // absent = default
  computerUse?: true // absent = off
  provider?: Provider // absent = Claude
  model?: string // the file's `model:` as written; absent = inherit
  autoCompactWindow?: number // tokens at which its session compacts; absent = the CLI's own (near the model's window)
  dailySpendCap?: number // USD the agent may spend a day (spendCaps.ts); absent = no cap
  remoteHost?: string // a remote (AG-UI) agent's endpoint host (aguiHost), for its chip; absent = runs here, or no endpoint
}

export interface AgentRename {
  from: string
  to: string
}

export type SaveAgentResult = { ok: true; filePath: string; name: string; renamedFrom: string | null } | { ok: false; error: string }

export const GROUP_MIN_MEMBERS = 2
export const GROUP_HOP_CAP = 15
/** A group role goes on every member's command line (`--append-system-prompt`): a huge one would fail every turn. */
export const ROLE_MAX_CHARS = 4000
/** A group member's whole reply when it has nothing to add: the room drops it, and the live bubble never shows it. */
export const PASS_MARKER = '[[PASS]]'
/** The emoji an agent message can be reacted with. */
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏', '🔥'] as const

/** A queued turn: it starts once every member in `after` has finished. */
export interface QueueEntry {
  agent: string
  after: string[]
}
/**
 * Why a queued room member gets its turn, which decides what its turn message asks of it (groupPrompts.ts), plus the
 * moderator's note for it. answer: the first member picked for a user message that mentions nobody or is for @everyone.
 */
export type QueueReason = (
  { kind: 'user' } | { kind: 'agent'; by: string } | { kind: 'answer' } | { kind: 'everyone' } | { kind: 'moderator' }
) & { note?: string }
/** A paused room, kept for Resume: the members that were working, the turns waiting and why each waits (absent = none). */
export interface PausedRoom {
  members: string[]
  queue: QueueEntry[]
  reasons?: Record<string, QueueReason>
}
/** A member working right now; `turn` is the id stamped on its live items. compacting: the CLI is compacting its context. */
export interface ActiveTurn {
  agent: string
  turn: string
  since: number
  compacting?: true
}

/**
 * How full an agent's context window is, in tokens: what its latest request sent plus what it wrote back. used null: it
 * compacted since, and the size is unknown until its next request (the CLI's `post` counts the summary only, not the
 * system prompt and tools). window null: not reported yet.
 */
export interface ContextUse {
  used: number | null
  window: number | null
  compacted?: { pre: number; post: number }
  at?: number // when its last request ran (the prompt cache lives an hour from it); absent before cold-cache notices
}
/** The longest "what to keep" note a compaction takes. */
export const COMPACT_NOTE_MAX = 2000

/**
 * A point in one session: resume `session` up to and including chain entry `at`. `engine` is set only by Codex (its
 * session is a thread id, `at` a turn id); absent = Claude, so Claude stamps keep their old shape.
 */
export interface SessionCut {
  session: string
  at: string
  engine?: Provider
}
/** On the last item a turn leaves: where its author's session ended. `agent` and `seen` only in group rooms. */
export interface TurnEnd extends SessionCut {
  agent?: string
  seen?: string | null
}
/** How an agent's next turn starts when it must not just resume its session's end. */
// fresh: a routine set to start fresh asked for the new session, so the chat says that rather than "expired".
// drops: the prompt uuid of the turn this cut discards, when it is known (`sent` below). The CLI validates the cut against it
// and refuses one that would discard anything else, so a rewind can never quietly drop a message the caller had not seen; a
// point without it cuts unvalidated, as every point did before. See docs/architecture/edit-resend-fork.md.
export type NextStart = { at: string; drops?: string } | { seed: true; fresh?: true }
/** On a user message with more than one version; index is 0-based, root is the first version's item id. */
export interface VersionInfo {
  root: string
  index: number
  count: number
}
export interface ForkResult {
  chat: ChatMeta
  draft: { text: string; attachments: Attachment[] } | null
}

export interface GroupInfo {
  members: string[] // agent names, in the order added
  sessions: Record<string, string | null> // CLI session per member
  sessionEngines?: Record<string, Provider> // per member, the engine that made its session (ChatMeta.sessionEngine's twin); absent = Claude
  seen: Record<string, string | null> // id of the last item each member has seen
  role: string // the group's role text; '' = none
  active: ActiveTurn[] // members working right now, in start order
  queue: QueueEntry[]
  next?: Record<string, NextStart> // per member; absent = resume the session's end
  context?: Record<string, ContextUse> // per member; absent = not run since it was cleared
  handoff?: RoomHandoff // absent = none
  paused?: PausedRoom // a paused room: who was working, the turns waiting and their reasons, kept for Resume
  lost?: Record<string, string[]> // per member: descriptions of subagents a stop killed, told to it at its next turn
}

// Summary a cloned room starts from; members read it as context, never as a user message.
export interface RoomHandoff {
  text: string
  from: { chatId: string; title: string }
  at: number
}

export interface QueuedTask {
  id: string
  text: string
  attachments?: Attachment[]
  replyTo?: string
  command?: SentCommand
  todo?: true // began with /todo or used a command that makes to-dos
  cardAsk?: import('./todos').CardAsk // a card comment that @mentioned the agent: the bubble shows the comment, the agent reads it inside the card's context (cardAskPrompt)
  auto?: true // a routine's or workflow's message, not typed by the user
  workflowSent?: WorkflowSent
  ts: number
}

export type SendResult = 'sent' | 'queued'

export interface ChatMeta {
  id: string
  agentName: string
  sessionId: string | null
  sessionEngine?: Provider // the engine that made sessionId; absent = Claude. A mismatch with the agent's engine reseeds.
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  inFlight: boolean
  group?: GroupInfo // absent for single chats; group chats have agentName ''
  reactions?: Record<string, string[]> // emoji per agent message id, in the order added; absent = none
  tasks?: QueuedTask[] // messages sent while the chat ran, oldest first; absent = none
  next?: NextStart // how a single chat's next turn starts; absent = resume the session's end
  held?: boolean
  pause?: PauseState // the chat's or room's pause (see pause.ts); absent = not paused
  pauseCap?: CapPause // a spend cap asked the pause (spendCaps.ts); absent = the user's own, or not paused
  lost?: string[] // descriptions of subagents a stop killed, told to the agent at its next turn
  context?: ContextUse // a single chat's; absent = not run since it was cleared (a new chat, an edit, a version switch)
  model?: string // a single chat's model, set by a command or picked by hand (chatModel.ts); absent = the agent's own
  modelByHand?: true // the user picked `model`: commands' models no longer move it; absent = commands may
  permissionMode?: ChatMode // a single chat's own permission mode (chatRun.ts); absent = the server's (Auto)
  effort?: Effort // a single Claude chat's own --effort; absent = Medium (DEFAULT_EFFORT)
  compacting?: true // a single chat's CLI is compacting its context now
  replyAt?: number // when an agent turn last ended with a reply or an error; absent = none since unread markers
  seenAt?: number // the user has seen the chat up to here (presence); absent = never marked
  mark?: UnreadMark // the user's "Mark unread"; absent = none
  archivedAt?: number // when the user last archived the chat; absent = never (see archive.ts)
  unarchivedAt?: number // when it last left the archive, by hand or by a turn starting; archived while archivedAt is later
  asked?: AskedFrom // set when another agent asked this agent a question in its own chat (see agentAsk.ts); absent = not asked
  workflow?: WorkflowLink // set on the chat of a workflow's Agent step (see workflows.ts); absent = a plain chat
  workflowRules?: import('./workflows').StepRule[] // a Room step's chat: the step's pre-allowed tool calls; absent = none
  workflowTest?: string // the workflow's name, on the chat an Agent step's Run step test made: its turns get the workflow paragraph, with no run to link
  voice?: true // made by a voice request: only the sidebar's mic mark reads it; absent = a plain chat
  channel?: import('./channels').ChatChannelMark // the chat is the current chat of a paired channel conversation (only the sidebar mark reads it); absent = none
  resume?: import('./limitResume').LimitResume // the usage limit stopped the last turn and it continues by itself at the reset; absent = no wait
  worktree?: ChatWorktree // the git worktree the chat or room runs in (see worktree.ts); absent = a plain chat
  task?: TodoTaskLink // made by giving a to-do card to its agent (see todos.ts); absent = a plain chat
  cardComments?: TodoTaskLink // where an agent answers the comments that mention it on that card (one per card and agent)
  attempt?: ChatAttempt // one of a card's parallel attempts (see review-loop.md); absent = not an attempt
  pr?: ChatPr // the GitHub pull request opened from this chat's worktree branch (see review-loop.md); absent = none
  allowRules?: string[] // `Bash(<prefix>:*)` and `Read(//<folder>/**)` rules the user granted for this chat, passed to its turns outside Plan; absent = none
  suggested?: SuggestedReplies // the next messages offered for the reply ending at item `after` (replyOptions.ts); absent = none read yet
}

/** What the reply reader offered: 1 option is the composer's placeholder, 2 or 3 are buttons; empty = asked, nothing to offer. */
export interface SuggestedReplies {
  after: string // the chat's last item id when the read began; shown only while it is still the last
  options: string[]
  question?: string // the decision the buttons answer, shown above them; absent = none usable
  summary?: string // one or two sentences on what the reply did, shown first; absent = none usable
}

export type PrState = 'open' | 'merged' | 'closed'

/** One failing check: what it is called, where to read it, and its Actions job when it has one. */
export interface PrCheck {
  name: string
  url?: string
  jobId?: string // from an Actions detailsUrl; only such a check has a log through gh
}

/** The checks of a pull request's head commit, folded from gh's `statusCheckRollup`. */
export interface PrChecks {
  status: 'pending' | 'passing' | 'failing' // a failure wins over anything still running
  total: number
  pending: number
  failing: PrCheck[]
}

/**
 * The pull request a chat's worktree branch has. Only the user's own click makes one; the watcher only reads. Checks
 * are volatile and per machine, so nothing here is worth more than the next read.
 */
export interface ChatPr {
  number: number
  url: string
  state: PrState
  draft?: true
  branch: string
  checks?: PrChecks // the last rollup read; absent = none reported
  at: number // when the state was last read
  error?: string // the last gh line, when a read failed; cleared by the next read that works
}

/**
 * On the ChatMeta of one of a card's parallel attempts: which set it belongs to and how its last turn ended. The card's
 * own `task` stays unset until the user keeps one, so nothing here drives the card's column.
 */
export interface ChatAttempt {
  todoId: string
  setId: string
  n: number // its place in the set, 1-based
  outcome?: 'ok' | 'error' | 'stopped' // how its last turn ended; absent = none has ended yet
}

/** Why the last release of a worktree folder skipped it: uncommitted changes, ignored files that would be lost, a detached HEAD, or another chat using it. 'failed': git could not remove it (the folder may be partly deleted); only the service sets it. */
export type WorktreeKeep = 'dirty' | 'ignored' | 'detached' | 'shared' | 'failed'

/** The git worktree a chat or room runs in, made by ZumiBot (see worktrees.md). */
export interface ChatWorktree {
  root: string // the worktree's top folder; the chat's cwd is this or a subfolder of it
  branch: string // zumibot/<slug>; kept when the folder is removed
  source: string // the top folder of the checkout it was made from: git commands for re-adding run here, and node_modules links point into it
  folder: string // the folder the user picked (source or a subfolder): the sidebar groups the chat under it, and reusableChat matches on it
  links: string[] // relative paths of the node_modules links ZumiBot made, ignored by the dirty check
  base?: string // the full sha the worktree was made from; the 'Since start' diff compares against it (absent: made before base diffs)
  removed?: true // the folder was removed by cleanup; the next turn adds it back from the branch
  kept?: WorktreeKeep // why the last release skipped the folder; absent = not skipped
}

/** What the chat's git chip shows. */
export interface GitStatus {
  branch: string | null // null = detached HEAD
  head: string // short sha, shown when detached
  changed: number // uncommitted entries (staged, unstaged, untracked), ZumiBot's links left out
  removed?: true // the worktree folder is gone (cleanup); the branch is kept
}

/** How an uncommitted file differs from HEAD, from `git status --porcelain=v2`. */
export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted'

/** One row of the Changes panel. */
export interface GitChangedFile {
  path: string // relative to the repo's top folder, `/`-separated
  from?: string // a rename's or copy's old path
  kind: GitChangeKind
  staged: boolean // some of the change is in the index
  submodule?: true // no text to show
  added: number | null // lines against HEAD; null when binary or not counted
  removed: number | null
}

/** The Changes panel's list: every uncommitted file in the chat's repo, ZumiBot's links left out. */
export interface GitChanges {
  top: string // the repo's top folder
  branch: string | null // null = detached HEAD
  head: string // short sha
  files: GitChangedFile[] // sorted by path, at most GIT_CHANGES_MAX
  more: number // files past the cap, not listed
}

/** Whether the GitHub CLI can be used here. ZumiBot stores no token: gh holds its own credentials. */
export type GhState = 'missing' | 'logged-out' | 'ready'

/** What the Open PR dialog starts from. `refusal` set means Create is refused and says why. */
export interface PrDraft {
  branch: string
  base: string | null // the commit the worktree started at; null = the commits could not be listed
  commits: string[] // `git log --oneline <base>..HEAD`, newest first
  title: string
  body: string
  dirty: number // uncommitted entries in the worktree, ZumiBot's links left out
  refusal?: string
}

/** What a start or a keep did, per attempt: a line for each one that could not be started, kept or archived. */
export interface AttemptsResult {
  started?: number // attempts whose chat was made and given the card
  kept?: string // the winner's chat id
  problems: { agent: string; why: string }[] // each one named, so a refusal is seen rather than silent
}

/** Which diff the Changes panel shows: what is uncommitted (against HEAD), or everything since the worktree's base commit. */
export type GitDiffScope = 'uncommitted' | 'base'

export type GitSideMiss = 'absent' | 'binary' | 'too-big' | 'unreadable' | 'submodule'
/** One side of a file's diff: its text, or why there is none (absent = not at HEAD, or deleted from the folder). */
export type GitSide = { text: string } | { miss: GitSideMiss }
/** A changed file at HEAD (before) and in the folder now (after). */
export interface GitFileDiff {
  path: string
  before: GitSide
  after: GitSide
}

/** "Mark unread" on an agent message: `at` when it was set, `from` just before that message. On while `at` is past seenAt. */
export interface UnreadMark {
  at: number
  from: number
}

/** The workflow step a chat was made for: its turns get the workflow's system paragraph and report through the run. */
export interface WorkflowLink {
  workflowId: string
  runId: string
  stepId: string
  name: string
  item?: { n: number; total: number }
  keep?: true
}

/** Which workflow step posted a message into a chat it does not own (a Chat or Room step); the chat itself carries no workflow link. */
export interface WorkflowSent {
  workflowId: string
  runId: string
  stepId: string
  name: string
  step: string
}

/** Where an asked chat came from: the agent that asked, and the chat it asked from (see agentAsk.ts). */
export interface AskedFrom {
  by: string // the asking agent's name
  from: string // the chat the ask was made in
  fromTitle: string // that chat's title when asked, shown in the sidebar
  chain: string[] // agents that passed the question along, oldest first
}

export const isGroup = (c: Pick<ChatMeta, 'group'>): c is ChatMeta & { group: GroupInfo } => c.group !== undefined

// 'kept' is only in older chats' stored items (the notice after an edit, no longer made or shown).
// 'unguarded': a Codex turn ran without ZumiBot's hooks (its text, from unguardedNoticeText, names what it lost).
// 'remote': a remote (AG-UI) agent's run said something the chat shows, in a fixed sentence (AGUI_TEXT) naming only its reason.
export type NoticeKind =
  | 'stopped'
  | 'interrupted'
  | 'expired'
  | 'fresh'
  | 'paused'
  | 'moderator'
  | 'unavailable'
  | 'held'
  | 'kept'
  | 'userPaused'
  | 'unguarded'
  | 'worktree'
  | 'remote'

export type ApprovalStatus =
  | 'pending'
  | 'allowed-once'
  | 'allowed-chat'
  | 'allowed-agent'
  | 'auto-allowed'
  | 'auto-allowed-agent'
  | 'auto-allowed-workflow' // a Room step's rule let it through
  | 'allowed-step' // the user chose Allow for this workflow step
  | 'denied'
  | 'unanswered'
  | 'answered'
  | 'skipped'
  | 'approved'
  | 'sent-back'

/** Answers to an AskUserQuestion call, keyed by the exact question text. */
export type QuestionAnswers = Record<string, string | string[]>

export type ApprovalDecision = 'allow-once' | 'allow-chat' | 'allow-agent' | 'allow-step' | 'deny'

/** A remembered "Allow always for this agent": any call of toolName, or for Bash only this exact command. */
export interface AgentRule {
  key: string
  toolName: string
  command: string | null
  cli?: string // a `Bash(<prefix>:*)` or `Read(//<folder>/**)` rule given to every turn of the agent (not matched against requests); its key never equals a request's
}

/** A card edit from the UI; files come as staged ids, never as attachments the client describes. */
export interface TodoCardEdit extends Omit<TodoEditPatch, 'files'> {
  addFiles?: string[]
  removeFiles?: string[]
}

/** A file attached to a message. kind 'image' = goes to the agent as an image block. */
export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  kind: 'image' | 'file'
}

export type StageResult = { ok: true; attachment: Attachment } | { ok: false; name: string; error: string }

export type ChatItem = (
  | {
      type: 'browser-action'
      id: string
      ts: number
      agent: string
      turn?: string
      handoff: import('./browser').BrowserHandoff
      surface?: 'desktop'
    }
  // A vault card's first use on a site, waiting for Allow or Deny (see VaultApprovals); no secret, only the item's name and label.
  | { type: 'vault-approval'; id: string; ts: number; agent: string; turn?: string; request: import('./vault').VaultApprovalRequest }
  | {
      type: 'user'
      id: string
      text: string
      ts: number
      attachments?: Attachment[]
      replyTo?: string
      command?: SentCommand
      todo?: true
      cardAsk?: import('./todos').CardAsk // a card comment that @mentioned this agent: the bubble shows the comment, the agent reads it inside the card's context (cardAskPrompt)
      versions?: VersionInfo
      from?: string
      workflowSent?: WorkflowSent
      engine?: 'ag-ui'
      ack?: string // ZumiBot's line on what the agent is about to do (acknowledge.ts), drawn as the reply's first bubble; no agent reads it
    } // attachments absent = none; replyTo = the agent message's id; from = the asking agent's name when another agent asked this one; engine = a remote agent's turn ran on it, saved before its first request so a turn a crash cut short still reads as AG-UI's (foreignHistory); no other engine writes it
  | { type: 'assistant'; id: string; text: string; ts: number; agent?: string; turn?: string; cut?: SessionCut }
  // One thinking block, as the CLI's summary of it (`--thinking-display summarized`); ts: when it began, doneTs: when it ended.
  | { type: 'thinking'; id: string; text: string; ts: number; doneTs?: number; agent?: string; turn?: string }
  | {
      type: 'tool'
      id: string // tool_use id
      name: string
      input: unknown
      result: string | null
      isError: boolean
      blocked: boolean
      blockedBy?: 'classifier' // Auto mode's classifier refused the call: the only refusal the Allow button is offered for
      allowedAs?: 'chat' | 'agent' // set once the user turned this refusal into a rule, so it cannot be allowed twice
      ts: number
      doneTs?: number // when the result arrived; absent while running and in chats saved before it existed
      agent?: string
      turn?: string // the live turn that wrote it; present only while that turn runs
      changes?: import('./files').FileChange[] // file edits this call made; absent for other tools and for chats saved before they were recorded
    }
  | { type: 'notice'; id: string; kind: NoticeKind; text: string; ts: number; turn?: string }
  // limit: the usage limit ended the turn; resetsAt (epoch ms) is when it lifts, agent the room member it stopped.
  | { type: 'error'; id: string; text: string; ts: number; turn?: string; limit?: LimitHit }
  | {
      type: 'approval'
      id: string // the CLI's request_id
      toolUseId: string | null
      toolName: string
      input: unknown
      description: string | null
      reason: string | null
      status: ApprovalStatus
      answers?: QuestionAnswers // present only on 'answered' cards
      feedback?: string // a 'sent-back' plan card's note to the agent, when the user wrote one
      ts: number
      agent?: string
      turn?: string
      risk?: import('./jev').ApprovalRisk // Jev's guess, added while the card waits; absent = no guess
      // Asked every time, Allow once and Deny only, never remembered: an ACP call no rule may hold (an unclassified call, or an
      // edit leaving the chat's folder). The server answers any other choice as Allow once.
      onceOnly?: true
      connector?: { id: ConnectorId; tool: string; remember: boolean } // a claude.ai connector's call; remember = that service's Remember switch when the card was made, which picks its buttons
    }
) & { end?: TurnEnd; sent?: SessionCut; memory?: MemoryTouch; todos?: TodoTouch } // end: set on the last item a turn leaves; sent: beside it, the id that turn's own prompt went out under, so a later cut can declare the turn it discards (absent before it existed, on Codex turns and on a turn that recorded no end); memory: files the turn saved or updated, on its last assistant/tool item; todos: what the turn did to the to-do list

export const THEME_PREFS = ['system', 'light', 'dark'] as const
export type ThemePref = (typeof THEME_PREFS)[number]
export function isThemePref(v: unknown): v is ThemePref {
  return typeof v === 'string' && (THEME_PREFS as readonly string[]).includes(v)
}

// The app's color theme: its accent and the neutrals tinted to it (styles/tokens.css). Blue unless the user picks another.
export const ACCENTS = ['blue', 'teal', 'coral', 'graphite'] as const
export type Accent = (typeof ACCENTS)[number]
export function isAccent(v: unknown): v is Accent {
  return typeof v === 'string' && (ACCENTS as readonly string[]).includes(v)
}

export interface AppSettings {
  claudePath: string | null
  lastFolderByAgent: Record<string, string>
  theme: ThemePref
  accent: Accent
  lastGroupFolder: string | null
  houseStyle: boolean // append the shared reply style to every agent's system prompt
  suggestedReplies: boolean // after a reply that asks the user something, offer their next message (replyOptions.ts)
  keepWarm: KeepWarmSettings // hours a big idle context's prompt cache is kept alive (keepWarm.ts)
  timeZone?: string // the user's IANA zone, as the page last reported it (setTimeZone)
  worktreeFolders: string[] // top folders of the repos where "Isolate in worktree" is on; keyed by top folder so a subfolder pick reads the same setting
}

/** One plan limit: how much of it is used (0–100) and when it starts over (epoch ms; null = unknown). */
export interface UsageWindow {
  percent: number
  resetsAt: number | null
}
// compact: the limit stopped a /compact, not the turn's own work (see limitResume.ts).
export interface LimitHit {
  resetsAt: number | null
  agent?: string
  compact?: true
}
/** The plan's limits as last seen, by a chat turn here or by Claude Code itself; updatedAt is epoch ms. */
export interface ClaudeUsage {
  session: UsageWindow | null
  weekly: UsageWindow | null
  updatedAt: number
}
/** Who claude is signed in as. Not signed in to a Claude plan: name is the OS account and the rest is null. */
export interface ClaudeAccount {
  name: string
  email: string | null
  plan: string | null // 'Pro', 'Max', 'Team', ...
  usage: ClaudeUsage | null
  codex?: ClaudeUsage // Codex's plan limits as its last run here reported them; absent until one did
}
export const USAGE_PAGE_URL = 'https://claude.ai/new#settings/usage'

export const NOTICE_TEXT: Record<NoticeKind, string> = {
  stopped: 'Stopped.',
  interrupted: 'Interrupted — the app closed before this reply finished.',
  expired: "Earlier session expired. Continued in a new session using this chat's history as context.",
  fresh: "This routine starts fresh each run: a new session, using this chat's recent history as context.",
  paused: 'Agents paused after 15 turns without you. Send a message to continue.',
  moderator: "Couldn't check who else should reply.",
  unavailable: 'That agent is no longer available.',
  held: 'That agent waits for your answer.',
  kept: 'An earlier version changed files. Nothing was undone.',
  userPaused: 'Paused. Press Resume to continue.',
  worktree: 'This chat runs in a git worktree.', // a stand-in: each worktree notice carries its own text
  remote: "A note about the remote agent's run.", // a stand-in: each remote notice carries its own text
  unguarded:
    "Codex didn't confirm ZumiBot's hooks, so this reply runs without the vault guard or the agent's API keys, and Pause takes effect only when it ends."
}

export type ChatPush =
  | { chatId: string; kind: 'delta'; text: string; agent?: string; thought?: true } // thought: the agent's thinking, not its reply
  | { chatId: string; kind: 'items'; items: ChatItem[]; clearStreaming: boolean; agent?: string } // with agent, clearStreaming clears only that agent's live text
  | { chatId: string; kind: 'meta'; meta: ChatMeta }
  | { chatId: string; kind: 'approvals'; pending: number; agent?: string; asked?: true } // aggregate permission and browser handoff waits; chats:answer remains permission-only. agent: whose turn changed it, for notifications. asked: the chat is an A→B ask

/**
 * A ChatPush as the socket carries it. Each items list is numbered (`seq`) and sent as the items after the first
 * `from` of the list numbered `base`, which the client must hold. `base` null: `items` is the list from index `from`
 * on, and the client drops whatever it held (a long list goes as its latest page).
 */
export type WirePush =
  | Exclude<ChatPush, { kind: 'items' }>
  | {
      chatId: string
      kind: 'items'
      seq: number
      base: number | null
      from: number
      items: ChatItem[]
      clearStreaming: boolean
      agent?: string
    }

/** A chat's items and the number of the pushed list they are, so the pushes after them can build on them. */
export interface ItemsSnapshot {
  items: ChatItem[]
  seq: number
}

/** How many items a page of a chat's history holds: what opening a chat loads, and what each scroll up adds. */
export const ITEMS_PAGE = 60
/** The most items one request loads to reach an older message (a search hit, Show in chat); past it, it asks again. */
export const ITEMS_JUMP_MAX = 600

/**
 * A page of a chat's items: those before the item `before` (else its latest), from index `start` of its history, cut
 * from the pushed list numbered `seq`. `quoted` holds the agent messages its replies quote from before the page.
 */
export interface ItemsPage {
  items: ChatItem[]
  start: number
  seq: number
  quoted: ChatItem[]
}

export interface DirListing {
  path: string
  parent: string | null
  dirs: string[]
}
export type ServerMode = 'vps' | 'local'
export type ConnectionStatus = 'connected' | 'reconnecting'

export interface ZumiBotApi {
  codexInfo(): Promise<import('./engine').CodexInfo>
  browsers: import('./browser').BrowserApi
  desktops: { status(agent: string): Promise<import('./desktop').DesktopStatus>; clear(agent: string): Promise<void> }
  agents: {
    list(): Promise<AgentSummary[]>
    read(filePath: string): Promise<string>
    save(originalFilePath: string | null, raw: string): Promise<SaveAgentResult>
    trash(filePath: string): Promise<void>
    onChanged(cb: (renamed: AgentRename[]) => void): () => void
    /** Agent Studio's Test: the saved, confirmed launch of an ACP agent, `initialize` only; a fixed `{error}` otherwise. */
    testAcp(agentName: string): Promise<import('./acp').AcpTestResult>
    /** The ACP launch Save confirmed on this machine (launch trust), or null. */
    acpLaunch(agentName: string): Promise<import('./acp').AcpLaunch | null>
    /** Agent Studio's Test of a remote agent: the saved, confirmed endpoint is checked and a connection opened, with no request sent; a fixed `{error}` otherwise. */
    testAgui(agentName: string): Promise<import('./agui').AguiTestResult>
    /** The remote agent's launch Save confirmed on this machine (launch trust), or null. */
    aguiLaunch(agentName: string): Promise<import('./agui').AguiLaunch | null>
    /** The engine's own `/` commands (Claude Code commands, Codex skills) for the agent in a folder (null = home); null for an ACP or remote agent. A Codex skill's path stays on the server. */
    engineCommands(agent: string, folder: string | null): Promise<import('./engineCommands').EngineCommands | null>
  }
  chats: {
    list(): Promise<ChatMeta[]>
    create(agentName: string, cwd: string | null): Promise<ChatMeta> // also settings.setLastFolder; null = a new folder under ~/zumibot/cache
    createVoice(agentName: string): Promise<ChatMeta> // a voice conversation's chat (a Claude agent's, in its last folder)
    createGroup(members: string[], cwd: string | null, role: string): Promise<ChatMeta> // null = a new folder under ~/zumibot/cache
    setRole(chatId: string, role: string): Promise<ChatMeta>
    setMembers(chatId: string, members: string[]): Promise<ChatMeta>
    // before = the oldest item held, for the page before it; until = an item to reach back to (a jump to an old message)
    items(chatId: string, before?: string, until?: string): Promise<ItemsPage>
    pending(): Promise<Record<string, number>> // every running chat's waiting count, as its approvals push gives it (asked chats too); 0s left out
    search(query: string, offset?: number): Promise<import('./search').SearchResult> // every chat's messages, newest first
    // replyTo = an agent message's id; messageId = the id the client already shows the message under (stored as it)
    send(
      chatId: string,
      text: string,
      attachmentIds?: string[],
      replyTo?: string,
      messageId?: string,
      command?: CommandPick
    ): Promise<SendResult>
    sendTask(chatId: string, taskId: string): Promise<SendResult>
    dropTask(chatId: string, taskId: string): Promise<void>
    // rewrites a user message as a new version and reruns from it; command = the editor's `/` menu pick, as in send
    edit(chatId: string, itemId: string, text: string, command?: CommandPick): Promise<void>
    resend(chatId: string, itemId: string): Promise<void> // reruns from a user message as a new version, same text
    switchVersion(chatId: string, itemId: string, index: number): Promise<void> // shows another version (0-based) of a user message
    fork(chatId: string, itemId: string): Promise<ForkResult> // new chat holding everything before (user) or through (agent) the message
    summarizeRoom(chatId: string): Promise<string> // a handoff draft for a room's clone; takes a minute, so no timeout
    cancelSummary(chatId: string): Promise<void>
    cloneRoom(chatId: string, title: string, handoff: string | null): Promise<ChatMeta> // new room: same members, role and folder, no history
    compact(chatId: string, note: string, agent?: string): Promise<void> // /compact on the agent's session; agent = the room member
    setModel(chatId: string, model: string | null): Promise<void> // a single chat's model picked by hand (one its engine runs, modelFits); null = back to the agent's own, commands may set it again
    setPermissionMode(chatId: string, mode: ChatMode | null): Promise<void> // a single chat's mode from its next turn (one its engine runs, modeFits); null = the server's
    allowBlocked(chatId: string, toolUseId: string, prefixes: string[], scope: 'chat' | 'agent', folders?: string[]): Promise<{ rules: string[]; text: string }> // Allow on a row Auto mode's classifier refused: stores a Bash(<prefix>:*) rule per prefix and a Read(//<folder>/**) rule per folder the command cd's into, for the chat or the agent; the text is what the client then sends as a message
    setEffort(chatId: string, effort: Effort | null): Promise<void> // a single Claude chat's --effort from its next turn; null = Medium (DEFAULT_EFFORT)
    cancelResume(chatId: string): Promise<void> // Don't continue: the chat the usage limit stopped no longer continues by itself at the reset, and its queued tasks wait for the user
    continueNow(chatId: string): Promise<void> // Continue now: the usage limit wait's continue goes in at once, ahead of the queued tasks
    stop(chatId: string): Promise<void>
    pause(chatId: string): Promise<void> // lets the reply wrap up and holds the next step until resume
    resume(chatId: string): Promise<void> // sends RESUME_TEXT to a paused chat
    answer(chatId: string, requestId: string, decision: ApprovalDecision, agent?: string): Promise<void>
    answerQuestions(chatId: string, requestId: string, answers: QuestionAnswers | null, agent?: string): Promise<void> // null = Skip
    answerPlan(chatId: string, requestId: string, approve: boolean, feedback?: string, agent?: string): Promise<void> // false = Keep planning
    rename(chatId: string, title: string): Promise<ChatMeta>
    react(chatId: string, itemId: string, emoji: string): Promise<ChatMeta> // adds the reaction, or takes it off when there
    markUnread(chatId: string, itemId: string): Promise<ChatMeta> // unread from this agent message until the chat is next opened
    archive(chatId: string, on: boolean): Promise<ChatMeta> // on = out of the sidebar into Archived; refused while the chat runs
    remove(chatId: string): Promise<void> // stop() first, then store.remove
    gitStatus(chatId: string): Promise<GitStatus | null> // branch and uncommitted count in the chat's folder; null when it is not in a git repo
    // Every changed file in the chat's repo: uncommitted (the default) or everything since the worktree's base commit.
    // null outside a repo, once the worktree folder was removed, or for 'base' on a chat with no base commit.
    gitChanges(chatId: string, scope?: GitDiffScope): Promise<GitChanges | null>
    // One listed file on both sides: at HEAD (or at the base commit) and on disk; refused for a path the scope does not list now.
    gitDiff(chatId: string, path: string, scope?: GitDiffScope): Promise<GitFileDiff>
    onPush(cb: (p: WirePush) => void): () => void
  }
  attachments: {
    stageBytes(name: string, bytes: Uint8Array): Promise<StageResult>
    discard(id: string): Promise<void>
    open(chatId: string, id: string, name: string): Promise<boolean> // false when the file is gone
  }
  app: {
    pickFolder(agentName: string | null): Promise<string | null> // dialog defaultPath = the agent's lastFolder ?? homedir
    newChatFolder(agentName: string): Promise<string> // where a new chat of the agent starts: its last folder if it still exists, else the server's home
    lastFolder(agentName: string): Promise<string | null> // null when unset or no longer a directory
    lastGroupFolder(): Promise<string | null>
    gitFolder(cwd: string): Promise<{ repo: boolean; worktree: boolean }> // whether the folder is in a git repo, and whether its repo's "Isolate in worktree" toggle is on
    setWorktreeFolder(cwd: string, on: boolean): Promise<void> // saves the toggle for the folder's repo; refused when it is not a git repo
    claudeStatus(): Promise<{ path: string | null }>
    setClaudePath(path: string): Promise<{ path: string | null }> // saves override, re-locates
    getTheme(): Promise<ThemePref>
    setTheme(theme: ThemePref): Promise<ThemePref> // resolves to the applied value
    getAccent(): Promise<Accent>
    setAccent(accent: Accent): Promise<Accent> // resolves to the applied value
    getHouseStyle(): Promise<boolean>
    setHouseStyle(on: boolean): Promise<boolean> // applies from each chat's next turn
    getSuggestedReplies(): Promise<boolean>
    setSuggestedReplies(on: boolean): Promise<boolean> // every tab hears it (onSuggestedRepliesChanged)
    onSuggestedRepliesChanged(cb: (on: boolean) => void): () => void
    getKeepWarm(): Promise<KeepWarmSettings>
    setKeepWarm(v: KeepWarmSettings): Promise<KeepWarmSettings> // applies to the next ping each context is due
    setTimeZone(tz: string): Promise<void> // the page's zone, sent on every connect; a bad or unchanged one is ignored
    account(): Promise<ClaudeAccount> // shown in the rail's Usage popover; read fresh on every call
    setEditorDirty(dirty: boolean): void
    onSaveBeforeClose(cb: () => Promise<boolean>): () => void // cb returns true when save succeeded
  }
  sidebar: {
    get(): Promise<SidebarLayout>
    save(layout: SidebarLayout): Promise<SidebarLayout> // resolves to the layout as stored
    onChanged(cb: (layout: SidebarLayout) => void): () => void // any tab's save, or a rename or delete the server applied
  }
  approvals: {
    list(agentName: string): Promise<AgentRule[]>
    remove(agentName: string, key: string): Promise<AgentRule[]> // resolves to the agent's remaining rules
    addCli(agentName: string, kind: 'prefix' | 'folder', value: string): Promise<AgentRule[]> // Agent Studio's Add: a Bash(<prefix>:*) or Read(//<folder>/**) rule given to the agent's turns; resolves to its rules
    onChanged(cb: (agentName: string) => void): () => void
  }
  memory: {
    list(agent: string): Promise<MemoryList>
    save(agent: string, file: string | null, input: MemoryInput, modified: number | null): Promise<MemoryList> // file null = new memory
    remove(agent: string, file: string, modified: number): Promise<MemoryList>
    onChanged(cb: (agent: string) => void): () => void
  }
  // One task board for every chat (todos.ts): an item's creator is who added it and the chat it was made in.
  todos: {
    board(): Promise<TodoBoard> // every open item, and the newest done ones
    list(chatId: string): Promise<{ rev: number; items: TodoItem[] }> // the live items made in this chat (its side panel)
    add(text: string, chatId: string | null): Promise<{ added: boolean }> // by hand, on the board (null) or in a chat's panel; false when an open item already reads the same
    check(ids: string[], done: boolean): Promise<void>
    remove(ids: string[]): Promise<void>
    restore(ids: string[]): Promise<void> // Undo of a remove
    // The card. addFiles: staged attachment ids; removeFiles: ids of the card's files.
    edit(id: string, patch: TodoCardEdit): Promise<void>
    // Who does it: 'user', an agent (with the folder its chat runs in), or null for nobody. Starts nothing by itself,
    // except an agent given a card already in To do or In progress.
    assign(id: string, assignee: string | null, folder: string | null): Promise<void>
    answer(id: string, answers: { id: string; text: string }[]): Promise<void> // stored, then sent to the task's chat as one message
    reply(id: string, text: string): Promise<void> // a message to the task's chat; ends a review
    // As a drop on the board: To do (or In progress) starts the assigned agent, New and Done stop it; an unassigned card
    // is refused To do and In progress.
    move(id: string, status: TodoStatus): Promise<void>
    // Comments: anyone's on any card; only its author edits or deletes one (a deleted one stays a tombstone for sync).
    /** `replyTo`: the comment it answers. An `@agent` in a top-level comment has that agent answer under it. */
    comment(id: string, text: string, replyTo?: string | null): Promise<void>
    editComment(id: string, commentId: string, text: string): Promise<void>
    deleteComment(id: string, commentId: string): Promise<void>
    onChanged(cb: (rev: number) => void): () => void // fires on every change, also at an unchanged rev
  }
  attempts: {
    // 2 to 5 agents (the same one may appear twice) each get the card in their own chat and worktree, all from one base
    // commit. Refused unless the card's folder is a repo whose "Isolate in worktree" toggle is on.
    start(todoId: string, picks: { agent: string }[], folder?: string | null): Promise<AttemptsResult>
    // Keeps one: the card goes to that agent with its chat, moves to In review, and the others are archived (a worktree
    // release refuses a dirty folder and says so, as any archive does).
    keep(todoId: string, chatId: string): Promise<AttemptsResult>
    cancel(todoId: string): Promise<void> // drops the set, stops what runs; the chats and their worktrees stay
  }
  github: {
    state(): Promise<{ gh: GhState }> // whether gh is installed and signed in; ZumiBot never holds a token itself
    // What the Open PR dialog shows: the branch, the commits since the worktree's base, a drafted title and body, and
    // why it cannot be opened yet (uncommitted changes, the default branch, no worktree).
    draftPr(chatId: string): Promise<PrDraft>
    // Pushes the branch and opens the pull request. Only ever from the user's own click: no agent, workflow or poll
    // reaches this. Never --force, and never to the repository's default branch.
    createPr(chatId: string, input: { title: string; body: string; draft: boolean }): Promise<ChatPr>
    refreshPr(chatId: string): Promise<ChatPr> // reads the state and the checks again (the row's Refresh)
    sendCheck(chatId: string, name: string): Promise<void> // posts a failing check and the tail of its log as a user turn
  }
  dispatch: {
    list(chatId: string): Promise<DispatchSummary[]> // the subagents of the visible messages, oldest first
    // One entry; with `from`, only its steps from that index on (the answer's `from` 0 means the whole entry came)
    get(chatId: string, id: string, from?: number): Promise<{ entry: DispatchEntry; from: number } | null>
    onChanged(cb: (chatId: string) => void): () => void // fires after every save, never dedupe
  }
  // Background processes the chat's agents started (docs/architecture/processes.md). Output reaches only who reads it.
  processes: {
    list(chatId: string): Promise<ProcessInfo[]> // running first, then ended newest first; commands scrubbed
    // Output from cursor `from` (the newest part when absent), at most 256 KiB, escapes stripped and scrubbed.
    logs(chatId: string, id: string, from?: number): Promise<ProcessLogRead>
    stop(chatId: string, id: string): Promise<ProcessInfo> // ends the whole tree
    restart(chatId: string, id: string): Promise<ProcessInfo> // the stored command again, same id; the user's click is its approval
    forget(chatId: string, id: string): Promise<void> // an ended record and its log
    counts(): Promise<Record<string, number>> // running processes per chat
    onChanged(cb: (e: { chatId: string; running: number }) => void): () => void // any start, end, restart or forget; never dedupe
    onOutput(cb: (e: { chatId: string; id: string; to: number }) => void): () => void // a cursor only, never the text
  }
  routines: {
    list(): Promise<RoutinesSnapshot> // never carries a webhook secret
    save(input: RoutineInput, meta?: SaveMeta): Promise<Routine> // meta.restoredFrom: this saves a restored version
    remove(id: string): Promise<void> // the chats it made stay; its history goes with it
    history(id: string): Promise<VersionSummary[]> // the saved versions, newest first
    version(id: string, versionId: string): Promise<RoutineDef> // one version's definition, to load into the editor
    duplicate(id: string): Promise<Routine> // the saved routine as an off copy, "<name> (2)"; a webhook of its own, no runs
    setEnabled(id: string, on: boolean): Promise<Routine>
    runNow(id: string): Promise<RoutineRun>
    draftWebhook(): Promise<{ id: string; url: string; secret: string }>
    dropDraft(id: string): Promise<void>
    webhook(id: string): Promise<{ url: string; secret: string; latest: WebhookCall | null }> // makes the secret if this routine has none
    newSecret(id: string): Promise<string>
    onChanged(cb: (s: RoutinesSnapshot) => void): () => void
  }
  workflows: {
    list(): Promise<WorkflowsSnapshot> // run summaries only, never a visit's input or output, never a webhook secret
    getRun(runId: string): Promise<WorkflowRun | null> // one run with every visit's input and output
    // Always saves, problems or not; a save never turns on a workflow with problems. meta.restoredFrom: a restored version.
    save(input: WorkflowInput, meta?: SaveMeta): Promise<Workflow>
    remove(id: string): Promise<void> // stops its unfinished runs first; the chats it made stay; its history goes with it
    history(id: string): Promise<VersionSummary[]> // the saved versions, newest first
    version(id: string, versionId: string): Promise<WorkflowDef> // one version's definition, to load into the editor
    duplicate(id: string): Promise<Workflow> // the saved workflow as an off copy, "<name> (2)"; a webhook of its own, no runs
    setEnabled(id: string, on: boolean): Promise<Workflow> // on refuses while the workflow has problems, as Run does
    run(id: string, input?: string): Promise<WorkflowRunSummary> // by hand; a webhook workflow uses its saved sample call
    stop(runId: string): Promise<void>
    // A run a spend cap holds goes on: one more cap's worth (the run's, or the agent's for today), and the chats it paused resume
    continueCap(runId: string): Promise<void>
    retry(runId: string, visitId: string, itemId?: string): Promise<void> // itemId: one failed item of a For each visit only
    approve(runId: string, visitId: string, ok: boolean, text?: string, note?: string): Promise<void>
    // The editor's unsaved draft, so the user tests what they see; nothing is stored as a run
    testStep(
      draft: WorkflowInput,
      stepId: string,
      input: string
    ): Promise<{ output?: string; port?: Port; reason?: string; chatId?: string; error?: string; missing?: string[] }>
    draftWebhook(): Promise<{ id: string; url: string; secret: string }>
    dropDraft(id: string): Promise<void>
    webhook(id: string): Promise<{ url: string; secret: string; latest: WebhookCall | null }> // makes the secret if this workflow has none
    newSecret(id: string): Promise<string>
    approvals(): Promise<WorkflowApproval[]> // every Approval waiting for the user, oldest first
    // The editor's email trigger: one sign-in, the folder's message count or why it failed (never the password)
    checkMail(trigger: Extract<WorkflowTrigger, { kind: 'email' }>): Promise<{ messages: number } | { error: string }>
    // A chat's /run-workflow: `text` is the composer's text (`/run-workflow <name> <input>`; the bare rest works too). `workflowId`, the
    // Workflows list's pick, wins over the name, whose leading copy is then cut from the input. Problems throw as a manual run's do
    runFromChat(chatId: string, text: string, workflowId?: string): Promise<WorkflowRunSummary>
    onChanged(cb: (s: WorkflowsSnapshot) => void): () => void
  }
  inbox: {
    messages(): Promise<InboxMessages> // Notify step messages, deleted ones left out
    archive(id: string, on: boolean): Promise<void>
    remove(id: string): Promise<void>
    restore(id: string): Promise<void> // the Undo of remove; refused once the undo window has passed
    seen(at: number): Promise<void> // clamped to now on the server
    onChanged(cb: () => void): () => void // `inbox:changed` carries no text
  }
  jev: {
    status(): Promise<import('./jev').JevStatus>
    setKey(key: string | null): Promise<import('./jev').JevStatus> // the key is never sent back
    setSwitches(patch: Partial<import('./jev').JevSwitches>): Promise<import('./jev').JevStatus>
    check(): Promise<import('./jev').JevCheck>
    suggestAgent(text: string): Promise<string | null> // null while Jev or agent suggestions are off, or when unsure
  }
  voice: {
    status(): Promise<import('./voice').VoiceStatus>
    set(patch: {
      enabled?: boolean
      key?: string | null
      talk?: Partial<import('./voice').VoiceTalk>
      clean?: Partial<import('./voice').VoiceClean>
    }): Promise<import('./voice').VoiceStatus> // the key is never sent back
    check(): Promise<import('./voice').VoiceCheck>
    onChanged(cb: (s: import('./voice').VoiceStatus) => void): () => void
  }
  channels: {
    status(): Promise<import('./channels').ChannelStatus[]> // never a token or a pairing code
    setToken(platform: import('./channels').ChannelPlatform, token: string, appToken?: string): Promise<void> // checked with the platform first; never sent back. Slack: bot token plus app-level token
    setSharedCards(platform: import('./channels').ChannelPlatform, on: boolean): Promise<void> // Slack: cards also in channels others can read
    setNotify(platform: import('./channels').ChannelPlatform, toggles: import('./notify').ChannelNotifyToggles): Promise<void> // which notifications also go to the paired chat
    removeToken(platform: import('./channels').ChannelPlatform): Promise<void>
    setRun(platform: import('./channels').ChannelPlatform, on: boolean): Promise<void> // this machine runs the bot
    pairStart(platform: import('./channels').ChannelPlatform): Promise<{ code: string; expiresAt: number }> // the code goes only to the page that asked
    pairCancel(platform: import('./channels').ChannelPlatform): Promise<void>
    unpair(platform: import('./channels').ChannelPlatform): Promise<void>
    setAgents(platform: import('./channels').ChannelPlatform, names: string[]): Promise<void>
    link(chatId: string, platform: import('./channels').ChannelPlatform): Promise<void> // Continue in Telegram / Slack
    unlink(chatId: string): Promise<void>
    onChanged(cb: () => void): () => void
  }
  vault: {
    status(): Promise<import('./vault').VaultStatus>
    keyFile(): Promise<string> // where this server looks for the key: a path, never the key
    list(): Promise<import('./vault').VaultListItem[]> // never a secret
    reveal(id: string, field: 'password' | 'totp' | 'code' | 'number' | 'expiry' | 'cvc' | 'value'): Promise<string> // the one way a secret reaches the UI; 30 a minute
    save(input: import('./vault').VaultInput, updatedAt?: number): Promise<import('./vault').VaultListItem> // a stale `updatedAt` fails with VAULT_CHANGED
    delete(id: string): Promise<void>
    removeApproval(id: string, site: string, frameSite: string): Promise<void>
    reset(): Promise<void> // "Start a new vault": only while the key is missing or wrong
    answer(chatId: string, requestId: string, decision: 'allow' | 'deny'): Promise<void> // a card's first use on a site
    onChanged(cb: () => void): () => void
  }
  // Self-update from the public showcase site's release manifest (no token anywhere).
  update: {
    status(): Promise<import('./update').UpdateStatus>
    check(): Promise<import('./update').UpdateStatus>
    install(opts: { force: boolean }): Promise<{ started: true } | { busy: number }> // busy: replies running; send force to go on
    rollBack(opts: { force: boolean }): Promise<{ started: true } | { busy: number }> // same busy rule as install
    onChanged(cb: (s: import('./update').UpdateStatus) => void): () => void
  }
  // The audit log (docs/architecture/governance.md): read-only for the UI; no agent tool reaches it. The export is an HTTP route
  // (POST /api/audit/export, the filter in the body), so a large range never sits in one message.
  audit: {
    list(filter: import('./audit').AuditFilter, cursor: string | null, limit?: number): Promise<import('./audit').AuditPage>
    get(id: string, at: string): Promise<import('./audit').AuditRecord | null> // `at` is the row's own place
    facets(): Promise<import('./audit').AuditFacets>
    status(): Promise<import('./audit').AuditStatus>
    verify(): Promise<import('./audit').AuditVerify>
    setCap(bytes: number): Promise<import('./audit').AuditStatus>
    onChanged(cb: () => void): () => void
  }
  // Per-agent isolation (governance.md Part 2). Only these calls change it.
  isolation: {
    status(fresh?: boolean): Promise<import('./isolation').IsolationStatus> // fresh: check the machine again
    get(agent: string): Promise<import('./isolation').AgentIsolationView>
    set(agent: string, isolation: import('./isolation').AgentIsolation): Promise<import('./isolation').AgentIsolationView>
  }
  // What a folder (or an agent in it) loads, from the CLI itself, and the user's own Claude Code config on the server's machine.
  // `folder` is an existing absolute folder; errors are EXT_TEXT sentences; env and header values never come back.
  extensions: {
    loadout(folder: string, agent: string | null, refresh?: boolean): Promise<import('./extensions').Loadout> // cached until a write or refresh
    server(folder: string, scope: import('./extensions').McpScope, name: string): Promise<import('./extensions').McpServerView>
    // With a stamp (from `server`) it edits `prevName ?? name`; without, it adds `name`, which must be free. A stale stamp fails with EXT_TEXT.stale.
    saveServer(
      folder: string,
      scope: import('./extensions').McpScope,
      name: string,
      input: import('./extensions').McpServerInput,
      prevName?: string,
      stamp?: string
    ): Promise<void>
    removeServer(folder: string, scope: import('./extensions').McpScope, name: string): Promise<void>
    setPlugin(id: string, enabled: boolean): Promise<void>
    skill(scope: 'user' | 'project', folder: string, name: string): Promise<import('./extensions').SkillView>
    // With a stamp it edits that skill; without, it creates one and refuses a name that is taken.
    saveSkill(
      scope: 'user' | 'project',
      folder: string,
      input: { name: string; description: string; body: string; stamp?: string }
    ): Promise<void>
    removeSkill(scope: 'user' | 'project', folder: string, name: string): Promise<void> // to the Trash
    setSkill(name: string, on: boolean): Promise<void> // `skillOverrides` in the user's settings.json
    // An add may pass a null stamp; an edit (`input.at`) passes its row's stamp.
    saveHook(
      file: import('./extensions').HookFile,
      folder: string,
      input: import('./extensions').HookInput,
      stamp: string | null
    ): Promise<void>
    removeHook(
      file: import('./extensions').HookFile,
      folder: string,
      event: string,
      at: import('./extensions').HookPosition,
      stamp: string
    ): Promise<void>
    onChanged(cb: () => void): () => void // `extensions:changed` after any write: refetch
  }
  // The claude.ai connectors, per agent: all off until the user turns one on. Only these two calls ever write the switches.
  connectors: {
    list(refresh?: boolean): Promise<import('./connectors').ConnectorsView> // cached until a write or refresh
    setAgent(id: import('./connectors').ConnectorId, agent: string, on: boolean): Promise<void>
    setRemember(id: import('./connectors').ConnectorId, on: boolean): Promise<void> // only then may the service's write cards offer Allow for this chat / Allow always, and remembered answers apply (a write still asks)
    onChanged(cb: () => void): () => void // `connectors:changed`: refetch
  }
  btw: {
    ask(chatId: string, question: string, id: string): Promise<SideQuestion> // `id` is the client's, so a retry never asks twice
    follow(chatId: string, threadId: string, question: string, id: string): Promise<SideQuestion> // `threadId`: any entry of the thread
    list(chatId: string): Promise<SideQuestion[]>
    stop(chatId: string, id: string): Promise<void>
    again(chatId: string, id: string): Promise<SideQuestion>
    onChanged(cb: (p: { chatId: string; entry: SideQuestion }) => void): () => void
  }
  files: {
    list(chatId: string): Promise<import('./files').ChatFileList>
    // Undoes steps fromId..toId of one changed file on disk, once it still matches what they left; refusals are RESTORE_REFUSALS.
    restore(chatId: string, path: string, fromId: string, toId: string): Promise<{ done: 'written' | 'trashed' | 'unchanged' }>
  }
  usage: {
    query(q: import('./usageReport').UsageQuery): Promise<import('./usageReport').UsageSummary>
    // Agents with a daily spend cap and their day so far; allowMore lets one spend another cap's worth today
    caps(): Promise<AgentCapStatus[]>
    allowMore(agent: string): Promise<AgentCapStatus>
    onChanged(cb: (chatId: string | null) => void): () => void // chatId null = more than one chat changed
  }
  notify: {
    status(deviceId: string): Promise<NotifyStatus>
    enable(deviceId: string, o: { channel: NotifyChannel; label: string; subscription?: SubscriptionInput }): Promise<NotifyStatus>
    // Never creates a device: an unknown id is { known: false } and the page decides whether to enable again.
    refresh(deviceId: string, subscription: SubscriptionInput | null): Promise<{ known: boolean }>
    disable(deviceId: string): Promise<NotifyStatus>
    remove(deviceId: string): Promise<NotifyStatus> // another device
    setPrefs(deviceId: string, t: NotifyToggles): Promise<NotifyStatus>
    test(deviceId: string): Promise<'sent' | 'none'>
    // openedAgoMs: how long ago this page opened the chat; only an open after a mark ends it
    presence(deviceId: string, chatId: string | null, looking: boolean, inputAgoMs: number, openedAgoMs?: number): Promise<void>
    state(): Promise<NotifyState>
    onShow(cb: (p: NotifyPayload) => void): () => void
    onClear(cb: (p: import('./notify').NotifyClear) => void): () => void
  }
  session: { mode(): Promise<ServerMode>; signOut(): Promise<void>; signOutEverywhere(): Promise<void> }
  connection: { onStatus(cb: (s: ConnectionStatus) => void): () => void }
  desktop: DesktopBridge | null
}
