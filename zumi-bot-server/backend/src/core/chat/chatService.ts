import type {
  AgentRule,
  ApprovalDecision,
  ApprovalStatus,
  Attachment,
  ChatItem,
  ChatMeta,
  ChatPush,
  ContextUse,
  LimitHit,
  NoticeKind,
  QuestionAnswers,
  SessionCut,
  WorkflowSent
} from '@zumibot/shared/types'
import { isGroup, NOTICE_TEXT } from '@zumibot/shared/types'
import type { SentCommand } from '@zumibot/shared/commands'
import { withoutComment, type CardAsk } from '@zumibot/shared/todos'
import type { ApprovalRisk } from '@zumibot/shared/jev'
import type { TurnEnd } from '@zumibot/shared/notify'
import { checkFeedback, PLAN_TOOL } from '@zumibot/shared/plans'
import { checkAnswers, QUESTION_TOOL } from '@zumibot/shared/questions'
import type { ChatFiles } from '../attachments/attachmentStore'
import { addDirArgs, imageBlocks, refsOf, withImages, withNote, withNotes } from '../attachments/content'
import type { ChatStore } from '../store/chatStore'
import type { PermissionMode, RunHandle, RunOptions, RunOutcome } from './claudeRunner'
import {
  agentAllowKey,
  allowKey,
  allowResponse,
  denyResponse,
  errorResponse,
  planSentBack,
  ruleOf,
  DENIED_BY_USER,
  SKIPPED_BY_USER,
  UNKNOWN_REQUEST_ERROR,
  type UserContent
} from './controlProtocol'
import { HOUSE_STYLE } from './houseStyle'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, resolve, sep, basename } from 'node:path'
import { homedir } from 'node:os'
import { MEMORY_INDEX, type MemoryTouch } from '@zumibot/shared/memory'
import type { BrowserHandoff, BrowserOwner } from '../browser/types'
import type { BrowserTurn } from '../browser/browserIpc'
import { NO_MCP, type McpServerSpec } from '../ipc/mcpSpec'
import {
  assertNever,
  capRefusal,
  CODEX_REFUSALS,
  engineCaps,
  ENGINE_LABEL,
  isolationRefusal,
  sessionMark,
  todoRefusal,
  unguardedNoticeText,
  type Engine,
  type EngineCaps,
  type Provider
} from '@zumibot/shared/engine'
import { displayName } from '@zumibot/shared/frontmatter'
import type { CodexRunOptions } from '../codex/codexRunner'
import { codexCompactLimit, codexModel, isCodexOwnEnv, type CodexHook, type CodexSkillRef } from '../codex/codexParams'
import { turnStart, type EngineAdapter, type EngineTurn, type TurnAction } from '../engines/engine'
import { claudeEngine, type ClaudeTurnConfig } from '../engines/claudeEngine'
import { codexEngine, type CodexEngine } from '../engines/codexEngine'
import { acpEngine, type AcpEngine } from '../engines/acpEngine'
import type { AcpRunOptions } from '../acp/acpRunner'
import { acpRememberable } from '../acp/acpTools'
import type { LaunchCheck } from '../acp/launchTrust'
import { ACP_TEXT, refusedArg, type AcpLaunch } from '@zumibot/shared/acp'
import { aguiEngine, type AguiEngine } from '../engines/aguiEngine'
import type { AguiRunOptions } from '../agui/aguiRunner'
import { checkUrl } from '../agui/aguiEndpoint'
import { aguiMessages, foreignHistory, type AguiMessage } from '../agui/aguiMessages'
import { aguiHeaders, keyUnusable } from '../agui/aguiTurn'
import { AGUI_TEXT, type AguiLaunch, type AguiThread } from '@zumibot/shared/agui'
import type { DesktopHandoff, DesktopOwner } from '@zumibot/shared/desktop'
import type { DesktopTurn } from '../desktop/desktopIpc'
import type { DesktopPlan } from '../desktop/desktopApplication'
import { desktopUnavailablePrompt } from '../desktop/desktopPrompt'
import { asksTodos, readAs, withCommands } from './commandText'
import { repliedItem, withReplies, withReply } from './reply'
import { buildSeedPrompt, makeTitle } from './seedPrompt'
import { droppedTurn, engineField, enginesAfter, memberStartsBefore, startBefore, withSessionEngines } from './sessionPoints'
import { branch, switchTo, type UserItem, type Versions } from './versions'
import { APPROVAL_REQUIRED, isCutRefused, isMissingSession, type RunEvent } from './streamParser'
import { allowSettingsArgs } from './allowRules'
import { checkFolder, checkPrefix, continueText, ruleOfFolder, ruleOfPrefix } from '@zumibot/shared/allowRules'
import type { ModelSpends } from '@zumibot/shared/usageReport'
import { engineChatModel, isCommandModel, modelFits, turnModel } from '@zumibot/shared/chatModel'
import {
  DEFAULT_EFFORT,
  effortFits,
  engineChatEffort,
  engineChatMode,
  modeFits,
  runMode,
  type ChatMode,
  type Effort
} from '@zumibot/shared/chatRun'
import { turnOutcome } from '@zumibot/shared/turnReply'
import type { RunCost } from '../usage/runCost'
import type { FileChange } from '@zumibot/shared/files'
import { FileTracker } from '../files/fileChanges'
import type { SnapshotStore } from '../files/snapshotStore'
import { CleanPoint } from '../btw/cleanPoint'
import type { TodoService } from '../todos/todoService'
import type { TodoOwner, TodoTurn } from '../todos/todoIpc'
import type { DispatchService } from '../dispatch/dispatchService'
import type { DispatchRecorder } from '../dispatch/dispatchRecorder'
import { TODO_SYSTEM, todoLabel, withTrailingText } from '../todos/todoPrompt'
import { TASK_QUESTIONS_DENIED } from '../todos/taskPrompt'
import type { VaultOwner, VaultTurn } from '../vault/vaultIpc'
import type { VaultApprovals } from '../vault/vaultApprovals'
import { FILL_TOOL, isFillField, type VaultApprovalRequest } from '@zumibot/shared/vault'
import { VAULT_SYSTEM } from '../vault/vaultPrompt'
import { vaultRowResult } from '../vault/vaultTools'
import { DeltaScrubber, scrubEvent, scrubText, scrubValue } from '../vault/scrub'
import { isAskTool } from '@zumibot/shared/agentAsk'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import type { AskOwner, AskTurn } from '../asks/askIpc'
import { automationTool, confirmOnly, WRITE_REFUSED } from '@zumibot/shared/automations'
import type { StepRule } from '@zumibot/shared/workflows'
import { stepRuleFits, stepRuleRefused, withStepRule } from '@zumibot/shared/stepRules'
import { stepRuleOf, stepRulesAllow } from '../workflows/stepRules'
import type { AutomationTurn } from '../automations/automationIpc'
import type { AutomationOwner } from '../automations/automationService'
import type { ProcessOwner, ProcessTurn } from '../processes/processIpc'
import { PROCESS_SYSTEM } from '../processes/processPrompt'
import { PROCESS_START_TOOL, PROCESS_TOOL_PREFIX } from '../processes/processTools'
import { PROCESS_REFUSALS } from '@zumibot/shared/processes'
import { askedSystem, askSystem, QUESTIONS_DENIED } from '../asks/askPrompt'
import { workflowSystem } from '../workflows/workflowPrompt'
import type { AskedOutcome } from '../asks/askService'
import { minusBaseline, type CostBaseline } from '../usage/costBaseline'
import type { ChatTmp } from './chatTmp'
import { PAUSE_BLOCK_CAP, PAUSE_MARKER, lostNote } from '@zumibot/shared/pause'
import { CONNECTORS_ALL_OFF, NO_RUN_CONFIG, type AgentRunConfig } from '../extensions/agentRunConfig'
import { connectorCallOf, isReadTool, offRefusal, unattendedRefusal, type ConnectorId } from '@zumibot/shared/connectors'
import { CAP_FLAG, capPausedText } from '@zumibot/shared/spendCaps'
import type { AuditSource } from '../audit/auditService'
import type { AuditTap } from '../audit/auditTap'
import type { AuditRunKind } from '@zumibot/shared/audit'
import { hostAllowed, WEBFETCH_BLOCKED, type IsolationLevel } from '@zumibot/shared/isolation'
import { addDirsOf, type ContainerPlan, type RunIsolation, type RunPlace } from '../isolation/isolationService'
import { withNetBlocks, type ContainerRun } from '../isolation/containerRunner'

/** The notice a landed pause adds: the cap's words when a spend cap asked it, else the user's own Paused. */
export const pausedText = (meta: Pick<ChatMeta, 'pauseCap'>): string =>
  meta.pauseCap ? capPausedText(meta.pauseCap) : NOTICE_TEXT.userPaused

export interface RunCostEvent {
  id: string
  chatId: string
  agent: string
  sessionId: string | null
  window: [number, number]
  cost: RunCost
}

/**
 * One request's price growth while a turn runs (spend caps): `attempt` keys the CLI attempt, so its exact cost replaces it.
 * message: the user message the turn answers (the newest at its start), so a routine run or a workflow step counts only its
 * own turns, never the user's in the same chat.
 */
export interface LiveSpend {
  chatId: string
  agent: string
  attempt: string
  usd: number
  message: string | null
}

export interface SideBase {
  bin: string
  cwd: string
  // The chat's effort rides along (another may write the cache again); the mode stays the server's, under the side run's own guard.
  args: {
    agentName: string
    model?: string
    effort?: Effort
    permissionMode: PermissionMode
    disallowedTools: string[]
    extraArgs: string[]
    appendSystemPrompt: string
    thinking?: boolean
  }
  browser: boolean
  desktop?: boolean // absent: the agent's runs had no desktop part (not even the unavailable prompt)
  asks: boolean // the run had the ask bridge, so a side run joins one too (sideBrowser)
  processes?: true // the run had the process bridge, so a side run joins one too, for the same tool definitions
  tmpDir: string | null // the main run's CLAUDE_CODE_TMPDIR: a side run must share it, or its tools would see other files
  active: boolean // retained spawn settings outlive the turn
  scrub?: ReadonlyMap<string, string> // the base agent's API key values and their labels: a side run's events and error pass through it
  // The agent's own servers' Vault values (`ZUMIBOT_MCP_VAULT_<n>`), which its --mcp-config in `args` names: the side run starts
  // the same servers. Granted API keys' values, so `scrub` already covers them. A Codex base has none.
  env?: Record<string, string>
  // With `env`: how many entries at the end of `args.disallowedTools` and `args.extraArgs` are the agent's own parts, which
  // refreshSideBase replaces when a value in `env` went stale.
  ownParts?: { disallowedTools: number; extraArgs: number }
  live: { session: string; at: string } | null
  start: { session: string; at: string } | null
  /**
   * A Codex agent's base: its side run forks this thread on Codex. Its point lives here alone (`live` and `start` stay null), so no
   * Claude fork ever reads a Codex thread id. `at` is the last completed turn (null: none yet, so the side run seeds a new thread).
   * `baseInstructions` leaves out the browser prompt, which the side turn brings, as `args.appendSystemPrompt` does.
   */
  codex?: { threadId: string; at: string | null; baseInstructions: string; model?: string }
}

/** A side run's bridges as one turn. `servers` keeps each bridge turn's own spec, which a Codex side run configures. */
export type SideTurn = BrowserTurn & { servers?: McpServerSpec[] }

export interface ChatServiceDeps {
  store: ChatStore
  files: ChatFiles
  locate(): Promise<string | null>
  run(o: RunOptions): RunHandle
  push(p: ChatPush): void
  now(): number
  newId(): string
  permissionMode: PermissionMode
  disallowedToolsFor(agentName: string): string[]
  // Read on every turn, so turning it on or off applies from each chat's next message.
  houseStyle?(): Promise<boolean>
  // Awaited before any spawn in the chat's folder: an archived chat's worktree may have been removed. A string is a notice for the
  // turn (the branch was made again); a throw is the turn's error text.
  ensureFolder?(chatId: string): Promise<string | null>
  // Whether this claude takes --thinking-display, asked per attempt (cached per binary); absent: never passed.
  thinkingDisplay?(bin: string): Promise<boolean>
  // Whether a cut may declare the turn it discards on this binary (--resume-drops-turn, `dropsTurnProbe.ts`), asked per attempt
  // like thinkingDisplay. Absent, or false: the cut goes unvalidated, exactly as it did before the flag existed.
  dropsTurn?(bin: string): Promise<boolean>
  // A Codex agent's skill by name in a folder (with its SKILL.md path), for the turn that runs a skill command; null = it is gone.
  codexSkill?(folder: string, agent: string, name: string): Promise<CodexSkillRef | null>
  browserTurns?: {
    profileId(agent: string, chatId: string): Promise<string | null>
    create(owner: BrowserOwner, onHandoff: (handoff: BrowserHandoff) => Promise<void>): Promise<BrowserTurn>
  }
  // Computer use, opt-in per agent: planned once per logical turn, a fresh desktop turn (capability) per CLI attempt.
  desktopTurns?: {
    plan(agent: string, chatId: string): Promise<DesktopPlan>
    create(owner: DesktopOwner, onHandoff: (handoff: DesktopHandoff) => Promise<void>, o?: { side?: boolean }): Promise<DesktopTurn>
  }
  // "Allow always for this agent": read on every permission request, so a rule added in one chat applies in all.
  // addCli is awaited: the user's Allow must be stored before the continue message goes out; add is fire-and-forget for cards.
  agentRules?: {
    has(agent: string, key: string): boolean
    add(agent: string, rule: AgentRule): void
    cli(agent: string): string[]
    addCli(agent: string, rule: string): Promise<void>
  }
  // "Allow for this workflow step" on a Room step's room: the rule to keep on the room's meta. A throw never reaches the turn.
  onStepRule?(chatId: string, rule: StepRule): void
  // The one "run ended" signal for single turns and group rooms: both release their claim here.
  onIdle?(chatId: string): void
  // Usage hooks: a failure in them never reaches the turn.
  onRunCost?(e: RunCostEvent): void
  // A resumed run's result totals include the session's earlier runs; this reads them, so only the run's own cost is reported.
  costBaseline?: CostBaseline
  // The agent's `autoCompactWindow`: the CLI applies the frontmatter key to subagents only, so the run gets it as env.
  compactWindow?(agent: string): Promise<number | null>
  // The line every agent's turn opens with (acknowledge.ts), else null: failed or too slow.
  // Not awaited by the turn, and dropped once the turn ends: after the reply it would say nothing.
  acknowledge?(o: { chatId: string; agent: string; user: UserItem; todos: boolean; signal: AbortSignal }): Promise<string | null>
  // The agent's own servers, plugins, skills and hooks (its file's extension keys), read per attempt like compactWindow, for every
  // Claude run of it: main, room member, Compact, and through the side base its side runs. Never a Codex agent's.
  agentRunConfig?(agent: string): Promise<AgentRunConfig>
  // Whether a connector's Remember switch is on, read per request and per answer: remembered approvals reach its writes only while it is. Absent: off.
  connectorRemembers?(id: ConnectorId): boolean
  // Every saved context of a request (a real one, never a side run's): keep warm times its pings from it.
  onContext?(chatId: string, agent: string, c: ContextUse): void
  // The chat's own CLI temp folder (CLAUDE_CODE_TMPDIR), so an agent's working files outlive a reboot. Env only: no prompt changes.
  tmp?: Pick<ChatTmp, 'ensure' | 'pauseFlagOf'>
  // The pause hook's --settings (pauseSettings.ts), added to every main run with the chat's flag path in env. Needs `tmp`, which
  // holds the flag. Absent: runs are as before, and a Pause is refused (canPause), since nothing would stop new tool calls.
  pauseHook?: { settings: string }
  // The vault guard's --settings (vaultGuard.ts): deny rules and a Bash hook keeping agents off the vault's files. Added to every
  // main run next to the pause hook; side runs and Compact keep their settings. Settings never enter the prompt, so the cache prefix holds.
  vaultGuard?: string
  // The audit log (core/audit/): every tool call of every run but a Compact gets a record, with the branch that decided it.
  audit?: AuditSource
  // Agent isolation (core/isolation/): a sandboxed agent's runs get the sandbox's --settings, or are refused where it cannot run.
  // Absent, or an agent set Off: the run is exactly as before.
  isolation?: { levelOf(agent: string): IsolationLevel; runFor(agent: string, place: RunPlace): Promise<RunIsolation> }
  // The same guard for Codex (codexHooks.ts): hooks on every Codex main run, never a Compact, while the vaultKeys cap is on. The
  // agent's API keys reach a Codex run only beside them; absent or empty, Codex runs get no keys (fail closed).
  codexVaultHooks?: CodexHook[]
  // The pause hook for Codex, from the same entry as `pauseHook` (app.ts builds both or neither): on every Codex main run while
  // the pause cap is on, trusted and checked with the vault's hooks. Absent, a Codex chat's Pause is refused (canPause).
  codexPauseHook?: CodexHook
  // The agent file's `model:` as written (null = inherit): a command's model is weighed against it (chatModel.ts).
  agentModel?(agent: string): Promise<string | null>
  onRunWithoutCost?(chatId: string, sessionId: string | null, agent: string): void // the attempt ended with no cost-bearing result
  // Spend caps: each request's price growth as it streams, and the attempt's end, which drops its estimate (its exact cost, if any,
  // went to onRunCost before). A throw in either never reaches the turn.
  spend?: { live(e: LiveSpend): void; ended(attempt: string): void }
  // Jev's guess of a pending call's risk, shown on its card. Only a hint: nothing answers a request on it.
  approvalRisk?(
    chatId: string,
    r: { toolName: string; input: unknown; description: string | null; reason: string | null }
  ): Promise<ApprovalRisk | null>
  // Once per agent turn, after its items are saved. Never for Compact. A throw in it never reaches the turn.
  onTurnEnd?(e: TurnEnd): void
  // Agent memory. begin runs once per turn (never for Compact) with the name the CLI is spawned with; end runs once after
  // the items are saved, even when the turn throws. A throw in either never reaches the turn.
  memory?: {
    begin(agent: string): Promise<{ dir: string; note: string } | null>
    end(agent: string, touched: boolean): void
  }
  // Whole-file copies of what Edit/Write changed, with the fstat-checked read that finds a subagent's edited file. Both, or nothing is tracked.
  snapshots?: Pick<SnapshotStore, 'put' | 'read'>
  readFile?(path: string): Promise<Buffer>
  // The chat's to-do list (state note, the reply's touch, seen marks) and the per-attempt MCP bridge the agent changes it through.
  // Bookkeeping only, like memory: a throw in any of them never reaches the turn.
  todos?: Pick<TodoService, 'note' | 'markSeen' | 'touch' | 'settle' | 'endTurn'>
  /** Records what the subagents a turn dispatches do, for the Dispatched agents panel. */
  dispatch?: Pick<DispatchService, 'begin' | 'finish'>
  todoTurns?: { create(owner: TodoOwner): TodoTurn }
  // On every run of every agent, whatever it is granted, so the tool definitions and the prompt prefix never depend on the vault.
  vaultTurns?: { create(owner: VaultOwner): VaultTurn }
  // A card's first-use approval: each attempt registers the callback that turns its requests into chat cards (same id as the browser turn's).
  vaultApprovals?: Pick<VaultApprovals, 'registerTurn'>
  // The agent's API keys as env vars (main runs only, read per attempt) and what each value is scrubbed to in everything a run stores or shows.
  vaultEnv?(agent: string): { env: Record<string, string>; scrub: Map<string, string> }
  // A browser_fill_from_vault row names its item: the name of the item with that id, only when it is granted to the agent.
  vaultItemName?(id: string, agent: string): string | null
  // Agent asks, for single chats only (never a room member or Zumi Bot): the per-attempt `ask` bridge and the agents
  // the system prompt lists. askEnd forgets a turn's ask counts once it is over; a throw in it never reaches the turn.
  askTurns?: { create(owner: AskOwner): AskTurn }
  askRoster?(agent: string): Promise<{ name: string; description: string }[]>
  askEnd?(turn: string): void
  // Zumi Bot's routine and workflow tools: on every main run of Zumi Bot's (never another agent's or a Compact) and
  // its side runs. `side` leaves out the delete ask rules, since a side run keeps its settings byte for byte.
  automationTurns?: { create(owner: AutomationOwner, o?: { side?: true }): AutomationTurn }
  // Background processes: on every main run of an agent whose engine has the `processes` cap (never Compact), and its side runs,
  // whose bridge refuses every call. `start` gets the card through the bridge's ask rule; the rest are this chat's own.
  processTurns?: { create(owner: ProcessOwner): ProcessTurn }
  // The agent's engine, read per turn, so a provider change applies from each chat's next message. Absent: every agent is Claude's.
  engineOf?(agent: string): Promise<Engine>
  // What each engine can do (default engineCaps). Rewinds, Compact, side questions, the Files panel and question cards read it, so
  // a flag a later probe turns off brings back that feature's Phase 1 behaviour; a test forces one off through it.
  caps?(engine: Engine): EngineCaps
  /**
   * A second Claude adapter in place of the CLI runner (the `ZUMIBOT_CLAUDE_SDK` dev hook: the Claude Agent SDK, see
   * docs/architecture/engines.md). Built with this service's own `caps` and `locate`, so only how a turn is spawned differs.
   * Absent: every Claude turn goes through `run` above, as it always has.
   */
  claudeEngine?(d: { caps(): EngineCaps; locate(): Promise<string | null> }): EngineAdapter<ClaudeTurnConfig>
  // Codex agents' runs (one `codex app-server` per attempt). definitionOf is the agent file's body and model, read per attempt.
  codex?: {
    locate(): Promise<string | null>
    run(o: CodexRunOptions): RunHandle
    definitionOf(agent: string): Promise<{ body: string; model: string | null } | null>
  }
  // ACP agents' runs (one agent process per attempt, see docs/architecture/protocol-engines.md). Each attempt reads the agent
  // file's provider, body and launch (`acp:`, null when absent or unreadable), runs it only when the file is still an ACP agent
  // and `trust` says it is the launch confirmed in Agent Studio on this machine, and spawns the command `locate` finds on the run
  // env's PATH. Absent: an ACP agent never runs.
  acp?: {
    definitionOf(agent: string): Promise<{ provider: Provider | null; body: string; launch: AcpLaunch | null } | null>
    trust(agent: string, launch: AcpLaunch): LaunchCheck
    locate(command: string): Promise<string | null>
    run(o: AcpRunOptions): RunHandle
  }
  // Remote (AG-UI) agents' runs (one HTTPS request per run, see docs/architecture/protocol-engines.md). Each attempt reads the
  // agent file's provider and launch (`agui:`, null when absent or unreadable) and runs it only when the file is still a remote
  // agent and `trust` says it is the launch confirmed in Agent Studio on this machine. `allowLocal` is the dev hook (devEnv),
  // never on in production. `thread` keeps `chats/<id>.agui.json`. Absent: a remote agent never runs.
  agui?: {
    definitionOf(agent: string): Promise<{ provider: Provider | null; launch: AguiLaunch | null } | null>
    trust(agent: string, launch: AguiLaunch): LaunchCheck
    allowLocal: boolean
    run(o: AguiRunOptions): RunHandle
    thread: { load(chatId: string): Promise<AguiThread | null>; save(chatId: string, t: AguiThread): Promise<void> }
  }
}

/** Shown when a cut run's `init` reports the session it resumed: the CLI ignored --fork-session. A Codex run says CODEX_REFUSALS.forkIgnored. */
export const FORK_IGNORED = (version: string | undefined): string =>
  `Claude Code${version ? ` ${version}` : ''} ignored --fork-session, so this reply was stopped before it could change an earlier version's memory. Edit, Resend, Fork and switching versions need an update for this Claude Code version.`

export const NOTHING_TO_COMPACT = 'Nothing to compact yet: the agent has no session.'
/** A pick by hand naming a model the chat's engine does not run (a Claude name for Codex, or the other way round). */
export const MODEL_REFUSED = "That model is not one this chat's agent can run"
/** A mode the chat's engine has no form of (Plan or Accept edits on Codex). */
export const MODE_REFUSED = "That mode is not one this chat's agent can run"
/** Allow on a row Auto mode did not refuse (or that is not Bash, or sits in a chat no person reads). */
export const NOT_ALLOWABLE = 'This call was not refused by Auto mode, so a rule cannot help'
/** Allow while a reply runs: it would race the running turn's own item list. */
export const CHAT_BUSY = 'Wait for the reply to finish'
export const ALREADY_ALLOWED = 'This call was already allowed'
const ALLOW_COUNT = 'Pick between 1 and 10 commands or folders to allow'
const MAX_ALLOW = 10
/** An effort for a Codex chat, which has none (chatRun.ts). */
export const EFFORT_REFUSED = "This chat's agent has no effort setting"

// The browser surface also covers the to-do, vault, ask and automation bridges: a side run's `browser` env is the merged env of
// all five (sideBrowser), and the main run gives those values the same label.
const PRIVATE_ENV = {
  browser: [
    'ZUMIBOT_BROWSER_CAPABILITY',
    'ZUMIBOT_BROWSER_IPC',
    'ZUMIBOT_TODOS_CAPABILITY',
    'ZUMIBOT_TODOS_IPC',
    'ZUMIBOT_VAULT_CAPABILITY',
    'ZUMIBOT_VAULT_IPC',
    'ZUMIBOT_ASKS_CAPABILITY',
    'ZUMIBOT_ASKS_IPC',
    'ZUMIBOT_AUTOMATIONS_CAPABILITY',
    'ZUMIBOT_AUTOMATIONS_IPC'
  ],
  desktop: ['ZUMIBOT_DESKTOP_CAPABILITY', 'ZUMIBOT_DESKTOP_IPC']
} as const
/** Notes a turn's capability and IPC path, which no error text a run stores (a chat item, a side answer) may carry. */
/** A contained run's own --settings: fetches reach ZumiBot (the network list), WebSearch off unless allowed, Bash per the choice. */
export function containerRunSettings(iso: { autoBash: boolean; webSearch?: boolean }): Record<string, unknown> {
  return {
    permissions: { ask: ['WebFetch'], ...(iso.webSearch ? {} : { deny: ['WebSearch'] }), ...(iso.autoBash ? { allow: ['Bash'] } : {}) }
  }
}

const stringEnv = (env: NodeJS.ProcessEnv | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(env ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'))

export function notePrivateValues(values: Map<string, string>, surface: 'browser' | 'desktop', env: NodeJS.ProcessEnv): void {
  for (const key of PRIVATE_ENV[surface]) {
    const value = env[key]
    if (value) values.set(value, `[private ${surface} value]`)
  }
}
export function redactPrivate(text: string, values: ReadonlyMap<string, string>): string {
  return scrubText(text, values)
}

/** The CLI's own command; the note says what the summary must keep, on one line. */
export function compactPrompt(note: string): string {
  const keep = note.replace(/\s+/g, ' ').trim()
  return keep === '' ? '/compact' : `/compact ${keep}`
}

/** The window of the model that spoke; the only one reported when the model is unknown. */
function windowOf(windows: Record<string, number>, model: string | null): number | undefined {
  const all = Object.entries(windows)
  if (model !== null) return (all.find(([k]) => k === model) ?? all.find(([k]) => k.startsWith(model)))?.[1]
  return all.length === 1 ? all[0][1] : undefined
}

const CLI_NOT_FOUND = 'Claude CLI not found. Set its path in the banner at the top of the window.'
// Each engine's own fixed sentences, so a new engine must write its own rather than inherit Claude's. The ACP sentence names the
// agent's own command, since every ACP agent has one.
function notFoundText(engine: Engine, command: string): string {
  switch (engine) {
    case 'claude':
      return CLI_NOT_FOUND
    case 'codex':
      return CODEX_REFUSALS.notFound
    case 'acp':
      return ACP_TEXT.notFound(command)
    // Nothing to install for a remote agent: what it lacks is an endpoint to call.
    case 'ag-ui':
      return AGUI_TEXT.noEndpoint
    default:
      return assertNever(engine)
  }
}
// ACP's and AG-UI's are never reached: without `rewind` a cut point reseeds instead (agentTurn), so neither runs a cut run.
export const FORK_IGNORED_TEXT: Record<Engine, (version: string | undefined) => string> = {
  claude: FORK_IGNORED,
  codex: CODEX_REFUSALS.forkIgnored,
  acp: () => ACP_TEXT.forkIgnored,
  'ag-ui': () => AGUI_TEXT.forkIgnored
}
/**
 * Whether a planned reseed (Edit, Resend, Fork, a version switch, a `seed` next) is news the chat tells (`expired`). A remote
 * agent's every run sends the whole visible history, so its new thread keeps every message the chat shows. What it drops is the
 * server's own: the new thread starts with state `{}` and nothing open (Rulings 3), so a server that kept state or history per
 * thread starts over, which the chat cannot show either way. A Record, so a new engine decides.
 */
const RESEED_IS_NEWS: Record<Engine, boolean> = { claude: true, codex: true, acp: true, 'ag-ui': false }
/** A side base is Claude's or Codex's by its shape: only those two engines keep one. */
const baseEngine = (base: { codex?: unknown }): Engine => (base.codex !== undefined ? 'codex' : 'claude')
const browserTool = (name: string) => name.startsWith('mcp__zumibot_browser__')
// Unlike browser calls, a desktop call is shown as it is (a click is meaningless to approve unseen); only its result,
// which may hold a screenshot, is replaced.
const desktopTool = (name: string) => name.startsWith('mcp__zumibot_desktop__')
/** How a dispatched subagent's tool is stored: browser, desktop and vault_items calls the way chat items store them. */
export const privateToolOf = (name: string): 'browser' | 'desktop' | 'vault' | null =>
  browserTool(name) ? 'browser' : desktopTool(name) ? 'desktop' : name === VAULT_ITEMS_TOOL ? 'vault' : null
const noDesktopTurn = (): DesktopTurn => ({ args: [], mcp: NO_MCP, env: {}, prompt: desktopUnavailablePrompt, dispose: async () => {} })
// The risk hint goes to an outside service: typed text (passwords slip in) leaves as its length only. The card shows it all.
function riskInput(toolName: string, input: unknown): unknown {
  if (toolName !== 'mcp__zumibot_desktop__desktop_type' || typeof input !== 'object' || input === null || !('text' in input)) return input
  const { text } = input as { text: unknown }
  return { ...input, text: typeof text === 'string' ? `<${[...text].length} chars>` : '<text>' }
}
// A fill row tells the user why it failed when the reason is theirs to act on; any other failure keeps the fixed line.
const FILL_REASONS: Record<string, string> = {
  wrong_site: 'wrong site',
  denied: 'denied',
  not_allowed: 'not allowed',
  insecure_site: 'insecure site',
  wrong_field_type: 'wrong field type'
}
function fillResultLine(content: string, isError: boolean): string {
  if (!isError) return 'Browser command completed.'
  let code: unknown
  try {
    code = (JSON.parse(content) as { code?: unknown } | null)?.code
  } catch {
    /* Not the bridge's JSON: the fixed line. */
  }
  return typeof code === 'string' && Object.hasOwn(FILL_REASONS, code)
    ? `Browser command failed: ${FILL_REASONS[code]}.`
    : 'Browser command failed.'
}
const todoTool = (name: string) => name.startsWith('mcp__zumibot_todos__')
const vaultTool = (name: string) => name.startsWith('mcp__zumibot_vault__')
const VAULT_ITEMS_TOOL = 'mcp__zumibot_vault__vault_items'
const noBrowserTurn = (): BrowserTurn => ({
  args: ['--no-chrome'],
  mcp: NO_MCP,
  env: {},
  prompt:
    'The agent browser is unavailable. Continue text work; do not open a system browser or use another browser service as a fallback.',
  dispose: async () => {}
})
// A Codex thread's servers come from each bridge turn's own spec. NO_MCP (no bridge of its own) has no command, and a dot in a
// name would split Codex's dotted `mcp_servers.<name>` config key.
export const codexServers = (specs: (McpServerSpec | undefined)[]): McpServerSpec[] =>
  specs.filter((s): s is McpServerSpec => s !== undefined && s.name !== '' && s.command !== '' && !s.name.includes('.'))
// A running Codex turn's side point: the turn it started from, the last completed one, since Codex names a turn only as it ends.
const codexPoint = (p: { session: string; at: string } | null): { threadId: string; at: string | null } =>
  p ? { threadId: p.session, at: p.at } : { threadId: '', at: null }

/** One CLI turn in progress: its process and the approvals waiting on it. */
export interface TurnSlot {
  readonly agent: string | null // the turn's author, read each time so a rename mid-turn follows
  handle: RunHandle | null
  // Approval requests waiting for the user, by CLI request id; the turn installs `answer`.
  // shown: the input with vault values scrubbed, the copy a stored rule or a risk hint may hold; the raw input is what the CLI is answered with.
  // onceOnly: asked every time with Allow once and Deny only (an ACP call no rule may hold), so any allow is kept as Allow once.
  pending: Map<string, { toolName: string; input: unknown; shown?: unknown; onceOnly?: true; connector?: ConnectorId }>
  // Pending browser and desktop handoff cards: both count as waiting, like a pending approval.
  browserPending: Set<string>
  // Pending vault approval cards: they count as waiting too, like a pending approval.
  vaultPending: Set<string>
  disposeBrowser: (() => Promise<void>) | null
  disposeDesktop: (() => Promise<void>) | null
  answer: ((requestId: string, decision: ApprovalDecision) => void) | null
  // A question card's own reply path: null = Skip. Distinct from `answer` because a question needs answers, not a decision.
  answerQuestions: ((requestId: string, answers: QuestionAnswers | null) => void) | null
  // A plan card's own reply path: approve, or send it back (Keep planning) with optional feedback.
  answerPlan: ((requestId: string, approve: boolean, feedback: string | null) => void) | null
  // Called by stop() before the CLI is told to stop, so the turn can note what was running at that moment.
  onStop?: () => void
}

export interface Running {
  reason: 'stopped' | 'interrupted' | null
  done: Promise<void>
  // One per CLI turn in progress; a single chat has at most one. Stop reaches all of them.
  slots: Set<TurnSlot>
  // Called by stop(), so a caller can abort work that is not a CLI run.
  onStop: (() => void) | null
}

const pendingOf = (r: Running) => [...r.slots].reduce((sum, s) => sum + s.pending.size + s.browserPending.size + s.vaultPending.size, 0)

/** The chat's item list, shared by every writer of the chat while it runs. */
export interface ItemsRef {
  get(): ChatItem[]
  set(items: ChatItem[]): void
}

/** One agent's turn: what to run and how to record it. */
export interface TurnSpec {
  agentName: string
  model?: string // passed as --model; absent = the agent file's own
  permissionMode?: ChatMode // the chat's own mode, one its engine runs (engineChatMode); absent = the server's
  effort?: Effort // passed as --effort, to Claude only (engineChatEffort); absent = Medium
  sessionId: string | null
  prompt: UserContent // stdin for the CLI
  seedPrompt(history: ChatItem[]): UserContent // stdin when the session expired; history is the item list the turn started with
  extraArgs: string[]
  systemPrompt?: string // appended to the agent's own system prompt
  disallowedTools: string[]
  author?: string // stamped as `agent` on assistant, tool and approval items, and on live pushes; read as each is added
  /**
   * Stamped as `turn` on every item the turn adds. Required for turns that share a claim (group members working side
   * by side): two CLIs can reuse an approval request id, and the guard that keeps a turn to its own cards (`ownCard`)
   * tells them apart by this id.
   */
  turnId?: string
  allowScope: string // key for "Allow for this chat" memory
  saveSession(id: string | null): Promise<void>
  resumeAt?: string // resume `sessionId` only up to this entry, into a new session (a cut run); never a plain resume if it fails
  // With resumeAt: the prompt uuid of the turn the cut discards, so the CLI refuses a cut that would discard anything else.
  // Passed only on a binary that takes the flag (`dropsTurn`); without it the cut runs unvalidated, as every cut did before.
  resumeDrops?: string
  reseed?: boolean // skip the resume: start a fresh session from the history, with the expired notice
  freshStart?: boolean // the reseed is a routine's fresh start, so its notice says that instead of "expired"
  onAnswered?(): void // called when the user answers (not Skips) a question card of this turn, or decides a plan card
  window?: number | null // the context window an earlier turn reported, shown until this turn's result reports it
  saveContext?(c: ContextUse): Promise<unknown>
  setCompacting?(on: boolean): Promise<unknown>
  compact?: boolean // a /compact run: a session that is gone is an error, never a reseed (there is nothing to compact)
  todoAsked?: boolean // the turn answers a /todo message (or a command that makes to-dos): its note lists the open items
  askChain?: string[] // agents waiting above this turn, outermost first; absent = none
  questionsDenied?: string // an asked turn: AskUserQuestion is denied with this, so the question goes back to the asker
  auto?: true // the turn answers a message the user did not type (a routine's or workflow's), not an edit or resend
  asked?: true // the chat is an A→B ask chat: its turn end says so
  workflow?: true // the chat is a workflow Agent step's: its turn end says so, and the run reports for itself
  lost?: string[] // what the subagents a stop killed in this agent's last turn were doing: told once, by a plain resume
  saveLost?(descriptions: string[] | null): Promise<unknown> // stores what this turn's stop killed; null clears it
  engine?: Engine // absent = Claude; 'codex' runs the turn on codex app-server, with what Codex cannot do left out
  skills?: CodexSkillRef[] // Codex only: the skills the message runs, sent as skill items beside its prompt
}

/** text is this turn's assistant text, joined with blank lines. */
/** end: where the session stands after the turn (its last entry), null when the CLI never reported both. */
export interface TurnResult {
  text: string
  ok: boolean
  stopped: boolean
  end: SessionCut | null
  /** The prompt's own entry in the session this turn ran on, for the caller to keep on the message it answered (`sent`). */
  sent?: SessionCut
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Runs one finish step even if an earlier one failed. A chat deleted mid-turn is not an error.
async function finishStep(errors: unknown[], fn: () => Promise<unknown> | void): Promise<void> {
  try {
    await fn()
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('Chat not found'))) errors.push(err)
  }
}

export class ChatService {
  private running = new Map<string, Running>()
  private liveTurns = new Set<{ spec: TurnSpec; ref: ItemsRef }>()
  private sideBases = new Map<string, SideBase>()
  // "Allow for this chat" memory: in memory only, per allow scope (a chat id, or `${chatId}:${agent}`).
  private allowed = new Map<string, Set<string>>()
  // A workflow room's pre-allowed tool calls (a Room step's rules), set by GroupService from the meta at each member turn
  // and grown by "Allow for this workflow step". Only a chat in this map takes that answer, so a plain room never does.
  private workflowRules = new Map<string, StepRule[]>()
  // Each running A→B chat and the chat that asked it: B's cards count, and are answered, up there; a stop there reaches B.
  private askParents = new Map<string, string>()
  // Chats whose pause flag this server set: only there does a blocked call count toward the cap, so a tool error that
  // merely quotes the block text never ends a run.
  private pauseFlags = new Set<string>()
  private spendSeq = 0 // numbers CLI attempts for their live spend keys
  // One engine behind one interface (core/engines/): each adapter is this service's own view of the deps above, so a turn names
  // a session kind and an action and lets the adapter spell its CLI's form. `caps` goes through this.caps, so a probe that
  // turns a flag off reaches the adapter too.
  private readonly claude: EngineAdapter<ClaudeTurnConfig>
  private readonly codex: CodexEngine | null
  private readonly acp: AcpEngine | null
  private readonly agui: AguiEngine | null

  constructor(private d: ChatServiceDeps) {
    const claudeBase = { caps: () => this.caps('claude'), locate: () => d.locate() }
    this.claude = d.claudeEngine ? d.claudeEngine(claudeBase) : claudeEngine({ ...claudeBase, run: (o) => d.run(o) })
    const codex = d.codex
    this.codex = codex
      ? codexEngine({
          caps: () => this.caps('codex'),
          locate: () => codex.locate(),
          run: (o) => codex.run(o),
          definitionOf: (agent) => codex.definitionOf(agent)
        })
      : null
    const acp = d.acp
    // `locate` answers only for a launch that would run: a turn locates the very launch it checked (acpLaunch), never a
    // file read again in between.
    this.acp = acp
      ? acpEngine({
          caps: () => this.caps('acp'),
          locate: async (agent) => {
            if (agent === undefined) return null
            const l = await this.acpLaunch(agent)
            return 'error' in l ? null : l.bin
          },
          run: (o) => acp.run(o)
        })
      : null
    const agui = d.agui
    // `locate` answers only for a launch that would run, as ACP's. The dev hook is this machine's own, so the adapter never
    // carries it: it is added to each request here.
    this.agui = agui
      ? aguiEngine({
          caps: () => this.caps('ag-ui'),
          locate: async (agent) => {
            if (agent === undefined) return null
            const l = await this.aguiLaunch(agent)
            return 'error' in l ? null : l.endpoint
          },
          run: (o) => agui.run({ ...o, allowLocal: agui.allowLocal })
        })
      : null
  }

  /**
   * A remote agent's launch for one attempt, read from its file: run only when it has an endpoint the URL check passes and it
   * is the launch confirmed in Agent Studio on this machine. Else the fixed sentence. The address checks run with each request.
   */
  private async aguiLaunch(agent: string): Promise<{ endpoint: string; launch: AguiLaunch } | { error: string }> {
    const agui = this.d.agui
    const def = agui ? await agui.definitionOf(agent).catch(() => null) : null
    if (!agui || !def?.launch) return { error: AGUI_TEXT.noEndpoint }
    const url = checkUrl(def.launch.endpoint, agui.allowLocal)
    if ('error' in url) return { error: url.error }
    // A file no longer a remote agent (edited outside Agent Studio after this turn read its engine) calls no confirmed endpoint.
    if (def.provider !== 'ag-ui' || agui.trust(agent, def.launch) !== 'ok') return { error: AGUI_TEXT.untrusted }
    return { endpoint: def.launch.endpoint, launch: def.launch }
  }

  /**
   * An ACP agent's launch for one attempt, read from its file: run only when it holds no refused argument and is the launch
   * confirmed in Agent Studio on this machine, and then the command found on the run env's PATH. Else the fixed sentence.
   */
  private async acpLaunch(agent: string): Promise<{ bin: string; launch: AcpLaunch; body: string } | { error: string }> {
    const acp = this.d.acp
    const def = acp ? await acp.definitionOf(agent).catch(() => null) : null
    if (!acp || !def?.launch) return { error: ACP_TEXT.noCommand }
    const flag = refusedArg(def.launch.args)
    if (flag !== null) return { error: ACP_TEXT.refusedArg(flag) }
    // A file no longer an ACP agent (edited outside Agent Studio after this turn read its engine) runs no confirmed launch.
    if (def.provider !== 'acp' || acp.trust(agent, def.launch) !== 'ok') return { error: ACP_TEXT.untrusted }
    const bin = await acp.locate(def.launch.command).catch(() => null)
    return bin ? { bin, launch: def.launch, body: def.body } : { error: notFoundText('acp', def.launch.command) }
  }

  private engineOf(agent: string): Promise<Engine> {
    return this.d.engineOf ? this.d.engineOf(agent) : Promise.resolve('claude')
  }

  private caps(engine: Engine): EngineCaps {
    return (this.d.caps ?? engineCaps)(engine)
  }

  /**
   * A Pause needs the temp folder that holds its flag and the hook each of the chat's agents runs with: Claude's --settings, or
   * Codex's while its pause cap is on. Without them it is refused, since nothing would block that agent's new tool calls.
   */
  async canPause(chatId: string): Promise<boolean> {
    if (!this.d.tmp) return false
    const meta = await this.d.store.get(chatId)
    // Read per agent, as each turn reads it: a room member whose agent moved to Codex needs Codex's hook too.
    const agents = meta ? (meta.group ? meta.group.members : [meta.agentName]) : []
    const engines = new Set<Engine>(await Promise.all(agents.map((a) => this.engineOf(a))))
    if (engines.size === 0) engines.add('claude')
    return [...engines].every((e) => this.pauseReady(e))
  }

  /** Whether a Pause can hold this engine's agent: Claude's hook rides in --settings, Codex's on its argv while its cap is on. */
  private pauseReady(engine: Engine): boolean {
    switch (engine) {
      case 'claude':
        return !!this.d.pauseHook
      case 'codex':
        return !!this.d.codexPauseHook && this.caps('codex').pause
      // No hook can block an ACP agent's call (`pause` off): calls it runs without asking never reach ZumiBot.
      case 'acp':
        return false
      // Nor a remote agent's: its tools run on its server.
      case 'ag-ui':
        return false
      default:
        return assertNever(engine)
    }
  }

  /** The flag the pause hook reads: while it exists, the agent's own new tool calls are blocked (its subagents' are not). */
  async setPauseFlag(chatId: string, on: boolean, cap = false): Promise<void> {
    if (on) this.pauseFlags.add(chatId)
    else this.pauseFlags.delete(chatId)
    const tmp = this.d.tmp
    if (!tmp) return
    const flag = tmp.pauseFlagOf(chatId)
    if (on) {
      await tmp.ensure(chatId)
      // Its content is only the hook's wording: a cap's pause tells the agent so, the user's says the user paused it.
      await fs.writeFile(flag, cap ? CAP_FLAG : '', { mode: 0o600 })
    } else await fs.rm(flag, { force: true })
  }

  /**
   * Lands a pause once the chat's run is over, however it ended (the wrap-up, the cap, a Stop, an error): the tray held,
   * the paused state, the Paused notice after whatever ended the turn, and no flag. Null when the chat was not pausing.
   * A single chat's turn calls it before release, whose onIdle would start the next task. A room lands its own pause at its
   * end (landPause); TaskQueue's pump calls this, under the chat's lock, for a Pause that came too late for the run's end.
   */
  async finishPause(chatId: string): Promise<ChatMeta | null> {
    const { store, push, newId, now } = this.d
    const meta = await this.landPause(chatId)
    if (!meta) return null
    const items: ChatItem[] = [
      ...(await store.loadItems(chatId)),
      { type: 'notice', id: newId(), kind: 'userPaused', text: pausedText(meta), ts: now() }
    ]
    await store.saveItems(chatId, items)
    push({ chatId, kind: 'items', items: [...items], clearStreaming: true })
    push({ chatId, kind: 'meta', meta })
    await this.setPauseFlag(chatId, false)
    return meta
  }

  /**
   * finishPause without the items, the pushes and the flag: the tray held, then `pausing` → `paused`. Null when the chat
   * was not pausing. A room keeps its own item list and saves it at its end, so it adds the Paused notice there itself.
   */
  async landPause(chatId: string): Promise<ChatMeta | null> {
    const { store } = this.d
    if ((await store.get(chatId))?.pause !== 'pausing') return null
    // Held first: that is what keeps a queued message from starting, even if a later step fails.
    await store.holdTasks(chatId)
    // Checked again in the write, so two ends never both land it (and add two notices).
    return store.patchInPlace(chatId, (cur) => (cur.pause === 'pausing' ? { pause: 'paused' } : null))
  }

  // In place: bookkeeping must not move the chat in the list.
  private saveLost(chatId: string, lost: string[] | null): Promise<unknown> {
    return this.d.store.patchInPlace(chatId, (cur) => (lost !== null ? { lost } : cur.lost === undefined ? null : { lost: undefined }))
  }

  // A flag left by a crash would block every call of a run nobody paused. A Pause pressed meanwhile puts it back.
  private async dropStaleFlag(chatId: string): Promise<void> {
    const pausing = async () => (await this.d.store.get(chatId))?.pause === 'pausing'
    if (await pausing()) return
    await this.setPauseFlag(chatId, false)
    if (await pausing()) await this.setPauseFlag(chatId, true)
  }

  // A single chat paused mid-reply ends paused, whatever ended the reply. Before release: its onIdle would start the next task.
  private async endSingle(chatId: string, r: Running): Promise<void> {
    try {
      await this.finishPause(chatId)
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('Chat not found'))) {
        // Only the code: an fs error names the data folder.
        const code = (err as { code?: unknown } | null)?.code
        console.error('pause not landed:', typeof code === 'string' ? code : 'error')
      }
    } finally {
      this.release(chatId, r)
    }
  }

  /** The agent's last spawn settings, with a clean point only while its turn runs. */
  sideBase(chatId: string, agent: string): SideBase | null {
    const base = this.sideBases.get(`${chatId}\n${agent}`)
    if (!base) return null
    const copy = structuredClone(base)
    // The retained map is from the agent's last main attempt: a grant added, rotated or revoked since must count now.
    const { scrub } = this.vaultKeys(agent)
    if (scrub.size > 0) copy.scrub = scrub
    else delete copy.scrub
    return copy
  }

  /**
   * A kept base fit for a side run now. Its own servers' Vault values are the agent's as of its last main attempt: one the grants
   * no longer hold (revoked, rotated, a vault that cannot be opened) would start a server with a value the agent lost, and
   * unscrubbed, so the agent's own parts are read again and replace only those parts and `env` (the point, folder, flags and scrub
   * stay). Otherwise the base is returned as kept: side runs share the main run's cache prefix until its next run, even after an
   * agent file change.
   */
  async refreshSideBase(agent: string, base: SideBase): Promise<SideBase> {
    const parts = base.ownParts
    if (!base.env || !parts || base.codex) return base
    const held = this.vaultKeys(agent).scrub
    if (Object.values(base.env).every((value) => held.has(value))) return base
    const own = await this.runConfigOf(agent)
    const { disallowedTools, extraArgs } = base.args
    const out: SideBase = {
      ...base,
      args: {
        ...base.args,
        disallowedTools: [...disallowedTools.slice(0, disallowedTools.length - parts.disallowedTools), ...own.disallowedTools],
        extraArgs: [...extraArgs.slice(0, extraArgs.length - parts.extraArgs), ...own.extraArgs]
      }
    }
    delete out.env
    delete out.ownParts
    if (Object.keys(own.env).length > 0)
      Object.assign(out, {
        env: { ...own.env },
        ownParts: { disallowedTools: own.disallowedTools.length, extraArgs: own.extraArgs.length }
      })
    return out
  }

  /**
   * Side runs own their browser capability and never add handoff cards. The to-do bridge joins it so the side run's
   * tools match the main run's (its prompt-cache prefix); the side run's deny hook keeps it from touching the list.
   */
  async sideBrowser(chatId: string, agent: string, side?: { chatId: string; entryId: string }, asks?: boolean): Promise<SideTurn | null> {
    let browser: BrowserTurn | null = null
    if (this.d.browserTurns) {
      const profileId = await this.d.browserTurns.profileId(agent, chatId)
      browser =
        profileId === null ? noBrowserTurn() : await this.d.browserTurns.create({ profileId, chatId, turnId: randomUUID() }, async () => {})
    }
    // After the browser, so a browser that fails to start leaves no to-do capability behind.
    const todo = this.todoTurn({ chatId, agent: () => agent, turn: randomUUID(), label: '' })
    // Same order as a main run's (browser, to-dos, vault, asks), so the tool definitions match.
    const vault = this.vaultTurn({ chatId, agent: () => agent, turn: randomUUID() })
    // Only when the main run had one, so the tools match; no chain, since the deny hook keeps the call from running.
    // `side` lets the one tool the deny hook lets through (a side ask) find the entry it answers; only SideQuestions passes it.
    // That entry can live in another chat than the session: an A→B chat's asker answers from the chat it asked from.
    const askTurnId = randomUUID()
    // `asks` is the caller's base: the prompt it built already says whether the tool exists. Without it, the live base decides.
    const ask =
      (asks ?? this.sideBases.get(`${chatId}\n${agent}`)?.asks)
        ? this.askTurn({ chatId, agent: () => agent, chain: [], turn: askTurnId, ...(side === undefined ? {} : { side }) })
        : null
    // Zumi Bot's routine and workflow tools, last as in its main run, so its side run's tools match. Never a writer, and
    // no delete ask rules: the side guard blocks every call anyway.
    const automation = agent === ZUMI_BOT_NAME ? this.automationTurn({ chatId, writable: false }, { side: true }) : null
    // Only when the main run had one (never Codex), after the automations as there; it refuses every call, as the guard does.
    const proc = this.sideBases.get(`${chatId}\n${agent}`)?.processes
      ? this.processTurn({ chatId, agent: () => agent, turn: randomUUID(), side: true })
      : null
    if (!todo && !vault && !ask && !automation && !proc) return browser
    return {
      args: [
        ...(browser?.args ?? []),
        ...(todo?.args ?? []),
        ...(vault?.args ?? []),
        ...(ask?.args ?? []),
        ...(automation?.args ?? []),
        ...(proc?.args ?? [])
      ],
      mcp: NO_MCP,
      env: { ...browser?.env, ...todo?.env, ...vault?.env, ...ask?.env, ...automation?.env, ...proc?.env },
      prompt: browser?.prompt ?? '',
      // The merged turn's `mcp` is no bridge; a Codex side run takes these, in the main run's order, with the env above.
      servers: [browser, todo, vault, ask, automation, proc].flatMap((t) => (t ? [t.mcp] : [])),
      dispose: async () => {
        proc?.dispose()
        automation?.dispose()
        if (ask) {
          ask.dispose()
          // Forget the ask counts of this side run; a throw never reaches the answer.
          try {
            this.d.askEnd?.(askTurnId)
          } catch {
            console.error('ask turn end failed')
          }
        }
        todo?.dispose()
        vault?.dispose()
        await browser?.dispose()
      }
    }
  }

  /** One attempt's to-do bridge, or null: an IPC that is gone (the server is stopping) only costs the run its list. */
  private todoTurn(owner: TodoOwner): TodoTurn | null {
    if (!this.d.todoTurns) return null
    try {
      return this.d.todoTurns.create(owner)
    } catch {
      console.error('to-do tools unavailable for this run')
      return null
    }
  }

  /** One attempt's process bridge, or null: an IPC that is gone (the server is stopping) only costs the run the tools. */
  private processTurn(owner: ProcessOwner): ProcessTurn | null {
    if (!this.d.processTurns) return null
    try {
      return this.d.processTurns.create(owner)
    } catch {
      console.error('process tools unavailable for this run')
      return null
    }
  }

  /** One attempt's vault bridge, or null: an IPC that is gone (the server is stopping) only costs the run the tool. */
  private vaultTurn(owner: VaultOwner): VaultTurn | null {
    if (!this.d.vaultTurns) return null
    try {
      return this.d.vaultTurns.create(owner)
    } catch {
      console.error('vault tool unavailable for this run')
      return null
    }
  }

  /** The agent's API keys and scrub map, read per attempt. A failing read costs the run its keys, never the run. */
  private vaultKeys(agent: string): { env: Record<string, string>; scrub: Map<string, string> } {
    if (!this.d.vaultEnv) return { env: {}, scrub: new Map() }
    try {
      return this.d.vaultEnv(agent)
    } catch {
      console.error('vault API keys unavailable for this run')
      return { env: {}, scrub: new Map() }
    }
  }

  /** The agent's extension parts for one attempt. A failing read costs the run those parts (and turns every connector off), never the run; logged by code only. */
  private async runConfigOf(agent: string): Promise<AgentRunConfig> {
    if (!this.d.agentRunConfig) return NO_RUN_CONFIG
    let own: AgentRunConfig
    try {
      own = await this.d.agentRunConfig(agent)
    } catch (err) {
      // Only the code: an fs error names the agents folder.
      const code = (err as { code?: unknown } | null)?.code
      console.error('agent run config not read:', typeof code === 'string' ? code : 'error')
      // Not open: without the read no connector may come alive, so every one is denied (Claude runs only: Codex never calls this).
      return CONNECTORS_ALL_OFF
    }
    // The agent file is never changed for it, so say which own server this run goes without: its name and why, never a value.
    if (own.dropped.length > 0)
      console.error('agent servers left out of this run:', own.dropped.map((d) => `${d.server} (${d.reason})`).join(', '))
    return own
  }

  /** One attempt's ask bridge, or null: an IPC that is gone (the server is stopping) only costs the run the tool. */
  private askTurn(owner: AskOwner): AskTurn | null {
    if (!this.d.askTurns) return null
    try {
      return this.d.askTurns.create(owner)
    } catch {
      console.error('ask tool unavailable for this run')
      return null
    }
  }

  /** One attempt's automation bridge, or null: an IPC that is gone (the server is stopping) only costs the run the tools. */
  private automationTurn(owner: AutomationOwner, o?: { side?: true }): AutomationTurn | null {
    if (!this.d.automationTurns) return null
    try {
      return this.d.automationTurns.create(owner, o)
    } catch {
      console.error('automation tools unavailable for this run')
      return null
    }
  }

  /** The ask paragraph and roster for the agent; '' when there is none, or when the agents cannot be read. */
  private async askRoster(agent: string): Promise<string> {
    try {
      return askSystem((await this.d.askRoster?.(agent)) ?? [])
    } catch (err) {
      // Only the code: an fs error names the agents folder.
      const code = (err as { code?: unknown } | null)?.code
      console.error('ask roster not added:', typeof code === 'string' ? code : 'error')
      return ''
    }
  }

  /** Like sideBrowser: its own capability, no handoff cards, and the same args a main run of this agent gets. */
  async sideDesktop(chatId: string, agent: string): Promise<DesktopTurn | null> {
    if (!this.d.desktopTurns) return null
    const plan = await this.d.desktopTurns.plan(agent, chatId)
    if (plan === 'off') return null
    if (plan === 'unavailable') return noDesktopTurn()
    return this.d.desktopTurns.create({ profileId: plan.profileId, chatId, turnId: randomUUID() }, async () => {}, { side: true })
  }

  renameAgent(from: string, to: string): void {
    for (const [key, base] of [...this.sideBases]) {
      if (!key.endsWith(`\n${from}`)) continue
      this.sideBases.delete(key)
      base.args.agentName = to
      this.sideBases.set(`${key.slice(0, key.lastIndexOf('\n'))}\n${to}`, base)
    }
    for (const { spec, ref } of this.liveTurns) {
      if (spec.agentName === from) spec.agentName = to
      ref.set(
        ref
          .get()
          .map((i) =>
            i.type === 'browser-action' && i.agent === from
              ? { ...i, agent: to, handoff: { ...i.handoff, agent: to } }
              : i.type === 'vault-approval' && i.agent === from
                ? { ...i, agent: to }
                : i
          )
      )
    }
  }

  isRunning(chatId: string): boolean {
    return this.running.has(chatId)
  }

  runningCount(): number {
    return this.running.size
  }

  stop(chatId: string, reason: 'stopped' | 'interrupted' = 'stopped'): void {
    // An agent this chat asked works for it: stopping the chat stops it too, down the chain.
    for (const [child, parent] of [...this.askParents]) if (parent === chatId) this.stop(child, reason)
    const r = this.running.get(chatId)
    if (!r) return
    if (r.reason !== 'interrupted') r.reason = reason
    for (const slot of r.slots) {
      slot.onStop?.()
      slot.handle?.stop()
      void slot.disposeBrowser?.().catch(() => {})
      void slot.disposeDesktop?.().catch(() => {})
    }
    r.onStop?.()
  }

  async stopAll(): Promise<void> {
    const runs = [...this.running.entries()]
    for (const [id] of runs) this.stop(id, 'interrupted')
    await Promise.all(runs.map(([, r]) => r.done.catch(() => {})))
  }

  /** `agent` picks the asking turn when two CLI processes reuse a request id. */
  answer(chatId: string, requestId: string, decision: ApprovalDecision, agent?: string): void {
    const r = this.running.get(chatId)
    if (!r) return
    const slot = [...r.slots].find((s) => s.pending.has(requestId) && (agent === undefined || s.agent === agent))
    slot?.answer?.(requestId, decision)
  }

  /**
   * Answers a question card. `answers` null = Skip. Throws TypeError (from checkAnswers) before anything is sent
   * when answers are invalid; does nothing when no matching pending card exists.
   */
  answerQuestions(chatId: string, requestId: string, answers: QuestionAnswers | null, agent?: string): void {
    const r = this.running.get(chatId)
    if (!r) return
    const slot = [...r.slots].find((s) => s.pending.has(requestId) && (agent === undefined || s.agent === agent))
    if (!slot) return
    // Mirrors slot.answer's own routing: a non-question pending request is this method's no-op, not its target.
    if (slot.pending.get(requestId)!.toolName !== QUESTION_TOOL) return
    if (answers !== null) checkAnswers(slot.pending.get(requestId)!.input, answers)
    slot.answerQuestions?.(requestId, answers)
  }

  /**
   * Decides a plan card: approve, or send it back with optional feedback. Throws TypeError (from checkFeedback) before
   * anything is sent when the feedback is invalid; does nothing when no matching pending plan card exists.
   */
  answerPlan(chatId: string, requestId: string, approve: boolean, feedback?: unknown, agent?: string): void {
    const r = this.running.get(chatId)
    if (!r) return
    const slot = [...r.slots].find((s) => s.pending.has(requestId) && (agent === undefined || s.agent === agent))
    if (!slot) return
    if (slot.pending.get(requestId)!.toolName !== PLAN_TOOL) return
    slot.answerPlan?.(requestId, approve, approve ? null : checkFeedback(feedback))
  }

  /** The card still waits: a live request of a running turn (a channel's press is checked against this, not its message). */
  isPending(chatId: string, requestId: string, agent?: string): boolean {
    const r = this.running.get(chatId)
    return r !== undefined && [...r.slots].some((s) => s.pending.has(requestId) && (agent === undefined || s.agent === agent))
  }

  /** The chat's own waiting cards plus those of every agent it asked that still runs: they are answered from here. */
  pendingCount(chatId: string): number {
    const r = this.running.get(chatId)
    let count = r ? pendingOf(r) : 0
    for (const [child, parent] of this.askParents) if (parent === chatId) count += this.pendingCount(child)
    return count
  }

  /**
   * Every chat's count as its last approvals push gave it, asked chats included: a page that loads or reconnects reads
   * this, since a card can sit above a chat's newest page, where counting its items would miss it.
   */
  pendingCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const id of new Set([...this.running.keys(), ...this.askParents.values()])) {
      const n = this.pendingCount(id)
      if (n > 0) out[id] = n
    }
    return out
  }

  /** The chat's waiting count, then each chat above it in its ask chain, all named after the agent whose turn changed it. */
  private pushPending(chatId: string, agent: string): void {
    const seen = new Set<string>()
    for (let id: string | undefined = chatId; id !== undefined && !seen.has(id); id = this.askParents.get(id)) {
      seen.add(id)
      // `asked` marks a chat whose cards are answered higher up, so its count alone notifies nobody.
      this.d.push({
        chatId: id,
        kind: 'approvals',
        pending: this.pendingCount(id),
        agent,
        ...(this.askParents.has(id) ? { asked: true as const } : {})
      })
    }
  }

  forget(chatId: string): void {
    for (const scope of [...this.allowed.keys()]) {
      if (scope === chatId || scope.startsWith(`${chatId}:`)) this.allowed.delete(scope)
    }
    // A chat deleted mid-pause never lands it; its flag file goes with the chat's temp folder.
    this.pauseFlags.delete(chatId)
    this.workflowRules.delete(chatId)
  }

  /**
   * Marks the chat a workflow room and adds these rules to what is held. Merges, never replaces: the saver writes the meta
   * asynchronously, so a turn that read the meta just before must not drop a rule the user has allowed since.
   */
  noteWorkflowRules(chatId: string, rules: readonly StepRule[]): void {
    let held = this.workflowRules.get(chatId) ?? []
    for (const r of rules) held = withStepRule(held, r)
    this.workflowRules.set(chatId, held)
  }

  /** A cloned room keeps what the user allowed for the old one. A copy, so forgetting one chat never touches the other. */
  copyAllowed(from: string, to: string): void {
    const keys = this.allowed.get(from)
    if (keys) this.allowed.set(to, new Set(keys))
  }

  /** Marks the chat running; the caller sets `done` and must release it. */
  claim(chatId: string): Running {
    if (this.running.has(chatId)) throw new Error('Chat is already running')
    const r: Running = { reason: null, done: Promise.resolve(), slots: new Set(), onStop: null }
    this.running.set(chatId, r)
    return r
  }

  release(chatId: string, r: Running): void {
    if (this.running.get(chatId) !== r) return
    this.running.delete(chatId)
    // After the delete, so the hook sees the chat as idle and may start its next run.
    this.d.onIdle?.(chatId)
  }

  /**
   * replyTo: the id of the agent message this one replies to; an id that is not one is ignored.
   * messageId: the id the client shows the message under; a new one when an item already has it.
   */
  send(
    chatId: string,
    text: string,
    attachments: Attachment[] = [],
    replyTo?: string,
    messageId?: string,
    command?: SentCommand,
    todo?: true,
    auto?: true,
    workflowSent?: WorkflowSent,
    cardAsk?: CardAsk
  ): Promise<void> {
    try {
      const r = this.claim(chatId)
      r.done = this.sendTurn(chatId, text, attachments, replyTo, messageId, command, todo, auto, workflowSent, cardAsk, r).finally(() =>
        this.endSingle(chatId, r)
      )
      return r.done
    } catch (e) {
      return Promise.reject(e)
    }
  }

  /**
   * Runs the message again as a new version: `text` is the edit, null = Resend (same text). The old version's tail
   * is hidden (versions.ts) and the session is cut where the message started. Rejects, leaving the chat as it was,
   * for an unknown id or an empty edit. `todo`: the edit began with /todo or used a command that makes to-dos; Resend
   * (text null) keeps the old message's flag instead, an edit never does.
   */
  rerun(chatId: string, userId: string, text: string | null, command?: SentCommand, todo?: true): Promise<void> {
    try {
      const r = this.claim(chatId)
      r.done = this.rerunTurn(chatId, userId, text, command, todo, r).finally(() => this.endSingle(chatId, r))
      return r.done
    } catch (e) {
      return Promise.reject(e)
    }
  }

  /** Compacts the chat's Claude session (/compact, the note says what to keep). Adds no items unless it fails. */
  compact(chatId: string, note: string): Promise<void> {
    try {
      const r = this.claim(chatId)
      r.done = this.compactTurn(chatId, note, r).finally(() => this.release(chatId, r))
      return r.done
    } catch (e) {
      return Promise.reject(e)
    }
  }

  /**
   * Runs one turn of the asked agent in its A→B chat, for AgentAsks. Not queued: nothing else sends to that chat, so a
   * claim that fails means an earlier ask from the same chat still runs. Never throws: every end is an outcome.
   */
  runAsked(
    chatId: string,
    o: { from: string; message: string; chain: string[]; parent: string; signal: AbortSignal; auto?: true }
  ): Promise<AskedOutcome> {
    if (o.signal.aborted) return Promise.resolve({ kind: 'stopped' })
    let r: Running
    try {
      r = this.claim(chatId)
    } catch {
      return Promise.resolve({ kind: 'busy' })
    }
    this.askParents.set(chatId, o.parent)
    const onAbort = () => this.stop(chatId)
    o.signal.addEventListener('abort', onAbort)
    const run = this.askedTurn(chatId, o, r).finally(() => {
      // Unlinked first, so the asker's count no longer holds this chat's cards when it is pushed again.
      if (this.askParents.get(chatId) === o.parent) this.askParents.delete(chatId)
      o.signal.removeEventListener('abort', onAbort)
      try {
        this.pushPending(o.parent, o.from)
      } finally {
        this.release(chatId, r)
      }
    })
    r.done = run.then(
      () => {},
      () => {}
    )
    return run
  }

  private async askedTurn(
    chatId: string,
    o: { from: string; message: string; chain: string[]; auto?: true },
    r: Running
  ): Promise<AskedOutcome> {
    const { store, now, newId } = this.d
    // A chat deleted mid-run was stopped first (chats:remove), so a missing row reads as stopped, never as a failure.
    const ended = (): AskedOutcome => (r.reason !== null ? { kind: 'stopped' } : { kind: 'error' })
    try {
      const meta = await store.get(chatId)
      if (!meta) return ended()
      const history = [...(await store.loadItems(chatId))]
      const user: UserItem = { type: 'user', id: newId(), text: o.message, ts: now(), from: o.from }
      const res = await this.runTurn(chatId, r, meta, {
        history,
        base: history,
        items: [...history, user],
        user,
        patch: {},
        extra: {
          systemPrompt: askedSystem(o.from, meta.asked?.fromTitle ?? ''),
          askChain: o.chain,
          questionsDenied: QUESTIONS_DENIED(o.from),
          ...(o.auto ? { auto: true as const } : {})
        }
      })
      if (r.reason !== null || res?.stopped) return { kind: 'stopped' }
      // Read back as stored, so the outcome is what the chat shows: this turn's items are the ones after its message.
      const turn = turnOutcome(await store.loadItems(chatId), user.id)
      if (!res?.ok) {
        const last = turn?.items.at(-1)
        return last?.type === 'error' && last.limit ? { kind: 'limited', resetsAt: last.limit.resetsAt } : { kind: 'error' }
      }
      return { kind: 'ok', reply: turn?.reply ?? null }
    } catch {
      return ended()
    }
  }

  /** The model this turn runs on: the user item's command may set or raise the chat's model (chatModel.ts). */
  private async turnModelOf(meta: ChatMeta, user: UserItem): Promise<{ run?: string; save?: string | null }> {
    const picked = user.command?.agent === meta.agentName && isCommandModel(user.command.model) ? user.command.model : undefined
    // Read only for a command with a model: a failed read ranks as inherit, which never switches a running session.
    const agentModel = picked && this.d.agentModel ? await this.d.agentModel(meta.agentName).catch(() => null) : null
    const fresh = meta.sessionId === null || (meta.next !== undefined && 'seed' in meta.next)
    // A Codex pick left from when the agent ran on Codex is no Claude model: the turn runs as if the chat had none.
    const chatModel = engineChatModel('claude', meta)
    return turnModel({ chatModel, byHand: chatModel !== undefined && meta.modelByHand, agentModel, picked, fresh })
  }

  /**
   * A single chat's model picked by hand, from the next turn (one cache reload when it differs); commands no longer move it.
   * null puts the chat back on its agent's own model, where commands may set one again. The sidebar order stays. The model must
   * be one the agent's engine runs (Claude's three, or a Codex name), so neither CLI is ever handed the other's.
   */
  async setModel(chatId: string, model: string | null): Promise<void> {
    const cur = await this.d.store.get(chatId)
    if (model !== null && cur && !cur.group && !modelFits(await this.engineOf(cur.agentName), model)) throw new Error(MODEL_REFUSED)
    const meta = await this.d.store.patchInPlace(chatId, (cur) => {
      if (cur.group) return null
      if (model === null)
        return cur.model === undefined && cur.modelByHand === undefined ? null : { model: undefined, modelByHand: undefined }
      return cur.model === model && cur.modelByHand ? null : { model, modelByHand: true }
    })
    if (meta) this.d.push({ chatId, kind: 'meta', meta })
  }

  /** A single chat's permission mode from its next turn; null puts it back on the server's. Only a mode its engine runs (modeFits). */
  async setPermissionMode(chatId: string, mode: ChatMode | null): Promise<void> {
    const cur = await this.d.store.get(chatId)
    if (mode !== null && cur && !cur.group && !modeFits(await this.engineOf(cur.agentName), mode)) throw new Error(MODE_REFUSED)
    const next = mode ?? undefined
    const meta = await this.d.store.patchInPlace(chatId, (cur) =>
      cur.group || cur.permissionMode === next ? null : { permissionMode: next }
    )
    if (meta) this.d.push({ chatId, kind: 'meta', meta })
  }

  /**
   * "Allow and continue" on a row Auto mode's classifier refused: stores a `Bash(<prefix>:*)` rule per prefix and a
   * `Read(//<folder>/**)` rule per folder the command cd's into, for this chat or the row's agent, marks the row so it cannot be
   * allowed twice, and returns the text the client sends as a normal message. Every prefix and folder is checked before any rule
   * is stored. The user's click is the only way a rule gets made.
   */
  async allowBlocked(
    chatId: string,
    toolUseId: string,
    prefixes: string[],
    scope: 'chat' | 'agent',
    folders: string[] = []
  ): Promise<{ rules: string[]; text: string; agent: string }> {
    const { store, push } = this.d
    const meta = await store.get(chatId)
    if (!meta) throw new Error(`Chat not found: ${chatId}`)
    if (meta.inFlight || this.running.has(chatId)) throw new Error(CHAT_BUSY)
    const items = await store.loadItems(chatId)
    const at = items.findIndex((i) => i.type === 'tool' && i.id === toolUseId)
    const item = items[at]
    const agent = item?.type === 'tool' ? (item.agent ?? meta.agentName) : ''
    if (
      item?.type !== 'tool' ||
      item.name !== 'Bash' ||
      item.blockedBy !== 'classifier' ||
      agent === ZUMI_BOT_NAME ||
      meta.workflow ||
      meta.workflowTest !== undefined ||
      !agent
    ) {
      throw new Error(NOT_ALLOWABLE)
    }
    if (item.allowedAs) throw new Error(ALREADY_ALLOWED)
    if (!Array.isArray(prefixes) || !Array.isArray(folders)) throw new Error(ALLOW_COUNT)
    const count = prefixes.length + folders.length
    if (count < 1 || count > MAX_ALLOW) throw new Error(ALLOW_COUNT)
    const command = (item.input as { command?: unknown } | null)?.command
    if (typeof command !== 'string') throw new Error(NOT_ALLOWABLE)
    for (const p of prefixes) {
      const bad = checkPrefix(p, command)
      if (bad) throw new Error(bad)
    }
    // The server's home: a folder rule on it (or above it) would let the agent read ~/.ssh and the like.
    for (const f of folders) {
      const bad = checkFolder(f, command, homedir())
      if (bad) throw new Error(bad)
    }
    const rules = [...new Set([...prefixes.map(ruleOfPrefix), ...folders.map(ruleOfFolder)])]
    let next = meta
    if (scope === 'chat') {
      // Merged in the write, so a second tab's rules are not lost.
      const patched = await store.patchInPlace(chatId, (cur) => ({ allowRules: [...new Set([...(cur.allowRules ?? []), ...rules])] }))
      if (patched) next = patched
    } else {
      if (!this.d.agentRules) throw new Error('Rules are not available')
      for (const rule of rules) await this.d.agentRules.addCli(agent, rule)
    }
    if (scope === 'chat') push({ chatId, kind: 'meta', meta: next })
    // The writes above awaited, so another tab or a room send may have started a turn or added items since the first read:
    // mark the row on a fresh list, and leave the log alone when a turn runs now (its own save would race ours). The rules
    // are stored either way, and the row stays unmarked so Allow can be tried again once the reply ends.
    if (!this.running.has(chatId) && !(await store.get(chatId))?.inFlight) {
      const fresh = await store.loadItems(chatId)
      const k = fresh.findIndex((i) => i.type === 'tool' && i.id === toolUseId)
      if (k >= 0) {
        const out = fresh.map((i, j) => (j === k ? { ...(i as ChatItem & { type: 'tool' }), allowedAs: scope } : i))
        await store.saveItems(chatId, out)
        push({ chatId, kind: 'items', items: [...out], clearStreaming: false })
      }
    }
    return { rules, text: continueText(rules, scope, agent, isGroup(meta) ? agent : null), agent }
  }

  /** A single Claude chat's --effort from its next turn; null or Medium puts it back on the default (stored as absent). */
  async setEffort(chatId: string, effort: Effort | null): Promise<void> {
    const cur = await this.d.store.get(chatId)
    if (effort !== null && cur && !cur.group && !effortFits(await this.engineOf(cur.agentName), effort)) throw new Error(EFFORT_REFUSED)
    const next = effort === null || effort === DEFAULT_EFFORT ? undefined : effort
    const meta = await this.d.store.patchInPlace(chatId, (cur) => (cur.group || cur.effort === next ? null : { effort: next }))
    if (meta) this.d.push({ chatId, kind: 'meta', meta })
  }

  /** As Claude Code leaves plan mode once its plan is approved; a mode the user picked meanwhile stays. */
  private async leavePlan(chatId: string): Promise<void> {
    const meta = await this.d.store.patchInPlace(chatId, (cur) => (cur.permissionMode === 'plan' ? { permissionMode: undefined } : null))
    if (meta) this.d.push({ chatId, kind: 'meta', meta })
  }

  /** Resolves once the chat's current run (if any) has ended and released its claim. */
  async whenIdle(chatId: string): Promise<void> {
    await this.running.get(chatId)?.done.catch(() => {})
  }

  /**
   * Shows another version of a message (single chat or room) and points the Claude sessions at where that version
   * ended. The version's own session is untouched, so the next message resumes it as it was.
   */
  async switchVersion(chatId: string, userId: string, index: number): Promise<void> {
    if (this.running.has(chatId)) throw new Error('Chat is busy')
    // Held while it works so a send cannot start midway, and `done` is the switch itself so whenIdle waits for it.
    // Dropped without release(): its onIdle would wake the task queue, which could start a task in a paused room.
    const r = this.claim(chatId)
    r.done = this.switchTurn(chatId, userId, index).finally(() => {
      if (this.running.get(chatId) === r) this.running.delete(chatId)
    })
    return r.done
  }

  private async switchTurn(chatId: string, userId: string, index: number): Promise<void> {
    const { store, push } = this.d
    const meta = await store.get(chatId)
    if (!meta) throw new Error(`Chat not found: ${chatId}`)
    const before = await store.loadVersions(chatId)
    const switched = switchTo(await store.loadItems(chatId), before, userId, index)
    // Already shown: nothing to write, and the sessions stay as the last send left them.
    if (switched.versions === before) return
    const items = switched.items
    // Three writes so a crash never loses a version: switchTo empties the target's slot, so first store the versions with
    // that slot still filled (the current one, filled by switchTo, is overwritten by the next switch anyway), then swap
    // the items, then store the final versions.
    const root = Object.keys(switched.versions).find((k) => switched.versions[k] !== before[k])!
    // A dropped stale empty slot is always the last one (branch reuses it instead of pushing), so no other slot moves
    // and the target's index is the same in both lists.
    const was = before[root]
    const after = switched.versions[root]
    const safe = { current: was.current, list: after.list.map((v, i) => (i === index ? was.list[i] : v)) }
    await store.saveVersions(chatId, { ...switched.versions, [root]: safe })
    await store.saveItems(chatId, items)
    await store.saveVersions(chatId, switched.versions)
    let next: ChatMeta
    if (isGroup(meta)) {
      const points = memberStartsBefore(items, items.length, meta.group.members)
      // Each member's mark follows its stamp, as a single chat's does: a Claude stamp clears a Codex mark.
      next = await store.updateGroup(chatId, (g) =>
        withSessionEngines(
          {
            ...g,
            sessions: { ...g.sessions, ...Object.fromEntries(Object.entries(points).map(([m, p]) => [m, p.sessionId])) },
            seen: { ...g.seen, ...Object.fromEntries(Object.entries(points).map(([m, p]) => [m, p.seen])) },
            next: Object.fromEntries(Object.entries(points).flatMap(([m, p]) => (p.next ? [[m, p.next]] : []))),
            queue: [],
            active: [],
            context: undefined // it described the version the members leave
          },
          enginesAfter(g.sessionEngines, points)
        )
      )
    } else {
      const start = startBefore(items, items.length)
      next = await store.update(chatId, {
        sessionId: start.sessionId,
        next: start.next ?? undefined,
        sessionEngine: start.engine,
        context: undefined
      })
    }
    push({ chatId, kind: 'items', items: [...items], clearStreaming: true })
    push({ chatId, kind: 'meta', meta: next })
  }

  private async sendTurn(
    chatId: string,
    text: string,
    attachments: Attachment[],
    replyTo: string | undefined,
    messageId: string | undefined,
    command: SentCommand | undefined,
    todo: true | undefined,
    auto: true | undefined,
    workflowSent: WorkflowSent | undefined,
    cardAsk: CardAsk | undefined,
    r: Running
  ): Promise<void> {
    const { store, now, newId } = this.d
    const meta = await store.get(chatId)
    if (!meta) throw new Error(`Chat not found: ${chatId}`)
    const history = [...(await store.loadItems(chatId))]
    const quoted = repliedItem(history, replyTo)
    const user: UserItem = {
      type: 'user',
      id: messageId !== undefined && !history.some((i) => i.id === messageId) ? messageId : newId(),
      text,
      ts: now(),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(quoted ? { replyTo: quoted.id } : {}),
      ...(command ? { command } : {}),
      ...(todo ? { todo } : {}),
      ...(workflowSent ? { workflowSent } : {}),
      ...(cardAsk ? { cardAsk } : {})
    }
    const title = meta.title === '' ? { title: makeTitle(text.trim() ? text : (attachments[0]?.name ?? '')) } : {}
    await this.runTurn(chatId, r, meta, {
      history,
      base: history,
      items: [...history, user],
      user,
      patch: title,
      ...(auto ? { extra: { auto } } : {})
    })
  }

  private async rerunTurn(
    chatId: string,
    userId: string,
    text: string | null,
    command: SentCommand | undefined,
    todo: true | undefined,
    r: Running
  ): Promise<void> {
    const { store, now, newId } = this.d
    const meta = await store.get(chatId)
    if (!meta) throw new Error(`Chat not found: ${chatId}`)
    if (isGroup(meta)) throw new Error('A group room reruns a message through the room')
    const stored = [...(await store.loadItems(chatId))]
    const old = stored.find((i): i is UserItem => i.type === 'user' && i.id === userId)
    if (!old) throw new Error('Message not found')
    const body = text ?? old.text
    if (body.trim() === '' && !old.attachments?.length) throw new Error('Message is empty')
    const user: UserItem = {
      type: 'user',
      id: newId(),
      text: body,
      ts: now(),
      ...(old.attachments?.length ? { attachments: old.attachments } : {}),
      ...(old.replyTo ? { replyTo: old.replyTo } : {}),
      // Never old.command: the new version resolved its own, or none.
      ...(command ? { command } : {}),
      // Resend keeps the flag the message had; an edit has its own, or none.
      ...((text === null ? old.todo : todo) ? { todo: true as const } : {}),
      // Resend keeps the workflow that sent it; an edit is the user's own text.
      ...(text === null && old.workflowSent ? { workflowSent: old.workflowSent } : {}),
      // Resend and edit both keep the card context: an edited comment is still read inside its card. An edit drops the
      // comment as first written, so the edited text is what the agent reads.
      ...(old.cardAsk ? { cardAsk: text === null ? old.cardAsk : withoutComment(old.cardAsk) } : {})
    }
    const b = branch(stored, await store.loadVersions(chatId), userId, user)
    const shown = b.items.slice(0, -1)
    // The point is read from the branched list, but what the session holds after it is the stored one: only there can the
    // turn this rewind discards be seen to be the only one, which is the condition for declaring it.
    const start = startBefore(b.items, b.items.length - 1, droppedTurn(stored, userId))
    await this.runTurn(chatId, r, meta, {
      history: shown,
      // Until the turn starts, a failure keeps the chat as it was, not half-branched.
      base: stored,
      items: b.items,
      user: b.items[b.items.length - 1] as UserItem,
      // The meter described the version being left; the new turn reports its own.
      // The mark follows the stamp: a Claude stamp clears a Codex mark.
      patch: { sessionId: start.sessionId, next: start.next ?? undefined, sessionEngine: start.engine, context: undefined },
      versions: b.versions
    })
  }

  private async compactTurn(chatId: string, note: string, r: Running): Promise<void> {
    const { store, push } = this.d
    let meta = await store.get(chatId)
    if (!meta) throw new Error(`Chat not found: ${chatId}`)
    if (isGroup(meta)) throw new Error('A group room compacts a member through the room')
    const engine = await this.engineOf(meta.agentName)
    const caps = this.caps(engine)
    if (!caps.compact) throw new Error(capRefusal(engine, 'compact'))
    // A session the other engine made is nothing this CLI can compact.
    const stale = (meta.sessionEngine ?? 'claude') !== engine
    // Without rewinds a cut point is never forked: the next turn reseeds, so nothing of this session is left to compact.
    const cutGone = !caps.rewind && meta.next !== undefined && 'at' in meta.next
    if (meta.sessionId === null || stale || cutGone || (meta.next !== undefined && 'seed' in meta.next)) throw new Error(NOTHING_TO_COMPACT)
    let items = await store.loadItems(chatId)
    const updateMeta = async (patch: Partial<Omit<ChatMeta, 'id'>>) => {
      meta = await store.update(chatId, patch)
      push({ chatId, kind: 'meta', meta })
    }
    const errors: unknown[] = []
    try {
      // Compacting the whole run: the CLI's own status events are not passed on, so they can't clear it midway.
      await updateMeta({ inFlight: true, compacting: true })
      const prompt = compactPrompt(note)
      await this.agentTurn(
        chatId,
        r,
        {
          agentName: meta.agentName,
          model: engineChatModel(engine, meta),
          // The chat's effort, as for the model (another may write the cache again); it runs no tools, so the mode is the server's.
          effort: engineChatEffort(engine, meta),
          sessionId: meta.sessionId,
          prompt,
          seedPrompt: () => prompt,
          extraArgs: [],
          disallowedTools: this.d.disallowedToolsFor(meta.agentName),
          allowScope: chatId,
          saveSession: (sessionId) => updateMeta({ sessionId, next: undefined }),
          resumeAt: meta.next && 'at' in meta.next ? meta.next.at : undefined,
          ...(meta.next && 'at' in meta.next && meta.next.drops !== undefined ? { resumeDrops: meta.next.drops } : {}),
          engine,
          compact: true,
          window: meta.context?.window ?? null,
          saveContext: (context) => updateMeta({ context }),
          // Only for a cut compact to clear: a compact is never told.
          ...(meta.lost && meta.lost.length > 0 ? { lost: meta.lost } : {}),
          saveLost: (lost) => this.saveLost(chatId, lost)
        },
        {
          get: () => items,
          set: (next) => {
            items = next
          }
        }
      )
    } catch (e) {
      errors.push(e)
    } finally {
      await finishStep(errors, () => updateMeta({ inFlight: false, compacting: undefined }))
    }
    if (errors.length > 0) throw errors[0]
  }

  /**
   * The turn send, rerun and an ask run: records the user message, then runs the agent on it.
   * history: the items before the message (the seed and the reply quote read these, never hidden versions).
   * extra: what an asked turn adds to the spec. Resolves to the agent's result, or null when it failed before starting.
   */
  private async runTurn(
    chatId: string,
    r: Running,
    loaded: ChatMeta,
    t: {
      history: ChatItem[]
      base: ChatItem[]
      items: ChatItem[]
      user: UserItem
      patch: Partial<Omit<ChatMeta, 'id'>>
      versions?: Versions
      extra?: Pick<TurnSpec, 'systemPrompt' | 'askChain' | 'questionsDenied' | 'auto'>
    }
  ): Promise<TurnResult | null> {
    const { store, push, newId, now } = this.d
    let meta: ChatMeta = loaded
    const { history, user } = t
    let items: ChatItem[] = t.base
    const ref: ItemsRef = {
      get: () => items,
      set: (next) => {
        items = next
      }
    }

    const pushItems = (clearStreaming: boolean) => push({ chatId, kind: 'items', items: [...items], clearStreaming })
    const updateMeta = async (patch: Partial<Omit<ChatMeta, 'id'>>) => {
      meta = await store.update(chatId, patch)
      push({ chatId, kind: 'meta', meta })
    }

    // Once agentTurn starts it records, saves and pushes its own outcome; a failure before that is recorded here.
    let started = false
    let result: TurnResult | null = null
    // The meta patch a failure before the save still applies (the message it keeps has its title).
    let kept: Partial<Omit<ChatMeta, 'id'>> = {}
    const errors: unknown[] = []
    const ackStop = new AbortController()
    try {
      const pathOf = (a: Attachment) => this.d.files.pathOf(chatId, a)
      const refs = refsOf(user.attachments ?? [], pathOf)
      // Read before anything is stored, so the refusal below stores nothing. An agent list that can't be read is still the
      // turn's error after its message, which is kept with its title (a rerun keeps the list it had), as before the refusal.
      const engine = await this.engineOf(meta.agentName).catch((e: unknown) => {
        if (!t.versions) {
          items = t.items
          kept = t.patch
        }
        throw e
      })
      const bridges = this.caps(engine).bridges
      // The one place every path (send, edit, resend, routine, workflow step) goes through: an agent without ZumiBot's to-do
      // tools is never asked for to-dos. Thrown here, it is this turn's error item and nothing runs.
      if (asksTodos(user) && !bridges) throw new Error(todoRefusal(engine, meta.agentName))
      // A Codex skill is looked up now: one removed since the menu was built is this turn's error, before anything is stored.
      let skills: CodexSkillRef[] | undefined
      if (engine === 'codex' && user.command?.engine === 'codex') {
        const skill = await this.d.codexSkill?.(meta.cwd, meta.agentName, user.command.name)
        if (!skill) throw new Error(`Codex has no $${user.command.name} skill any more`)
        skills = [skill]
      }
      // A Claude command reads as one only at the start of the message, so a reply's quote goes after it.
      const noted = withNote(
        withReply(readAs(user, meta.agentName, bridges), repliedItem(history, user.replyTo), user.command?.engine === 'claude'),
        refs
      )
      const blocks = await imageBlocks(refs)
      // Versions first: a failure or crash between the two writes leaves the old tail stored twice, never lost, and
      // the next edit or switch reads the shown item's index (an unmarked original counts as slot 0) and reuses or drops
      // the empty slot this left.
      // `items` stays the unbranched list until the versions are safe, so a failed save here loses nothing.
      if (t.versions) await store.saveVersions(chatId, t.versions)
      items = t.items
      await store.saveItems(chatId, [...items])
      await updateMeta({ inFlight: true, ...t.patch })
      pushItems(false)
      // Only for a message the user typed (an edit and a resend too), never a routine's, a workflow's or another agent's ask.
      const acknowledge = this.d.acknowledge
      if (acknowledge && !t.extra?.auto && user.from === undefined) {
        const userId = user.id
        acknowledge({ chatId, agent: meta.agentName, user, todos: asksTodos(user) && bridges, signal: ackStop.signal })
          .then(async (ack) => {
            if (ack === null || ackStop.signal.aborted) return
            // Through `items`, which agentTurn's ref also writes, so its own adds keep the line and its saves store it.
            items = items.map((i) => (i.type === 'user' && i.id === userId ? { ...i, ack } : i))
            pushItems(false)
            await store.saveItems(chatId, [...items])
          })
          .catch((e: unknown) => console.error('acknowledge failed:', chatId, e instanceof Error ? e.message : 'error'))
      }
      // A session the other engine made means nothing to this engine's CLI: the turn starts fresh from the history (expired notice).
      const stale = meta.sessionId !== null && (meta.sessionEngine ?? 'claude') !== engine
      // The engine goes with every session saved, so the other CLI is never handed it; a chat that never ran on Codex keeps its meta.
      const mark = sessionMark(engine)
      const engineMark: Partial<Omit<ChatMeta, 'id'>> =
        mark !== undefined ? { sessionEngine: mark } : meta.sessionEngine !== undefined ? { sessionEngine: undefined } : {}
      let model: { run?: string; save?: string | null }
      switch (engine) {
        case 'claude':
          model = await this.turnModelOf(meta, user)
          break
        // Codex has no command models: its thread runs on a model picked by hand, else the agent file's.
        case 'codex': {
          const pick = engineChatModel('codex', meta)
          model = pick !== undefined ? { run: pick } : {}
          break
        }
        // No `models` cap: an ACP agent's model is its own config option, which ZumiBot never sets.
        case 'acp':
          model = {}
          break
        // Nor a remote agent's: its model is its server's.
        case 'ag-ui':
          model = {}
          break
        default:
          model = assertNever(engine)
      }
      // A command's model is no pick by hand: a later command may still move it.
      if (model.save !== undefined) await updateMeta({ model: model.save ?? undefined, modelByHand: undefined })
      const spec: TurnSpec = {
        agentName: meta.agentName,
        model: model.run,
        permissionMode: engineChatMode(engine, meta),
        effort: engineChatEffort(engine, meta),
        sessionId: stale ? null : meta.sessionId,
        prompt: withImages(noted, blocks),
        seedPrompt: () =>
          withImages(buildSeedPrompt(withNotes(withReplies(withCommands(history, meta.agentName, bridges)), pathOf), noted), blocks),
        extraArgs: addDirArgs(items, this.d.files.dirOf(chatId)),
        disallowedTools: this.d.disallowedToolsFor(meta.agentName),
        allowScope: chatId,
        // A run that fails before `init` saves nothing, so `next` survives for the retry.
        // null is saved only on the reseed path: if that run fails before `init` too, the next send reseeds again.
        saveSession: (sessionId) =>
          updateMeta({ ...(sessionId === null ? { sessionId, next: { seed: true } } : { sessionId, next: undefined }), ...engineMark }),
        resumeAt: meta.next && 'at' in meta.next ? meta.next.at : undefined,
        ...(meta.next && 'at' in meta.next && meta.next.drops !== undefined ? { resumeDrops: meta.next.drops } : {}),
        reseed: stale || (meta.next !== undefined && 'seed' in meta.next),
        engine,
        ...(skills ? { skills } : {}),
        ...(meta.next !== undefined && 'fresh' in meta.next ? { freshStart: true } : {}),
        window: meta.context?.window ?? null,
        saveContext: (context) => updateMeta({ context }),
        setCompacting: (on) => updateMeta({ compacting: on ? true : undefined }),
        ...(user.todo ? { todoAsked: true } : {}),
        ...(meta.asked ? { asked: true as const } : {}),
        // The prompt follows the chat's origin, kept or not, so its prefix never changes; only the silent end drops with keep.
        ...(meta.workflow ? { systemPrompt: workflowSystem(meta.workflow.name) } : {}),
        ...(meta.workflow && !meta.workflow.keep ? { workflow: true as const } : {}),
        // A step test's chat: the same paragraph, but no run reports for it, so its turn end stays a normal one.
        ...(!meta.workflow && meta.workflowTest !== undefined ? { systemPrompt: workflowSystem(meta.workflowTest) } : {}),
        ...(meta.lost && meta.lost.length > 0 ? { lost: meta.lost } : {}),
        // A task's chat: the questions go on its card (ask_user), where the user answers whenever they like.
        ...(meta.task ? { questionsDenied: TASK_QUESTIONS_DENIED } : {}),
        saveLost: (lost) => this.saveLost(chatId, lost),
        ...t.extra
      }
      started = true
      const res = await this.agentTurn(chatId, r, spec, ref)
      result = res
      // Both stamps go on the turn's last item: where its session ended, and the id its own prompt went out under.
      if (res.end && items.length > 0) {
        items = [...items.slice(0, -1), { ...items[items.length - 1], end: res.end, ...(res.sent ? { sent: res.sent } : {}) }]
        await store.saveItems(chatId, [...items])
        pushItems(false)
      }
    } catch (e) {
      if (started) errors.push(e)
      // A rerun fails back to the pre-branch list: its meta patch (session cut) never ran, so keeping the branched
      // items would let the next send resume a session that still remembers the hidden tail.
      else items = [...(t.versions ? t.base : items), { type: 'error', id: newId(), text: errorText(e), ts: now() }]
    } finally {
      ackStop.abort()
      await finishStep(errors, () => updateMeta({ ...kept, inFlight: false, compacting: undefined }))
      if (!started) {
        await finishStep(errors, () => store.saveItems(chatId, [...items]))
        await finishStep(errors, () => pushItems(true))
      }
    }
    if (errors.length > 0) throw errors[0]
    return result
  }

  /**
   * Runs one agent turn on a claimed chat, in its own turn slot, so several can run under one claim.
   * Every item read and write goes through `ref`, so items another writer adds meanwhile are kept.
   * Does not touch the chat's inFlight flag or title.
   */
  async agentTurn(chatId: string, r: Running, spec: TurnSpec, ref: ItemsRef): Promise<TurnResult> {
    const { store, push, now, newId } = this.d
    const engine: Engine = spec.engine ?? 'claude'
    const caps = this.caps(engine)
    // Without rewinds (Codex's thread/fork off) a cut point starts a fresh session from the history instead, as in Phase 1.
    if (!caps.rewind && spec.resumeAt !== undefined) spec = { ...spec, resumeAt: undefined, reseed: true }
    const history = [...ref.get()]
    const turnMessage = [...history].reverse().find((i) => i.type === 'user')?.id ?? null // spend caps: whose turn this is
    // A remote agent's input: the whole visible history with this turn's message last, built once per turn, so a reseed sends
    // it too. The adapter never reads the prompt, so nothing else of this turn (a note, a seed) reaches the remote host. Each
    // message reads as a seed reads it (its command filled, its reply quoted), the turn's own too: one text on every run.
    const aguiInput: AguiMessage[] | null =
      engine === 'ag-ui' ? aguiMessages(withReplies(withCommands(history, spec.agentName, caps.bridges))) : null
    /**
     * A remote agent's launch, then what this turn would send: a chat that holds another engine's turn would hand local file
     * contents and command output quoted there to the remote host, and attachments are never sent. Checked before the turn
     * touches its session, and again by every attempt (a reseed too), so an edit outside Agent Studio between two is refused.
     */
    const aguiCheck = async (): Promise<{ endpoint: string; launch: AguiLaunch } | { error: string }> => {
      const l = await this.aguiLaunch(spec.agentName)
      if ('error' in l) return l
      if (foreignHistory(history)) return { error: AGUI_TEXT.otherEngine }
      const own = history.find((i) => i.type === 'user' && i.id === turnMessage)
      if (own?.type === 'user' && (own.attachments?.length ?? 0) > 0) return { error: AGUI_TEXT.noAttachments }
      return l
    }
    const previousEnd = [...history]
      .reverse()
      .find((i) => i.end?.session === spec.sessionId && (spec.author === undefined || i.end.agent === spec.author))?.end
    const start =
      spec.sessionId === null || spec.reseed
        ? null
        : spec.resumeAt !== undefined
          ? { session: spec.sessionId, at: spec.resumeAt }
          : previousEnd
            ? { session: previousEnd.session, at: previousEnd.at }
            : null
    // A base the other engine's run of this agent left no longer matches the chat's session: until this attempt publishes, none.
    const keptBase = this.sideBases.get(`${chatId}\n${spec.agentName}`)
    if (keptBase && baseEngine(keptBase) !== engine) this.sideBases.delete(`${chatId}\n${spec.agentName}`)
    let sideBase = this.sideBases.get(`${chatId}\n${spec.agentName}`) ?? null
    if (sideBase) {
      sideBase.active = true
      sideBase.live = null
      if (sideBase.codex) Object.assign(sideBase.codex, codexPoint(start))
      else sideBase.start = start
    }
    let clean = new CleanPoint()
    const clearSideLive = () => {
      if (sideBase) sideBase.live = null
    }
    const slot: TurnSlot = {
      get agent() {
        return spec.author ?? null
      },
      handle: null,
      pending: new Map(),
      browserPending: new Set(),
      vaultPending: new Set(),
      disposeBrowser: null,
      disposeDesktop: null,
      answer: null,
      answerQuestions: null,
      answerPlan: null
    }
    // The run's audit tap, made once the meta is read (before any spawn); every answer below tells it why a call ran or not.
    let tap: AuditTap | null = null
    // This attempt's sandbox network list (null: not sandboxed), and whether an on-list fetch runs without a card: only in auto
    // mode, where no card would have been shown before; in every other mode it gets the card it always got.
    let sandboxNet: string[] | null = null
    let sandboxAutoFetch = false
    // A contained attempt's container: the hosts its network proxy refused are added to the tool result they came during.
    let container: ContainerRun | null = null
    // Read each time: a group member renamed mid-turn signs the rest of its turn, and its pushes, with the new name.
    const by = () => (spec.author === undefined ? {} : { agent: spec.author })
    // Every item the turn adds carries its turn id; all but notices and errors carry its author.
    const stamp = (item: ChatItem): ChatItem => ({
      ...item,
      ...(item.type === 'notice' || item.type === 'error' ? {} : by()),
      ...(spec.turnId === undefined ? {} : { turn: spec.turnId })
    })
    // The attempt's folder (the chat's folder or worktree): an ACP edit's card may be remembered only while its paths stay inside.
    let runCwd = ''
    // Two turns may hold cards with the same CLI request id; a turn only touches its own.
    const ownCard = (i: ChatItem, id: string): i is Extract<ChatItem, { type: 'approval' }> =>
      i.type === 'approval' && i.id === id && i.turn === spec.turnId
    const texts: string[] = []
    // Capabilities and IPC paths of this turn's browser and desktop: never in a chat item.
    const privateValues = new Map<string, string>()
    // The vault values of this attempt's agent (API keys) and the scrubber for its streamed text; empty when the agent has none.
    let scrub: ReadonlyMap<string, string> = new Map()
    let deltas = new DeltaScrubber(scrub)
    let thoughts = new DeltaScrubber(scrub) // the thinking stream's own: a held tail must never cross into the reply's
    let thinkStart: number | null = null // when the thinking block now streaming began
    // One key for every attempt of this turn, so a reseed retry adds to the same touch.
    const todoKey = randomUUID()
    const turnLabel = todoLabel(history)
    // Only ours: an attempt that runs without the bridge (none wired, or it failed to start) may have someone else's
    // tool of that name, which asks like any other.
    let todoBridged = false
    const ownTodo = (name: string) => todoBridged && todoTool(name)
    let vaultBridged = false // as todoBridged: only our own bridge's tool skips the card
    const ownVault = (name: string) => vaultBridged && vaultTool(name)
    // Single chats only: a room hands work over by @mention, Zumi Bot never delegates, and /compact runs no tools. The ask tool
    // is a bridge: an engine without `bridges` (ACP) gets none.
    const askable =
      this.d.askTurns !== undefined && spec.author === undefined && spec.agentName !== ZUMI_BOT_NAME && !spec.compact && caps.bridges
    let askBridged = false // as todoBridged: only our own bridge's tool skips the card
    const ownAsk = (name: string) => askBridged && isAskTool(name)
    // Zumi Bot only, never a Compact. It never joins a room; the author check keeps a room turn out all the same.
    // Only a message the user typed may change routines and workflows.
    const automatable =
      this.d.automationTurns !== undefined &&
      spec.author === undefined &&
      spec.agentName === ZUMI_BOT_NAME &&
      !spec.compact &&
      engine === 'claude'
    const automationWritable = spec.auto !== true
    let automationBridged = false // as todoBridged: only our own bridge's tools skip the card
    // A delete is never ours to allow: it always gets the user's card.
    const ownAutomation = (name: string) => automationBridged && automationTool(name) && !confirmOnly(name)
    // The attempt's claude.ai connector tool prefixes (its own run config's); {} on Codex and before an attempt reads it.
    let runPrefixes: Readonly<Record<string, ConnectorId>> = {}
    let runOff: readonly ConnectorId[] = []
    const isolationOf = (): IsolationLevel => this.d.isolation?.levelOf(ruleAgent()) ?? 'off'
    let processBridged = false // as todoBridged: only our own bridge's tools skip the card, and never start, which runs a command
    const ownProcess = (name: string) => processBridged && name.startsWith(PROCESS_TOOL_PREFIX) && name !== PROCESS_START_TOOL
    // A turn that started in Plan plans until its plan card is approved: no process starts before that.
    let planApproved = false
    const planning = () => caps.plan && spec.permissionMode === 'plan' && !planApproved
    const todoUses = new Set<string>()
    let todoSpawned = false // an attempt reached the CLI, so the agent read the list's state
    let todoReadRev: number | undefined // the list's rev as the latest note read it; none when that read failed
    let cardAsked = false // the agent put questions on its task card: the turn end tells notifications
    // What a stop killed in this agent's last turn. A plain resume is told (a cut run or a seed starts from before that
    // turn); either way it stays stored until an attempt's CLI is heard from, so a run that never started keeps it.
    // A compact is never told: /compact is its whole message. A plain one leaves the note for the next turn, but one that
    // cuts the session (after a rewind) drops that turn as any cut run does, and the next turn resumes plainly from it.
    const lost = spec.compact ? [] : (spec.lost ?? [])
    let lostStored = (spec.lost?.length ?? 0) > 0 && spec.saveLost !== undefined && (!spec.compact || spec.resumeAt !== undefined)
    let lostClearing = false // tried once per turn: a store that keeps failing must not be written on every event
    const saveLost = async (descriptions: string[] | null): Promise<boolean> => {
      try {
        await spec.saveLost?.(descriptions)
        return true
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Chat not found')) return true
        // Only the code: an fs error names the data folder. Bookkeeping never fails a turn.
        const code = (err as { code?: unknown } | null)?.code
        console.error('lost subagents not saved:', chatId, typeof code === 'string' ? code : 'error')
        return false
      }
    }
    const withLostNote = (content: UserContent): UserContent => {
      const note = lostNote(lost)
      return note === null ? content : withTrailingText(content, note)
    }

    const pushItems = (clearStreaming: boolean) => push({ chatId, kind: 'items', items: [...ref.get()], clearStreaming, ...by() })
    // The last assistant/tool item this turn adds carries the memory line, so it sits where the work ended.
    let lastWork: string | null = null
    const add = (item: ChatItem) => {
      if (item.type === 'assistant' || item.type === 'tool') lastWork = item.id
      ref.set([...ref.get(), stamp(item)])
    }
    // Memory files this turn wrote, by tool id (existence is read at the call, before the write lands).
    const memoryUses = new Map<string, { file: string; existedAtUse: boolean; tool: string }>()
    const memoryTouched = new Map<string, 'saved' | 'updated'>()
    let memoryDir: string | null = null
    const noteMemoryUse = (id: string, name: string, input: unknown) => {
      if (memoryDir === null || !['Write', 'Edit', 'MultiEdit'].includes(name)) return
      const fp = (input as { file_path?: unknown } | null)?.file_path
      if (typeof fp !== 'string') return
      const resolved = resolve(fp)
      // Strictly inside, as a direct child: a `..` escape or a subfolder is not this agent's memory.
      if (!resolved.startsWith(resolve(memoryDir) + sep) || dirname(resolved) !== resolve(memoryDir) || basename(resolved) === MEMORY_INDEX)
        return
      memoryUses.set(id, { file: resolved, existedAtUse: existsSync(resolved), tool: name })
    }
    const noteMemoryResult = (id: string, isError: boolean) => {
      const u = memoryUses.get(id)
      if (!u || isError) return
      // Once saved it stays saved: a later edit of the same file adds nothing.
      if (!memoryTouched.has(u.file)) memoryTouched.set(u.file, u.tool === 'Write' && !u.existedAtUse ? 'saved' : 'updated')
    }
    const addAssistant = (text: string, cut?: SessionCut) => {
      texts.push(text)
      add({ type: 'assistant', id: newId(), text, ts: now(), ...(cut ? { cut } : {}) })
    }
    const addNotice = (kind: NoticeKind, text: string = NOTICE_TEXT[kind]) => add({ type: 'notice', id: newId(), kind, text, ts: now() })
    // Once a turn: a reseed's second attempt that falls back again says nothing new.
    let unguardedNoticed = false
    const addError = (t: string, limit?: LimitHit) => {
      add({ type: 'error', id: newId(), text: redactPrivate(t, privateValues), ts: now(), ...(limit ? { limit } : {}) })
    }
    // The reset of the usage limit that rejected a request of this turn (null: unknown); a routine reads it off the error.
    let limitResets: number | null | undefined
    // The session last saved, and the one the CLI reported; a failed save is retried at the end.
    let savedSession = spec.sessionId
    let wantedSession: string | null | undefined
    // Per attempt: when its run started, and whether a result with a cost came back (else the usage log is searched).
    let attemptStart = 0
    let costSeen = false
    let baseline: Promise<ModelSpends | null> | null = null // read before the run starts: the run appends its own cost-state
    let costReport: Promise<void> = Promise.resolve()
    let spendKey = '' // this attempt's key for its live spend
    let spent = new Map<string, number>() // the highest price seen per request this attempt
    let attemptSession: string | null = null // from this attempt's init only, so a retry never inherits the last one's
    let attemptResume: string | null = null
    // This attempt's prompt uuid: a fresh one per attempt, since a reseed writes its prompt again under a new id.
    let attemptPrompt: string = randomUUID()
    // The last session-log entry the CLI wrote in this attempt: where the session can be cut to.
    let tip: string | null = null
    // Set while a cut run (resume + resume-at) is the attempt: the session id it resumed from.
    let cutFrom: string | null = null
    let forkIgnored: string | null | undefined // the CLI version, once --fork-session was seen to be ignored
    const saveSession = async (id: string | null) => {
      await spec.saveSession(id)
      savedSession = id
    }
    // Streamed text not yet covered by a complete assistant message; kept when the reply ends without one.
    let partial = ''
    const flushPartial = () => {
      if (partial) addAssistant(partial)
      partial = ''
    }

    // Event-driven saves are chained so the turn can await them before finishing.
    let pending: Promise<unknown> = Promise.resolve()
    const later = (fn: () => Promise<unknown>) => {
      pending = pending.then(fn).catch(() => {})
    }
    // The context meter, saved like the items: a save not yet started takes the latest, so a burst is one write.
    let window = spec.window ?? null
    let model: string | null = null
    let context: ContextUse | null = null
    let contextWaiting = false
    const saveContext = (next: ContextUse) => {
      context = next
      // The `keepWarm` cap: a ping warms a prompt cache, which a Codex thread has none of, so its contexts arm no slot.
      if (caps.keepWarm) {
        try {
          this.d.onContext?.(chatId, spec.agentName, next)
        } catch (err) {
          console.error('onContext failed', err)
        }
      }
      if (!spec.saveContext || contextWaiting) return
      contextWaiting = true
      later(() => {
        contextWaiting = false
        return spec.saveContext!(context!)
      })
    }
    // A save not yet started covers every event before it: a long chat is written once per burst, not once per event.
    let saveWaiting = false
    const saveAndPush = (clearStreaming: boolean) => {
      if (!saveWaiting) {
        saveWaiting = true
        // Reads the items when the save runs, so an item another writer appended meanwhile is not overwritten.
        later(() => {
          saveWaiting = false
          return store.saveItems(chatId, [...ref.get()])
        })
      }
      pushItems(clearStreaming)
    }
    // Set once the chat is loaded (its cwd is needed); events only arrive after that. Never built for the moderator or a Compact's tools.
    let tracker: FileTracker | null = null
    // The tracker's work already runs; only the save waits its turn, so the turn's final `await pending` covers it.
    const track = (p: Promise<{ itemId: string; change: FileChange } | null>) => {
      later(async () => {
        const hit = await p
        if (!hit) return
        patchTool(hit.itemId, (t) => ({ changes: [...(t.changes ?? []), hit.change] }))
        saveAndPush(false)
      })
    }
    // A Codex patch changes several files at once; they land on the one tool item together.
    const trackMany = (itemId: string, p: Promise<FileChange[]>) => {
      later(async () => {
        const got = await p
        if (got.length === 0) return
        patchTool(itemId, (t) => ({ changes: [...(t.changes ?? []), ...got] }))
        saveAndPush(false)
      })
    }
    const patchTool = (id: string, patch: (t: Extract<ChatItem, { type: 'tool' }>) => Partial<Extract<ChatItem, { type: 'tool' }>>) => {
      ref.set(ref.get().map((i) => (i.type === 'tool' && i.id === id && i.turn === spec.turnId ? { ...i, ...patch(i) } : i)))
    }

    // The agent lets a room's notification say who is waiting.
    const pushApprovals = () => this.pushPending(chatId, spec.author ?? spec.agentName)
    const blockTool = (toolUseId: string | null) => {
      if (toolUseId !== null) patchTool(toolUseId, () => ({ blocked: true }))
    }
    const setApproval = (id: string, status: ApprovalStatus) => {
      ref.set(ref.get().map((i) => (ownCard(i, id) ? { ...i, status } : i)))
    }
    const approvalOf = (id: string) => ref.get().find((i) => ownCard(i, id))
    const reply = (message: object): boolean => slot.handle?.send(message) ?? false
    // Ends every card still waiting: the CLI cannot be answered any more.
    const endPending = () => {
      if (slot.pending.size === 0) return
      for (const id of slot.pending.keys()) setApproval(id, 'unanswered')
      slot.pending.clear()
      saveAndPush(false)
      pushApprovals()
    }
    const allowedKeys = () => {
      let set = this.allowed.get(spec.allowScope)
      if (!set) {
        set = new Set()
        this.allowed.set(spec.allowScope, set)
      }
      return set
    }
    // Read when used, so a group member renamed mid-turn follows (spec.author). A single chat's agentName is fixed at
    // turn start: a rule saved after a rename mid-turn lands under the old name, which the next start's prune drops.
    const ruleAgent = () => spec.author ?? spec.agentName
    // Only the item's name and the field: the stamp, the ref and the item id are the browser's, not the chat's.
    const fillRowInput = (input: unknown): { item: string; field: string } => {
      const { item, field } = (input !== null && typeof input === 'object' ? input : {}) as { item?: unknown; field?: unknown }
      let name: string | null = null
      if (typeof item === 'string' && this.d.vaultItemName) {
        try {
          name = this.d.vaultItemName(item, ruleAgent())
        } catch {
          name = null
        }
      }
      return { item: name ?? 'unknown item', field: isFillField(field) ? field : 'unknown field' }
    }
    slot.answer = (requestId, decision) => {
      const p = slot.pending.get(requestId)
      if (!p) return
      // A question card needs answers, not a decision: chats:answer only knows Skip (deny); allow is ignored.
      if (p.toolName === QUESTION_TOOL) {
        if (decision === 'deny') slot.answerQuestions?.(requestId, null)
        return
      }
      // A plan is approved or sent back, never remembered: every allow-* is a plain approval.
      if (p.toolName === PLAN_TOOL) {
        slot.answerPlan?.(requestId, decision !== 'deny', null)
        return
      }
      slot.pending.delete(requestId)
      const item = approvalOf(requestId)
      let status: ApprovalStatus = 'unanswered'
      if (decision === 'deny') {
        if (reply(denyResponse(requestId, DENIED_BY_USER))) {
          status = 'denied'
          blockTool(item?.toolUseId ?? null)
          tap?.decided(requestId, { kind: 'deniedByUser' })
        }
      } else if (reply(allowResponse(requestId, p.input))) {
        // A delete (or a once-only ACP card) is allowed once whatever was pressed: its card offers no other choice, and no answer may remember it.
        // So is a step rule's refused tool, and Allow for this step outside a workflow room (the map holds only those).
        const held = this.workflowRules.get(chatId)
        // A rule the workflow couldn't keep (a long command, a 101st rule) would make every later save of it fail, so that call is only allowed once.
        // A connector write is remembered only while its Remember switch is on (read now, not at card time), and never for a step.
        const given =
          p.connector !== undefined && (decision === 'allow-step' || !this.d.connectorRemembers?.(p.connector)) ? 'allow-once' : decision
        const stepRule =
          given === 'allow-step' && held && !stepRuleRefused(p.toolName) ? stepRuleOf(p.toolName, p.shown ?? p.input, ruleAgent()) : null
        const kept =
          confirmOnly(p.toolName) || p.onceOnly
            ? 'allow-once'
            : given === 'allow-step' && (!stepRule || !stepRuleFits(stepRule, held ?? []))
              ? 'allow-once'
              : given
        status =
          kept === 'allow-chat'
            ? 'allowed-chat'
            : kept === 'allow-agent'
              ? 'allowed-agent'
              : kept === 'allow-step'
                ? 'allowed-step'
                : 'allowed-once'
        tap?.decided(requestId, {
          kind: 'approvedByUser',
          scope: kept === 'allow-chat' ? 'chat' : kept === 'allow-agent' ? 'agent' : kept === 'allow-step' ? 'step' : 'once'
        })
        if (kept === 'allow-chat') allowedKeys().add(allowKey(p.toolName, p.input))
        else if (kept === 'allow-agent') this.d.agentRules?.add(ruleAgent(), ruleOf(p.toolName, p.shown ?? p.input))
        else if (kept === 'allow-step' && held && stepRule) {
          this.workflowRules.set(chatId, withStepRule(held, stepRule))
          try {
            this.d.onStepRule?.(chatId, stepRule)
          } catch (err) {
            const code = (err as { code?: unknown } | null)?.code
            console.error('onStepRule failed', typeof code === 'string' ? code : 'error')
          }
        }
      }
      setApproval(requestId, status)
      saveAndPush(false)
      pushApprovals()
    }
    slot.answerQuestions = (requestId, answers) => {
      const p = slot.pending.get(requestId)
      if (!p) return
      slot.pending.delete(requestId)
      const item = approvalOf(requestId)
      let patch: Partial<Extract<ChatItem, { type: 'approval' }>> = { status: 'unanswered' }
      if (answers === null) {
        if (reply(denyResponse(requestId, SKIPPED_BY_USER))) {
          patch = { status: 'skipped' }
          blockTool(item?.toolUseId ?? null)
          tap?.decided(requestId, { kind: 'deniedByUser' }, { skipped: true })
        }
      } else if (reply(allowResponse(requestId, { ...(p.input as object), answers }))) {
        patch = { status: 'answered', answers }
        tap?.decided(requestId, { kind: 'approvedByUser', scope: 'once' }, { answers })
        spec.onAnswered?.()
      }
      ref.set(ref.get().map((i) => (ownCard(i, requestId) ? { ...i, ...patch } : i)))
      saveAndPush(false)
      pushApprovals()
    }

    slot.answerPlan = (requestId, approve, feedback) => {
      const p = slot.pending.get(requestId)
      if (!p) return
      slot.pending.delete(requestId)
      let patch: Partial<Extract<ChatItem, { type: 'approval' }>> = { status: 'unanswered' }
      // Approving sends the input back unchanged: the CLI's tool restores the earlier permission mode itself. A process that
      // started in plan mode has none, so the CLI would go on in `default` and ask before every edit: it gets the server's.
      // Only on an engine with the `plan` cap: one without sends no plan, so no card of its own could have started in it.
      const startedInPlan = caps.plan && spec.permissionMode === 'plan'
      if (approve) {
        const toMode = startedInPlan
          ? [{ type: 'setMode' as const, mode: this.d.permissionMode, destination: 'session' as const }]
          : undefined
        if (reply(allowResponse(requestId, p.input, toMode))) {
          patch = { status: 'approved' }
          tap?.decided(requestId, { kind: 'approvedByUser', scope: 'once' }, { approved: true })
          planApproved = true
          if (startedInPlan) {
            this.leavePlan(chatId).catch((err: unknown) => {
              const code = (err as { code?: unknown } | null)?.code
              console.error('plan mode not left:', typeof code === 'string' ? code : 'error')
            })
          }
        }
      } else if (reply(denyResponse(requestId, planSentBack(feedback)))) {
        patch = { status: 'sent-back', ...(feedback === null ? {} : { feedback }) }
        tap?.decided(requestId, { kind: 'deniedByUser' }, { approved: false, ...(feedback === null ? {} : { feedback }) })
      }
      if (patch.status !== 'unanswered') spec.onAnswered?.()
      ref.set(ref.get().map((i) => (ownCard(i, requestId) ? { ...i, ...patch } : i)))
      saveAndPush(false)
      pushApprovals()
    }

    // A tool whose card is still pending (or never answered) must not be marked blocked by later CLI events.
    const unansweredCard = (toolUseId: string) =>
      ref.get().some((i) => i.type === 'approval' && i.toolUseId === toolUseId && (i.status === 'pending' || i.status === 'unanswered'))

    // What the subagents this turn dispatches do; set just before the run starts. A /compact runs no tools.
    let dispatched: DispatchRecorder | null = null
    // The agent's own subagents running when a Stop (or a shutdown) was asked for. The CLI's SIGINT aborts its running
    // query first, so it may close them `failed` before it exits: still running at the end is not the only sign of a kill.
    // The pause's cap stops the handle itself, with nothing running, so it notes nothing.
    const atStop = new Set<string>()
    slot.onStop = () => {
      for (const d of dispatched?.entries() ?? []) if (d.parent === null && d.status === 'running') atStop.add(d.id)
    }
    // Pause, on main runs only (single chats and room members, never a Compact): the hook blocks the agent's own new
    // calls while the chat's flag exists. Per attempt: the agent's calls still open, and its responses ("rounds") in
    // which the hook blocked a call. Rounds, not calls: a response of parallel calls is blocked all at once, before the
    // agent has read a single block, and it must still get to write its status.
    // Claude's hook is a --settings; Codex's a hook on the app-server's argv (codexHooks below), so only while its cap is on.
    const claudePause =
      !spec.compact && engine === 'claude' && this.d.pauseHook && this.d.tmp
        ? { settings: this.d.pauseHook.settings, flag: this.d.tmp.pauseFlagOf(chatId) }
        : null
    const codexPause =
      !spec.compact && engine === 'codex' && caps.pause && this.d.codexPauseHook && this.d.tmp
        ? { hook: this.d.codexPauseHook, flag: this.d.tmp.pauseFlagOf(chatId) }
        : null
    const pause = claudePause ?? codexPause
    const openCalls = new Set<string>()
    let blockedRounds = 0
    // The response the latest main-thread calls came in: its API message id when the stream has one (on Codex, the id the
    // mapper gives each response), and whether a result came back since it began. The CLI runs tools while a response still streams, so a result can land between
    // two calls of one response: the id keeps them together. Without an id, a call after a result starts a new one.
    let round: { message: string | null; sawResult: boolean; blocked: boolean } | null = null
    let blockedNow = false // this event was a call the hook blocked: the only event that may reach the cap
    // Every main run, not a Compact (it runs no tools); the CLI keeps only the last --settings, so buildArgs merges them into one.
    const vaultGuard = !spec.compact && engine === 'claude' ? this.d.vaultGuard : undefined
    // Codex's: the same main runs, as hooks on the app-server's argv. Codex skips an untrusted hook silently, so the runner ends a
    // run before any thread unless codex lists them trusted; only then may the agent's API keys be in its env.
    const codexVault =
      engine === 'codex' && !spec.compact && caps.vaultKeys && this.d.codexVaultHooks?.length ? this.d.codexVaultHooks : null
    // The pause hook goes with them, one set trusted and checked together, so a run has both or (after a failed check) neither.
    const codexHooks = codexVault || codexPause ? [...(codexVault ?? []), ...(codexPause ? [codexPause.hook] : [])] : null
    let capStopped = false // the server ended the run for the pause: no stopped notice, finishPause adds its own
    const notePause = (e: RunEvent) => {
      blockedNow = false
      if (e.kind === 'toolUse') {
        const message = e.message ?? null
        const fresh = round === null || (message !== null && round.message !== null ? message !== round.message : round.sawResult)
        if (fresh) round = { message, sawResult: false, blocked: false }
        openCalls.add(e.id)
      } else if (e.kind === 'toolResult') {
        openCalls.delete(e.toolUseId)
        round ??= { message: null, sawResult: false, blocked: false }
        round.sawResult = true
        if (e.isError && e.content.includes(PAUSE_MARKER) && this.pauseFlags.has(chatId)) {
          blockedNow = true
          if (!round.blocked) {
            round.blocked = true
            blockedRounds++
          }
        }
      }
    }
    // An agent that keeps trying tools never ends on its own. Judged only on a block, never when an allowed call closes:
    // after its last result the agent always gets a request to read it and write its status. Stopping is safe only with
    // nothing mid-flight: none of its own calls (a parallel one the hook let through before the pause) and no subagent.
    const pauseCap = () => {
      if (capStopped || blockedRounds < PAUSE_BLOCK_CAP || openCalls.size > 0 || !slot.handle) return
      if (dispatched?.entries().some((d) => d.status === 'running')) return
      capStopped = true
      slot.handle.stop()
    }
    const onRunEvent = (e: RunEvent) => {
      // The CLI runs, so it has its message: the note (or the rewind that made it moot) is spent. Not at spawn: a spawn
      // error (a missing folder) only shows at the end, and that run told the agent nothing.
      if (lostStored && !lostClearing) {
        lostClearing = true
        later(async () => {
          if (await saveLost(null)) lostStored = false
        })
      }
      // Once the fork was ignored the run is being stopped; nothing it still sends may be recorded or stamped.
      if (forkIgnored !== undefined) return
      dispatched?.event(e)
      tap?.event(e)
      if (pause) notePause(e)
      if (e.kind === 'entry') clean.entry(e.uuid)
      else if (e.kind === 'toolUse') clean.toolUse(e.id)
      else if (e.kind === 'toolResult') clean.toolResult(e.toolUseId)
      // Not on Codex: its only entry is the running turn's own id, which comes as the turn ends; its base keeps the turn it started from.
      if (sideBase && engine === 'claude') {
        const at = clean.get()
        sideBase.live = attemptSession !== null && at !== null ? { session: attemptSession, at } : null
      }
      switch (e.kind) {
        case 'init':
          // The same id after a cut run means the original session may be written to: stop before it is.
          if (cutFrom !== null && e.sessionId === cutFrom) {
            forkIgnored = e.version ?? null
            slot.handle?.stop()
            break
          }
          // A remote agent's handle starts one run per interrupt round, each on the same thread: a repeat has nothing new.
          if (e.sessionId === attemptSession) break
          wantedSession = e.sessionId
          attemptSession = e.sessionId
          if (sideBase && engine === 'claude' && clean.get() !== null) sideBase.live = { session: e.sessionId, at: clean.get()! }
          if (e.sessionId !== savedSession) later(() => saveSession(e.sessionId))
          break
        case 'entry':
          tip = e.uuid
          break
        case 'textDelta':
          partial += e.text
          push({ chatId, kind: 'delta', text: e.text, ...by() })
          break
        case 'thinkingDelta':
          if (thinkStart === null) thinkStart = now()
          push({ chatId, kind: 'delta', text: e.text, thought: true, ...by() })
          break
        case 'thinking': {
          const end = now()
          add({ type: 'thinking', id: newId(), text: e.text, ts: Math.min(e.startedAt ?? thinkStart ?? end, end), doneTs: end })
          thinkStart = null
          // Clears the live thought it replaces; the block ends before any reply text of its request streams.
          saveAndPush(true)
          break
        }
        case 'assistantText':
          partial = ''
          // Never on Codex: its one entry is the turn's own id, sent as the turn ends, so the turn's end stamp is its only cut point.
          addAssistant(
            e.text,
            engine === 'claude' && typeof wantedSession === 'string' && tip !== null ? { session: wantedSession, at: tip } : undefined
          )
          saveAndPush(true)
          break
        case 'toolUse':
          // The list is the panel's: its calls show as the reply's to-do lines (the touch), never as rows.
          if (ownTodo(e.name)) {
            todoUses.add(e.id)
            break
          }
          noteMemoryUse(e.id, e.name, e.input)
          add({
            type: 'tool',
            id: e.id,
            name: e.name,
            input: e.name === FILL_TOOL ? fillRowInput(e.input) : browserTool(e.name) ? {} : e.input,
            result: null,
            isError: false,
            blocked: false,
            ts: now()
          })
          saveAndPush(false)
          break
        case 'toolResult':
          if (todoUses.delete(e.toolUseId)) break
          noteMemoryResult(e.toolUseId, e.isError)
          patchTool(e.toolUseId, (tool) => ({
            result:
              tool.name === FILL_TOOL
                ? fillResultLine(e.content, e.isError)
                : browserTool(tool.name)
                  ? e.isError
                    ? 'Browser command failed.'
                    : 'Browser command completed.'
                  : desktopTool(tool.name)
                    ? e.isError
                      ? 'Desktop command failed.'
                      : 'Desktop command completed.'
                    : // Only the count and the names: the rest of an item (user, sites, variable) is not the chat's to keep.
                      tool.name === VAULT_ITEMS_TOOL
                      ? vaultRowResult(e.content, e.isError)
                      : e.content,
            isError: e.isError,
            doneTs: now(),
            ...(e.isError && e.content === APPROVAL_REQUIRED && !unansweredCard(e.toolUseId) ? { blocked: true } : {})
          }))
          saveAndPush(false)
          if (tracker && !e.isError) {
            const item = ref.get().find((i) => i.type === 'tool' && i.id === e.toolUseId && i.turn === spec.turnId)
            if (item?.type === 'tool' && (item.name === 'Edit' || item.name === 'Write')) {
              const itemId = item.id
              track(tracker.own(item, e.detail).then((change) => (change ? { itemId, change } : null)))
            } else if (item?.type === 'tool' && item.name === 'ApplyPatch') {
              trackMany(item.id, tracker.ownPatch(item, e.detail))
            } else if (item?.type === 'tool' && item.name === 'AcpEdit' && engine === 'acp') {
              // An ACP diff is a whole file's old and new text, or a hunk of it; the file on disk settles which (exact copies or none).
              trackMany(item.id, tracker.ownAcp(item, e.detail))
            }
          }
          break
        case 'subToolUse':
          tracker?.subUse(e)
          break
        case 'subToolResult': {
          // Called here, not in the chain: its disk read must start before the subagent's next step can change the file.
          // A Codex subagent's patch lands its changes as the main thread's do; anything else is a Claude subagent's Edit/Write.
          const patch = tracker?.subPatch(e) ?? null
          if (patch) trackMany(patch.itemId, patch.changes)
          else if (tracker) track(tracker.subResult(e))
          break
        }
        case 'permissionRequest': {
          // The to-do tools only touch this chat's list, and the user can undo any change in the panel: no card, rule or risk hint.
          if (ownTodo(e.toolName)) {
            reply(allowResponse(e.requestId, e.input))
            tap?.decided(e.requestId, { kind: 'allowedByZumiBot', why: 'todos' })
            break
          }
          // The vault tool only lists what the user granted this agent, without a secret: no card, rule or risk hint.
          if (ownVault(e.toolName)) {
            reply(allowResponse(e.requestId, e.input))
            tap?.decided(e.requestId, { kind: 'allowedByZumiBot', why: 'vault' })
            break
          }
          // An ask runs nothing itself: every tool the asked agent uses goes through that agent's own approvals.
          if (ownAsk(e.toolName)) {
            reply(allowResponse(e.requestId, e.input))
            tap?.decided(e.requestId, { kind: 'allowedByZumiBot', why: 'ask' })
            break
          }
          // Zumi Bot's reads, saves and edits: the bridge refuses a write the user did not send, and the user sees every change.
          if (ownAutomation(e.toolName)) {
            reply(allowResponse(e.requestId, e.input))
            tap?.decided(e.requestId, { kind: 'allowedByZumiBot', why: 'automation' })
            break
          }
          // list, logs, wait and stop touch only this chat's processes and start nothing: no card, rule or risk hint.
          if (ownProcess(e.toolName)) {
            reply(allowResponse(e.requestId, e.input))
            break
          }
          // Refused before any card while the turn still plans: the bridge would refuse it after the user's yes.
          if (processBridged && e.toolName === PROCESS_START_TOOL && planning()) {
            reply(denyResponse(e.requestId, PROCESS_REFUSALS.plan))
            break
          }
          // A delete in a turn the user did not type is refused before any card: the bridge would refuse it after the user's yes.
          if (automationBridged && !automationWritable && confirmOnly(e.toolName)) {
            reply(denyResponse(e.requestId, WRITE_REFUSED))
            tap?.decided(e.requestId, { kind: 'deniedByZumiBot', why: 'writeRefused' })
            break
          }
          // Nobody reads an A→B chat live: the asked agent's question goes back to the asker in its reply instead.
          if (spec.questionsDenied !== undefined && e.toolName === QUESTION_TOOL) {
            reply(denyResponse(e.requestId, spec.questionsDenied))
            tap?.decided(e.requestId, { kind: 'deniedByZumiBot', why: 'questionsDenied' })
            break
          }
          // A sandboxed agent's fetch: an off-list host is refused with a line, never a card, so no approval can widen the list
          // mid-turn. An on-list one runs without a card only in auto mode; otherwise it gets its usual card below.
          if (sandboxNet !== null && e.toolName === 'WebFetch') {
            const host = hostOfFetch(e.input)
            if (host === null || !hostAllowed(host, sandboxNet)) {
              reply(denyResponse(e.requestId, WEBFETCH_BLOCKED(host ?? 'that address')))
              tap?.decided(e.requestId, { kind: 'deniedBySandbox', target: host })
              break
            }
            if (sandboxAutoFetch) {
              reply(allowResponse(e.requestId, e.input))
              tap?.decided(e.requestId, { kind: 'allowedByAllowlist', host })
              break
            }
          }
          // A repeated id must not add a second card or answer twice.
          if (slot.pending.has(e.requestId) || approvalOf(e.requestId)) break
          // A claude.ai connector's call: a read never asks, a write in a run the user did not type is refused before any card, and a
          // write the user can answer asks (its memory applies only while the service's Remember switch is on).
          const call = connectorCallOf(e.toolName, runPrefixes)
          let remembering = false
          if (call) {
            // The CLI denies an off connector already; this is the belt, ahead of every other branch, with no card.
            if (runOff.includes(call.id)) {
              reply(denyResponse(e.requestId, offRefusal(call.id)))
              tap?.decided(e.requestId, { kind: 'deniedByZumiBot', why: 'connectorOff' })
              break
            }
            if (isReadTool(call.id, call.tool)) {
              reply(allowResponse(e.requestId, e.input))
              tap?.decided(e.requestId, { kind: 'allowedByZumiBot', why: 'connectorRead' })
              break
            }
            if (spec.auto) {
              reply(denyResponse(e.requestId, unattendedRefusal(call.id, call.tool)))
              tap?.decided(e.requestId, { kind: 'deniedByZumiBot', why: 'connectorUnattended' })
              break
            }
            remembering = this.d.connectorRemembers?.(call.id) === true
          }
          const memoryAllowed = !call || remembering
          // The card, a risk hint and a remembered rule are copies that get stored or shown: scrubbed. The CLI is answered
          // with the raw input (slot.pending), or an approved command would run with a label where its key should be.
          const shownInput = scrubValue(e.input, scrub)
          const shownText = (t: string | null): string | null => (t === null ? null : scrubText(t, scrub))
          const base = {
            type: 'approval' as const,
            id: e.requestId,
            toolUseId: e.toolUseId,
            toolName: e.toolName,
            input: browserTool(e.toolName) ? {} : shownInput,
            description: browserTool(e.toolName) ? null : shownText(e.description),
            reason: browserTool(e.toolName) ? null : shownText(e.reason),
            ts: now(),
            ...(call ? { connector: { id: call.id, tool: call.tool, remember: remembering } } : {})
          }
          // Places a card right after its own tool row, else appends.
          const place = (card: ChatItem) => {
            const items = ref.get()
            const item = stamp(card)
            const at = e.toolUseId === null ? -1 : items.findIndex((i) => i.type === 'tool' && i.id === e.toolUseId)
            ref.set(at < 0 ? [...items, item] : [...items.slice(0, at + 1), item, ...items.slice(at + 1)])
          }
          // A question needs the user's own answers and a plan the user's own decision: chat memory and agent rules never auto-allow them.
          // Nor a routine or workflow delete (by its name, whoever serves it), which is the user's yes each time.
          const needsUser = e.toolName === QUESTION_TOOL || e.toolName === PLAN_TOOL
          const askEveryTime = needsUser || confirmOnly(e.toolName)
          // An ACP call no rule may hold (an unclassified call, or an edit whose paths leave the chat's folder): asked every time
          // with Allow once and Deny only. Judged on the raw input the agent is answered for, never the scrubbed copy.
          const onceOnly = !needsUser && engine === 'acp' && !acpRememberable(e.toolName, e.input, runCwd)
          const remembered = !askEveryTime && !onceOnly
          const card = onceOnly ? { ...base, onceOnly: true as const } : base
          if (r.reason) {
            // Stop already pressed: nobody can answer any more, so no live card.
            place({ ...card, status: 'unanswered' })
          } else if (remembered && memoryAllowed && this.allowed.get(spec.allowScope)?.has(allowKey(e.toolName, e.input))) {
            place({ ...card, status: reply(allowResponse(e.requestId, e.input)) ? 'auto-allowed' : 'unanswered' })
            tap?.decided(e.requestId, { kind: 'allowedByChatRule' })
          } else if (remembered && memoryAllowed && this.d.agentRules?.has(ruleAgent(), agentAllowKey(e.toolName, shownInput))) {
            place({ ...card, status: reply(allowResponse(e.requestId, e.input)) ? 'auto-allowed-agent' : 'unanswered' })
            tap?.decided(e.requestId, { kind: 'allowedByAgentRule', rule: agentAllowKey(e.toolName, shownInput) })
          } else if (remembered && !call && stepRulesAllow(this.workflowRules.get(chatId) ?? [], ruleAgent(), e.toolName, shownInput)) {
            place({ ...card, status: reply(allowResponse(e.requestId, e.input)) ? 'auto-allowed-workflow' : 'unanswered' })
            tap?.decided(e.requestId, { kind: 'allowedByWorkflowRule' })
          } else {
            place({ ...card, status: 'pending' })
            slot.pending.set(e.requestId, {
              toolName: e.toolName,
              input: e.input,
              shown: shownInput,
              ...(onceOnly ? { onceOnly: true as const } : {}),
              ...(call ? { connector: call.id } : {})
            })
            saveAndPush(false)
            pushApprovals()
            // A question or a plan runs nothing, so it has no risk to guess; a delete's card already names exactly what goes.
            if (this.d.approvalRisk && !askEveryTime && !browserTool(e.toolName)) {
              const { requestId } = e
              this.d
                .approvalRisk(chatId, {
                  toolName: e.toolName,
                  input: riskInput(e.toolName, shownInput),
                  description: shownText(e.description),
                  reason: shownText(e.reason)
                })
                .then(
                  (risk) => {
                    // Too late once answered: the guess only helps while the user decides.
                    if (!risk || !slot.pending.has(requestId)) return
                    ref.set(ref.get().map((i) => (ownCard(i, requestId) ? { ...i, risk } : i)))
                    saveAndPush(false)
                  },
                  () => {}
                )
            }
            break
          }
          saveAndPush(false)
          break
        }
        case 'permissionCancel':
          if (slot.pending.delete(e.requestId)) {
            tap?.decided(e.requestId, { kind: 'unanswered' })
            setApproval(e.requestId, 'unanswered')
            saveAndPush(false)
            pushApprovals()
          }
          break
        case 'controlUnknown':
          if (e.requestId !== null) reply(errorResponse(e.requestId, UNKNOWN_REQUEST_ERROR))
          addError(`The CLI sent a request ZumiBot does not handle (${e.subtype || 'unknown'}).`)
          saveAndPush(false)
          break
        case 'denied':
          // Only the classifier's refusal is marked: a deny rule, a hook or the user's own Deny is not ours to override.
          if (e.reasonType === 'classifier') {
            patchTool(e.toolUseId, () => ({ blocked: true, blockedBy: 'classifier' }))
            saveAndPush(false)
          }
          break
        case 'result': {
          if (e.cost) {
            costSeen = true
            // The exact cost replaces the estimate: dropped first, so no check meanwhile counts both (a short undercount is safer).
            try {
              this.d.spend?.ended(spendKey)
            } catch (err) {
              console.error('spend cap end failed', err)
            }
            const run = {
              id: e.uuid ?? this.d.newId(),
              chatId,
              agent: ruleAgent(),
              sessionId: e.sessionId || attemptSession || null,
              window: [attemptStart, now()] as [number, number]
            }
            const report = (cost: RunCost) => {
              try {
                this.d.onRunCost?.({ ...run, cost })
              } catch (err) {
                console.error('onRunCost failed', err)
              }
            }
            const cost = e.cost
            if (baseline) costReport = baseline.then((b) => report(minusBaseline(cost, b)))
            else report(cost)
          }
          const denied = new Set(e.denials.map((x) => x.toolUseId))
          ref.set(ref.get().map((i) => (i.type === 'tool' && denied.has(i.id) && !unansweredCard(i.id) ? { ...i, blocked: true } : i)))
          saveAndPush(false)
          const reported = windowOf(e.windows, model)
          if (reported !== undefined && reported !== window) {
            window = reported
            if (context) saveContext({ ...context, window })
          }
          break
        }
        case 'context':
          model = e.model ?? model
          saveContext({ used: e.tokens, window, at: now() })
          break
        case 'spend': {
          // Repeated on each content block line with the usage so far: only the growth is new.
          const before = spent.get(e.id) ?? 0
          if (e.usd > before) {
            spent.set(e.id, e.usd)
            try {
              this.d.spend?.live({ chatId, agent: ruleAgent(), attempt: spendKey, usd: e.usd - before, message: turnMessage })
            } catch (err) {
              console.error('spend cap check failed', err)
            }
          }
          break
        }
        case 'compacted':
          // Codex never reports the size after a compaction (and the one before is 0 in a compaction's own process), so its
          // meter names none rather than "0 → 0".
          saveContext({ used: null, window, ...(engine === 'claude' ? { compacted: { pre: e.pre, post: e.post } } : {}), at: now() })
          break
        case 'compacting':
          if (spec.setCompacting) later(() => spec.setCompacting!(e.on))
          break
        case 'limited':
          limitResets = e.resetsAt
          break
        case 'notice':
          // A remote run's fixed sentence (an approval it could not show, tools it asked for), scrubbed like every event.
          addNotice('remote', e.text)
          saveAndPush(false)
          break
      }
      // After the event is recorded, so the blocked call that reached the cap is in the items.
      if (pause && blockedNow) pauseCap()
    }

    // Every parsed event passes here first: vault values never reach the items, the feed, the dispatch record or a log. Text deltas
    // keep a short tail back, so a value split across two of them is caught; it goes out before the message or result that follows.
    const flushDeltas = () => {
      const rest = deltas.flush()
      if (rest) onRunEvent({ kind: 'textDelta', text: rest })
    }
    const flushThoughts = () => {
      const rest = thoughts.flush()
      if (rest) onRunEvent({ kind: 'thinkingDelta', text: rest })
    }
    const onEvent = (event: RunEvent) => {
      let raw = event
      if (container && raw.kind === 'toolResult') {
        const hosts = container.drainDenied()
        if (hosts.length > 0) raw = { ...raw, content: withNetBlocks(raw.content, hosts) }
      }
      if (scrub.size === 0) return onRunEvent(raw)
      if (raw.kind === 'textDelta') {
        const text = deltas.push(raw.text)
        if (text) onRunEvent({ kind: 'textDelta', text })
        return
      }
      if (raw.kind === 'thinkingDelta') {
        const text = thoughts.push(raw.text)
        if (text) onRunEvent({ kind: 'thinkingDelta', text })
        return
      }
      if (raw.kind === 'assistantText' || raw.kind === 'result') flushDeltas()
      if (raw.kind === 'thinking' || raw.kind === 'result') flushThoughts()
      onRunEvent(scrubEvent(raw, scrub))
    }

    // A logical turn never rebinds to a replacement identity after clear/delete.
    // Renames retain this profile; each CLI attempt still gets its own capability.
    let browserProfileId: string | null | undefined
    let desktopPlan: DesktopPlan | undefined
    // A handoff becomes a card through the current ref and counts as waiting; a desktop's card carries its surface.
    const handoffCard = (surface?: 'desktop') => async (handoff: BrowserHandoff) => {
      const same = (i: ChatItem): i is Extract<ChatItem, { type: 'browser-action' }> =>
        i.type === 'browser-action' && i.surface === surface && i.id === handoff.id && i.handoff.turnId === handoff.turnId
      const card: ChatItem = {
        type: 'browser-action',
        id: handoff.id,
        ts: handoff.createdAt,
        agent: handoff.agent,
        handoff: { ...handoff },
        ...(surface ? { surface } : {}),
        ...(spec.turnId === undefined ? {} : { turn: spec.turnId })
      }
      ref.set(
        ref.get().some(same)
          ? ref.get().map((i) => (same(i) ? { ...i, agent: handoff.agent, handoff: { ...handoff } } : i))
          : [...ref.get(), card]
      )
      if (handoff.status === 'pending') slot.browserPending.add(handoff.id)
      else slot.browserPending.delete(handoff.id)
      saveAndPush(false)
      pushApprovals()
      await pending
    }
    // A vault approval request becomes a card the same way, under the attempt's turn id; once the attempt is over it writes nothing.
    const vaultCard = (open: { value: boolean }) => async (request: VaultApprovalRequest) => {
      if (!open.value) return
      const same = (i: ChatItem): i is Extract<ChatItem, { type: 'vault-approval' }> => i.type === 'vault-approval' && i.id === request.id
      const card: ChatItem = {
        type: 'vault-approval',
        id: request.id,
        ts: now(),
        agent: spec.author ?? spec.agentName,
        request: { ...request },
        ...(spec.turnId === undefined ? {} : { turn: spec.turnId })
      }
      ref.set(ref.get().some(same) ? ref.get().map((i) => (same(i) ? { ...i, request: { ...request } } : i)) : [...ref.get(), card])
      if (request.status === 'pending') slot.vaultPending.add(request.id)
      else slot.vaultPending.delete(request.id)
      saveAndPush(false)
      pushApprovals()
      await pending
    }
    // What a turn that ends leaves behind: its waiting vault cards read interrupted, never pending.
    const closeVaultCards = (turnId: string) => {
      const counted = slot.vaultPending.size > 0
      slot.vaultPending.clear()
      const mine = (i: ChatItem): i is Extract<ChatItem, { type: 'vault-approval' }> =>
        i.type === 'vault-approval' && i.request.turnId === turnId && i.request.status === 'pending'
      const changed = ref.get().some(mine)
      if (changed) ref.set(ref.get().map((i) => (mine(i) ? { ...i, request: { ...i.request, status: 'interrupted' } } : i)))
      // The card callback is closed by now, so nobody else tells the client, the notifier or a routine that nothing waits any more.
      if (changed || counted) {
        saveAndPush(false)
        pushApprovals()
      }
    }
    const attempt = async (
      bin: string,
      cwd: string,
      resumeId: string | null,
      prompt: UserContent,
      system: string,
      resumeAt?: string
    ): Promise<RunOutcome> => {
      tip = null
      clean = new CleanPoint()
      costSeen = false
      baseline = null
      costReport = Promise.resolve()
      spendKey = `${chatId}:${++this.spendSeq}` // not newId(): ids of items stay as they were
      spent = new Map()
      attemptSession = null
      attemptResume = resumeId
      attemptPrompt = randomUUID()
      cutFrom = resumeId !== null && resumeAt !== undefined ? resumeId : null
      todoBridged = false
      vaultBridged = false
      askBridged = false
      automationBridged = false
      sandboxNet = null
      container = null
      processBridged = false
      runPrefixes = {}
      runOff = []
      blockedRounds = 0
      round = null
      openCalls.clear()
      if (r.reason) {
        return { exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: true }
      }
      if (sideBase?.codex) Object.assign(sideBase.codex, codexPoint(resumeId === null ? null : start))
      else if (sideBase) sideBase.start = resumeId === null ? null : start
      runCwd = cwd
      let browser: BrowserTurn | undefined
      let desktop: DesktopTurn | undefined
      let todo: TodoTurn | null = null
      let vault: VaultTurn | null = null
      let ask: AskTurn | null = null
      let automation: AutomationTurn | null = null
      let proc: ProcessTurn | null = null
      // One id for the browser turn and the vault's approvals: the fill call runs in the browser manager under it.
      const turnId = randomUUID()
      const vaultOpen = { value: true }
      const unregisterVault = this.d.vaultApprovals?.registerTurn(turnId, vaultCard(vaultOpen))
      try {
        // The browser is a bridge: an engine without `bridges` (ACP) gets none, not even the unavailable prompt.
        if (this.d.browserTurns && caps.bridges) {
          if (browserProfileId === undefined) browserProfileId = await this.d.browserTurns.profileId(ruleAgent(), chatId)
          const profileId = browserProfileId
          browser = profileId === null ? noBrowserTurn() : await this.d.browserTurns.create({ profileId, chatId, turnId }, handoffCard())
          slot.disposeBrowser = () => browser!.dispose()
          notePrivateValues(privateValues, 'browser', browser.env)
        }
        // The `desktop` cap: off for Codex until its guards are proven there, so that agent's run gets no desktop, whatever its file says.
        if (this.d.desktopTurns && caps.desktop) {
          // Planned once, like the browser profile: a retry after a clear, delete or rename never rebinds.
          desktopPlan ??= await this.d.desktopTurns.plan(ruleAgent(), chatId)
          const plan = desktopPlan
          if (plan !== 'off') {
            desktop =
              plan === 'unavailable'
                ? noDesktopTurn()
                : await this.d.desktopTurns.create({ profileId: plan.profileId, chatId, turnId: randomUUID() }, handoffCard('desktop'))
            slot.disposeDesktop = () => desktop!.dispose()
            notePrivateValues(privateValues, 'desktop', desktop.env)
          }
        }
        if (r.reason) return { exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: true }
        // An ACP agent's launch, read and checked on every attempt (a reseed too), so an edit outside Agent Studio between two
        // attempts is refused as well. Its refusal ends the attempt before anything is spawned.
        let acpOwn: { bin: string; launch: AcpLaunch; body: string } | null = null
        if (engine === 'acp') {
          const l = await this.acpLaunch(spec.agentName)
          if ('error' in l) return { exitCode: null, signal: null, stderr: '', spawnError: l.error, result: null, stopped: false }
          acpOwn = l
        }
        // A remote agent's launch and turn, the same way; its thread is read per attempt too, as the last run kept it.
        let aguiOwn: { endpoint: string; launch: AguiLaunch; thread: AguiThread | null } | null = null
        if (engine === 'ag-ui') {
          const l = await aguiCheck()
          if ('error' in l) return { exitCode: null, signal: null, stderr: '', spawnError: l.error, result: null, stopped: false }
          const thread = await this.d.agui!.thread.load(chatId).catch((err: unknown) => {
            // Only the code: an fs error names the data folder. A thread that can't be read starts afresh.
            const code = (err as { code?: unknown } | null)?.code
            console.error('remote agent thread not read:', typeof code === 'string' ? code : 'error')
            return null
          })
          aguiOwn = { ...l, thread }
        }
        // Read per attempt, so an Agent Studio change applies from the next turn. Env changes no prompt, so the cache holds.
        const compactAt = this.d.compactWindow ? await this.d.compactWindow(spec.agentName).catch(() => null) : null
        const compactEnv = compactAt !== null && engine === 'claude' ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactAt) } : undefined
        // Codex takes it as a thread config key instead, only while its Compact is on and only below the model's window. A turn
        // that starts its thread afresh may hold another engine's window (a Claude session the agent left), so none is known there.
        const codexCompactAt =
          engine === 'codex' && caps.compact ? codexCompactLimit(compactAt, spec.reseed || spec.sessionId === null ? null : window) : null
        // Also per attempt, so a Save in Agent Studio applies from the next run; a Compact too, so its tools match the session's.
        const own = engine === 'claude' ? await this.runConfigOf(spec.agentName) : NO_RUN_CONFIG
        const ownEnv = Object.keys(own.env).length > 0 ? own.env : undefined
        // The rules the user granted after Auto's classifier refused a call, read per attempt so a grant applies from the next turn.
        // Main runs only (a Compact runs no tools; side runs build from the base, not from this spawn). The agent is the room member's.
        const runModeNow = runMode(this.d.permissionMode, spec.permissionMode)
        const allowArgs =
          engine === 'claude' && !spec.compact
            ? allowSettingsArgs(
                (await this.d.store.get(chatId).catch(() => null))?.allowRules,
                this.d.agentRules?.cli(ruleAgent()) ?? [],
                runModeNow
              )
            : []
        runPrefixes = own.connectorPrefixes
        runOff = own.connectorsOff
        // On every attempt, used or not: tools that come and go between turns would change the cached prompt prefix.
        // The owner's agent is read per call, so a room member renamed mid-turn acts under its new name.
        // None for an engine without `bridges` (ACP): it gets none of ZumiBot's own servers.
        if (caps.bridges) todo = this.todoTurn({ chatId, agent: ruleAgent, turn: todoKey, label: turnLabel })
        todoBridged = todo !== null
        for (const value of [todo?.env.ZUMIBOT_TODOS_CAPABILITY, todo?.env.ZUMIBOT_TODOS_IPC])
          if (value) privateValues.set(value, '[private browser value]')
        // The same for the vault, whatever the agent may use: its answer depends on the grants, its definition never does.
        if (caps.bridges) vault = this.vaultTurn({ chatId, agent: ruleAgent, turn: todoKey })
        vaultBridged = vault !== null
        for (const value of [vault?.env.ZUMIBOT_VAULT_CAPABILITY, vault?.env.ZUMIBOT_VAULT_IPC])
          if (value) privateValues.set(value, '[private browser value]')
        // Also on every attempt, under the turn's key, so the per-turn ask limit spans a reseed retry.
        if (askable)
          ask = this.askTurn({
            chatId,
            agent: ruleAgent,
            chain: spec.askChain ?? [],
            turn: todoKey,
            ...(spec.auto ? { auto: true as const } : {})
          })
        askBridged = ask !== null
        for (const value of [ask?.env.ZUMIBOT_ASKS_CAPABILITY, ask?.env.ZUMIBOT_ASKS_IPC])
          if (value) privateValues.set(value, '[private browser value]')
        // Zumi Bot's, also on every attempt, so its tools never come and go between turns. Whether it may write is the turn's.
        if (automatable) automation = this.automationTurn({ chatId, writable: automationWritable })
        automationBridged = automation !== null
        for (const value of [automation?.env.ZUMIBOT_AUTOMATIONS_CAPABILITY, automation?.env.ZUMIBOT_AUTOMATIONS_IPC])
          if (value) privateValues.set(value, '[private browser value]')
        // On every attempt of an engine with the cap, a Compact too, so the tools never come and go between a chat's turns.
        // Never for a sandboxed or contained agent: its processes run on the host, outside the isolation (governance.md 2.3, 2.4).
        if (caps.processes && caps.bridges && isolationOf() === 'off')
          proc = this.processTurn({ chatId, agent: ruleAgent, turn: todoKey, planning })
        processBridged = proc !== null
        for (const value of [proc?.env.ZUMIBOT_PROCESSES_CAPABILITY, proc?.env.ZUMIBOT_PROCESSES_IPC])
          if (value) privateValues.set(value, '[private browser value]')
        // The agent's API keys: env for a main run only (a Compact runs no tools), but the values are scrubbed from a Compact's output too.
        const keys = this.vaultKeys(ruleAgent())
        scrub = keys.scrub
        deltas = new DeltaScrubber(scrub)
        thoughts = new DeltaScrubber(scrub)
        thinkStart = null
        for (const [value, label] of scrub) privateValues.set(value, label)
        // An ACP agent's own sign-in keys (`acp.authEnv`): each must be granted, or the send fails naming it, never a value.
        const acpKeys = acpOwn?.launch.authEnv ?? []
        const keyMissing = acpKeys.find((name) => !Object.hasOwn(keys.env, name))
        if (keyMissing !== undefined)
          return { exitCode: null, signal: null, stderr: '', spawnError: ACP_TEXT.authEnvMissing(keyMissing), result: null, stopped: false }
        // A remote agent's auth key (`agui.authKey`): granted, and fit for a header, or the send fails naming it, never a value.
        const authKey = aguiOwn?.launch.authKey ?? null
        if (authKey !== null && !Object.hasOwn(keys.env, authKey))
          return { exitCode: null, signal: null, stderr: '', spawnError: AGUI_TEXT.authKeyMissing(authKey), result: null, stopped: false }
        if (authKey !== null && keyUnusable(keys.env[authKey]))
          return { exitCode: null, signal: null, stderr: '', spawnError: AGUI_TEXT.authKeyUnusable(authKey), result: null, stopped: false }
        // On Codex only beside the vault guard's hooks, and never under a name codex reads for itself; the output is still
        // scrubbed of every value either way.
        let keyEnv: Record<string, string> | undefined
        if (spec.compact || Object.keys(keys.env).length === 0) keyEnv = undefined
        else {
          switch (engine) {
            case 'claude':
              keyEnv = keys.env
              break
            case 'codex': {
              if (!codexVault) {
                keyEnv = undefined
                break
              }
              const kept = Object.entries(keys.env).filter(([name]) => !isCodexOwnEnv(name))
              if (kept.length < Object.keys(keys.env).length)
                console.error('vault API keys left out of a Codex run: their names are reserved by codex')
              keyEnv = kept.length ? Object.fromEntries(kept) : undefined
              break
            }
            // No guard stands beside an ACP agent (`vaultKeys` off): only the keys its own sign-in names, under their own names.
            case 'acp':
              keyEnv = acpKeys.length ? Object.fromEntries(acpKeys.map((name) => [name, keys.env[name]])) : undefined
              break
            // Nothing runs here for a remote agent: its auth key goes in one request header, and no key is env.
            case 'ag-ui':
              keyEnv = undefined
              break
            default:
              keyEnv = assertNever(engine)
          }
        }
        attemptStart = now()
        // An unreadable log keeps the CLI's totals: too much is better than a run that cost nothing.
        // A Codex result's cost is the turn's own already.
        baseline = resumeId !== null && engine === 'claude' && this.d.costBaseline ? this.d.costBaseline(resumeId).catch(() => null) : null
        // Made on every attempt: the folder may have been removed since the last one. A failure costs the run only the folder.
        let tmpDir: string | null = null
        if (this.d.tmp && engine === 'claude') {
          try {
            tmpDir = await this.d.tmp.ensure(chatId)
          } catch (err) {
            const code = (err as { code?: unknown } | null)?.code
            console.error('chat temp folder not made:', typeof code === 'string' ? code : 'error')
          }
        }
        // A sandboxed agent's run gets the sandbox's settings, or is refused (never run unsandboxed). Side runs block every tool
        // by their own guard, and a Compact runs none, so neither needs it. Every engine asks: one without the `isolation` cap
        // (Codex, ACP, a remote agent) is refused here when its agent is set to a level.
        let sandboxSettings: string | null = null
        let containerPlan: ContainerPlan | null = null
        if (this.d.isolation && !spec.compact) {
          const iso = await this.d.isolation.runFor(ruleAgent(), {
            engine,
            cwd,
            tmpDir,
            addDirs: addDirsOf(spec.extraArgs),
            memoryDir,
            desktop: !!desktop,
            chatId
          })
          if ('refused' in iso) return { exitCode: null, signal: null, stderr: '', spawnError: iso.refused, result: null, stopped: false }
          if (iso.level === 'sandbox') {
            sandboxSettings = iso.settings
            sandboxNet = iso.network
            sandboxAutoFetch = runMode(this.d.permissionMode, spec.permissionMode) === 'auto'
          } else if (iso.level === 'container') {
            containerPlan = iso.plan
            sandboxSettings = JSON.stringify(containerRunSettings(iso))
            sandboxNet = iso.network
            sandboxAutoFetch = runMode(this.d.permissionMode, spec.permissionMode) === 'auto'
          }
          // The belt: only Claude's CLI takes the sandbox's settings or a container's wrap, and another engine would run without
          // them. runFor refuses such a run already; this keeps it refused, never run as Off, if the two ever disagree.
          if (iso.level !== 'off' && !caps.isolation) {
            return {
              exitCode: null,
              signal: null,
              stderr: '',
              spawnError: isolationRefusal(engine, iso.level),
              result: null,
              stopped: false
            }
          }
        }
        // Before the side base is published, so nothing awaits between it and the spawn.
        if (pause) {
          try {
            await this.dropStaleFlag(chatId)
          } catch (err) {
            const code = (err as { code?: unknown } | null)?.code
            console.error('pause flag not checked:', typeof code === 'string' ? code : 'error')
          }
        }
        // Read per attempt, so an Agent Studio edit applies from the next one. Codex has no --agent: the file's body leads its instructions.
        const def = engine === 'codex' ? await this.codex!.definitionOf(spec.agentName).catch(() => null) : null
        const thinking = engine === 'claude' && this.d.thinkingDisplay ? await this.d.thinkingDisplay(bin).catch(() => false) : false
        // A Stop pressed during the awaits above found no process to stop.
        if (r.reason) return { exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: true }
        switch (engine) {
          case 'claude': {
            sideBase = {
              bin,
              cwd,
              tmpDir,
              browser: !!browser || todo !== null || vault !== null || ask !== null || automation !== null || proc !== null,
              asks: ask !== null,
              desktop: !!desktop,
              active: true,
              live: null,
              start: resumeId === null ? null : start,
              ...(proc !== null ? { processes: true as const } : {}),
              ...(scrub.size > 0 ? { scrub: new Map(scrub) } : {}),
              ...(ownEnv
                ? { env: { ...ownEnv }, ownParts: { disallowedTools: own.disallowedTools.length, extraArgs: own.extraArgs.length } }
                : {}),
              args: {
                agentName: spec.agentName,
                ...(spec.model ? { model: spec.model } : {}),
                ...(spec.effort ? { effort: spec.effort } : {}),
                permissionMode: this.d.permissionMode,
                // The agent's parts right after the turn's own, as in the spawn below: a side run replays these first.
                disallowedTools: [...spec.disallowedTools, ...own.disallowedTools],
                extraArgs: [...spec.extraArgs, ...own.extraArgs],
                appendSystemPrompt: system,
                ...(thinking ? { thinking } : {})
              }
            }
            this.sideBases.set(`${chatId}\n${spec.agentName}`, sideBase)
            break
          }
          case 'codex':
            if (caps.btw) {
              // A Codex side run is its own request (sideRun.ts) on the same thread, instructions and model. `args` only names the agent
              // (a rename follows it there); its other fields are the Claude CLI's. None without side questions, as in Phase 1.
              const model = codexModel(spec.model ?? def?.model)
              sideBase = {
                bin,
                cwd,
                tmpDir: null,
                browser: !!browser || todo !== null || vault !== null || ask !== null,
                asks: ask !== null,
                active: true,
                live: null,
                start: null,
                ...(scrub.size > 0 ? { scrub: new Map(scrub) } : {}),
                args: {
                  agentName: spec.agentName,
                  permissionMode: this.d.permissionMode,
                  disallowedTools: [],
                  extraArgs: [],
                  appendSystemPrompt: ''
                },
                codex: {
                  ...codexPoint(resumeId === null ? null : start),
                  baseInstructions: [def?.body ?? '', system].filter(Boolean).join('\n\n'),
                  ...(model !== undefined ? { model } : {})
                }
              }
              this.sideBases.set(`${chatId}\n${spec.agentName}`, sideBase)
            }
            break
          // No side questions (`btw` off): stable ACP has no read-only fork to answer from, so no base is kept.
          case 'acp':
            break
          // Nor for a remote agent (`btw` off): a side thread could not stop its server's own tools.
          case 'ag-ui':
            break
          default:
            assertNever(engine)
        }
        const tmpEnv = tmpDir === null ? undefined : { CLAUDE_CODE_TMPDIR: tmpDir }
        // Env only, like the hook: neither enters the prompt, so the cache prefix holds.
        const pauseEnv = pause ? { ZUMIBOT_PAUSE_FILE: pause.flag } : undefined
        // The agent's API keys go first, so no key's name can stand in for a value the server set for the run (a capability, a
        // socket, the temp folder, the pause flag, its own servers' Vault values); envNameError refuses such names on save, and a
        // sync join re-checks nothing.
        const envOf = (keys: Record<string, string> | undefined) =>
          browser || todo || vault || ask || automation || proc || desktop || compactEnv || tmpEnv || pauseEnv || ownEnv || keys
            ? {
                ...keys,
                ...ownEnv,
                ...browser?.env,
                ...todo?.env,
                ...vault?.env,
                ...ask?.env,
                ...automation?.env,
                ...proc?.env,
                ...desktop?.env,
                ...compactEnv,
                ...tmpEnv,
                ...pauseEnv
              }
            : undefined
        const env = envOf(keyEnv)
        // The container opens once the env is known: its names cross into it, their values stay in podman's own env.
        if (containerPlan) {
          const opened = await containerPlan.open(stringEnv(env))
          if ('refused' in opened)
            return { exitCode: null, signal: null, stderr: '', spawnError: opened.refused, result: null, stopped: false }
          container = opened
          if (r.reason) return { exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: true }
        }
        // The turn as both engines read it: where its session comes from (a cut run forks at the stamped point, keeping the old
        // session as it was) and what it does on it. Each adapter spells its own CLI's form of the two (core/engines/).
        // The cut declares the turn it discards only where that is known and the binary takes the flag; otherwise it cuts as
        // it always did. The SDK adapter's dep answers true for every binary: its option is typed and pins a CLI version.
        const drops =
          resumeAt !== undefined && spec.resumeDrops !== undefined && engine === 'claude' && this.d.dropsTurn
            ? (await this.d.dropsTurn(bin).catch(() => false))
              ? spec.resumeDrops
              : undefined
            : undefined
        const sessionStart = turnStart(resumeId, resumeAt, drops)
        // promptUuid: the id the CLI writes this prompt's own entry under, kept on the message so a later cut can declare it.
        const action: TurnAction = {
          kind: spec.compact ? 'compact' : 'turn',
          prompt,
          ...(engine === 'claude' && !spec.compact ? { promptUuid: attemptPrompt } : {})
        }
        const turnOf = (runEnv: NodeJS.ProcessEnv | undefined): EngineTurn => ({
          bin,
          cwd,
          ...(runEnv ? { env: runEnv } : {}),
          ...(container ? { wrap: container.wrap } : {}),
          start: sessionStart,
          action,
          onEvent
        })
        // Codex gets the same bridges, prompt texts and env, less the Claude-only parts gated off above, as its own request.
        // `guard`: the hooks from the trust cache, the same with their trust asked afresh, or none (and so no keys). The flag
        // path stays in a hookless run's env: nothing reads it there, and a pause still lands when that run ends.
        const codexRun = (guard: 'cached' | 'fresh' | 'none') => {
          const guarded = guard !== 'none' && codexHooks !== null
          return this.codex!.start(turnOf(guarded ? env : envOf(undefined)), {
            // The pre-flight that reads the hooks' trust starts no model: the base env alone, never the agent's keys.
            ...(guarded ? { hookTrustEnv: {} } : {}),
            ...(guarded && guard === 'fresh' ? { freshHookTrust: true } : {}),
            // Codex numbers each process's requests from 0 and a card's item id is its request id: a fresh tag per attempt keeps a
            // turn's first card from taking an earlier attempt's id and being dropped as a repeat.
            requestTag: randomUUID(),
            // Skill items go on a real turn only: a compaction takes no input.
            ...(spec.skills && !spec.compact ? { skills: spec.skills } : {}),
            ...(caps.questions ? {} : { questions: false }),
            // Codex subagents, which the Dispatched agents panel shows and a stop ends with the process; a compaction runs none.
            ...(caps.dispatch && !spec.compact ? { subagents: true } : {}),
            thread: {
              cwd,
              model: codexModel(spec.model ?? def?.model),
              permissionMode: spec.permissionMode === 'manual' ? 'manual' : this.d.permissionMode,
              ...(codexCompactAt !== null ? { autoCompactTokenLimit: codexCompactAt } : {}),
              baseInstructions: [def?.body ?? '', system, browser?.prompt].filter(Boolean).join('\n\n'),
              // The same order as the Claude run's --mcp-config flags. Automations never apply: Zumi Bot is a Claude agent.
              mcpServers: codexServers([browser?.mcp, todo?.mcp, vault?.mcp, ask?.mcp]),
              ...(guarded ? { hooks: codexHooks } : {})
            }
          })
        }
        const claudeRun = (): RunHandle =>
          this.claude.start(turnOf(env), {
            agentName: spec.agentName,
            model: spec.model,
            effort: spec.effort,
            permissionMode: runModeNow,
            // Several --mcp-config flags all load. The browser's stays first, then to-dos, vault, asks and Zumi Bot's automations: the
            // order sideBrowser joins them in for side runs; the desktop's server goes after them. buildArgs merges the automations' and
            // the desktop's ask rules and the pause hook into one --settings. Those go in the spawn only, never the side base: side
            // runs keep their own settings. The agent's own parts (its settings and servers) go before every bridge, in the base too.
            disallowedTools: [...spec.disallowedTools, ...own.disallowedTools],
            extraArgs: [
              ...spec.extraArgs,
              ...own.extraArgs,
              ...(browser?.args ?? []),
              ...(todo?.args ?? []),
              ...(vault?.args ?? []),
              ...(ask?.args ?? []),
              ...(automation?.args ?? []),
              ...(proc?.args ?? []),
              ...(desktop?.args ?? []),
              ...(claudePause ? ['--settings', claudePause.settings] : []),
              ...allowArgs,
              ...(vaultGuard ? ['--settings', vaultGuard] : []),
              ...(sandboxSettings ? ['--settings', sandboxSettings] : [])
            ],
            appendSystemPrompt: [system, browser?.prompt, desktop?.prompt].filter(Boolean).join('\n\n'),
            thinking
          })
        // The agent file's body, then the turn's system text (no bridge paragraphs: it has no bridges), as `systemPrompt`. Always an
        // env object, so the adapter never falls back to this process's own: the caller lays the run env under it.
        const acpRun = (own: { bin: string; launch: AcpLaunch; body: string }): RunHandle =>
          this.acp!.start(
            { ...turnOf(env), bin: own.bin, env: env ?? {} },
            {
              args: own.launch.args,
              systemPrompt: [own.body, system].filter(Boolean).join('\n\n'),
              // Agents number their requests from 0 in every process: a fresh tag per attempt keeps a card from answering another's.
              requestTag: randomUUID()
            }
          )
        // The turn's messages and the auth header, and nothing else of this machine: no env, no folder, no system text, no body.
        // The header's value is in `scrub` already. A thread save is queued like the items', so the next send reads it.
        const aguiRun = (own: { endpoint: string; launch: AguiLaunch; thread: AguiThread | null }): RunHandle =>
          this.agui!.start(turnOf(undefined), {
            endpoint: own.endpoint,
            headers: aguiHeaders(own.launch, own.launch.authKey === null ? undefined : keys.env[own.launch.authKey]),
            authKey: own.launch.authKey,
            messages: aguiInput!,
            thread: own.thread,
            onThread: (t) =>
              later(() =>
                this.d.agui!.thread.save(chatId, t).catch((err: unknown) => {
                  if (err instanceof Error && err.message.startsWith('Chat not found')) return
                  const code = (err as { code?: unknown } | null)?.code
                  console.error('remote agent thread not saved:', typeof code === 'string' ? code : 'error')
                })
              ),
            // A server's ids are its own: a fresh tag per attempt keeps a card from answering another attempt's.
            requestTag: randomUUID()
          })
        let handle: RunHandle
        switch (engine) {
          case 'claude':
            handle = claudeRun()
            break
          case 'codex':
            handle = codexRun('cached')
            break
          case 'acp':
            handle = acpRun(acpOwn!)
            break
          case 'ag-ui':
            handle = aguiRun(aguiOwn!)
            break
          default:
            handle = assertNever(engine)
        }
        slot.handle = handle
        let outcome = await handle.done
        slot.handle = null
        // Hooks codex did not trust ended their run before any thread, so nothing ran with the keys and no guard. Once more with
        // their trust asked afresh (a codex update may hash differently), then with none, so the user's turn still runs.
        for (const next of ['fresh', 'none'] as const) {
          if (!codexHooks || !outcome.hooksUntrusted || r.reason || outcome.stopped) break
          if (next === 'none') {
            console.error('codex hooks not confirmed: running without the vault guard, the pause hook or API keys')
            // A security downgrade the user should see, ahead of the reply it applies to: only what this run lost, never CLI text.
            if (!unguardedNoticed) {
              unguardedNoticed = true
              const member = spec.author === undefined ? {} : { member: displayName(ruleAgent()) }
              addNotice(
                'unguarded',
                unguardedNoticeText({ vault: codexVault !== null, keys: keyEnv !== undefined, pause: codexPause !== null, ...member })
              )
              saveAndPush(false)
            }
          }
          handle = codexRun(next)
          slot.handle = handle
          outcome = await handle.done
          slot.handle = null
        }
        flushDeltas()
        await costReport
        // A Codex prompt goes out only on a thread: a run that ended before one (an untrusted guard, a Stop during its check) read no note.
        let promptReached: boolean
        switch (engine) {
          case 'claude':
            promptReached = true
            break
          case 'codex':
            promptReached = attemptSession !== null && !outcome.hooksUntrusted
            break
          // An ACP prompt goes out only on a session: one that ended before (a failed start, a Stop) read nothing.
          case 'acp':
            promptReached = attemptSession !== null
            break
          // A remote run starts with RUN_STARTED: one that ended before (refused, cut, a Stop) took nothing in.
          case 'ag-ui':
            promptReached = attemptSession !== null
            break
          default:
            promptReached = assertNever(engine)
        }
        if (!outcome.spawnError && promptReached) todoSpawned = true
        // Only the Claude CLI's logs can be searched for a cost; a Codex thread is never estimated.
        if (!costSeen && engine === 'claude') {
          try {
            this.d.onRunWithoutCost?.(chatId, attemptSession ?? attemptResume, ruleAgent())
          } catch (err) {
            console.error('onRunWithoutCost failed', err)
          }
        }
        endPending()
        await pending
        flushPartial()
        return outcome
      } finally {
        // In finally: an attempt that throws must not leave its estimate counted for good.
        try {
          this.d.spend?.ended(spendKey)
        } catch (err) {
          console.error('spend cap end failed', err)
        }
        clearSideLive()
        // Revokes the capability and aborts a call still open, which stops the asked agent.
        ask?.dispose()
        todo?.dispose()
        vault?.dispose()
        automation?.dispose()
        proc?.dispose()
        // Ends a vault approval still waiting (Stop, the turn over): the card must not stay pending.
        unregisterVault?.()
        vaultOpen.value = false
        closeVaultCards(turnId)
        // Both, even when one fails: no capability may outlive its attempt. The container too (its proxies, a leftover container).
        const disposed = await Promise.allSettled([browser?.dispose(), desktop?.dispose(), container?.dispose()])
        slot.disposeBrowser = null
        slot.disposeDesktop = null
        const failed = disposed.find((d): d is PromiseRejectedResult => d.status === 'rejected')
        if (failed) throw failed.reason
      }
    }

    let ok = false
    let stopped = false
    // The name the CLI is spawned with: a rename mid-turn must not change what end() reports.
    const spawnedName = spec.agentName
    let memoryBegun = false
    const live = { spec, ref }
    this.liveTurns.add(live)
    r.slots.add(slot)
    let memoryNote = ''
    if (this.d.dispatch && !spec.compact) {
      // Single chats have no turn id: any id groups this reply's dispatches.
      dispatched = this.d.dispatch.begin(chatId, {
        turn: spec.turnId ?? randomUUID(),
        ...(spec.author === undefined ? {} : { member: spec.author })
      })
    }
    try {
      // The `memory` cap: agent memory is Claude's own feature, so a run without it repairs no index and reads no memory note.
      if (this.d.memory && !spec.compact && caps.memory) {
        memoryBegun = true
        try {
          const m = await this.d.memory.begin(spawnedName)
          if (m) {
            memoryDir = m.dir
            memoryNote = m.note
          }
        } catch (err) {
          console.error('memory begin failed', err instanceof Error ? err.message : err)
        }
      }
      // Before the meta is read: a re-added folder may change nothing in it, but the CLI must find the folder. A throw lands in
      // this try's catch below, so it ends the turn as an error item, like a spawnError does.
      const folderNotice = await this.d.ensureFolder?.(chatId)
      if (folderNotice) {
        addNotice('worktree', folderNotice)
        saveAndPush(false)
      }
      const meta = await store.get(chatId)
      if (!meta) throw new Error(`Chat not found: ${chatId}`)
      if (this.d.audit && !spec.compact) {
        const runKind: AuditRunKind = meta.workflow
          ? 'workflow'
          : spec.asked || meta.asked
            ? 'asked'
            : spec.author !== undefined
              ? 'room'
              : spec.auto
                ? 'routine'
                : 'chat'
        try {
          tap = this.d.audit.tap(
            {
              chatId,
              engine,
              runKind,
              mode: spec.permissionMode ?? this.d.permissionMode,
              turnId: spec.turnId ?? turnMessage,
              isolation: this.d.isolation?.levelOf(ruleAgent()) ?? 'off',
              ...(meta.workflow
                ? { workflow: { id: meta.workflow.workflowId, runId: meta.workflow.runId, stepId: meta.workflow.stepId } }
                : {})
            },
            { agent: ruleAgent, scrub: () => scrub, fillRow: fillRowInput }
          )
        } catch (err) {
          console.error('audit tap not made:', err instanceof Error ? err.name : 'error')
        }
      }
      const { snapshots, readFile } = this.d
      if (snapshots && readFile && caps.files) {
        // A copy still being written when the chat is deleted must not recreate its folder (it may hold secrets).
        const guarded: typeof snapshots = {
          read: (id, copy) => snapshots.read(id, copy),
          put: async (id, text) => {
            if (!(await store.get(id))) throw new Error('Chat is gone')
            return snapshots.put(id, text)
          }
        }
        tracker = new FileTracker({
          cwd: meta.cwd,
          chatId,
          snapshots: guarded,
          now,
          items: () => ref.get(),
          readFile,
          // Only a fixed reason and the error code: fs errors carry copy paths, and file text must never reach a log.
          log: (_msg, err) => {
            const code = (err as { code?: unknown } | null)?.code
            console.error('file change not recorded:', chatId, typeof code === 'string' ? code : 'error')
          }
        })
      }
      let bin: string | null
      let missing = '' // the error when there is no bin
      switch (engine) {
        case 'claude':
          bin = await this.claude.locate()
          missing = notFoundText(engine, '')
          break
        case 'codex':
          bin = (await this.codex?.locate()) ?? null
          missing = notFoundText(engine, '')
          break
        // The launch is checked here (an untrusted one is never located), and again by each attempt, which spawns what it read.
        case 'acp': {
          const l = await this.acpLaunch(spec.agentName)
          bin = 'error' in l ? null : l.bin
          if ('error' in l) missing = l.error
          break
        }
        // The endpoint stands for the binary. Checked here, so a refused turn never reaches the reseed that drops the session.
        case 'ag-ui': {
          const l = await aguiCheck()
          bin = 'error' in l ? null : l.endpoint
          if ('error' in l) missing = l.error
          break
        }
        default:
          bin = assertNever(engine)
      }
      if (!bin) {
        addError(missing)
      } else {
        // A remote turn's message is marked, and saved, before its first request: the end stamp waits for the turn's end, so
        // a hard crash would leave this engine's rows under a message that says nothing of whose they are (foreignHistory).
        const own = ref.get().findIndex((i) => i.type === 'user' && i.id === turnMessage)
        const message = ref.get()[own]
        if (engine === 'ag-ui' && message?.type === 'user' && message.engine !== 'ag-ui') {
          ref.set(ref.get().map((i, at) => (at === own ? { ...message, engine: 'ag-ui' as const } : i)))
          saveAndPush(false)
          await pending
        }
        const style = (await this.d.houseStyle?.()) ? HOUSE_STYLE : ''
        // Fixed text, last so the earlier parts keep their order; side runs (sideBase) inherit it. The list's state goes in the note.
        // The ask roster after it: it changes only when the agents do.
        const asks = askable ? await this.askRoster(spawnedName) : ''
        // The bridge paragraphs only with the bridges (an ACP agent gets none of either).
        const system = [
          spec.systemPrompt ?? '',
          style,
          memoryNote,
          this.d.todoTurns && caps.bridges ? TODO_SYSTEM : '',
          this.d.vaultTurns && caps.bridges ? VAULT_SYSTEM : '',
          this.d.processTurns && caps.processes && caps.bridges && isolationOf() === 'off' ? PROCESS_SYSTEM : '',
          asks
        ]
          .filter(Boolean)
          .join('\n\n')
        // The list's state after the message, for the CLI only (never an item). Compact gets none: /compact is the whole message.
        // Not without the bridges (ACP): the note names the to-do tools, which such a run does not have.
        const withTodoNote = async (content: UserContent, force: boolean): Promise<UserContent> => {
          if (!this.d.todos || spec.compact || !caps.bridges) return content
          todoReadRev = undefined // a reseed's read replaces the first attempt's
          try {
            const note = await this.d.todos.note(chatId, ruleAgent(), { force, asked: spec.todoAsked === true })
            todoReadRev = note.rev
            return note.text === null ? content : withTrailingText(content, note.text)
          } catch (err) {
            // Only the code: an fs error names the data folder. The message goes as it would without to-dos.
            const code = (err as { code?: unknown } | null)?.code
            console.error('to-do note not added:', chatId, typeof code === 'string' ? code : 'error')
            return content
          }
        }
        // Session gone (or never cut-able): a fresh session seeded from the visible history, with the notice that says why
        // (none when the agent resumes no session at all: every turn reseeds, so it is no news).
        const reseed = async (notice: NoticeKind | null): Promise<RunOutcome> => {
          if (notice !== null) addNotice(notice)
          saveAndPush(true)
          await pending
          wantedSession = null
          if (savedSession !== null) await saveSession(null)
          // A seeded session has never seen the list, so it gets the whole note. A remote agent's attempt sends the turn's
          // messages, which hold the history already, so no seed is built for it.
          return attempt(bin, meta.cwd, null, await withTodoNote(aguiInput !== null ? spec.prompt : spec.seedPrompt(history), true), system)
        }
        const resumeId = spec.reseed ? null : spec.sessionId
        // A cut run (Edit, Resend, a version switch) resumes a session from before the hidden turns, while `seen` is
        // already past the news their notes gave: it gets the whole note, as a new session does.
        // Only a plain resume continues the turn a stop cut short, so only it hears what the stop killed, last.
        const firstPrompt = async () => {
          const content = await withTodoNote(spec.prompt, spec.sessionId === null || spec.resumeAt !== undefined)
          return resumeId !== null && spec.resumeAt === undefined ? withLostNote(content) : content
        }
        let outcome = spec.reseed
          ? // Only the planned reseed can be a fresh start; one after a missing session is an expiry, where that is news.
            await reseed(spec.freshStart ? 'fresh' : RESEED_IS_NEWS[engine] ? 'expired' : null)
          : await attempt(bin, meta.cwd, resumeId, await firstPrompt(), system, spec.resumeAt)
        // A cut run is judged by its error text alone: a result that merely looks empty never means "missing", and a
        // failed cut is never retried as a plain --resume (that would write into the version being kept).
        // Codex says so itself (thread/resume found no thread); Claude's own wording is never read off a Codex run.
        // A cut the CLI refused because it would discard more than the turn it declared reseeds the same way: the refusal is
        // deterministic, so the cut is never sent again, and a fresh session from the visible items is the recovery path.
        const sessionGone = (o: RunOutcome): boolean => {
          switch (engine) {
            case 'claude':
              return isMissingSession(resumeId !== null, spec.resumeAt === undefined ? o.result : null, o.stderr) || isCutRefused(o.stderr)
            case 'codex':
              return o.missingSession === true
            // A failed resume or load (or an agent that resumes none) says so itself: one reseed, as Codex's.
            case 'acp':
              return o.missingSession === true
            // A remote thread is never gone: every run sends the whole history, so there is nothing a reseed would add.
            case 'ag-ui':
              return false
            default:
              return assertNever(engine)
          }
        }
        if (!spec.reseed && !spec.compact && !r.reason && !outcome.stopped && forkIgnored === undefined && sessionGone(outcome)) {
          outcome = await reseed(outcome.noResume ? null : 'expired')
        }
        if (forkIgnored !== undefined) {
          addError(FORK_IGNORED_TEXT[engine](forkIgnored ?? undefined))
        } else if (capStopped && !r.reason) {
          // The pause's own end, not the user's Stop: it reads as a reply that ended, and finishPause adds the Paused notice.
          ok = true
        } else if (r.reason || outcome.stopped) {
          stopped = true
          addNotice(r.reason ?? 'stopped')
        } else if (outcome.spawnError) addError(outcome.spawnError)
        else if (!outcome.result || outcome.result.isError) {
          addError(
            outcome.stderr.trim() || `${ENGINE_LABEL[engine]} exited with code ${outcome.exitCode ?? outcome.signal}`,
            limitResets === undefined
              ? undefined
              : {
                  resetsAt: limitResets,
                  ...(spec.author === undefined ? {} : { agent: spec.author }),
                  // A compact the limit stopped is no work of the turn's: the chat must not continue by itself for it.
                  ...(spec.compact ? { compact: true as const } : {})
                }
          )
        } else ok = true
      }
    } catch (e) {
      addError(errorText(e))
    } finally {
      clearSideLive()
      if (sideBase) sideBase.active = false
      this.liveTurns.delete(live)
      slot.handle = null
      r.slots.delete(slot)
      endPending()
      await pending
      // Each finish step runs even if an earlier one fails; the first real error is rethrown.
      const errors: unknown[] = []
      const wanted = wantedSession
      if (wanted !== undefined && savedSession !== wanted) await finishStep(errors, () => spec.saveSession(wanted))
      const touch: MemoryTouch = { saved: 0, updated: 0 }
      for (const k of memoryTouched.values()) touch[k]++
      if (lastWork !== null && touch.saved + touch.updated > 0) {
        const id = lastWork
        ref.set(ref.get().map((i) => (i.id === id && (i.type === 'assistant' || i.type === 'tool') ? { ...i, memory: touch } : i)))
      }
      // What the turn did to the list goes on the same item, and settle points the turn's to-dos at it: one reply for both.
      const todoService = this.d.todos
      const todoList = spec.compact ? undefined : todoService
      const work = lastWork
      // The list is bookkeeping: its failure (an fs error, a malformed file) must not fail a reply the agent finished,
      // or the turn would lose its end stamp and onTurnEnd, and a room would halt. Never pushed to `errors`.
      const todoStep = async (fn: () => Promise<unknown> | unknown): Promise<void> => {
        try {
          await fn()
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Chat not found')) return
          // Only the code: an fs error names the data folder, and item text must never reach a log.
          const code = (err as { code?: unknown } | null)?.code
          console.error('to-do list not updated:', chatId, typeof code === 'string' ? code : 'error')
        }
      }
      if (todoList) {
        await todoStep(() => {
          const t = todoList.touch(todoKey)
          if (t?.asked && t.asked.length > 0) cardAsked = true
          if (t && work !== null)
            ref.set(ref.get().map((i) => (i.id === work && (i.type === 'assistant' || i.type === 'tool') ? { ...i, todos: t } : i)))
        })
      }
      await finishStep(errors, () => store.saveItems(chatId, [...ref.get()]))
      await finishStep(errors, () => pushItems(true))
      // What a Stop (or shutdown) killed, read before end() marks it: what ran when the stop was asked for and never came
      // back done, and what started while the CLI wound down and still runs. Only the agent's own subagents: a nested one
      // is part of its parent's work. Never a pause end (the wrap-up or the cap): nothing was running to kill there.
      const killed =
        stopped && dispatched
          ? dispatched
              .entries()
              .filter((d) => d.parent === null && (atStop.has(d.id) ? d.status !== 'done' : d.status === 'running'))
              .map((d) => d.description)
          : []
      // After the items are saved, so the Agent rows the panel's list checks against are on disk. Never throws.
      if (dispatched && this.d.dispatch) {
        dispatched.end(stopped ? 'stopped' : 'interrupted')
        await this.d.dispatch.finish(chatId, dispatched)
      }
      // After every attempt: what never came back is written as interrupted (a stop) or with no result.
      tap?.end(stopped)
      // A compact records nothing (it has no dispatch record); a cut compact may still retry its clear.
      if (killed.length > 0) await saveLost(killed)
      // A reply that ended on its own has had the note: a clear that failed when it started is tried once more.
      else if (ok && lostStored) await saveLost(null)
      if (todoList) {
        await todoStep(() => todoList.settle(chatId, todoKey, work))
        // Seen as the note read it, not as it is now: a change made while the reply ran is still news next turn.
        const readRev = todoReadRev
        if (todoSpawned && readRev !== undefined) await todoStep(() => todoList.markSeen(chatId, ruleAgent(), readRev))
      }
      // After every attempt's bridge is disposed, so no new call can add to the record. One already in flight may still
      // finish: its change stays on the list, only outside this reply's touch.
      if (todoService) await todoStep(() => todoService.endTurn(todoKey))
      // The same: once every attempt's ask bridge is gone, the turn's ask counts can go.
      if (askable) {
        try {
          this.d.askEnd?.(todoKey)
        } catch {
          console.error('ask turn end failed')
        }
      }
      if (memoryBegun) {
        try {
          this.d.memory?.end(spawnedName, touch.saved + touch.updated > 0)
        } catch (err) {
          console.error('memory end failed', err instanceof Error ? err.message : err)
        }
      }
      if (errors.length > 0) throw errors[0]
    }
    // A fork-ignored run never ends a version: its session is the one it was meant to leave alone.
    const end: SessionCut | null =
      typeof wantedSession === 'string' && tip !== null && forkIgnored === undefined
        ? { session: wantedSession, at: tip, ...engineField(engine) }
        : null
    // Where this turn's prompt landed, so a later cut before it can declare the turn it discards. Claude only (Codex names its
    // own turns) and never a Compact, whose prompt is no message of the user's. Written with the end stamp and only with it:
    // the two go in one items write, and a turn that recorded no end is no cut point either, so its prompt declares nothing.
    const sent: SessionCut | null =
      end !== null && engine === 'claude' && !spec.compact ? { session: end.session, at: attemptPrompt } : null
    if (!spec.compact) {
      try {
        this.d.onTurnEnd?.({
          chatId,
          agent: spec.author ?? spec.agentName,
          outcome: stopped ? 'stopped' : ok ? 'ok' : 'error',
          reply: texts.join('\n\n'),
          ...(spec.asked ? { asked: true as const } : {}),
          ...(spec.workflow ? { workflow: true as const } : {}),
          ...(cardAsked ? { cardQuestions: true as const } : {})
        })
      } catch {
        /* a signal for notifications must not change the turn */
      }
    }
    return { text: texts.join('\n\n'), ok, stopped, end, ...(sent ? { sent } : {}) }
  }
}

/** The host a WebFetch call names, lower-cased; null when its url is missing or not http(s). */
function hostOfFetch(input: unknown): string | null {
  const url = (input as { url?: unknown } | null)?.url
  if (typeof url !== 'string') return null
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}
