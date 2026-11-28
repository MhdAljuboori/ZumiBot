import type { ChannelService } from '../core/channels/channelService'
import type { ChannelStore } from '../core/channels/channelStore'
import { CHANNEL_PLATFORMS, isChannelPlatform, tokenShapeOk, type ChannelPlatform } from '@zumibot/shared/channels'
import { isChannelToggles } from '@zumibot/shared/notify'
import { randomBytes, randomUUID } from 'node:crypto'
import type { AuditLog } from '../core/audit/auditLog'
import { AUDIT_CAPS, AUDIT_PAGE_MAX, parseAuditFilter } from '@zumibot/shared/audit'
import { mkdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { AgentStore } from '../core/agents/agentStore'
import type { AttachmentStore } from '../core/attachments/attachmentStore'
import type { SideQuestions } from '../core/btw/sideQuestions'
import type { ItemsLoader } from '../core/git/agentTree'
import type { GitChangesService } from '../core/git/changes'
import type { WorktreeService } from '../core/git/worktrees'
import type { ChatService } from '../core/chat/chatService'
import type { CommandResolver } from '../core/chat/commandResolver'
import type { GroupService } from '../core/chat/groupService'
import type { ReadMarks } from '../core/chat/readMarks'
import type { LimitResumes } from '../core/chat/limitResumes'
import type { LaterSends } from '../core/chat/laterSends'
import { laterNests, laterRest, parseLater, LATER_NESTED } from '@zumibot/shared/later'
import { isTimeZone } from '@zumibot/shared/schedule'
import type { TaskQueue } from '../core/chat/taskQueue'
import { forkChat } from '../core/chat/fork'
import { cloneRoom } from '../core/chat/roomClone'
import type { RoomSummaries } from '../core/chat/roomSummary'
import { CLONE_TITLE_MAX, HANDOFF_MAX_CHARS } from '@zumibot/shared/roomClone'
import { copyTitle } from '@zumibot/shared/copyTitle'
import { ARCHIVE_RUNNING, archivePatch } from '@zumibot/shared/archive'
import type { SnapshotStore } from '../core/files/snapshotStore'
import type { BrowserShots } from '../core/browser/browserShots'
import type { ChatTmp } from '../core/chat/chatTmp'
import { listChatFiles } from '@zumibot/shared/chatFiles'
import type { RestoreResult } from '../core/files/restoreFile'
import { parseDecision } from '../core/chat/controlProtocol'
import { listDirs, makeDir } from '../core/folders'
import { groupRole, memberList, refuseCodexMembers, validateNewGroupMembers } from '../core/groupMembers'
import {
  assertNever,
  CODEX_REFUSALS,
  capRefusal,
  chatEngine,
  engineCaps,
  engineOfAgent,
  ENGINES,
  isolationRefusal,
  isRemoteAgent,
  markEngine,
  spendCapRefusal,
  todoRefusal,
  type CodexInfo,
  type Engine,
  type EngineCaps,
  type RefusedCap
} from '@zumibot/shared/engine'
import { matchAgent } from '@zumibot/shared/agentMatch'
import { voiceChatTitle } from '../core/voice/voiceTitle'
import type { ChatStore } from '../core/store/chatStore'
import type { SettingsStore } from '../core/store/settingsStore'
import type { MemoryStore } from '../core/memory/memoryStore'
import type { MemoryTurns } from '../core/memory/memoryTurns'
import type { TodoService } from '../core/todos/todoService'
import { TaskCards } from '../core/todos/taskCards'
import { CommentAsks, type Routed } from '../core/todos/commentAsks'
import type { RouteInput } from '../core/todos/commentRouting'
import { AttemptSets } from '../core/attempts/attemptSets'
import type { PullRequests } from '../core/github/pullRequests'
import type { PrWatcher } from '../core/github/prWatcher'
import { GH_MISSING, PR_BODY_MAX, PR_TITLE_MAX } from '@zumibot/shared/pullRequest'
import type { DispatchService } from '../core/dispatch/dispatchService'
import type { ProcessService } from '../core/processes/processService'
import { runBlock } from '../core/processes/runBlock'
import { isProcessId } from '@zumibot/shared/processes'
import type { SearchIndex } from '../core/search/searchIndex'
import { SEARCH_OFFSET_MAX, SEARCH_QUERY_MAX } from '@zumibot/shared/search'
import { isScratchRoot, scratchChild, scratchName } from '@zumibot/shared/scratch'
import { checkMemoryInput, effectiveLimit, isMemoryFileName } from '@zumibot/shared/memory'
import type { ApprovalStore } from '../core/store/approvalStore'
import { acpRecord, aguiRecord, type LaunchTrust } from '../core/acp/launchTrust'
import { checkUrl, resolveTarget, type AguiLookup } from '../core/agui/aguiEndpoint'
import { AGUI_TEXT, type AguiLaunch, type AguiTestResult } from '@zumibot/shared/agui'
import { ACP_TEXT, refusedArg, type AcpLaunch, type AcpTestResult } from '@zumibot/shared/acp'
import type { SidebarStore } from '../core/store/sidebarStore'
import type { RoutineRunner } from '../core/routines/routineRunner'
import { KEEP_WARM_CHAT_HOURS, KEEP_WARM_ROOM_HOURS, keepWarmOf } from '@zumibot/shared/keepWarm'
import { parseRoutineInput } from '../core/routines/routineInput'
import { NOT_FOUND, routineEditing, type RoutineEditing } from '../core/routines/routineEditing'
import type { HistoryStore } from '../core/history/historyStore'
import {
  routineChanges,
  routineDef,
  summarizeVersions,
  workflowChanges,
  workflowDef,
  type RoutineDef,
  type SaveMeta,
  type WorkflowDef
} from '@zumibot/shared/definitionHistory'
import { nextFor } from '../core/nextFor'
import { WORKFLOW_NOT_FOUND, withSample, workflowEditing, type WorkflowEditing } from '../core/workflows/workflowEditing'
import type { RoutineStore } from '../core/routines/routineStore'
import { INVALID_WORKFLOW, NAME_MAX as WORKFLOW_NAME_MAX, parseTrigger, parseWorkflowInput, validId } from '../core/workflows/workflowInput'
import { PROBLEMS_TEXT, type WorkflowRunner } from '../core/workflows/workflowRunner'
import type { WorkflowStore } from '../core/workflows/workflowStore'
import type { WorkflowMessages } from '../core/workflows/workflowMessages'
import type { ItemsFeed } from './itemsFeed'
import type { JevStore } from '../core/jev/jevStore'
import type { UsageService } from '../core/usage/usageService'
import type { UsageQuery } from '@zumibot/shared/usageReport'
import type { createBrowserApplication } from '../core/browser/browserApplication'
import type { DesktopApplication } from '../core/desktop/desktopApplication'
import { ATTACH_MAX_FILES, stageErrors } from '@zumibot/shared/attachments'
import { COMMAND_PROMPT_MAX, type CommandPick } from '@zumibot/shared/commands'
import { ROUTINE_NAME_MAX, type Routine } from '@zumibot/shared/routines'
import { afterWorkflowName, resolveRunWorkflow, runWorkflowRest } from '@zumibot/shared/runWorkflow'
import { REPLY_TEXT_MAX, eventCall, type ChatRef } from '@zumibot/shared/workflowEvents'
import {
  APPROVAL_TEXT_MAX,
  OUTPUT_MAX,
  TRIGGER_BODY_MAX,
  type Workflow,
  type WorkflowInput,
  type WorkflowTrigger
} from '@zumibot/shared/workflows'
import { parseLayout, type SidebarLayout } from '@zumibot/shared/sidebarLayout'
import {
  ATTEMPTS_MAX,
  ATTEMPTS_MIN,
  TODO_FILES_MAX,
  TODO_QUESTIONS_MAX,
  isTodoStatus,
  splitTodo,
  type TodoStatus
} from '@zumibot/shared/todos'
import {
  COMPACT_NOTE_MAX,
  REACTIONS,
  isAccent,
  isThemePref,
  type Accent,
  type AgentSummary,
  type ChatMeta,
  type ChatPush,
  type ChatWorktree,
  type ClaudeAccount,
  type GhState,
  type GitDiffScope,
  type QuestionAnswers,
  type ServerMode,
  type ThemePref,
  type TodoCardEdit
} from '@zumibot/shared/types'
import {
  VOICE_KEY_MAX,
  parseCleanPatch,
  parseTalkPatch,
  type VoiceCheck,
  type VoiceClean,
  type VoiceStatus,
  type VoiceTalk
} from '@zumibot/shared/voice'
import type { VoiceStore } from '../core/voice/voiceStore'
import { JEV_KEY_MAX, SUGGEST_MIN_CHARS, type JevCheck, type JevSwitches } from '@zumibot/shared/jev'
import { CONTACT_FIELDS, listView, type VaultInput } from '@zumibot/shared/vault'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { folderRuleError, prefixRuleError, ruleOfFolder, ruleOfPrefix } from '@zumibot/shared/allowRules'
import {
  EXT_TEXT,
  isReservedServerName,
  isServerName,
  type HookFile,
  type HookInput,
  type HookPosition,
  type McpScope,
  type McpServerInput
} from '@zumibot/shared/extensions'
import type { EngineCommands } from '@zumibot/shared/engineCommands'
import { NAME_PATTERN, parseAgent } from '@zumibot/shared/frontmatter'
import type { ExtensionsService } from '../core/extensions/extensionsService'
import type { ConnectorsService } from '../core/connectors/connectorsService'
import { CONNECTOR_TEXT, isConnectorId } from '@zumibot/shared/connectors'
import type { VaultStore } from '../core/vault/vaultStore'
import type { VaultApprovals } from '../core/vault/vaultApprovals'
import type { UpdateService } from '../core/update/updateService'
import { capEngines } from '../core/caps/capEngines'
import type { SpendCaps } from '../core/caps/spendCaps'
import { createRevealLimiter } from '../core/vault/revealLimiter'
import { totpAt } from '../auth/totp'
import { isChatMode, isEffort } from '@zumibot/shared/chatRun'
import { parseIsolation, type AgentIsolationView } from '@zumibot/shared/isolation'
import type { IsolationService } from '../core/isolation/isolationService'

export interface HandlerDeps {
  side: Pick<SideQuestions, 'ask' | 'follow' | 'list' | 'stop' | 'again' | 'stopChat' | 'renameAgent'>
  browsers?: Pick<Awaited<ReturnType<typeof createBrowserApplication>>, 'status' | 'clear' | 'renameAgent' | 'removeAgents'>
  desktops?: Pick<DesktopApplication, 'status' | 'clear' | 'renameAgent' | 'removeAgents'>
  agents: AgentStore
  chats: ChatStore
  settings: SettingsStore
  sidebar: SidebarStore
  approvals: ApprovalStore
  /**
   * The ACP launches confirmed on this machine (`protocol-launch.json`): Agent Studio's Save is the only place a launch is
   * confirmed. Absent (tests that do not look at it): nothing is confirmed, so no ACP agent runs.
   */
  launchTrust?: Pick<LaunchTrust, 'confirm' | 'rename' | 'remove' | 'confirmed'>
  /** Agent Studio's Test of an ACP agent's saved, confirmed launch (`core/acp/acpTest.ts`). Absent: refused with a fixed sentence. */
  acpTest?(agent: string): Promise<AcpTestResult>
  /** Agent Studio's Test of a remote agent's saved, confirmed endpoint (`core/agui/aguiTest.ts`). Absent: refused with a fixed sentence. */
  aguiTest?(agent: string): Promise<AguiTestResult>
  /**
   * What agents:save checks a remote agent's endpoint with, as a run does: the dev hook (devEnv) and, in tests, the name lookup.
   * Absent: no local address is allowed, and names resolve through DNS.
   */
  aguiEndpoint?: { allowLocal: boolean; lookup?: AguiLookup }
  routineStore: RoutineStore
  runner: RoutineRunner
  scheduler: { rearm(): Promise<void> }
  /** `<origin>/hooks/<id>`; read at call time, since local mode learns its origin after listening. */
  hookUrl(id: string): string
  /** Tells every tab the routines or their runs changed. */
  routinesChanged(): void
  /** The save and remove shared with Zumi Bot; built from the deps above when absent (tests). */
  routineEditing?: RoutineEditing
  /** Saved versions of routines and workflows; absent in tests that do not look at history (none listed). */
  routineHistory?: HistoryStore<RoutineDef>
  workflowHistory?: HistoryStore<WorkflowDef>
  workflowStore: WorkflowStore
  workflowRunner: Pick<
    WorkflowRunner,
    'run' | 'stopRun' | 'stopAllOf' | 'retry' | 'approve' | 'testStep' | 'problems' | 'taskDropped' | 'chatRemoved'
  >
  /** Spend caps; absent in tests that do not look at them (no caps, and their RPCs refuse). */
  spendCaps?: Pick<SpendCaps, 'status' | 'allowMore' | 'continueWorkflow'>
  workflowScheduler: { rearm(): Promise<void> }
  /** Tells every tab the workflows or their runs changed (`workflows:changed`, summaries only). */
  workflowsChanged(): void
  /** The save and remove shared with Zumi Bot; built from the deps above when absent (tests). */
  workflowEditing?: WorkflowEditing
  /** The Inbox's Messages (a Notify step's text), kept in `workflow-messages.json`. */
  inbox: Pick<WorkflowMessages, 'list' | 'setArchived' | 'remove' | 'restore' | 'markSeen'>
  /** Tells every tab the Inbox changed (`inbox:changed`, an empty payload: the tab refetches). */
  inboxChanged(): void
  /** Tells every tab an agent's remembered rules changed. */
  approvalsChanged(agent: string): void
  memory: { store: MemoryStore; turns: MemoryTurns; autoMemoryOff(): Promise<boolean> }
  /** Tells every tab an agent's memory changed. */
  memoryChanged(agent: string): void
  /** The to-do list; the service itself tells every tab (`todos:changed`) after each change. */
  todos: Pick<
    TodoService,
    | 'list'
    | 'board'
    | 'userAdd'
    | 'userCheck'
    | 'userRemove'
    | 'userRestore'
    | 'userEdit'
    | 'card'
    | 'userAssign'
    | 'userStatus'
    | 'userStartTask'
    | 'userAnswer'
    | 'userReopen'
    | 'userStartAttempts'
    | 'userKeepAttempt'
    | 'userDropAttempts'
    | 'userComment'
    | 'commentRouted'
    | 'userEditComment'
    | 'userDeleteComment'
    | 'agentReply'
  >
  /** The chats' dispatched agents; the service tells every tab (`dispatch:changed`) about once a second while a turn runs. */
  dispatch: Pick<DispatchService, 'list' | 'get'>
  /** Background processes; the service tells every tab (`processes:changed`, `processes:output`) itself. */
  processes?: Pick<ProcessService, 'list' | 'read' | 'stop' | 'restart' | 'forget' | 'counts' | 'endChat' | 'removeChat' | 'run'>
  /** The full-text index over every chat's messages, kept up to date by the store's items and removal listeners. */
  search: Pick<SearchIndex, 'search'>
  /** Tells every tab the sidebar layout changed. */
  sidebarChanged(layout: SidebarLayout): void
  suggestedRepliesChanged(on: boolean): void
  chatService: ChatService
  groupService: GroupService
  tasks: TaskQueue
  summaries: Pick<RoomSummaries, 'summarize' | 'cancel'>
  /** Turns a leading /command into the agent's saved prompt; the routine runner has its own `forRoutine` call. */
  commands: Pick<CommandResolver, 'forSend' | 'forRerun'>
  /** Sends a chat push to every tab (the same path ChatService pushes through). */
  push(p: ChatPush): void
  reads: Pick<ReadMarks, 'markUnread'>
  /** Chats the usage limit stopped, waiting to continue at the reset. */
  limits: Pick<LimitResumes, 'dontContinue' | 'continueNow'>
  /** `/later` messages waiting on their chats (agent-commands.md, /later). */
  later: Pick<LaterSends, 'add' | 'cancel' | 'sendNow'>
  /** After a chat is deleted: drops its held notifications and clears the ones on screen. */
  chatRemoved?(chatId: string): void
  attachments: AttachmentStore
  snapshots: Pick<SnapshotStore, 'copy' | 'removeChat'>
  /** "Restore to before this change" in the Files panel (`core/files/restoreFile.ts`). */
  restoreFile(chatId: string, path: string, fromId: string, toId: string): Promise<RestoreResult>
  browserShots: Pick<BrowserShots, 'removeChat'>
  tmp: Pick<ChatTmp, 'remove'>
  feed: ItemsFeed
  claude: {
    status(): Promise<string | null>
    setPath(path: string): Promise<string | null>
  }
  // What Codex reports here (found, models). Absent: reported as not found.
  codexInfo?(): Promise<CodexInfo>
  /** Which of the agents a card comment names it is addressed to, with a line for each (Haiku). Absent: all are asked. */
  routeComment?(input: RouteInput): Promise<Routed | null>
  // What each engine can do (default engineCaps); a test turns a flag off through it.
  caps?(engine: Engine): EngineCaps
  account(): Promise<ClaudeAccount>
  usage: Pick<UsageService, 'query'>
  /** Git worktrees for chats and rooms (`core/git/worktrees.ts`); absent in tests that do not look at them (no chat isolates, no git chip). */
  worktrees?: Pick<WorktreeService, 'topOf' | 'create' | 'status' | 'release' | 'headOf'>
  /** The gh CLI and the pull requests opened from a chat's worktree branch (see review-loop.md); absent without git. */
  github?: {
    state(): Promise<GhState>
    prs: Pick<PullRequests, 'draftPr' | 'createPr' | 'refreshPr' | 'sendCheck'>
    watcher: Pick<PrWatcher, 'watch' | 'stop'>
  }
  /** The Changes panel's list and diffs (`core/git/changes.ts`); absent in tests that do not look at them. */
  gitChanges?: Pick<GitChangesService, 'list' | 'diff'>
  // A fixed folder for built-in agents (their chats never ask for one), or null.
  builtInCwd(agentName: string): string | null
  home: string
  mode: ServerMode
  // ZUMIBOT_TEST_PICK_FOLDER (read through devEnv): the folder browser is skipped and this one is used.
  testPickFolder: string | null
  jev: {
    store: Pick<JevStore, 'status' | 'setKey' | 'setSwitches'>
    check(): Promise<JevCheck>
    // null while Jev or its switch is off
    suggestAgent(text: string, agents: readonly { name: string; description: string }[]): Promise<string | null>
  }
  voice: {
    store: Pick<VoiceStore, 'status' | 'set' | 'renameAgent'>
    check(): Promise<VoiceCheck>
  }
  voiceChanged(s: VoiceStatus): void
  /** The encrypted vault; the store tells every tab itself (`vault:changed`, wired in app.ts). */
  vault: Pick<VaultStore, 'status' | 'keyFile' | 'list' | 'get' | 'save' | 'delete' | 'removeApproval' | 'reset' | 'renameAgent'>
  /** Self-update; the service tells every tab itself (`update:changed`, wired in app.ts). */
  update: Pick<UpdateService, 'seen' | 'check' | 'install' | 'rollBack'>
  // Channels (Telegram): absent in tests that build handlers without them.
  channels?: { services: Record<ChannelPlatform, ChannelService>; store: Pick<ChannelStore, 'renameAgent'> }
  /** A card's first-use approval, answered from its chat card. */
  vaultApprovals: Pick<VaultApprovals, 'answer'>
  /** Check mailbox: one IMAP sign-in with the trigger's Vault login (`checkMailbox`); absent in tests that do not look at it. */
  checkMail?(trigger: Extract<WorkflowTrigger, { kind: 'email' }>): Promise<{ messages: number } | { error: string }>
  /** What agents load and the user's Claude Code config; the service tells every tab itself (`extensions:changed`, wired in app.ts). */
  extensions: Pick<
    ExtensionsService,
    | 'loadout'
    | 'server'
    | 'saveServer'
    | 'removeServer'
    | 'setPlugin'
    | 'skill'
    | 'saveSkill'
    | 'removeSkill'
    | 'setSkill'
    | 'saveHook'
    | 'removeHook'
    | 'engineCommands'
    | 'forget'
  >
  /** The claude.ai connector switches; the service tells every tab itself (`connectors:changed`, wired in app.ts). */
  connectors: Pick<ConnectorsService, 'list' | 'setAgent' | 'setRemember'>
  /** The audit log, read-only here apart from its cap; absent in tests that don't need it. */
  audit?: Pick<AuditLog, 'list' | 'get' | 'getFacets' | 'status' | 'verify' | 'setCap'>
  // Agent isolation: only these UI calls change it; no agent tool or bridge reaches them.
  isolation?: Pick<IsolationService, 'get' | 'set' | 'rename' | 'status'>
}

export type Handlers = Record<string, (...args: unknown[]) => Promise<unknown>>

const isolationOf = (d: HandlerDeps): NonNullable<HandlerDeps['isolation']> => {
  if (!d.isolation) throw new Error('Isolation unavailable')
  return d.isolation
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new TypeError(`${what} must be a string`)
  return v
}

// An agent's name, checked as agents:save checks it (validateFields): the rule a saved file's name passed.
function savedAgentName(v: unknown): string {
  const name = str(v, 'agentName')
  if (!NAME_PATTERN.test(name)) throw new TypeError('Name must be lowercase letters, digits and single hyphens')
  return name
}

function cloneTitle(v: unknown): string {
  const t = str(v, 'title').trim()
  if (!t) throw new TypeError('title must not be empty')
  if (t.length > CLONE_TITLE_MAX) throw new TypeError(`title must be at most ${CLONE_TITLE_MAX} characters`)
  return t
}

function cloneHandoff(v: unknown): string | null {
  if (v === null) return null
  const t = str(v, 'handoff')
  if (!t.trim()) throw new TypeError('handoff must not be empty')
  if (t.length > HANDOFF_MAX_CHARS) throw new TypeError(`handoff must be at most ${HANDOFF_MAX_CHARS} characters`)
  return t
}

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new TypeError(`${what} must be an array of strings`)
  return v as string[]
}

// null = Skip the question card. The per-answer checks live in ChatService (checkAnswers).
function questionAnswers(v: unknown): QuestionAnswers | null {
  if (v === null) return null
  if (typeof v !== 'object' || Array.isArray(v)) throw new TypeError('answers must be an object or null')
  return v as QuestionAnswers
}

function attachmentIds(v: unknown): string[] {
  if (v === undefined || v === null) return [] // JSON turns an omitted argument into null
  const ids = strings(v, 'attachmentIds')
  if (ids.length > ATTACH_MAX_FILES) throw new Error(stageErrors.TOO_MANY)
  // commit() moves files one by one, so a repeated id would fail half way through.
  if (new Set(ids).size !== ids.length) throw new Error(stageErrors.GONE)
  return ids
}

function replyTo(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : str(v, 'replyTo')
}

const MESSAGE_ID_RE = /^[A-Za-z0-9-]{1,64}$/

// The id the client gave the message it already shows, so the stored one is the same message.
function messageId(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  const id = str(v, 'messageId')
  if (!MESSAGE_ID_RE.test(id)) throw new TypeError('messageId must be 1-64 letters, digits or dashes')
  return id
}

/** The `/` menu's pick (composer or message editor); the server looks the prompt up itself, so only the two names and the engine marker are read. */
function commandPick(v: unknown): CommandPick | undefined {
  if (v === undefined || v === null) return undefined
  const o = v as Record<string, unknown>
  if (typeof v !== 'object' || typeof o.agent !== 'string' || typeof o.name !== 'string') throw new TypeError('Invalid command')
  if (o.engine !== undefined && !(o.engine === 'claude' || o.engine === 'codex')) throw new TypeError('Invalid command')
  return o.engine === undefined ? { agent: o.agent, name: o.name } : { agent: o.agent, name: o.name, engine: o.engine }
}

/** A version position; the queue checks it against the message's versions. */
function versionIndex(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new TypeError('index must be a non-negative integer')
  return v
}

// Where an open conversation's new steps start; absent (null or undefined) = the whole entry.
function processId(v: unknown): string {
  if (!isProcessId(v)) throw new TypeError('id must be a process id')
  return v
}

function stepFrom(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new TypeError('from must be a non-negative integer')
  return v
}

function compactNote(v: unknown): string {
  const note = str(v, 'note')
  if (note.length > COMPACT_NOTE_MAX) throw new TypeError(`note must be at most ${COMPACT_NOTE_MAX} characters`)
  return note
}

function reaction(v: unknown): string {
  if (!(REACTIONS as readonly unknown[]).includes(v)) throw new TypeError('emoji must be one of the reactions')
  return v as string
}

function themePref(v: unknown): ThemePref {
  if (!isThemePref(v)) throw new TypeError('theme must be system, light or dark')
  return v
}

function accentOf(v: unknown): Accent {
  if (!isAccent(v)) throw new TypeError('accent must be blue, teal, coral or graphite')
  return v
}

// update:install and update:rollBack both take { force: boolean }.
function forceOf(v: unknown): { force: boolean } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('options must be an object')
  return { force: bool((v as { force?: unknown }).force, 'force') }
}

function channelPlatform(v: unknown): ChannelPlatform {
  if (!isChannelPlatform(v)) throw new TypeError('platform must be a known channel')
  return v
}

// Never echoed: a refusal names the setting only. Slack takes two: the bot token and the app-level token.
function botToken(platform: ChannelPlatform, v: unknown, app: unknown): { token: string; appToken?: string } {
  const token = typeof v === 'string' ? v.trim() : null
  const appToken = app === undefined || app === null ? undefined : typeof app === 'string' ? app.trim() : null
  if (
    token === null ||
    appToken === null ||
    token.length > 300 ||
    (appToken?.length ?? 0) > 300 ||
    !tokenShapeOk(platform, token, appToken)
  ) {
    throw new TypeError(
      `That doesn't look like ${platform === 'slack' ? 'a Slack bot token (xoxb-…) and app token (xapp-…)' : 'a Telegram bot token'}.`
    )
  }
  return { token, ...(appToken !== undefined ? { appToken } : {}) }
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new TypeError(`${what} must be a boolean`)
  return v
}

// Which diff the Changes panel asks for; absent (null or undefined) is the uncommitted one, as before the base diff.
function gitScope(v: unknown): GitDiffScope {
  if (v === undefined || v === null) return 'uncommitted'
  if (v !== 'uncommitted' && v !== 'base') throw new TypeError("scope must be 'uncommitted' or 'base'")
  return v
}

const TODO_IDS_MAX = 200
const TODO_ID_MAX = 64

function todoStatus(v: unknown): TodoStatus {
  if (!isTodoStatus(v)) throw new TypeError("status must be 'new', 'todo', 'blocked', 'progress', 'review' or 'done'")
  return v
}

/** What Create pull request sends. The service cuts and re-checks everything; these bounds only keep the request sane. */
function prInput(v: unknown): { title: string; body: string; draft: boolean } {
  const o = v as Record<string, unknown> | null
  if (typeof o !== 'object' || o === null) throw new TypeError('input must be an object')
  const title = str(o.title, 'title')
  if (title.trim() === '') throw new TypeError('title must not be empty')
  if (title.length > PR_TITLE_MAX) throw new TypeError(`title must be at most ${PR_TITLE_MAX} characters`)
  const body = o.body === undefined || o.body === null ? '' : str(o.body, 'body')
  if (body.length > PR_BODY_MAX) throw new TypeError(`body must be at most ${PR_BODY_MAX} characters`)
  return { title, body, draft: o.draft === undefined || o.draft === null ? false : bool(o.draft, 'draft') }
}

/** A check's name as the chat's own stored rollup spells it; the service refuses one it does not list. */
function checkName(v: unknown): string {
  const name = str(v, 'name')
  if (name.trim() === '' || name.length > 300) throw new TypeError('name must be 1 to 300 characters')
  return name
}

/** The agents a set of attempts runs: 2 to 5 `{agent}` entries, the same agent allowed twice. The service checks they exist. */
function attemptPicks(v: unknown): { agent: string }[] {
  if (!Array.isArray(v)) throw new TypeError('picks must be an array')
  if (v.length < ATTEMPTS_MIN || v.length > ATTEMPTS_MAX) throw new TypeError(`picks must name ${ATTEMPTS_MIN} to ${ATTEMPTS_MAX} agents`)
  return v.map((p) => {
    const o = p as Record<string, unknown> | null
    if (typeof o !== 'object' || o === null || typeof o.agent !== 'string') throw new TypeError('each pick must be {agent}')
    return { agent: str(o.agent, 'agent') }
  })
}

/** Who a card is for: 'user', an agent's name, or null for nobody. */
function assigneeArg(v: unknown): string | null {
  return v === null ? null : str(v, 'assignee')
}

function todoId(v: unknown): string {
  const id = str(v, 'id')
  if (id.length < 1 || id.length > TODO_ID_MAX) throw new TypeError(`id must be 1 to ${TODO_ID_MAX} characters`)
  return id
}

// Lengths are the shared rules' (they cut); these bounds only keep a request's size sane before they run.
const CARD_TEXT_BOUND = 100_000

function boundedText(v: unknown, what: string): string {
  const t = str(v, what)
  if (t.length > CARD_TEXT_BOUND) throw new TypeError(`${what} is too long`)
  return t
}

/** A card edit: only known keys, files as staged ids to add and card file ids to remove. */
function todoCardEdit(v: unknown): TodoCardEdit {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('patch must be an object')
  const o = v as Record<string, unknown>
  if (Object.keys(o).some((k) => !['text', 'description', 'addFiles', 'removeFiles'].includes(k)))
    throw new TypeError('patch has an unknown key')
  const ids = (x: unknown, what: string): string[] => {
    const a = strings(x, what)
    if (a.length > TODO_FILES_MAX || new Set(a).size !== a.length || a.some((id) => id.length < 1 || id.length > TODO_ID_MAX))
      throw new TypeError(`${what} must hold at most ${TODO_FILES_MAX} distinct ids`)
    return a
  }
  return {
    ...(o['text'] !== undefined ? { text: boundedText(o['text'], 'text') } : {}),
    ...(o['description'] !== undefined ? { description: boundedText(o['description'], 'description') } : {}),
    ...(o['addFiles'] !== undefined ? { addFiles: ids(o['addFiles'], 'addFiles') } : {}),
    ...(o['removeFiles'] !== undefined ? { removeFiles: ids(o['removeFiles'], 'removeFiles') } : {})
  }
}

function todoAnswers(v: unknown): { id: string; text: string }[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > TODO_QUESTIONS_MAX)
    throw new TypeError(`answers must hold 1 to ${TODO_QUESTIONS_MAX} answers`)
  return v.map((a) => {
    if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new TypeError('each answer must be {id, text}')
    const o = a as Record<string, unknown>
    if (Object.keys(o).some((k) => k !== 'id' && k !== 'text')) throw new TypeError('each answer must be {id, text}')
    return { id: todoId(o['id']), text: boundedText(o['text'], 'text') }
  })
}

function todoIds(v: unknown): string[] {
  const a = strings(v, 'ids')
  if (a.length < 1 || a.length > TODO_IDS_MAX) throw new TypeError(`ids must hold 1 to ${TODO_IDS_MAX} ids`)
  if (a.some((x) => x.length > TODO_ID_MAX)) throw new TypeError(`ids must be at most ${TODO_ID_MAX} characters each`)
  return a
}

// The vault's input comes from RPC JSON, so every field is checked here and only known keys are copied over:
// the store trusts shapes, and a client must never set `approved` or an id of its own choosing. Errors name the
// field, never its value (most of them are secrets).
function vaultInput(v: unknown): VaultInput {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError('item must be an object')
  const o = v as Record<string, unknown>
  const optional = (x: unknown, what: string): string | undefined => (x === undefined ? undefined : str(x, what))
  const base = {
    ...(o['id'] === undefined ? {} : { id: str(o['id'], 'id') }),
    name: str(o['name'], 'name'),
    agents: strings(o['agents'], 'agents')
  }
  switch (o['kind']) {
    case 'login': {
      const totp = o['totp']
      if (totp !== undefined && totp !== null && typeof totp !== 'string') throw new TypeError('totp must be a string or null')
      return {
        ...base,
        kind: 'login',
        sites: strings(o['sites'], 'sites'),
        username: str(o['username'], 'username'),
        workflows: o['workflows'] === true,
        ...(o['password'] === undefined ? {} : { password: str(o['password'], 'password') }),
        ...(totp === undefined ? {} : { totp })
      }
    }
    case 'card': {
      const number = optional(o['number'], 'number')
      const expiry = optional(o['expiry'], 'expiry')
      const cvc = optional(o['cvc'], 'cvc')
      return {
        ...base,
        kind: 'card',
        holder: str(o['holder'], 'holder'),
        ...(number === undefined ? {} : { number }),
        ...(expiry === undefined ? {} : { expiry }),
        ...(cvc === undefined ? {} : { cvc })
      }
    }
    case 'contact': {
      const fields = Object.fromEntries(CONTACT_FIELDS.map((f) => [f, str(o[f], f)])) as Record<(typeof CONTACT_FIELDS)[number], string>
      return { ...base, kind: 'contact', ...fields }
    }
    case 'apiKey': {
      // Trimmed: a pasted key with a trailing space or newline would reach the env as is, and the literal scrub would then
      // miss the bare token wherever a command prints it.
      const value = optional(o['value'], 'value')?.trim()
      return {
        ...base,
        kind: 'apiKey',
        env: str(o['env'], 'env'),
        description: str(o['description'], 'description'),
        workflows: o['workflows'] === true,
        ...(value === undefined ? {} : { value })
      }
    }
    default:
      throw new TypeError('kind must be login, card, contact or apiKey')
  }
}

function searchQuery(v: unknown): string {
  const q = str(v, 'query')
  if (q.length > SEARCH_QUERY_MAX) throw new TypeError(`query must be at most ${SEARCH_QUERY_MAX} characters`)
  return q
}

// absent (null or undefined) = the first page
function searchOffset(v: unknown): number {
  if (v === undefined || v === null) return 0
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > SEARCH_OFFSET_MAX)
    throw new TypeError(`offset must be an integer from 0 to ${SEARCH_OFFSET_MAX}`)
  return v
}

function finiteOrNone(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what} must be a number`)
  return v
}

const VAULT_REVEAL_FIELDS = ['password', 'totp', 'code', 'number', 'expiry', 'cvc', 'value'] as const
type VaultRevealField = (typeof VAULT_REVEAL_FIELDS)[number]

function revealField(v: unknown): VaultRevealField {
  if (!(VAULT_REVEAL_FIELDS as readonly unknown[]).includes(v)) throw new TypeError('field is not a secret field')
  return v as VaultRevealField
}

function secretOf(item: NonNullable<ReturnType<HandlerDeps['vault']['get']>>, field: VaultRevealField): string {
  switch (item.kind) {
    case 'login':
      if (field === 'password') return item.password
      if (field === 'totp' || field === 'code') {
        if (item.totp === null) throw new Error('This login has no 2FA secret.')
        return field === 'totp' ? item.totp : totpAt(item.totp, Date.now())
      }
      break
    case 'card':
      if (field === 'number' || field === 'expiry' || field === 'cvc') return item[field]
      break
    case 'apiKey':
      if (field === 'value') return item.value
      break
  }
  throw new Error('This item has no such field.')
}

function layout(v: unknown): SidebarLayout {
  const l = parseLayout(v)
  if (!l) throw new TypeError('layout must be a sidebar layout')
  return l
}

// Errors never quote the key: a mistyped one is still mostly the secret.
function jevKey(v: unknown): string | null {
  if (v === null) return null
  if (typeof v !== 'string') throw new TypeError('key must be a string or null')
  const key = v.trim()
  if (!key) throw new TypeError('key must not be empty')
  if (key.length > JEV_KEY_MAX || /\s/.test(key)) throw new TypeError('That does not look like an OpenRouter key')
  return key
}

// Same rules as jevKey; the store is a dumb holder, so the limits live here. Errors never quote the key.
function voiceKey(v: unknown): string | null {
  if (v === null) return null
  if (typeof v !== 'string') throw new TypeError('key must be a string or null')
  const key = v.trim()
  if (!key) throw new TypeError('key must not be empty')
  if (key.length > VOICE_KEY_MAX || /\s/.test(key)) throw new TypeError('That does not look like an OpenRouter key')
  return key
}

function voicePatch(v: unknown): { enabled?: boolean; key?: string | null; talk?: Partial<VoiceTalk>; clean?: Partial<VoiceClean> } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('patch must be an object')
  const out: { enabled?: boolean; key?: string | null; talk?: Partial<VoiceTalk>; clean?: Partial<VoiceClean> } = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === 'enabled') out.enabled = bool(x, k)
    else if (k === 'key') out.key = voiceKey(x)
    else if (k === 'talk') {
      const talk = parseTalkPatch(x)
      if (!talk) throw new TypeError('bad talk settings')
      out.talk = talk
    } else if (k === 'clean') {
      const clean = parseCleanPatch(x)
      if (!clean) throw new TypeError('bad clean settings')
      out.clean = clean
    } else throw new TypeError(`${k} is not a voice setting`)
  }
  return out
}

const JEV_SWITCHES: readonly (keyof JevSwitches)[] = ['enabled', 'moderator', 'approvalRisk', 'agentSuggest']

function jevSwitches(v: unknown): Partial<JevSwitches> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('switches must be an object')
  const out: Partial<JevSwitches> = {}
  for (const [k, x] of Object.entries(v)) {
    if (!(JEV_SWITCHES as readonly string[]).includes(k)) throw new TypeError(`${k} is not a Jev switch`)
    out[k as keyof JevSwitches] = bool(x, k)
  }
  return out
}

const newSecret = (): string => randomBytes(32).toString('base64url')

const APPROVAL_NOTE_MAX = 2_000
export const VERSION_NOT_FOUND = 'That version is no longer kept'
const TEST_INPUT_MAX = 4 * OUTPUT_MAX // a step's input may join the outputs of several steps

const isDir = (p: string): Promise<boolean> =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false
  )

/** A fresh folder of its own for a chat started without a picked folder, so chats never share files. */
async function newScratchFolder(home: string): Promise<string> {
  const dir = scratchChild(home, scratchName(new Date(), randomBytes(4).toString('hex')))
  await mkdir(dir, { recursive: true })
  return dir
}

/** No folder, or the scratch root itself (a sidebar group's +): the chat gets a scratch folder. */
const wantsScratch = (cwd: unknown): boolean => cwd === null || cwd === undefined || (typeof cwd === 'string' && isScratchRoot(cwd))

// ---- extensions:* arguments. The service builds every path from these: the three settings files, the two skill roots and the
// folder's `.mcp.json`, so a folder and a name are all a caller can steer. ----

const isPlainObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** An existing absolute directory, normalized, so `/a/../a/` and `/a` share one cached loadout. */
async function extFolder(v: unknown): Promise<string> {
  if (typeof v !== 'string' || !isAbsolute(v) || CONTROL_CHARS.test(v)) throw new Error(EXT_TEXT.badFolder)
  const folder = resolve(v)
  if (!(await isDir(folder))) throw new Error(EXT_TEXT.badFolder)
  return folder
}

function extScope(v: unknown): McpScope {
  if (v !== 'user' && v !== 'local' && v !== 'project') throw new TypeError('scope must be user, local or project')
  return v
}

function skillScope(v: unknown): 'user' | 'project' {
  if (v !== 'user' && v !== 'project') throw new TypeError('scope must be user or project')
  return v
}

function hookFile(v: unknown): HookFile {
  if (v !== 'user' && v !== 'project' && v !== 'local') throw new TypeError('file must be user, project or local')
  return v
}

function serverName(v: unknown): string {
  if (typeof v !== 'string' || !isServerName(v)) throw new Error(EXT_TEXT.badName)
  return v
}

// A name being written: ZumiBot's bridges own `zumibot_*` (the run drops such a server, by the same rule).
function newServerName(v: unknown): string {
  const name = serverName(v)
  if (isReservedServerName(name)) throw new Error(EXT_TEXT.reservedName)
  return name
}

// A skill on disk is its folder name, so only the folder-name pattern can reach a path.
function skillName(v: unknown): string {
  if (typeof v !== 'string' || v.length > 100 || !NAME_PATTERN.test(v)) throw new Error(EXT_TEXT.badSkillName)
  return v
}

// `setSkill` names any skill the CLI lists (`caveman:compress`, a claude.ai one): only a key in settings.json, never a path or argv.
const SKILL_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:@ -]{0,199}$/
function skillKey(v: unknown): string {
  if (typeof v !== 'string' || !SKILL_KEY.test(v)) throw new Error(EXT_TEXT.badSkillName)
  return v
}

// An id from `claude plugin list`, which goes into argv: no leading `-`.
const PLUGIN_ID = /^[A-Za-z0-9_.:@+/-]{1,200}$/
function pluginId(v: unknown): string {
  if (typeof v !== 'string' || !PLUGIN_ID.test(v) || v.startsWith('-')) throw new TypeError('id must be a plugin id')
  return v
}

const STAMP_MAX = 128
function optStamp(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  const s = str(v, 'stamp')
  if (s.length > STAMP_MAX) throw new TypeError('stamp is too long')
  return s
}

const SERVER_KEYS = new Set(['type', 'command', 'args', 'env', 'url', 'headers'])
const SERVER_TEXT_MAX = 10_000
const SERVER_LIST_MAX = 200

/** A form's server: the six keys the CLI format has, each of its type; env and header values are text, or null to keep the stored one. */
function serverInput(v: unknown): McpServerInput {
  const bad = (): Error => new Error(EXT_TEXT.badServer)
  if (!isPlainObj(v) || Object.keys(v).some((k) => !SERVER_KEYS.has(k))) throw bad()
  const text = (x: unknown): string => {
    if (typeof x !== 'string' || x.length > SERVER_TEXT_MAX) throw bad()
    return x
  }
  const values = (x: unknown): Record<string, string | null> => {
    if (!isPlainObj(x) || Object.keys(x).length > SERVER_LIST_MAX) throw bad()
    const out: Record<string, string | null> = {}
    // The names the form takes (`rowsError`): one per key of an object, so never twice.
    for (const [k, value] of Object.entries(x)) {
      if (k.trim() === '' || k.length > 200 || /[=\r\n\0]/.test(k)) throw bad()
      // An own property, so a `__proto__` name stays a name.
      Object.defineProperty(out, k, { value: value === null ? null : text(value), enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  const out: McpServerInput = {}
  const set = (k: string): boolean => v[k] !== undefined && v[k] !== null
  if (set('type')) {
    if (v.type !== 'stdio' && v.type !== 'http' && v.type !== 'sse') throw bad()
    out.type = v.type
  }
  if (set('command')) out.command = text(v.command)
  if (set('args')) {
    if (!Array.isArray(v.args) || v.args.length > SERVER_LIST_MAX) throw bad()
    out.args = v.args.map(text)
  }
  if (set('env')) out.env = values(v.env)
  if (set('url')) out.url = text(v.url)
  if (set('headers')) out.headers = values(v.headers)
  if (out.command === undefined && out.url === undefined) throw bad()
  return out
}

// PascalCase, as the CLI's events are; this also keeps `__proto__` out of the `hooks` block.
const HOOK_EVENT = /^[A-Za-z][A-Za-z0-9]{0,63}$/
function hookEvent(v: unknown): string {
  if (typeof v !== 'string' || !HOOK_EVENT.test(v)) throw new TypeError('event must be a hook event name')
  return v
}

function hookPosition(v: unknown): HookPosition {
  const index = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
  if (!isPlainObj(v) || !index(v.group) || !index(v.hook)) throw new TypeError('at must be {group, hook}')
  return { group: v.group, hook: v.hook }
}

function hookInput(v: unknown): HookInput {
  if (!isPlainObj(v)) throw new TypeError('hook must be an object')
  const matcher = v.matcher === undefined || v.matcher === null ? '' : str(v.matcher, 'matcher')
  const command = str(v.command, 'command')
  if (matcher.length > 1000) throw new TypeError('matcher is too long')
  if (command.trim() === '' || command.length > 20_000) throw new TypeError('command must be 1 to 20000 characters')
  const out: HookInput = { event: hookEvent(v.event), matcher, command }
  if (v.timeout !== undefined && v.timeout !== null) {
    if (typeof v.timeout !== 'number' || !Number.isFinite(v.timeout) || v.timeout <= 0)
      throw new TypeError('timeout must be a positive number')
    out.timeout = v.timeout
  }
  if (v.at !== undefined && v.at !== null) out.at = hookPosition(v.at)
  return out
}

const SKILL_DESCRIPTION_MAX = 5_000
const SKILL_BODY_MAX = 500_000

function skillInput(v: unknown): { name: string; description: string; body: string; stamp?: string } {
  if (!isPlainObj(v)) throw new TypeError('skill must be an object')
  const name = skillName(v.name)
  const description = str(v.description, 'description')
  const body = str(v.body, 'body')
  if (description.length > SKILL_DESCRIPTION_MAX) throw new TypeError(`description is longer than ${SKILL_DESCRIPTION_MAX} characters`)
  if (body.length > SKILL_BODY_MAX) throw new TypeError(`body is longer than ${SKILL_BODY_MAX} characters`)
  const stamp = optStamp(v.stamp)
  return { name, description, body, ...(stamp === undefined ? {} : { stamp }) }
}

function auditOf(d: HandlerDeps): NonNullable<HandlerDeps['audit']> {
  if (!d.audit) throw new Error('The audit log is not available')
  return d.audit
}

export function createHandlers(d: HandlerDeps): Handlers {
  const {
    agents,
    chats,
    settings,
    sidebar,
    approvals,
    routineStore,
    runner,
    workflowStore,
    workflowRunner,
    chatService,
    groupService,
    tasks,
    commands,
    attachments,
    feed
  } = d
  const told = (l: SidebarLayout | null): void => {
    if (l) d.sidebarChanged(l)
  }
  // Where the agent worked, for the git chip and Changes: the open chat's list is held by the feed, with the running
  // turn's calls; any other chat is read from disk.
  const itemsOf =
    (id: string): ItemsLoader =>
    async () =>
      feed.peek(id) ?? (await chats.loadItems(id))
  const reveals = createRevealLimiter()
  const needChannels = (p: ChannelPlatform): ChannelService => {
    if (!d.channels) throw new Error('Channels are not available on this server')
    return d.channels.services[p]
  }
  // Closures, so a test that swaps a dep after building the handlers is still read at call time.
  // A spend cap that can't hold for an agent's engine is refused at save (the same check the run makes where it starts).
  const capEngineCheck = capEngines({ agents: () => agents.list(), chats, caps: d.caps })
  const routineEdit =
    d.routineEditing ??
    routineEditing({
      store: routineStore,
      scheduler: { rearm: () => d.scheduler.rearm() },
      changed: () => d.routinesChanged(),
      newSecret,
      history: d.routineHistory,
      capEngines: capEngineCheck
    })
  const workflowEdit =
    d.workflowEditing ??
    workflowEditing({
      store: workflowStore,
      runner: workflowRunner,
      scheduler: { rearm: () => d.workflowScheduler.rearm() },
      changed: () => d.workflowsChanged(),
      newSecret,
      history: d.workflowHistory,
      capEngines: capEngineCheck
    })

  // The agent's own summary decides scope and limit, never the client.
  const listMemory = async (name: string) => {
    const summary = (await agents.list()).find((a) => a.name === name && a.error === null)
    if (!summary) throw new Error('Unknown agent')
    const list = await d.memory.store.list(name, {
      scope: summary.memory ?? null,
      limit: effectiveLimit(summary.memoryLimit),
      autoMemoryOff: await d.memory.autoMemoryOff()
    })
    return { summary, list }
  }
  const memoryFile = (v: unknown): string => {
    if (typeof v !== 'string' || !isMemoryFileName(v)) throw new TypeError('file is not a memory file name')
    return v
  }
  const finite = (v: unknown, field: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${field} must be a finite number`)
    return v
  }

  // Workflow, run, visit and step ids are made by randomUUID (or the editor, to the same shape); nothing else names one.
  const wid = (v: unknown, what: string): string => {
    const s = str(v, what)
    if (!validId(s)) throw new TypeError(`${what} must be a valid id`)
    return s
  }
  // Optional arguments arrive as null over the socket, since JSON has no undefined.
  const optText = (v: unknown, what: string, label: string, max: number): string | undefined => {
    if (v === undefined || v === null) return undefined
    const s = str(v, what)
    if (s.length > max) throw new Error(`${label} is longer than ${max} characters`)
    return s
  }
  // A save's optional second argument (null over the socket when absent): only a finite restoredFrom is read.
  const saveMeta = (v: unknown): SaveMeta => {
    if (v === undefined || v === null) return {}
    if (typeof v !== 'object' || Array.isArray(v)) throw new TypeError('meta must be an object')
    const r = (v as { restoredFrom?: unknown }).restoredFrom
    return r === undefined || r === null ? {} : { restoredFrom: finite(r, 'restoredFrom') }
  }
  // An A→B ask chat is B's answer to A, not a conversation: hiding its controls is not a guard, this is.
  const writable = async (id: string): Promise<void> => {
    if ((await chats.get(id))?.asked) throw new Error('This chat is read-only')
  }
  // The worktree a new chat or room gets: only for a picked folder in a git repo whose toggle is on (never the built-in agent).
  const isolate = async (dir: string, slugBase: string) => {
    // No toggle on anywhere: nothing to isolate, so git is never asked (a machine without git still chats).
    if (!d.worktrees || (await settings.get()).worktreeFolders.length === 0) return null
    const top = await d.worktrees.topOf(dir)
    if (!top || !(await settings.worktreeOn(top))) return null
    return d.worktrees.create(dir, slugBase)
  }
  // An agent starting on a card gets its chat as chats:create does: a built-in's own folder, else the picked one,
  // isolated in a worktree when that folder's toggle is on.
  const placeAgent = async (agent: string, dir: string): Promise<{ cwd: string; worktree?: ChatWorktree }> => {
    const fixed = d.builtInCwd(agent)
    if (fixed) return { cwd: fixed }
    if (!(await isDir(dir))) throw new Error('Folder not found')
    const w = await isolate(dir, agent)
    return w ? { cwd: w.cwd, worktree: w.worktree } : { cwd: dir }
  }
  const taskCards = new TaskCards({
    store: chats,
    todos: d.todos,
    files: attachments,
    submit: (chatId, text, staged) => tasks.submit(chatId, text, staged),
    running: (chatId) => chatService.isRunning(chatId),
    stop: (chatId) => chatService.stop(chatId),
    agents: () => agents.list(),
    isFolder: isDir,
    place: placeAgent,
    rememberFolder: (agent, dir) => (d.builtInCwd(agent) ? Promise.resolve() : settings.setLastFolder(agent, dir)),
    push: (p) => d.push(p),
    now: Date.now,
    // Read per call, so a test that swaps `d.caps` after building the handlers is still honoured.
    caps: (e) => (d.caps ?? engineCaps)(e)
  })
  // An agent mentioned in a card's comment answers in its own chat for that card, placed as a task's chat is.
  const commentAsks = new CommentAsks({
    store: chats,
    todos: d.todos,
    files: attachments,
    submit: (chatId, text, messageId, staged, cardAsk) =>
      tasks.submit(chatId, text, staged, undefined, messageId, undefined, undefined, 'user', undefined, { cardAsk }),
    agents: () => agents.list(),
    commandsOf: (agent) => agents.commandsOf(agent),
    isFolder: isDir,
    place: placeAgent,
    lastFolder: async (agent) => (await settings.get()).lastFolderByAgent[agent] ?? null,
    home: d.home,
    push: (p) => d.push(p),
    newId: () => randomUUID(),
    // Read per call, so a test that swaps `d.caps` after building the handlers is still honoured.
    caps: (e) => (d.caps ?? engineCaps)(e),
    ...(d.routeComment ? { route: (input: RouteInput) => d.routeComment!(input) } : {})
  })
  // Fire and forget: archive and delete must not wait on git, and never fail on it (release logs its own errors).
  const releaseInBackground = (meta: ChatMeta, deleted: boolean): void => {
    void Promise.resolve(d.worktrees?.release(meta, { deleted })).catch((err) =>
      console.error('releasing worktree failed:', err instanceof Error ? err.message : err)
    )
  }

  /**
   * An archived chat's processes end before its worktree is released, so a dev server still writing into the checkout cannot make
   * the release refuse a tree it is dirtying. A failure is logged by code and never fails the archive.
   */
  const endProcesses = async (id: string): Promise<void> => {
    try {
      await d.processes?.endChat(id, 'archive')
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      console.error('ending archived chat processes failed:', typeof code === 'string' ? code : 'error')
    }
  }

  /** Archiving a chat as the sidebar's Archive does: refused while it runs, pushed, its processes ended, its worktree released after. */
  const archiveChat = async (id: string): Promise<ChatMeta> => {
    const meta = await chats.patchInPlace(id, (cur) => {
      if (cur.inFlight) throw new Error(ARCHIVE_RUNNING)
      return archivePatch(cur, true, Date.now())
    })
    if (!meta) throw new Error(`Chat not found: ${id}`)
    d.push({ chatId: id, kind: 'meta', meta })
    await endProcesses(id)
    if (meta.worktree) releaseInBackground(meta, false)
    return meta
  }

  const needProcesses = (): NonNullable<HandlerDeps['processes']> => {
    if (!d.processes) throw new Error('Processes unavailable')
    return d.processes
  }

  const needGithub = (): NonNullable<HandlerDeps['github']> => {
    if (!d.github) throw new Error(GH_MISSING)
    return d.github
  }

  // Several agents trying one card at once, each in its own worktree from one base commit.
  const attemptSets = new AttemptSets({
    store: chats,
    todos: d.todos,
    files: attachments,
    submit: (chatId, text, staged) => tasks.submit(chatId, text, staged),
    running: (chatId) => chatService.isRunning(chatId),
    stop: (chatId) => chatService.stop(chatId),
    agents: () => agents.list(),
    engineOf: (agent, list) => engineOfAgent(list.find((a) => a.name === agent)),
    isolatedTop: async (dir) => {
      if (!d.worktrees) return null
      const top = await d.worktrees.topOf(dir)
      return top && (await settings.worktreeOn(top)) ? top : null
    },
    headOf: (dir) => (d.worktrees ? d.worktrees.headOf(dir) : Promise.resolve(null)),
    worktree: (dir, slugBase, at) => {
      if (!d.worktrees) throw new Error('Not a git repository')
      return d.worktrees.create(dir, slugBase, at === null ? {} : { at })
    },
    caps: (e) => (d.caps ?? engineCaps)(e),
    archive: async (chatId) => void (await archiveChat(chatId)),
    isFolder: isDir,
    push: (p) => d.push(p),
    now: Date.now,
    newId: () => randomUUID()
  })

  // What the chat's engine cannot do (Pause, side questions, Compact, Edit, Resend, versions and Fork where its engine lacks the cap): the
  // UI hides it, this is the guard. A chat that does not exist is left to the call that follows, which says so. Only the
  // agent's engine counts: a Claude agent that once ran on Codex works.
  // A room is judged per member: the one named (Compact), else every member (one Pause stops them all). A room's side
  // question picks its member later, so SideQuestions judges that member's engine itself.
  const caps = d.caps ?? engineCaps
  // Agent Studio's Isolation reason: an engine without the `isolation` cap is offered neither level (an unknown agent is Claude's).
  const isolationRefused = (a: AgentSummary | undefined): string | null => {
    const engine = engineOfAgent(a)
    return caps(engine).isolation ? null : isolationRefusal(engine, null)
  }
  const refuseWithout = async (id: string, cap: RefusedCap, member?: string): Promise<void> => {
    // Nothing to look up while both engines have it: the agents scan would only slow every side question down.
    if (ENGINES.every((e) => caps(e)[cap])) return
    const meta = await chats.get(id)
    if (!meta) return
    const list = await agents.list()
    const engines = !meta.group
      ? [chatEngine(meta, list)]
      : member !== undefined
        ? [chatEngine(meta, list, member)]
        : cap === 'btw'
          ? []
          : meta.group.members.map((m) => chatEngine(meta, list, m))
    const lacking = engines.find((e) => !caps(e)[cap])
    if (lacking !== undefined) throw new Error(capRefusal(lacking, cap))
  }

  // A to-do request tells the agent to use ZumiBot's to-do tools, which an agent without `bridges` does not have (and a
  // remote one would be sent ZumiBot's instruction). A room's request goes to every member that answers, so one lacking
  // member refuses it. Before the command is resolved or anything is queued.
  const refuseTodo = async (id: string): Promise<void> => {
    const meta = await chats.get(id)
    if (!meta) return
    const list = await agents.list()
    for (const name of meta.group ? meta.group.members : [meta.agentName]) {
      const engine = chatEngine(meta, list, meta.group ? name : undefined)
      if (!caps(engine).bridges) throw new Error(todoRefusal(engine, name))
    }
  }

  // Each handler may throw synchronously on a bad argument; the wrapper turns that into a rejection.
  const h: Record<string, (...args: any[]) => unknown> = {
    'btw:ask': async (chatId, question, id) => {
      const chat = str(chatId, 'chatId'),
        body = str(question, 'question'),
        entry = str(id, 'id')
      if (body.length > COMMAND_PROMPT_MAX) throw new Error(`Question is longer than ${COMMAND_PROMPT_MAX} characters`)
      // No writable(): a side answer never touches the chat or either agent's session, so an A→B chat takes it.
      await refuseWithout(chat, 'btw')
      return d.side.ask(chat, body, entry)
    },
    'btw:follow': async (chatId, threadId, question, id) => {
      const chat = str(chatId, 'chatId'),
        thread = str(threadId, 'threadId'),
        body = str(question, 'question'),
        entry = str(id, 'id')
      if (body.length > COMMAND_PROMPT_MAX) throw new Error(`Question is longer than ${COMMAND_PROMPT_MAX} characters`)
      // No writable(), as for btw:ask.
      await refuseWithout(chat, 'btw')
      return d.side.follow(chat, thread, body, entry)
    },
    'btw:list': (chatId) => d.side.list(str(chatId, 'chatId')),
    'btw:stop': (chatId, id) => d.side.stop(str(chatId, 'chatId'), str(id, 'id')),
    'btw:again': (chatId, id) => d.side.again(str(chatId, 'chatId'), str(id, 'id')),
    'browsers:status': (agent) => {
      if (!d.browsers) throw new Error('Browser unavailable')
      return d.browsers.status(str(agent, 'agent'))
    },
    'browsers:clear': (agent) => {
      if (!d.browsers) throw new Error('Browser unavailable')
      return d.browsers.clear(str(agent, 'agent'))
    },
    'desktops:status': (agent) => {
      if (!d.desktops) throw new Error('Desktop unavailable')
      return d.desktops.status(str(agent, 'agent'))
    },
    'desktops:clear': (agent) => {
      if (!d.desktops) throw new Error('Desktop unavailable')
      return d.desktops.clear(str(agent, 'agent'))
    },
    'agents:list': () => agents.list(),
    'agents:codexInfo': () => (d.codexInfo ? d.codexInfo() : Promise.resolve({ found: false, models: [] })),
    'agents:read': (filePath) => agents.read(str(filePath, 'filePath')),
    // Only the saved file's launch, and only once it is confirmed: never a command typed into the browser.
    'agents:testAcp': async (name): Promise<AcpTestResult> => {
      const agent = savedAgentName(name)
      return d.acpTest ? d.acpTest(agent) : { error: ACP_TEXT.testUnavailable }
    },
    // What Save confirmed on this machine, for Agent Studio to show beside the form's launch.
    'agents:acpLaunch': async (name): Promise<AcpLaunch | null> => {
      const confirmed = d.launchTrust?.confirmed(savedAgentName(name)) ?? null
      // Only an ACP launch: a remote agent's confirmed endpoint is no command.
      return confirmed?.provider === 'acp'
        ? { command: confirmed.command, args: [...confirmed.args], authEnv: [...confirmed.authEnv] }
        : null
    },
    // The same for a remote agent: the saved file's endpoint, once confirmed. It connects and sends nothing.
    'agents:testAgui': async (name): Promise<AguiTestResult> => {
      const agent = savedAgentName(name)
      return d.aguiTest ? d.aguiTest(agent) : { error: AGUI_TEXT.testUnavailable }
    },
    'agents:aguiLaunch': async (name): Promise<AguiLaunch | null> => {
      const confirmed = d.launchTrust?.confirmed(savedAgentName(name)) ?? null
      return confirmed?.provider === 'ag-ui'
        ? { endpoint: confirmed.endpoint, authKey: confirmed.authKey, authHeader: confirmed.authHeader }
        : null
    },
    // Optional folder arrives as null (the new-chat screen before one is picked): home, as the extensions page uses.
    'agents:engineCommands': async (agent, folder): Promise<EngineCommands | null> => {
      const name = str(agent, 'agent')
      if (!(await agents.list()).some((a) => a.name === name && a.error === null)) throw new Error(EXT_TEXT.notFound)
      const f = folder === undefined || folder === null ? d.home : await extFolder(folder)
      const found = await d.extensions.engineCommands(f, name)
      // `path` is Codex's SKILL.md on this machine: it never leaves the server.
      if (!found) return null
      const commands = found.rows.map(({ name, description, hint, kind }) =>
        hint ? { name, description, hint, kind } : { name, description, kind }
      )
      return { engine: found.engine, commands }
    },
    'agents:save': async (original, raw) => {
      const from = original === null ? null : str(original, 'originalFilePath')
      const text = str(raw, 'raw')
      const parsed = parseAgent(text)
      // A refused argument blocks the save itself, before anything is written: it would let the agent act without asking.
      const flag = parsed.ok && parsed.fields.acp ? refusedArg(parsed.fields.acp.args) : null
      if (flag !== null) return { ok: false, error: ACP_TEXT.refusedArg(flag) }
      // A daily cap that can't hold (the engine reports no cost) is refused, never saved and ignored.
      if (parsed.ok && parsed.fields.dailySpendCap !== null) {
        const engine = markEngine(parsed.fields.provider ?? undefined)
        if (!caps(engine).cost) return { ok: false, error: spendCapRefusal(engine, parsed.fields.name) }
      }
      // A remote agent's endpoint passes the URL and address checks a run makes before anything is written, since this save is
      // what confirms it: a private or loopback address (outside the dev hook) is refused with its sentence.
      const remote = parsed.ok && parsed.fields.provider === 'ag-ui' ? parsed.fields.agui : null
      if (remote !== null) {
        const allowLocal = d.aguiEndpoint?.allowLocal ?? false
        const url = checkUrl(remote.endpoint, allowLocal)
        if ('error' in url) return { ok: false, error: url.error }
        const target = await resolveTarget(url.url, allowLocal, d.aguiEndpoint?.lookup)
        if ('error' in target) return { ok: false, error: target.error }
      }
      const result = await agents.save(from, text)
      // Launch trust, queued before any await so it lands in this order: a rename moves the entry first, then the launch the
      // user just saved is confirmed under the saved name (or dropped, for a save that is no longer an ACP or remote agent with one).
      let trusted: Promise<unknown> | null = null
      if (result.ok && parsed.ok && d.launchTrust) {
        const lt = d.launchTrust
        const steps: Promise<void>[] = []
        if (result.renamedFrom && result.renamedFrom !== result.name) steps.push(lt.rename(result.renamedFrom, result.name))
        const { acp, agui } = parsed.fields
        const engine = markEngine(parsed.fields.provider ?? undefined)
        switch (engine) {
          case 'acp':
            steps.push(acp ? lt.confirm(result.name, acpRecord(acp)) : lt.remove([result.name]))
            break
          case 'ag-ui':
            steps.push(agui ? lt.confirm(result.name, aguiRecord(agui)) : lt.remove([result.name]))
            break
          case 'claude':
          case 'codex':
            steps.push(lt.remove([result.name]))
            break
          default:
            assertNever(engine)
        }
        // Only the code: the file holds commands, arguments and endpoints. A failure leaves the launch unconfirmed, so a run refuses it.
        trusted = Promise.all(steps).catch((err) =>
          console.error(
            'confirming the agent launch failed:',
            typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : 'error'
          )
        )
      }
      // A loadout is keyed on the agent file's text too; this only makes the next one probe without waiting for the watcher.
      if (result.ok) d.extensions.forget()
      if (result.ok && result.renamedFrom && result.renamedFrom !== result.name) {
        // First, before any await: the watcher's removal pass for the old file must find the rules already moved.
        void approvals.renameAgent(result.renamedFrom, result.name).catch((err) => console.error('moving approvals failed:', err))
        // Isolation moves in memory before its first await too, so the renamed agent never runs as Off for a moment.
        void d.isolation
          ?.rename(result.renamedFrom, result.name)
          .catch((err) => console.error('moving isolation failed:', err instanceof Error ? err.name : 'error'))
        // The vault's grants move in memory before its first await too; the log names no item.
        void d.vault
          .renameAgent(result.renamedFrom, result.name)
          .catch((err) => console.error('moving vault grants failed:', err instanceof Error ? err.message : 'unknown error'))
        // Same reason: the memory folder moves (or waits for a running turn) before the watcher's removal pass.
        d.memory.turns.renamed(result.renamedFrom, result.name)
        // Running group rooms first, so none of them saves the old name back over the rewritten chats.
        d.side.renameAgent(result.renamedFrom, result.name)
        groupService.renameAgent(result.renamedFrom, result.name)
        chatService.renameAgent(result.renamedFrom, result.name)
        // Same reason: both profile moves start before any await.
        await Promise.all([
          d.browsers?.renameAgent(result.renamedFrom, result.name),
          d.desktops?.renameAgent(result.renamedFrom, result.name)
        ])
        await chats.renameAgent(result.renamedFrom, result.name)
        feed.reset()
        await settings.renameAgent(result.renamedFrom, result.name)
        told(await sidebar.renameAgent(result.renamedFrom, result.name))
        // Voice talk settings (default agent, spoken aliases): caught, a failure here must not skip the routines or fail the save.
        await d.voice.store.renameAgent(result.renamedFrom, result.name).then(
          (status) => {
            if (status) d.voiceChanged(status)
          },
          (err) => console.error('renaming voice talk agent failed:', err instanceof Error ? err.message : 'unknown error')
        )
        // Channel switches follow the agent; caught like voice.
        await d.channels?.store.renameAgent(result.renamedFrom, result.name).catch(() => console.error('renaming channel agents failed'))
        // Last and caught: a routines-store failure must not skip the renames above or fail a saved agent.
        await routineStore
          .renameAgent(result.renamedFrom, result.name)
          .then(d.routinesChanged, (err) => console.error('renaming routine agents failed:', err instanceof Error ? err.message : err))
        await workflowStore
          .renameAgent(result.renamedFrom, result.name)
          .then(d.workflowsChanged, (err) => console.error('renaming workflow agents failed:', err instanceof Error ? err.message : err))
      }
      // Before the answer: a send right after Save must find its launch confirmed.
      await trusted
      return result
    },
    'agents:trash': async (filePath) => {
      const path = str(filePath, 'filePath')
      const old = (await agents.list()).find((a) => a.filePath === path && a.error === null)
      await agents.trash(path)
      if (old && !(await agents.list()).some((a) => a.name === old.name)) {
        await Promise.all([d.browsers?.removeAgents([old.name]), d.desktops?.removeAgents([old.name])])
        await d.launchTrust?.remove([old.name]).catch(() => console.error('dropping the agent launch failed'))
        await d.memory.turns.deleted(old.name)
      }
    },

    'chats:list': () => chats.list(),
    'chats:create': async (agentName, cwd) => {
      const name = str(agentName, 'agentName')
      const fixed = d.builtInCwd(name)
      if (fixed) return chats.create(name, fixed)
      // Not remembered as the last folder: the next chat starts in a fresh one too, and a real pick stays the default.
      if (wantsScratch(cwd)) return chats.create(name, await newScratchFolder(d.home))
      const dir = str(cwd, 'cwd')
      const w = await isolate(dir, name)
      const chat = await chats.create(name, w?.cwd ?? dir, w ? { worktree: w.worktree } : undefined)
      // The folder the user picked, never the worktree: the next chat starts from the same pick.
      await settings.setLastFolder(name, dir)
      return chat
    },
    // A voice conversation's chat, in the folder the new-chat screen opens.
    'chats:createVoice': async (agentName) => {
      const named = str(agentName, 'agentName')
      // The server is the voice authority: a remote agent reads as unknown here, as `routeUtterance` reads it, so spoken words
      // never start a chat that sends them to a remote host.
      const all = (await agents.list()).filter((a) => !isRemoteAgent(a, caps))
      const m = matchAgent(named, all)
      if (!m.ok) throw new Error(m.reason === 'zumi-bot' ? 'Zumi Bot cannot be used in a voice chat' : `No agent named ${named}`)
      const last = (await settings.get()).lastFolderByAgent[m.name]
      const cwd = d.builtInCwd(m.name) ?? (last && (await isDir(last)) ? last : d.home)
      return chats.create(m.name, cwd, {
        title: voiceChatTitle(Date.now(), (await settings.timeZone()) ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
        voice: true
      })
    },
    'chats:createGroup': async (members, cwd, role) => {
      const list = validateNewGroupMembers(members, await agents.list(), caps)
      if (wantsScratch(cwd)) return chats.createGroup(list, await newScratchFolder(d.home), groupRole(role))
      const dir = str(cwd, 'cwd')
      const w = await isolate(dir, 'room')
      const chat = await chats.createGroup(list, w?.cwd ?? dir, groupRole(role), w ? { worktree: w.worktree } : undefined)
      await settings.setLastGroupFolder(dir)
      return chat
    },
    'chats:setMembers': async (chatId, members) => {
      const id = str(chatId, 'chatId'),
        list = memberList(members)
      refuseCodexMembers(list, await agents.list(), caps)
      return groupService.setMembers(id, list)
    },
    'chats:setRole': (chatId, role) => groupService.setRole(str(chatId, 'chatId'), groupRole(role)),
    // A page from the last push when there is one: a running turn's saves trail its pushes.
    'chats:items': (chatId, before, until) => {
      const id = str(chatId, 'chatId')
      const opt = (v: unknown, what: string): string | undefined => (v === undefined || v === null ? undefined : str(v, what))
      return feed.page(id, () => chats.loadItems(id), opt(before, 'before'), opt(until, 'until'))
    },
    // Read on every connect: counts live only in memory and are pushed only when they change.
    'chats:pending': () => chatService.pendingCounts(),
    // Every chat's messages, archived and asked ones too; only listed chats, so a chat removed a moment ago never shows.
    'chats:search': async (query, offset) => {
      const q = searchQuery(query)
      const from = searchOffset(offset)
      const listed = new Set((await chats.list()).map((c) => c.id))
      return d.search.search(q, from, (id) => listed.has(id))
    },
    // Deliberately not caught: a rejected send must reach the client so the user sees it.
    // TaskQueue decides: send now (single chat or group room), or queue while the chat runs.
    'chats:send': async (chatId, text, ids, reply, mid, cmd, steerArg) => {
      const id = str(chatId, 'chatId')
      const body = str(text, 'text')
      const staged = attachmentIds(ids)
      const quoted = replyTo(reply)
      const picked = messageId(mid)
      const pick = commandPick(cmd)
      // The composer's Enter: true or absent (JSON turns an omitted one into null).
      const steer = steerArg === undefined || steerArg === null ? false : bool(steerArg, 'steer')
      await writable(id)
      // Resolved before queueing, so what a queued message will send is fixed now and a refusal reaches the client.
      // /todo is the handler's: the command, if any, is whatever follows it. A command with the flag asks for a list too.
      const { todo, rest } = splitTodo(body)
      if (todo) await refuseTodo(id)
      const command = await commands.forSend(id, rest, pick)
      if (command?.todos === true) await refuseTodo(id)
      // No trailing undefined: without a to-do the queue sees the call as before.
      // Into the running reply where one takes it (docs/architecture/mid-turn-messages.md); submit queues a command or /todo itself.
      if (steer && !todo && command?.todos !== true)
        return tasks.submit(id, body, staged, quoted, picked, command, undefined, 'user', undefined, { steer: true })
      return todo || command?.todos === true
        ? tasks.submit(id, body, staged, quoted, picked, command, true)
        : tasks.submit(id, body, staged, quoted, picked, command)
    },
    // Edit, resend and version switches go through the queue, never the services: its lock keeps two runs from overlapping.
    // Like chats:send, not caught: a refusal must reach the client.
    'chats:edit': async (chatId, itemId, text, cmd) => {
      const id = str(chatId, 'chatId')
      const item = str(itemId, 'itemId')
      const body = str(text, 'text')
      const pick = commandPick(cmd)
      await writable(id)
      await refuseWithout(id, 'resend')
      if (splitTodo(body).todo) await refuseTodo(id)
      const command = await commands.forRerun(id, item, body, pick)
      if (command?.todos === true) await refuseTodo(id)
      // An edit's flag comes from the new text alone, so editing /todo away drops it. Resend (below) passes none:
      // the services keep the old message's flag.
      return splitTodo(body).todo || command?.todos === true
        ? tasks.rerun(id, item, body, command, true)
        : tasks.rerun(id, item, body, command)
    },
    'chats:resend': async (chatId, itemId) => {
      const id = str(chatId, 'chatId')
      const item = str(itemId, 'itemId')
      await writable(id)
      await refuseWithout(id, 'resend')
      return tasks.rerun(id, item, null, await commands.forRerun(id, item, null))
    },
    'chats:switchVersion': async (chatId, itemId, index) => {
      const id = str(chatId, 'chatId'),
        item = str(itemId, 'itemId'),
        at = versionIndex(index)
      await writable(id)
      await refuseWithout(id, 'resend')
      return tasks.switchVersion(id, item, at)
    },
    'chats:fork': async (chatId, itemId) => {
      const id = str(chatId, 'chatId'),
        item = str(itemId, 'itemId')
      await writable(id)
      await refuseWithout(id, 'fork')
      const result = await forkChat({ store: chats, files: attachments, snapshots: d.snapshots, now: Date.now }, id, item)
      // The caller opens it; every other tab lists it.
      d.push({ chatId: result.chat.id, kind: 'meta', meta: result.chat })
      return result
    },
    'chats:summarizeRoom': (chatId) => d.summaries.summarize(str(chatId, 'chatId')),
    'chats:cancelSummary': async (chatId) => {
      d.summaries.cancel(str(chatId, 'chatId'))
    },
    'chats:cloneRoom': async (chatId, title, handoff) => {
      const id = str(chatId, 'chatId')
      const name = cloneTitle(title)
      const text = cloneHandoff(handoff)
      // A member may have moved to Codex since the room was made; the clone is made anew, so while Codex rooms are off it is
      // refused like a new room.
      const src = await chats.get(id)
      if (src?.group) refuseCodexMembers(src.group.members, await agents.list(), caps)
      const meta = await cloneRoom({ store: chats, allowed: chatService, now: Date.now }, id, name, text, { keepWorktree: true })
      // The caller opens it; every other tab lists it.
      d.push({ chatId: meta.id, kind: 'meta', meta })
      return meta
    },
    // Through the queue like an edit: its lock keeps a compaction and a send from overlapping, and sends meanwhile queue.
    'chats:compact': async (chatId, note, agent) => {
      const id = str(chatId, 'chatId'),
        text = compactNote(note),
        member = agent === undefined || agent === null ? undefined : str(agent, 'agent')
      await writable(id)
      await refuseWithout(id, 'compact', member)
      return tasks.compact(id, text, member)
    },
    'chats:setModel': async (chatId, model) => {
      const id = str(chatId, 'chatId')
      if (model !== null && typeof model !== 'string') throw new TypeError('model must be a string or null')
      await writable(id)
      // The service checks the name against the chat's engine.
      return chatService.setModel(id, model)
    },
    'chats:setPermissionMode': async (chatId, mode) => {
      const id = str(chatId, 'chatId')
      // Only the chat modes (never auto, bypassPermissions or dontAsk); the service checks the mode against the chat's engine.
      if (mode !== null && !isChatMode(mode)) throw new TypeError('mode must be a chat mode or null')
      await writable(id)
      return chatService.setPermissionMode(id, mode)
    },
    'chats:allowBlocked': async (chatId, toolUseId, prefixes, scope, folders) => {
      const id = str(chatId, 'chatId')
      const toolId = str(toolUseId, 'toolUseId')
      const list = strings(prefixes, 'prefixes')
      if (scope !== 'chat' && scope !== 'agent') throw new TypeError("scope must be 'chat' or 'agent'")
      // Absent from a page loaded before folder grants.
      const dirs = folders === undefined ? [] : strings(folders, 'folders')
      await writable(id)
      const { agent, ...out } = await chatService.allowBlocked(id, toolId, list, scope, dirs)
      if (scope === 'agent') d.approvalsChanged(agent)
      return out
    },
    'chats:setEffort': async (chatId, effort) => {
      const id = str(chatId, 'chatId')
      if (effort !== null && !isEffort(effort)) throw new TypeError('effort must be an effort level or null')
      await writable(id)
      return chatService.setEffort(id, effort)
    },
    'chats:cancelResume': (chatId) => d.limits.dontContinue(str(chatId, 'chatId')),
    'chats:continueNow': async (chatId) => {
      const id = str(chatId, 'chatId')
      await writable(id)
      return d.limits.continueNow(id)
    },
    // `text`: the composer's `/later <when> <message>` (the bare rest works too), read in the browser's zone. The message is
    // checked now as a send would be (a /todo the agent cannot take, a command that no longer resolves), and resolved again
    // when it goes, as typed then.
    'chats:later': async (chatId, text, timeZone) => {
      const id = str(chatId, 'chatId')
      const body = str(text, 'text')
      const zone = str(timeZone, 'timeZone')
      if (!isTimeZone(zone)) throw new TypeError('timeZone must be a time zone')
      await writable(id)
      const parsed = parseLater(laterRest(body) ?? body.trim(), Date.now(), zone)
      if ('error' in parsed) throw new Error(parsed.error)
      if (laterNests(parsed.text)) throw new Error(LATER_NESTED)
      const { todo, rest } = splitTodo(parsed.text)
      if (todo) await refuseTodo(id)
      const command = await commands.forSend(id, rest)
      if (command?.todos === true) await refuseTodo(id)
      return d.later.add(id, parsed.at, parsed.text)
    },
    'chats:laterCancel': async (chatId, laterId) => {
      const id = str(chatId, 'chatId')
      await writable(id)
      return d.later.cancel(id, str(laterId, 'id'))
    },
    'chats:laterNow': async (chatId, laterId) => {
      const id = str(chatId, 'chatId')
      await writable(id)
      return d.later.sendNow(id, str(laterId, 'id'))
    },
    'chats:sendTask': (chatId, taskId) => tasks.sendTask(str(chatId, 'chatId'), str(taskId, 'taskId')),
    'chats:dropTask': async (chatId, taskId) => {
      const id = str(chatId, 'chatId')
      const task = str(taskId, 'taskId')
      // Only a task that was still queued: one already sent belongs to a run that will end by itself.
      if (await tasks.drop(id, task)) {
        runner.taskDropped(id, task)
        workflowRunner.taskDropped(id, task)
      }
    },
    'attachments:stageBytes': (name, bytes) => {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array')
      return attachments.stageBytes(str(name, 'name'), bytes)
    },
    'attachments:discard': (id) => attachments.discard(str(id, 'id')),
    'todos:board': () => d.todos.board(),
    // A chat's side panel: the live items made in it.
    'todos:list': (chatId) => d.todos.list(str(chatId, 'chatId')),
    'todos:add': (text, chatId) =>
      d.todos.userAdd(str(text, 'text'), chatId === null || chatId === undefined ? null : str(chatId, 'chatId')),
    'todos:check': (ids, done) => d.todos.userCheck(todoIds(ids), bool(done, 'done')),
    'todos:remove': (ids) => d.todos.userRemove(todoIds(ids)),
    'todos:restore': (ids) => d.todos.userRestore(todoIds(ids)),
    'todos:edit': (id, patch) => d.todos.userEdit(todoId(id), todoCardEdit(patch)),
    'todos:assign': (id, assignee, folder) =>
      taskCards.assign(todoId(id), assigneeArg(assignee), folder === null ? null : str(folder, 'folder')),
    'todos:answer': (id, answers) => taskCards.answer(todoId(id), todoAnswers(answers)),
    'todos:reply': (id, text) => taskCards.reply(todoId(id), boundedText(text, 'text')),
    'todos:move': (id, status) => taskCards.move(todoId(id), todoStatus(status)),
    'todos:comment': (id, text, replyTo) =>
      commentAsks.comment(todoId(id), boundedText(text, 'text'), replyTo === undefined || replyTo === null ? null : todoId(replyTo)),
    'todos:editComment': (id, commentId, text) => d.todos.userEditComment(todoId(id), todoId(commentId), boundedText(text, 'text')),
    'todos:deleteComment': (id, commentId) => d.todos.userDeleteComment(todoId(id), todoId(commentId)),
    'attempts:start': (id, picks, folder) =>
      attemptSets.start(todoId(id), attemptPicks(picks), folder === undefined || folder === null ? null : str(folder, 'folder')),
    'attempts:keep': (id, chatId) => attemptSets.keep(todoId(id), str(chatId, 'chatId')),
    'attempts:cancel': (id) => attemptSets.cancel(todoId(id)),
    // GitHub. A push and a create happen only here, from the user's own click: no agent tool, workflow step, routine
    // or poll reaches these, and nothing in them ever writes to the repository's default branch.
    'github:state': async () => ({ gh: d.github ? await d.github.state() : ('missing' as const) }),
    'github:draftPr': (chatId) => needGithub().prs.draftPr(str(chatId, 'chatId')),
    'github:createPr': (chatId, input) =>
      needGithub()
        .prs.createPr(str(chatId, 'chatId'), prInput(input))
        .then(async (pr) => {
          const meta = await chats.get(str(chatId, 'chatId'))
          if (meta) needGithub().watcher.watch(meta)
          return pr
        }),
    'github:refreshPr': (chatId) =>
      needGithub()
        .prs.refreshPr(str(chatId, 'chatId'))
        .then(async (pr) => {
          const meta = await chats.get(str(chatId, 'chatId'))
          if (meta) needGithub().watcher.watch(meta)
          return pr
        }),
    'github:sendCheck': (chatId, name) => needGithub().prs.sendCheck(str(chatId, 'chatId'), checkName(name)),
    'dispatch:list': (chatId) => d.dispatch.list(str(chatId, 'chatId')),
    'dispatch:get': (chatId, id, from) => d.dispatch.get(str(chatId, 'chatId'), str(id, 'id'), stepFrom(from)),
    'processes:list': async (chatId) => needProcesses().list(str(chatId, 'chatId')),
    'processes:logs': (chatId, id, from) => needProcesses().read(str(chatId, 'chatId'), processId(id), stepFrom(from)),
    'processes:stop': (chatId, id) => needProcesses().stop(str(chatId, 'chatId'), processId(id), 'user'),
    'processes:restart': (chatId, id) => needProcesses().restart(str(chatId, 'chatId'), processId(id)),
    'processes:forget': (chatId, id) => needProcesses().forget(str(chatId, 'chatId'), processId(id)),
    // The user's Run of a block of an agent's reply. `messageId()` lets null through as "none", but here the id is required.
    'processes:run': async (chatId, messageIdArg, command) => {
      const id = str(chatId, 'chatId')
      const mid = messageId(str(messageIdArg, 'messageId'))!
      const cmd = str(command, 'command')
      const p = needProcesses()
      return runBlock(
        {
          meta: (c) => chats.get(c),
          items: (c) => chats.loadItems(c),
          engineOf: async (agent) =>
            agent === ZUMI_BOT_NAME ? 'claude' : engineOfAgent((await d.agents.list()).find((a) => a.name === agent)),
          run: (c, agent, m, command2) => p.run(c, agent, m, command2)
        },
        id,
        mid,
        cmd
      )
    },
    'processes:counts': async () => (d.processes ? d.processes.counts() : {}),
    'files:list': async (chatId) => {
      const id = str(chatId, 'chatId')
      const meta = await chats.get(id)
      if (!meta) throw new Error(`Chat not found: ${id}`)
      return listChatFiles(await chats.loadItems(id), meta.cwd, d.home, process.env['CLAUDE_CONFIG_DIR'] || undefined)
    },
    // Not caught: a refusal (running, changed since, not kept) is a fixed sentence the panel shows.
    'files:restore': (chatId, path, fromId, toId) =>
      d.restoreFile(str(chatId, 'chatId'), str(path, 'path'), str(fromId, 'fromId'), str(toId, 'toId')),
    // Deliberately not caught: a bad decision rejects the call and never reaches ChatService.answer.
    'chats:answer': (chatId, requestId, decision, agent) =>
      chatService.answer(
        str(chatId, 'chatId'),
        str(requestId, 'requestId'),
        parseDecision(decision),
        agent === undefined || agent === null ? undefined : str(agent, 'agent')
      ),
    // Deliberately not caught: ChatService.checkAnswers rejects a bad answer before anything is sent.
    'chats:answerQuestions': (chatId, requestId, answers, agent) =>
      chatService.answerQuestions(
        str(chatId, 'chatId'),
        str(requestId, 'requestId'),
        questionAnswers(answers),
        agent === undefined || agent === null ? undefined : str(agent, 'agent')
      ),
    // Deliberately not caught: ChatService.checkFeedback rejects over-long feedback before anything is sent.
    'chats:answerPlan': (chatId, requestId, approve, feedback, agent) =>
      chatService.answerPlan(
        str(chatId, 'chatId'),
        str(requestId, 'requestId'),
        bool(approve, 'approve'),
        feedback === undefined || feedback === null ? undefined : str(feedback, 'feedback'),
        agent === undefined || agent === null ? undefined : str(agent, 'agent')
      ),
    'chats:stop': (chatId) => chatService.stop(str(chatId, 'chatId')),
    // Through the queue, like an edit: its lock keeps a pause or Resume from crossing a send. Not caught: a refusal
    // (not running, compacting, not paused, busy) must reach the client.
    'chats:pause': async (chatId) => {
      const id = str(chatId, 'chatId')
      await writable(id)
      await refuseWithout(id, 'pause')
      return tasks.pause(id)
    },
    'chats:resume': async (chatId) => {
      const id = str(chatId, 'chatId')
      await writable(id)
      return tasks.resumePaused(id)
    },
    'chats:rename': (chatId, title) => chats.update(str(chatId, 'chatId'), { title: str(title, 'title') }),
    'chats:react': (chatId, itemId, emoji) => chats.toggleReaction(str(chatId, 'chatId'), str(itemId, 'itemId'), reaction(emoji)),
    'chats:markUnread': async (chatId, itemId) => {
      const id = str(chatId, 'chatId')
      const want = str(itemId, 'itemId')
      await writable(id)
      const item = (await chats.loadItems(id)).find((i) => i.id === want)
      // Only an agent's message: the New line never sits on the user's own.
      if (item?.type !== 'assistant') throw new Error('Message not found')
      return d.reads.markUnread(id, item.ts - 1)
    },
    'chats:archive': async (chatId, on) => {
      const id = str(chatId, 'chatId')
      const want = bool(on, 'on')
      // Checked in the store's queued step, so a turn starting meanwhile can't slip in between the check and the write.
      const meta = await chats.patchInPlace(id, (cur) => {
        if (want && cur.inFlight) throw new Error(ARCHIVE_RUNNING)
        return archivePatch(cur, want, Date.now())
      })
      if (!meta) throw new Error(`Chat not found: ${id}`)
      d.push({ chatId: id, kind: 'meta', meta })
      if (want) await endProcesses(id)
      if (want && meta.worktree) releaseInBackground(meta, false)
      // Archived: nothing of it is polled any more. Unarchived: the next read arms it again.
      if (want) d.github?.watcher.stop(id)
      else d.github?.watcher.watch(meta)
      return meta
    },
    'chats:gitStatus': async (chatId) => {
      const id = str(chatId, 'chatId')
      const meta = await chats.get(id)
      if (!meta) throw new Error(`Chat not found: ${id}`)
      return d.worktrees ? d.worktrees.status(meta, itemsOf(id)) : null
    },
    'chats:gitChanges': async (chatId, scope) => {
      const id = str(chatId, 'chatId')
      const want = gitScope(scope)
      const meta = await chats.get(id)
      if (!meta) throw new Error(`Chat not found: ${id}`)
      return d.gitChanges ? d.gitChanges.list(meta, want, itemsOf(id)) : null
    },
    'chats:gitDiff': async (chatId, path, scope) => {
      const id = str(chatId, 'chatId')
      const p = str(path, 'path')
      const want = gitScope(scope)
      const meta = await chats.get(id)
      if (!meta) throw new Error(`Chat not found: ${id}`)
      // The service reads only a path the scope lists as changed, so a made-up path never reaches the disk.
      if (!d.gitChanges) throw new Error('Not in a git repository')
      return d.gitChanges.diff(meta, p, want, itemsOf(id))
    },
    'chats:remove': async (chatId) => {
      const id = str(chatId, 'chatId')
      // Read first: once removed, the meta (and so its worktree) is gone.
      const gone = await chats.get(id)
      d.github?.watcher.stop(id)
      d.side.stopChat(id)
      chatService.stop(id) // not awaited: ChatService finishes quietly once its chat is gone
      chatService.forget(id) // drop this chat's "Allow for this chat" memory
      // Before the release below; its records and logs go too. The store's removal listener repeats it for other paths.
      try {
        await d.processes?.removeChat(id)
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code
        console.error('ending deleted chat processes failed:', typeof code === 'string' ? code : 'error')
      }
      await chats.remove(id)
      // After the removal, so release no longer counts this chat among the folder's users.
      if (gone?.worktree) releaseInBackground(gone, true)
      runner.chatRemoved(id)
      workflowRunner.chatRemoved(id)
      try {
        d.chatRemoved?.(id)
      } catch {
        /* a notification hook must not fail the delete */
      }
      feed.forget(id)
      told(await sidebar.forgetChat(id))
      try {
        await attachments.removeChat(id)
      } catch (err) {
        console.error('removing attachments failed:', err) // best effort: the chat itself is already gone
      }
      try {
        await d.snapshots.removeChat(id)
      } catch (err) {
        console.error('removing file copies failed:', err)
      }
      try {
        await d.browserShots.removeChat(id)
      } catch (err) {
        console.error('removing browser screenshots failed:', err)
      }
      try {
        await d.tmp.remove(id) // after the stop above: the CLI may still hold files in it
      } catch (err) {
        console.error('removing chat temp folder failed:', err)
      }
    },

    // Where the folder browser opens. fixed = the chat's folder is decided and the browser is skipped.
    // agentName is null when the folder is picked before the agent (the no-chat-open screen).
    'app:folderStart': async (agentName) => {
      const name = agentName === null ? null : str(agentName, 'agentName')
      const builtIn = name === null ? null : d.builtInCwd(name)
      if (builtIn) return { fixed: true, path: builtIn }
      if (d.testPickFolder) return { fixed: true, path: d.testPickFolder }
      const last = name === null ? undefined : (await settings.get()).lastFolderByAgent[name]
      // A saved folder deleted since would make the browser fail, so fall back to home.
      return { fixed: false, path: last && (await isDir(last)) ? last : d.home }
    },
    'app:mode': () => d.mode,
    // Whether the folder is in a git repo, and whether that repo's "Isolate in worktree" toggle is on.
    'app:gitFolder': async (cwd) => {
      const top = await d.worktrees?.topOf(str(cwd, 'cwd'))
      return top ? { repo: true, worktree: await settings.worktreeOn(top) } : { repo: false, worktree: false }
    },
    'app:setWorktreeFolder': async (cwd, on) => {
      const dir = str(cwd, 'cwd')
      const want = bool(on, 'on')
      const top = await d.worktrees?.topOf(dir)
      if (!top) throw new Error(`Not a git repository: ${basename(dir)}`)
      await settings.setWorktreeFolder(top, want)
    },
    'fs:listDirs': (path) => listDirs(path === null ? null : str(path, 'path'), d.home),
    'fs:makeDir': (parent, name) => makeDir(str(parent, 'parent'), str(name, 'name')),
    'app:lastFolder': async (agentName) => {
      const name = str(agentName, 'agentName')
      const fixed = d.builtInCwd(name)
      if (fixed) return fixed
      const last = (await settings.get()).lastFolderByAgent[name]
      if (!last) return null
      // A folder deleted since its last chat would only fail later, when claude starts in it.
      return (await isDir(last)) ? last : null
    },
    'app:lastGroupFolder': async () => {
      const last = (await settings.get()).lastGroupFolder
      if (!last) return null
      return (await isDir(last)) ? last : null
    },
    'app:claudeStatus': async () => ({ path: await d.claude.status() }),
    'app:setClaudePath': async (path) => ({ path: await d.claude.setPath(str(path, 'path')) }),
    'app:getTheme': async () => (await settings.get()).theme,
    'app:account': () => d.account(),
    // Only saves: the desktop shell applies the theme to its own window.
    'app:setTheme': async (v) => {
      const theme = themePref(v)
      await settings.set({ theme })
      return theme
    },
    'app:getAccent': async () => (await settings.get()).accent,
    'app:setAccent': async (v) => {
      const accent = accentOf(v)
      await settings.set({ accent })
      return accent
    },
    'sidebar:get': () => sidebar.get(),
    'sidebar:save': async (v) => {
      const saved = await sidebar.save(layout(v))
      d.sidebarChanged(saved)
      return saved
    },
    'memory:list': async (agent) => listMemory(str(agent, 'agent')).then((x) => x.list),
    'memory:save': async (agent, file, input, modified) => {
      const name = str(agent, 'agent')
      const f = file === null ? null : memoryFile(file)
      const m = modified === null ? null : finite(modified, 'modified')
      const clean = checkMemoryInput(input)
      const { summary } = await listMemory(name)
      await d.memory.store.save(name, f, clean, m, effectiveLimit(summary.memoryLimit))
      d.memoryChanged(name)
      return (await listMemory(name)).list
    },
    'memory:remove': async (agent, file, modified) => {
      const name = str(agent, 'agent')
      const f = memoryFile(file)
      const m = finite(modified, 'modified')
      await listMemory(name)
      await d.memory.store.remove(name, f, m)
      d.memoryChanged(name)
      return (await listMemory(name)).list
    },
    'approvals:list': (agentName) => approvals.list(str(agentName, 'agentName')),
    'approvals:remove': async (agentName, key) => {
      const agent = str(agentName, 'agentName')
      await approvals.remove(agent, str(key, 'key'))
      d.approvalsChanged(agent)
      return approvals.list(agent)
    },
    // Agent Studio's Add: the same CLI rule the Allow card makes for an agent, typed by the user. No refused command to match,
    // so only the rule's own checks apply; the server's home folder (and any folder holding it) is refused.
    'approvals:addCli': async (agentName, kind, value) => {
      const agent = str(agentName, 'agentName')
      if (kind !== 'prefix' && kind !== 'folder') throw new TypeError("kind must be 'prefix' or 'folder'")
      const v = str(value, 'value').trim()
      if (agent === '' || agent === ZUMI_BOT_NAME) throw new Error('Zumi Bot and an unnamed agent take no rules')
      const bad = kind === 'prefix' ? prefixRuleError(v) : folderRuleError(v, homedir())
      if (bad) throw new Error(bad)
      const rule = kind === 'prefix' ? ruleOfPrefix(v) : ruleOfFolder(v)
      await approvals.add(agent, { key: JSON.stringify(['cli', rule]), toolName: kind === 'prefix' ? 'Bash' : 'Read', command: null, cli: rule })
      d.approvalsChanged(agent)
      return approvals.list(agent)
    },
    'routines:list': () => routineStore.snapshot(),
    'routines:save': (raw, meta) => routineEdit.save(parseRoutineInput(raw), saveMeta(meta)),
    'routines:remove': (id) => routineEdit.remove(str(id, 'id')),
    'routines:history': async (id) => {
      const rid = str(id, 'id')
      const current = await routineStore.get(rid)
      if (!current) throw new Error(NOT_FOUND)
      return summarizeVersions(d.routineHistory ? await d.routineHistory.list(rid) : [], routineDef(current), routineChanges)
    },
    'routines:version': async (id, versionId) => {
      const rid = str(id, 'id')
      if (!(await routineStore.get(rid))) throw new Error(NOT_FOUND)
      const v = d.routineHistory ? await d.routineHistory.get(rid, str(versionId, 'versionId')) : null
      if (!v) throw new Error(VERSION_NOT_FOUND)
      return v.def
    },
    'routines:duplicate': async (id) => {
      const sourceId = str(id, 'id')
      const source = await routineStore.get(sourceId)
      if (!source) throw new Error(NOT_FOUND)
      const copyId = randomUUID()
      const now = Date.now()
      // Never the source's URL or secret: the copy gets a hook of its own, holding the source's latest call (or the
      // saved sample, which a webhook routine always has), so its {{body.…}} fields and Run now work as they did and
      // it can be saved again. A draft until the copy exists, as for a save.
      const latest = source.trigger.kind === 'webhook' ? ((await routineStore.hook(sourceId))?.latest ?? source.trigger.sample) : null
      if (latest) await routineStore.putHook({ id: copyId, secret: newSecret(), latest, draftAt: now })
      // Read fresh from the file, so nothing is shared with the source. Runs are not copied.
      const copy = await routineStore.copy(sourceId, (r, all) => ({
        ...r,
        id: copyId,
        name: copyTitle(
          r.name,
          all.map((x) => x.name),
          ROUTINE_NAME_MAX,
          'Routine'
        ),
        // Off, so a schedule or webhook never fires twice.
        enabled: false,
        nextRunAt: null,
        trigger: r.trigger.kind === 'webhook' ? { ...r.trigger, sample: latest } : r.trigger,
        createdAt: now,
        updatedAt: now
      }))
      if (!copy) {
        if (latest) await routineStore.dropHook(copyId)
        throw new Error(NOT_FOUND)
      }
      if (latest) await routineStore.clearDraft(copyId)
      d.routinesChanged()
      return copy
    },
    'routines:setEnabled': async (id, on) => {
      const rid = str(id, 'id')
      const enabled = bool(on, 'on')
      const now = Date.now()
      const saved = await routineStore.update(rid, (old) =>
        old.enabled === enabled ? old : { ...old, enabled, updatedAt: now, nextRunAt: nextFor(old.trigger, enabled, old.timeZone, now) }
      )
      if (!saved) throw new Error(NOT_FOUND)
      await d.scheduler.rearm()
      d.routinesChanged()
      return saved
    },
    'routines:runNow': async (id) => {
      const routine = await routineStore.get(str(id, 'id'))
      if (!routine) throw new Error(NOT_FOUND)
      return runner.run(routine, 'manual')
    },
    'routines:draftWebhook': async () => {
      const id = randomUUID()
      const hook = await routineStore.ensureHook(id, newSecret, Date.now())
      return { id, url: d.hookUrl(id), secret: hook.secret }
    },
    // A saved routine's hook goes with the routine; only a hook nobody owns is a draft.
    'routines:dropDraft': async (id) => {
      const hookId = str(id, 'id')
      if (await routineStore.get(hookId)) return
      await routineStore.dropHook(hookId)
    },
    'routines:webhook': async (id) => {
      const rid = str(id, 'id')
      if (!(await routineStore.get(rid)) && !(await routineStore.hook(rid))) throw new Error(NOT_FOUND)
      const hook = await routineStore.ensureHook(rid, newSecret, Date.now())
      return { url: d.hookUrl(rid), secret: hook.secret, latest: hook.latest }
    },
    'routines:newSecret': async (id) => {
      const rid = str(id, 'id')
      if (!(await routineStore.get(rid)) && !(await routineStore.hook(rid))) throw new Error(NOT_FOUND)
      await routineStore.ensureHook(rid, newSecret, Date.now())
      const secret = newSecret()
      if (!(await routineStore.rotateSecret(rid, secret))) throw new Error(NOT_FOUND)
      return secret
    },
    'workflows:list': () => workflowStore.snapshot(),
    'workflows:getRun': (runId) => workflowStore.getRun(wid(runId, 'runId')),
    'workflows:save': async (raw, meta) => (await workflowEdit.save(parseWorkflowInput(raw), saveMeta(meta))).workflow,
    'workflows:remove': (id) => workflowEdit.remove(wid(id, 'id')),
    'workflows:history': async (id) => {
      const w = wid(id, 'id')
      const current = await workflowStore.get(w)
      if (!current) throw new Error(WORKFLOW_NOT_FOUND)
      return summarizeVersions(d.workflowHistory ? await d.workflowHistory.list(w) : [], workflowDef(current), workflowChanges)
    },
    'workflows:version': async (id, versionId) => {
      const w = wid(id, 'id')
      if (!(await workflowStore.get(w))) throw new Error(WORKFLOW_NOT_FOUND)
      const v = d.workflowHistory ? await d.workflowHistory.get(w, str(versionId, 'versionId')) : null
      if (!v) throw new Error(VERSION_NOT_FOUND)
      return v.def
    },
    'workflows:duplicate': async (id) => {
      const sourceId = wid(id, 'id')
      const source = await workflowStore.get(sourceId)
      if (!source) throw new Error(WORKFLOW_NOT_FOUND)
      const copyId = randomUUID()
      const now = Date.now()
      // Never the source's URL or secret: the copy gets a hook of its own, holding the source's latest call, so its
      // {{trigger.…}} fields and a run by hand work as they did. A draft until the copy exists, as for a save.
      const latest = source.trigger.kind === 'webhook' ? ((await workflowStore.hooks.hook(sourceId))?.latest ?? null) : null
      if (latest) await workflowStore.hooks.putHook({ id: copyId, secret: newSecret(), latest, draftAt: now })
      // Read fresh from the file, so nothing is shared with the source. Runs are not copied.
      const copy = await workflowStore.copy(sourceId, (w, all) => ({
        ...w,
        id: copyId,
        name: copyTitle(
          w.name,
          all.map((x) => x.name),
          WORKFLOW_NAME_MAX,
          'Workflow'
        ),
        // Off, so a schedule or webhook never fires twice; turning it on checks its problems as usual.
        enabled: false,
        nextRunAt: null,
        trigger: w.trigger.kind === 'webhook' ? { ...w.trigger, sample: latest } : w.trigger,
        createdAt: now,
        updatedAt: now
      }))
      if (!copy) {
        if (latest) await workflowStore.hooks.dropHook(copyId)
        throw new Error(WORKFLOW_NOT_FOUND)
      }
      if (latest) await workflowStore.hooks.clearDraft(copyId)
      d.workflowsChanged()
      return copy
    },
    'workflows:setEnabled': async (id, on) => {
      const workflowId = wid(id, 'id')
      const enabled = bool(on, 'on')
      if (enabled) {
        const current = await workflowStore.get(workflowId)
        if (!current) throw new Error(WORKFLOW_NOT_FOUND)
        if ((await workflowRunner.problems(current)).length > 0) throw new Error(PROBLEMS_TEXT)
      }
      const now = Date.now()
      const saved = await workflowStore.update(workflowId, (old) =>
        old.enabled === enabled ? old : { ...old, enabled, updatedAt: now, nextRunAt: nextFor(old.trigger, enabled, old.timeZone, now) }
      )
      if (!saved) throw new Error(WORKFLOW_NOT_FOUND)
      await d.workflowScheduler.rearm()
      d.workflowsChanged()
      return saved
    },
    'workflows:run': async (id, input) => {
      const workflowId = wid(id, 'id')
      const text = optText(input, 'input', 'Input', TRIGGER_BODY_MAX)
      const workflow = await workflowStore.get(workflowId)
      if (!workflow) throw new Error(WORKFLOW_NOT_FOUND)
      return workflowRunner.run(workflow, 'manual', text !== undefined ? { input: text } : {})
    },
    // `text` is the composer's text (`/run-workflow <name> <input>`) or just what follows the command. `workflowId`: the
    // Workflows list's pick, which wins over the name (two workflows may share one); typed by hand, the name decides.
    'workflows:runFromChat': async (chatId, text, workflowId) => {
      const id = str(chatId, 'chatId')
      const typed = optText(text ?? '', 'text', 'Input', TRIGGER_BODY_MAX) ?? ''
      // Optional, so null over the socket.
      const picked = workflowId === undefined || workflowId === null ? null : wid(workflowId, 'workflowId')
      const rest = runWorkflowRest(typed) ?? typed.trim()
      const meta = await chats.get(id)
      if (!meta) throw new Error('Chat not found')
      const all = await workflowStore.list()
      let found: { id: string; input: string }
      if (picked !== null) {
        const named = all.find((x) => x.id === picked)
        if (!named) throw new Error(WORKFLOW_NOT_FOUND)
        found = { id: named.id, input: afterWorkflowName(rest, named.name) ?? rest }
      } else {
        const resolved = resolveRunWorkflow(rest, all)
        if ('error' in resolved) throw new Error(resolved.error)
        found = resolved
      }
      const w = all.find((x) => x.id === found.id)
      if (!w) throw new Error(WORKFLOW_NOT_FOUND)
      const items = await chats.loadItems(id)
      let lastReply = ''
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]!
        if (it.type === 'assistant') {
          lastReply = it.text.slice(0, REPLY_TEXT_MAX)
          break
        }
      }
      const chat: ChatRef = { id: meta.id, title: meta.title, folder: meta.cwd }
      return workflowRunner.run(w, 'chat', {
        input: found.input,
        chat: { chatId: meta.id, title: meta.title },
        call: eventCall({ chat, text: found.input, lastReply }, Date.now())
      })
    },
    'workflows:stop': (runId) => workflowRunner.stopRun(wid(runId, 'runId')),
    'workflows:continueCap': async (runId) => {
      if (!d.spendCaps) throw new Error('Spend caps are off')
      await d.spendCaps.continueWorkflow(wid(runId, 'runId'))
    },
    'workflows:retry': (runId, visitId, itemId) => {
      const run = wid(runId, 'runId'),
        visit = wid(visitId, 'visitId')
      // Optional, so null over the socket; given, it names one failed item of a For each visit.
      return itemId === undefined || itemId === null
        ? workflowRunner.retry(run, visit)
        : workflowRunner.retry(run, visit, wid(itemId, 'itemId'))
    },
    'workflows:approve': (runId, visitId, ok, text, note) => {
      const run = wid(runId, 'runId'),
        visit = wid(visitId, 'visitId'),
        approved = bool(ok, 'ok')
      const edited = optText(text, 'text', 'Text', APPROVAL_TEXT_MAX)
      const said = optText(note, 'note', 'Note', APPROVAL_NOTE_MAX)
      return workflowRunner.approve(run, visit, {
        ok: approved,
        ...(edited !== undefined ? { text: edited } : {}),
        ...(said !== undefined ? { note: said } : {})
      })
    },
    'workflows:testStep': async (draft, stepId, input) => {
      const w = parseWorkflowInput(draft)
      const step = wid(stepId, 'stepId')
      const text = str(input, 'input')
      if (text.length > TEST_INPUT_MAX) throw new Error(`Input is longer than ${TEST_INPUT_MAX} characters`)
      return workflowRunner.testStep(await withSample(workflowStore, w), step, text)
    },
    'workflows:checkMail': async (raw) => {
      // Parsed as a saved trigger is, so only the fields a workflow keeps reach the mail server.
      const t = parseTrigger(raw)
      if (t.kind !== 'email') throw new Error(INVALID_WORKFLOW)
      return d.checkMail ? d.checkMail(t) : { error: 'Email is not available on this server.' }
    },
    'workflows:draftWebhook': async () => {
      const id = randomUUID()
      const secret = newSecret()
      await workflowStore.hooks.putHook({ id, secret, latest: null, draftAt: Date.now(), reserved: true })
      return { id, url: d.hookUrl(id), secret }
    },
    'workflows:dropDraft': async (id) => {
      const hookId = wid(id, 'id')
      if (await workflowStore.get(hookId)) return
      await workflowStore.hooks.dropHook(hookId)
    },
    'workflows:webhook': async (id) => {
      const workflowId = wid(id, 'id')
      if (!(await workflowStore.get(workflowId)) && !(await workflowStore.hooks.hook(workflowId))) throw new Error(WORKFLOW_NOT_FOUND)
      // draftAt set: a remove racing this call would otherwise orphan the hook; the next save clears it.
      const hook = await workflowStore.hooks.ensureHook(workflowId, newSecret, Date.now())
      return { url: d.hookUrl(workflowId), secret: hook.secret, latest: hook.latest }
    },
    'workflows:newSecret': async (id) => {
      const workflowId = wid(id, 'id')
      if (!(await workflowStore.get(workflowId)) && !(await workflowStore.hooks.hook(workflowId))) throw new Error(WORKFLOW_NOT_FOUND)
      await workflowStore.hooks.ensureHook(workflowId, newSecret, Date.now())
      const secret = newSecret()
      if (!(await workflowStore.hooks.rotateSecret(workflowId, secret))) throw new Error(WORKFLOW_NOT_FOUND)
      return secret
    },
    'workflows:approvals': () => workflowStore.waitingApprovals(),
    'inbox:messages': () => d.inbox.list(),
    'inbox:archive': async (id, on) => {
      await d.inbox.setArchived(str(id, 'id'), bool(on, 'on'))
      d.inboxChanged()
    },
    'inbox:remove': async (id) => {
      await d.inbox.remove(str(id, 'id'))
      d.inboxChanged()
    },
    'inbox:restore': async (id) => {
      await d.inbox.restore(str(id, 'id'))
      d.inboxChanged()
    },
    'inbox:seen': async (at) => {
      if (typeof at !== 'number' || !Number.isFinite(at)) throw new TypeError('at must be a number')
      // A client clock ahead of the server's must never mark later messages seen in advance.
      await d.inbox.markSeen(Math.min(at, Date.now()))
      d.inboxChanged()
    },
    'usage:query': async (q) => {
      const o = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>
      const num = (v: unknown, what: string): number | null => {
        if (v === null || v === undefined) return null
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what} must be a number or null`)
        return v
      }
      const text = (v: unknown, what: string): string | null => (v === null || v === undefined ? null : str(v, what))
      let timeZone = 'UTC'
      if (typeof o['timeZone'] === 'string') {
        try {
          new Intl.DateTimeFormat('en-CA', { timeZone: o['timeZone'] })
          timeZone = o['timeZone']
        } catch {
          /* unknown zone: UTC */
        }
      }
      const query: UsageQuery = {
        from: num(o['from'], 'from'),
        to: num(o['to'], 'to'),
        agent: text(o['agent'], 'agent'),
        chatId: text(o['chatId'], 'chatId'),
        timeZone
      }
      return d.usage.query(query)
    },
    'usage:caps': async () => (d.spendCaps ? d.spendCaps.status() : []),
    'usage:allowMore': async (agent) => {
      if (!d.spendCaps) throw new Error('Spend caps are off')
      return d.spendCaps.allowMore(str(agent, 'agent'))
    },
    'jev:status': async () => d.jev.store.status(),
    'jev:setKey': async (key) => d.jev.store.setKey(jevKey(key)),
    'jev:setSwitches': async (patch) => d.jev.store.setSwitches(jevSwitches(patch)),
    'jev:check': async () => d.jev.check(),
    // Channels: only the user, from Settings, pairs, unpairs or flips switches; no agent tool reaches these.
    // Arguments are checked before anything else, the service's presence included.
    'channels:status': async () => (d.channels ? Promise.all(CHANNEL_PLATFORMS.map((p) => d.channels!.services[p].statusOf())) : []),
    'channels:setToken': async (platform, token, appToken) => {
      const p = channelPlatform(platform)
      const t = botToken(p, token, appToken)
      await needChannels(p).setToken(t)
    },
    'channels:removeToken': async (platform) => {
      const p = channelPlatform(platform)
      await needChannels(p).removeToken()
    },
    'channels:setRun': async (platform, on) => {
      const p = channelPlatform(platform)
      const v = bool(on, 'on')
      await needChannels(p).setRun(v)
    },
    'channels:setSharedCards': async (platform, on) => {
      const p = channelPlatform(platform)
      const v = bool(on, 'on')
      if (p !== 'slack') throw new TypeError('only Slack has shared channels')
      await needChannels(p).setSharedCards(v)
    },
    'channels:setNotify': async (platform, toggles) => {
      const p = channelPlatform(platform)
      if (!isChannelToggles(toggles))
        throw new TypeError('toggles must name waiting, replied, error, routineFailed and workflow, each a boolean')
      await needChannels(p).setNotify(toggles)
    },
    'channels:pairStart': async (platform) => {
      const p = channelPlatform(platform)
      return needChannels(p).pairStart()
    },
    'channels:pairCancel': async (platform) => {
      const p = channelPlatform(platform)
      needChannels(p).pairCancel()
    },
    'channels:unpair': async (platform) => {
      const p = channelPlatform(platform)
      await needChannels(p).unpair()
    },
    'channels:setAgents': async (platform, names) => {
      const p = channelPlatform(platform)
      const list = strings(names, 'names')
      if (list.length > 200) throw new TypeError('names must hold at most 200 agents')
      await needChannels(p).setAgents(list)
    },
    'channels:link': async (chatId, platform) => {
      const id = str(chatId, 'chatId')
      const p = channelPlatform(platform)
      await needChannels(p).link(id)
    },
    // Every platform lets go of the chat: its mark is one, whichever linked it last.
    'channels:unlink': async (chatId) => {
      const id = str(chatId, 'chatId')
      for (const p of CHANNEL_PLATFORMS) await needChannels(p).unlink(id)
    },
    'voice:status': async () => d.voice.store.status(),
    'voice:set': async (patch) => {
      const status = await d.voice.store.set(voicePatch(patch))
      d.voiceChanged(status)
      return status
    },
    'voice:check': async () => d.voice.check(),
    'audit:list': async (filter, cursor, limit) => {
      const log = auditOf(d)
      const c = cursor === undefined || cursor === null ? null : str(cursor, 'cursor')
      if (c !== null && c.length > 200) throw new TypeError('cursor is too long')
      if (
        limit !== undefined &&
        limit !== null &&
        (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX)
      ) {
        throw new TypeError(`limit must be a whole number from 1 to ${AUDIT_PAGE_MAX}`)
      }
      return log.list(parseAuditFilter(filter), c, typeof limit === 'number' ? limit : undefined)
    },
    'audit:get': async (id, at) => {
      const i = str(id, 'id'),
        a = str(at, 'at')
      if (i.length > 100 || a.length > 200) throw new TypeError('id or at is too long')
      return auditOf(d).get(i, a)
    },
    'isolation:status': async (fresh) => isolationOf(d).status(fresh === true),
    'isolation:get': async (agent) => {
      const name = str(agent, 'agent')
      if (name.length > 200) throw new TypeError('agent is too long')
      const a = (await agents.list()).find((x) => x.name === name)
      return { isolation: isolationOf(d).get(name), refused: isolationRefused(a) } satisfies AgentIsolationView
    },
    'isolation:set': async (agent, value) => {
      const name = str(agent, 'agent')
      if (name.length > 200) throw new TypeError('agent is too long')
      const iso = parseIsolation(value)
      const a = (await agents.list()).find((x) => x.name === name)
      if (!a) throw new Error(`No agent named ${name}`)
      // Codex, ACP and remote agents (no `isolation` cap): only Off saves.
      const engine = engineOfAgent(a)
      if (iso.level !== 'off' && !caps(engine).isolation) throw new Error(isolationRefusal(engine, iso.level))
      const svc = isolationOf(d)
      await svc.set(name, iso)
      return { isolation: svc.get(name), refused: isolationRefused(a) } satisfies AgentIsolationView
    },
    'audit:facets': async () => auditOf(d).getFacets(),
    'audit:status': async () => auditOf(d).status(),
    'audit:verify': async () => auditOf(d).verify(),
    'audit:setCap': async (bytes) => {
      if (typeof bytes !== 'number' || !(AUDIT_CAPS as readonly number[]).includes(bytes))
        throw new TypeError('cap must be one of the offered sizes')
      const log = auditOf(d)
      await log.setCap(bytes)
      return log.status()
    },
    // seen(): a stale answer also starts a check, so a tab that connects or comes back gets the toast on its own.
    'update:status': async () => d.update.seen(),
    'update:check': async () => d.update.check(),
    'update:install': async (opts) => d.update.install(forceOf(opts)),
    'update:rollBack': async (opts) => d.update.rollBack(forceOf(opts)),
    'vault:status': async () => d.vault.status(),
    'vault:keyFile': async () => d.vault.keyFile(),
    'vault:list': async () => d.vault.list().map(listView),
    'vault:reveal': async (id, field) => {
      const itemId = str(id, 'id')
      const f = revealField(field)
      // Counted before the lookup, so probing ids costs the same as reading.
      if (!reveals.take()) throw new Error('Too many reveals. Wait a minute.')
      const item = d.vault.get(itemId)
      if (!item) throw new Error('Item not found.')
      return secretOf(item, f)
    },
    'vault:save': async (input, updatedAt) => {
      const clean = vaultInput(input)
      const at = finiteOrNone(updatedAt, 'updatedAt')
      // The client picks the agents, so the server checks each one is loadable and never Zumi Bot. The check runs inside the
      // save, after the store took its mark: an agent renamed or deleted while the folder is read is replayed onto the grant.
      return listView(
        await d.vault.save(clean, at, async () => {
          const loadable = new Set((await agents.list()).filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME).map((a) => a.name))
          if (clean.agents.some((a) => !loadable.has(a))) throw new Error('Only working agents (not Zumi Bot) can use vault items.')
        })
      )
    },
    'vault:delete': async (id) => d.vault.delete(str(id, 'id')),
    'vault:removeApproval': async (id, site, frameSite) =>
      d.vault.removeApproval(str(id, 'id'), str(site, 'site'), str(frameSite, 'frameSite')),
    // Only a request pending for this very chat can be answered, whatever ids the caller names: VaultApprovals holds the live
    // ones and checks both. Not the stored items: ChatService pushes a card before its save lands, so a quick click would miss it.
    'vault:answer': async (chatId, requestId, decision) => {
      const id = str(chatId, 'chatId'),
        request = str(requestId, 'requestId')
      if (decision !== 'allow' && decision !== 'deny') throw new TypeError('decision must be allow or deny')
      return d.vaultApprovals.answer(id, request, decision)
    },
    'vault:reset': async () => {
      // Only for a vault that cannot be read: a click on a healthy one must never move it aside.
      const status = d.vault.status()
      if (status !== 'keyMissing' && status !== 'keyMismatch') throw new Error('The vault is fine; nothing to reset.')
      await d.vault.reset()
    },
    // Optional arguments arrive as null over the socket. Zumi Bot may be looked at (view only); nothing else takes an agent.
    'extensions:loadout': async (folder, agent, refresh) => {
      const f = await extFolder(folder)
      let name: string | null = null
      if (agent !== undefined && agent !== null) {
        if (typeof agent !== 'string' || !(await agents.list()).some((a) => a.name === agent && a.error === null))
          throw new Error(EXT_TEXT.notFound)
        name = agent
      }
      return d.extensions.loadout(f, name, refresh === undefined || refresh === null ? false : bool(refresh, 'refresh'))
    },
    'extensions:server': async (folder, scope, name) => d.extensions.server(await extFolder(folder), extScope(scope), serverName(name)),
    'extensions:saveServer': async (folder, scope, name, input, prevName, stamp) => {
      const f = await extFolder(folder)
      const s = extScope(scope)
      const n = newServerName(name)
      const before = prevName === undefined || prevName === null ? undefined : serverName(prevName)
      return d.extensions.saveServer(f, s, n, serverInput(input), before, optStamp(stamp))
    },
    'extensions:removeServer': async (folder, scope, name) =>
      d.extensions.removeServer(await extFolder(folder), extScope(scope), serverName(name)),
    'extensions:setPlugin': async (id, enabled) => d.extensions.setPlugin(pluginId(id), bool(enabled, 'enabled')),
    'extensions:skill': async (scope, folder, name) => {
      const s = skillScope(scope)
      return d.extensions.skill(s, await extFolder(folder), skillName(name))
    },
    'extensions:saveSkill': async (scope, folder, input) => {
      const s = skillScope(scope)
      return d.extensions.saveSkill(s, await extFolder(folder), skillInput(input))
    },
    'extensions:removeSkill': async (scope, folder, name) => {
      const s = skillScope(scope)
      return d.extensions.removeSkill(s, await extFolder(folder), skillName(name))
    },
    'extensions:setSkill': async (name, on) => d.extensions.setSkill(skillKey(name), bool(on, 'on')),
    'extensions:saveHook': async (file, folder, input, stamp) => {
      const which = hookFile(file)
      const f = await extFolder(folder)
      const hook = hookInput(input)
      const s = optStamp(stamp) ?? null
      // A place in the file is only good for the text the page read, so an edit carries that file's stamp; an add only appends.
      if (hook.at && s === null) throw new TypeError('stamp is required to edit a hook')
      return d.extensions.saveHook(which, f, hook, s)
    },
    'connectors:list': async (refresh) => d.connectors.list(refresh === undefined || refresh === null ? false : bool(refresh, 'refresh')),
    'connectors:setAgent': async (id, agent, on) => {
      if (!isConnectorId(id)) throw new TypeError('id')
      if (typeof agent !== 'string') throw new TypeError('agent')
      // Zumi Bot never uses connectors and a Codex agent can't (it never sees claude.ai's).
      const found = (await agents.list()).find((a) => a.name === agent && a.error === null)
      if (!found || found.name === ZUMI_BOT_NAME || engineOfAgent(found) !== 'claude') throw new Error(CONNECTOR_TEXT.notSwitchable)
      return d.connectors.setAgent(id, agent, bool(on, 'on'))
    },
    'connectors:setRemember': async (id, on) => {
      if (!isConnectorId(id)) throw new TypeError('id')
      return d.connectors.setRemember(id, bool(on, 'on'))
    },
    'extensions:removeHook': async (file, folder, event, at, stamp) => {
      const which = hookFile(file)
      const f = await extFolder(folder)
      const s = optStamp(stamp)
      if (s === undefined) throw new TypeError('stamp is required to remove a hook')
      return d.extensions.removeHook(which, f, hookEvent(event), hookPosition(at), s)
    },
    'jev:suggestAgent': async (text) => {
      const t = str(text, 'text').trim()
      if (t.length < SUGGEST_MIN_CHARS) return null
      // A remote agent is only ever the user's own pick: a suggestion would put one a click away from a message it should not get.
      const usable = (await agents.list()).filter((a) => a.error === null && !isRemoteAgent(a, caps))
      return d.jev.suggestAgent(
        t,
        usable.map((a) => ({ name: a.name, description: a.description }))
      )
    },
    'app:getKeepWarm': async () => (await settings.get()).keepWarm,
    'app:setKeepWarm': async (v) => {
      const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
      if (!(KEEP_WARM_ROOM_HOURS as readonly unknown[]).includes(o.roomHours))
        throw new TypeError(`roomHours must be one of ${KEEP_WARM_ROOM_HOURS.join(', ')}`)
      if (!(KEEP_WARM_CHAT_HOURS as readonly unknown[]).includes(o.chatHours))
        throw new TypeError(`chatHours must be one of ${KEEP_WARM_CHAT_HOURS.join(', ')}`)
      const keepWarm = keepWarmOf(o)
      await settings.set({ keepWarm })
      return keepWarm
    },
    'app:setTimeZone': async (tz) => {
      await settings.setTimeZone(str(tz, 'tz'))
    },
    'app:getHouseStyle': async () => (await settings.get()).houseStyle,
    'app:setHouseStyle': async (v) => {
      const houseStyle = bool(v, 'on')
      await settings.set({ houseStyle })
      return houseStyle
    },
    'app:getSuggestedReplies': async () => (await settings.get()).suggestedReplies,
    'app:setSuggestedReplies': async (v) => {
      const suggestedReplies = bool(v, 'on')
      await settings.set({ suggestedReplies })
      // Every tab, this one too: a switched-off block must vanish everywhere without a reload.
      d.suggestedRepliesChanged(suggestedReplies)
      return suggestedReplies
    }
  }

  const out: Handlers = {}
  for (const [name, fn] of Object.entries(h)) {
    out[name] = async (...args) => fn(...args)
  }
  return out
}
