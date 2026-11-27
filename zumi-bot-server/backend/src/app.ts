import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync, realpathSync, watch as fsWatch } from 'node:fs'
import { open, readFile as readFileText, stat } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { homedir, hostname, userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isInside } from './core/fsutil'
import { folderOfRule } from '@zumibot/shared/allowRules'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { groupKey, type SidebarLayout } from '@zumibot/shared/sidebarLayout'
import type { ChatMeta, ChatPush } from '@zumibot/shared/types'
import type { VoiceStatus } from '@zumibot/shared/voice'
import type { Workflow } from '@zumibot/shared/workflows'
import { AuthStore } from './auth/authStore'
import { createGate } from './auth/guard'
import { createLimiter } from './auth/rateLimit'
import { type Config } from './config'
import { controlPath, serveControl } from './control'
import { AgentStore } from './core/agents/agentStore'
import { createAgentsSync } from './core/agents/agentsSync'
import { zumiBotDenyRules, ensureZumiBot } from './core/agents/zumiBot'
import { OLD_BUILT_IN_NAMES, migrateOldBuiltIn } from './core/agents/oldBuiltIn'
import { AttachmentStore } from './core/attachments/attachmentStore'
import { SNAPSHOT_MAX_BYTES, SnapshotStore } from './core/files/snapshotStore'
import { BrowserShots } from './core/browser/browserShots'
import { ChatTmp } from './core/chat/chatTmp'
import { pauseHookOf } from './core/chat/pauseSettings'
import { resolveBrowserRuntime } from './core/browser/browserRuntime'
import { ChatService, privateToolOf, type SideBase } from './core/chat/chatService'
import { createClaudeLocator } from './core/chat/claudeLocator'
import { createThinkingProbe } from './core/chat/thinkingDisplay'
import { createDropsTurnProbe } from './core/chat/dropsTurnProbe'
import { mergeInlineJson, runClaude } from './core/chat/claudeRunner'
import { runCodex, type CodexRunOptions } from './core/codex/codexRunner'
import { defaultCodexLocateDeps, locateCodex } from './core/codex/codexLocator'
import { createCodexInfo, listCodexModels } from './core/codex/codexInfo'
import { isCodexChat } from './core/codex/isCodexChat'
import { codexModel } from './core/codex/codexParams'
import { engineChatModel } from '@zumibot/shared/chatModel'
import { engineChatEffort } from '@zumibot/shared/chatRun'
import { codexPauseHook, codexVaultHooks } from './core/codex/codexHooks'
import { assertNever, CODEX_REFUSALS, engineCaps, engineOfAgent, type Engine } from '@zumibot/shared/engine'
import { GroupService } from './core/chat/groupService'
import { RoomSummaries } from './core/chat/roomSummary'
import { ReadMarks } from './core/chat/readMarks'
import { TaskQueue } from './core/chat/taskQueue'
import { SideQuestions } from './core/btw/sideQuestions'
import { parsePick, pickArgs, pickPrompt } from './core/btw/sidePicker'
import { addDirArgs } from './core/attachments/content'
import { buildBriefing } from './core/chat/groupPrompts'
import { HOUSE_STYLE } from './core/chat/houseStyle'
import { runJsonCall, runModerator } from './core/chat/moderator'
import { ackMessage, runAck } from './core/chat/acknowledge'
import { runReplyOptions } from './core/chat/replyOptions'
import { ReplyOptions } from './core/chat/replyOptionsService'
import { runRoute } from './core/todos/commentRouting'
import type { RunCost } from './core/usage/runCost'
import { createRunEnv } from './core/chat/shellEnv'
import { GitChangesService } from './core/git/changes'
import { makeGit, type Git } from './core/git/git'
import { WorktreeService } from './core/git/worktrees'
import { AccountService, claudeConfigFile, claudeUsageOf } from './core/claudeAccount'
import { CodexUsage, codexReadingsOnly, withCodexUsage } from './core/codex/codexAccount'
import { CapStore, SPEND_CAPS_FILE } from './core/caps/capStore'
import { capEngines } from './core/caps/capEngines'
import { SpendCaps } from './core/caps/spendCaps'
import { RoutineRunner } from './core/routines/routineRunner'
import { LimitResumes } from './core/chat/limitResumes'
import { RoutineStore } from './core/routines/routineStore'
import { createScheduler } from './core/routines/scheduler'
import { routineEditing } from './core/routines/routineEditing'
import { HistoryStore } from './core/history/historyStore'
import { logHistoryError } from './core/history/keepHistory'
import { renameRoutineDef, renameWorkflowDef } from './core/history/renameAgent'
import type { RoutineDef, WorkflowDef } from '@zumibot/shared/definitionHistory'
import { workflowEditing } from './core/workflows/workflowEditing'
import { stepRuleSaver } from './core/workflows/stepRuleSave'
import { copyRoom, newRoom } from './core/workflows/workflowRooms'
import { BareCalls } from './core/workflows/bareCalls'
import { WorkflowMessages } from './core/workflows/workflowMessages'
import { WorkflowRunner } from './core/workflows/workflowRunner'
import { FileWatchers, fileBusy } from './core/workflows/fileWatchers'
import { MailWatchers, checkMailbox } from './core/workflows/mailWatchers'
import { connectImap, mailStateFile, parseMail } from './core/workflows/mailClient'
import { WorkflowEventDispatcher } from './core/workflows/workflowEvents'
import { inboxEvent, replyEvent, todoEvent } from './core/workflows/workflowEventSources'
import type { WorkflowEvent } from '@zumibot/shared/workflowEvents'
import { WorkflowStore } from './core/workflows/workflowStore'
import { workflowSystem } from './core/workflows/workflowPrompt'
import { KeepWarm } from './core/btw/keepWarm'
import { isArchived } from '@zumibot/shared/archive'
import { createCostBaseline } from './core/usage/costBaseline'
import { EstimateCache } from './core/usage/estimateCache'
import { UsageService, usageAgentLabel } from './core/usage/usageService'
import { UsageStore } from './core/usage/usageStore'
import { createJev } from './core/jev/jev'
import { NotifyService } from './core/notify/notifyService'
import type { NotifyTarget } from './core/notify/notifyService'
import { NotifyStore } from './core/notify/notifyStore'
import { Presence } from './core/notify/presence'
import { sendPush } from './core/notify/pushSender'
import { createJevClient } from './core/jev/jevClient'
import { JevStore } from './core/jev/jevStore'
import { createCleaner } from './core/voice/cleaner'
import { createTranscriber, testVoiceOrigin } from './core/voice/transcriber'
import { VoiceStore } from './core/voice/voiceStore'
import { ChannelService } from './core/channels/channelService'
import { ChannelStore } from './core/channels/channelStore'
import { ChannelStateStore } from './core/channels/channelState'
import { ChannelTokens } from './core/channels/channelTokens'
import { scrubOutbound } from './core/channels/channelScrub'
import { TelegramAdapter } from './core/channels/telegramAdapter'
import { TelegramError, createTelegramApi, testChannelOrigin } from './core/channels/telegramApi'
import { SlackAdapter } from './core/channels/slackAdapter'
import { createSlackApi, isAuthError } from './core/channels/slackApi'
import type { ChannelPlatform } from '@zumibot/shared/channels'
import type { VoiceFormat } from '@zumibot/shared/voice'
import { cleanTranscript } from './core/voice/cleaner'
import { CHAT_PREFIX } from '@zumibot/shared/appPaths'
import { VaultStore } from './core/vault/vaultStore'
import { createVoiceLimiter } from './http/voice'
import { ChatStore } from './core/store/chatStore'
import { SettingsStore } from './core/store/settingsStore'
import { ApprovalStore } from './core/store/approvalStore'
import { SidebarStore } from './core/store/sidebarStore'
import { capNote, effectiveLimit } from '@zumibot/shared/memory'
import { MemoryStore, isAutoMemoryOff, memoryRoot } from './core/memory/memoryStore'
import { MemoryTurns } from './core/memory/memoryTurns'
import { AgentAsks } from './core/asks/askService'
import { serveAskIpc } from './core/asks/askIpc'
import { serveAutomationIpc } from './core/automations/automationIpc'
import { AutomationService } from './core/automations/automationService'
import { attemptTurnEnded } from './core/attempts/attemptSets'
import { createGhLocator } from './core/github/gh'
import { PullRequests } from './core/github/pullRequests'
import { PrWatcher } from './core/github/prWatcher'
import { TodoService } from './core/todos/todoService'
import { DispatchService } from './core/dispatch/dispatchService'
import { migrateToBoard } from './core/todos/boardMigration'
import { SearchIndex } from './core/search/searchIndex'
import { serveTodoIpc } from './core/todos/todoIpc'
import { ProcessService, type RunEndEvent } from './core/processes/processService'
import { serveProcessIpc } from './core/processes/processIpc'
import { ProcessWakes } from './core/processes/processWakes'
import { RunResults } from './core/processes/runResults'
import { runAuditRecord } from './core/audit/runAudit'
import { serveVaultIpc } from './core/vault/vaultIpc'
import { VaultApprovals } from './core/vault/vaultApprovals'
import { UpdateService, detectAvailability } from './core/update/updateService'
import { UPDATE_SITE } from '@zumibot/shared/update'
import { browserVaultOf } from './core/vault/browserVault'
import { vaultEnvOf } from './core/vault/vaultEnv'
import { acpRecord, aguiRecord, LaunchTrust } from './core/acp/launchTrust'
import { startAgui } from './core/agui/aguiRunner'
import { createAguiTest } from './core/agui/aguiTest'
import { acpLocate } from './core/acp/acpLocator'
import { createAcpTest } from './core/acp/acpTest'
import { startAcp } from './core/acp/acpRunner'
import { scrubbedAsks, scrubbedHandoffs, scrubbedTodos } from './core/vault/scrubBridges'
import { VAULT_SYSTEM } from './core/vault/vaultPrompt'
import { vaultGuardSettings } from './core/vault/vaultGuard'
import { AuditLog } from './core/audit/auditLog'
import { IsolationService } from './core/isolation/isolationService'
import { realSupportDeps, checkSandbox } from './core/isolation/sandboxSupport'
import { ContainerRunner, pruneHomes, sweepOwned } from './core/isolation/containerRunner'
import { AGENT_IMAGE, checkContainer, realContainerDeps, which } from './core/isolation/containerSupport'
import { PodmanCalls } from './core/isolation/podmanCalls'
import { serverCredential } from './core/isolation/authProxy'
import { AuditService } from './core/audit/auditService'
import { buildAgentRunConfig, CONNECTORS_ALL_OFF, NO_RUN_CONFIG, type AgentRunConfig } from './core/extensions/agentRunConfig'
import { ExtensionsService } from './core/extensions/extensionsService'
import { ConnectorStore } from './core/connectors/connectorStore'
import { ConnectorsService, startConnectors } from './core/connectors/connectorsService'
import { connectorsGuardSettings } from './core/connectors/connectorsGuard'
import { keyVarInUse } from './core/claudeStatus'
import { CONNECTOR_IDS } from '@zumibot/shared/connectors'
import { NO_EXTENSIONS } from '@zumibot/shared/extensions'
import { TODO_SYSTEM } from './core/todos/todoPrompt'
import { RUN_SYSTEM } from './core/processes/processPrompt'
import { askRoster, askSystem, askedSystem } from './core/asks/askPrompt'
import { trashPath } from './core/trash'
import { restoreFile } from './core/files/restoreFile'
import { ensureDataDir } from './dataDir'
import { aguiAllowLocal, claudeSdkEngineOn, devEnv, testWaitScale } from './devEnv'
import { createHookHandler, routineHookTarget, workflowHookTarget } from './http/hooks'
import { createAppServer } from './http/server'
import { acquireDataLock } from './lock'
import { migrateFromDesktop } from './migrate'
import { CommandResolver } from './core/chat/commandResolver'
import { createHandlers } from './rpc/handlers'
import { createHub, type Hub } from './rpc/hub'
import { createItemsFeed } from './rpc/itemsFeed'
import { createNotifyHandlers } from './rpc/notifyHandlers'
import { createBrowserApplication } from './core/browser/browserApplication'
import { createBrowserHub } from './http/browserSocket'
import { createDesktopHub } from './http/desktopSocket'
import { loginDir } from './http/loginDir'
import { createDesktopApplication } from './core/desktop/desktopApplication'
import { recoverDesktops } from './core/desktop/desktopProcess'
import { sweepStaleIpcDirs } from './core/ipc/staleIpcDirs'

// A backstop: `serve` runs startSetupServer first, which serves the browser wizard instead of failing.
export const NEEDS_AUTH = 'Not set up yet. Open /setup in a browser, or run "zumibot-server set-password" and "zumibot-server setup-2fa".'
const GOING_AWAY = 1001
const DRAFT_MAX_AGE_MS = 24 * 60 * 60_000

export interface RunningServer {
  // Synchronous, for a forced exit: removes the lock file if it is ours.
  releaseLock(): void
  port: number
  origin: string
  close(): Promise<void>
}

/** Wires every service together and listens on 127.0.0.1 (a reverse proxy is the only way in from outside). */
export async function startServer(
  input: Config,
  // restart: Local mode's update asks the process to stop so the desktop shell starts it again (cli.ts wires it).
  io: { out?(line: string): void; restart?(): void } = {}
): Promise<RunningServer> {
  const out = io.out ?? ((l: string) => console.log(l))
  // A copy: the gate reads config.origin on every call, and local mode learns its port only after listening.
  const config: Config = { ...input }
  const { dataDir } = config
  const auth = new AuthStore(dataDir, Date.now)

  if (config.mode === 'vps') {
    const set = await auth.configured()
    if (!set.password || !set.totp) throw new Error(NEEDS_AUTH)
  }

  await ensureDataDir(dataDir)
  const releaseLock = await acquireDataLock(dataDir)
  // An unconfirmed browser or desktop cleanup keeps the lock: their processes may still use the data dir.
  let browserCleanupFailed = false
  let desktopCleanupFailed = false
  const undo: (() => Promise<void>)[] = [
    async () => {
      if (!browserCleanupFailed && !desktopCleanupFailed) await releaseLock()
    }
  ]
  const unwind = async (): Promise<void> => {
    for (const fn of undo.reverse()) await fn().catch(() => {})
  }

  try {
    // A SIGKILLed or crashed server never ran close(), so its IPC and container run folders stay in /tmp; never throws.
    const sweptIpcDirs = await sweepStaleIpcDirs()
    if (sweptIpcDirs) out(`removed ${sweptIpcDirs} socket folders left by a server that did not shut down`)

    if (config.mode === 'local' && config.migrateFrom) {
      const copied = await migrateFromDesktop(config.migrateFrom, dataDir)
      if (copied.length) console.error(`migrated from the desktop app: ${copied.join(', ')}`)
    }

    const home = process.env['HOME'] || homedir()
    const agents = new AgentStore(config.agentsDir, (p) => trashPath(p, home, () => new Date()), undefined, ZUMI_BOT_NAME)
    const chats = new ChatStore(dataDir)
    const projectsDir = join(home, '.claude', 'projects')
    const costBaseline = createCostBaseline(projectsDir)
    const usage = new UsageService({
      store: new UsageStore(join(dataDir, 'usage-records.jsonl')),
      cache: new EstimateCache(join(dataDir, 'usage-estimates.json')),
      chats,
      projectsDir,
      changed: (chatId) => hub.broadcast({ event: 'usage:changed', payload: { chatId } }),
      agentLabel: usageAgentLabel,
      workflowNames: async () => new Map((await workflowStore.list()).map((w) => [w.id, w.name]))
    })
    // What dispatched subagents do; sent on every save, which a running turn coalesces to about once a second.
    const dispatch = new DispatchService({
      store: chats,
      now: () => Date.now(),
      privateTool: privateToolOf,
      onChanged: (chatId) => hub.broadcast({ event: 'dispatch:changed', payload: { chatId } })
    })
    // The audit log: one record per tool call of every run (docs/architecture/governance.md). Never synced; `machine` names
    // this install, so exports from two machines join by id.
    const auditDir = join(dataDir, 'audit')
    let auditPushTimer: NodeJS.Timeout | null = null
    const auditLog = new AuditLog({
      dir: auditDir,
      machine: createHash('sha256').update(`${hostname()}\n${dataDir}`).digest('hex').slice(0, 8),
      now: () => Date.now(),
      // At most once a second: an open Audit page only offers to load what is new.
      onAppend: () => {
        auditPushTimer ??= setTimeout(() => {
          auditPushTimer = null
          hub.broadcast({ event: 'audit:changed', payload: {} })
        }, 1000)
      }
    })
    // A log that can't start counts every later write as a failure (shown on the page); it never stops the server.
    try {
      await auditLog.start()
    } catch (err) {
      console.error('audit log not started:', (err as { code?: unknown } | null)?.code ?? 'error')
    }
    undo.push(async () => {
      if (auditPushTimer) clearTimeout(auditPushTimer)
      await auditLog.flush()
    })
    const audit = new AuditService({
      machine: auditLog.status().machine,
      now: () => Date.now(),
      newId: () => randomUUID(),
      write: (r) => {
        void auditLog.append(r)
      },
      routineOf: (chatId) => runner?.routineOfChat(chatId) ?? null
    })
    // Every chat's messages, for chats:search: built in the background once the server listens, kept by these listeners.
    const search = new SearchIndex({ store: chats, log: (l) => console.error(l) })
    chats.setItemsListener((id, items) => {
      usage.noteItems(id, items)
      dispatch.noteItems(id, items)
      search.note(id, items)
    })
    chats.setRemovedListener((id) => search.remove(id))
    const settings = new SettingsStore(dataDir)
    const sidebar = new SidebarStore(dataDir)
    const approvals = new ApprovalStore(dataDir)
    await approvals.load()
    // The ACP launches confirmed in Agent Studio on this machine; a file it cannot read trusts nothing (load never throws).
    const launchTrust = new LaunchTrust(dataDir)
    await launchTrust.load()
    // Before any service: a status of keyMissing/keyMismatch is a state to show, not a failure, so load never throws.
    const vault = new VaultStore({ dataDir, keyFile: config.vaultKeyFile })
    await vault.load()
    // Channel bot tokens: sealed under the vault key in their own per-machine file, scrubbed like any vault value.
    const channelStore = new ChannelStore(dataDir)
    const channelTokens = new ChannelTokens(dataDir, vault)
    await channelTokens.load()
    vault.setExtraSecrets(() => channelTokens.all())
    const connectorStore = new ConnectorStore(dataDir)
    await connectorStore.load()
    const jevStore = new JevStore(dataDir)
    const jevClient = createJevClient({ key: () => jevStore.key() })
    const jev = createJev({ store: jevStore, client: jevClient })
    const voiceStore = new VoiceStore(dataDir)
    const transcriber = createTranscriber({
      key: () => voiceStore.key(),
      origin: testVoiceOrigin(devEnv('ZUMIBOT_TEST_VOICE_URL')) ?? undefined,
      log: (l) => console.error(l)
    })
    const cleaner = createCleaner({
      key: () => voiceStore.key(),
      origin: testVoiceOrigin(devEnv('ZUMIBOT_TEST_VOICE_URL')) ?? undefined,
      log: (l) => console.error(l)
    })
    const claude = createClaudeLocator(settings)
    const runEnv = createRunEnv()
    // Agent isolation: each agent's level, in the audit folder (guarded like the log). Read once here; only isolation:set writes it.
    const isolation = new IsolationService({
      file: join(auditDir, 'isolation.json'),
      home: homedir(),
      dataDir,
      keyDir: dirname(resolve(config.vaultKeyFile)),
      pathEnv: async () => {
        await runEnv.ready()
        return runEnv.env().PATH ?? ''
      },
      checkSupport: async () => {
        await runEnv.ready()
        return checkSandbox(realSupportDeps(runEnv.env().PATH ?? ''))
      },
      // Resolved like the pause hook; a build without it refuses sandboxed runs rather than running them without the guard.
      fileHook: (() => {
        try {
          const rt = resolveBrowserRuntime()
          return isAbsolute(rt.node) && isAbsolute(rt.sandboxFileHookEntry) && existsSync(rt.sandboxFileHookEntry)
            ? { node: rt.node, entry: rt.sandboxFileHookEntry, electronNode: rt.electronNode }
            : null
        } catch {
          return null
        }
      })()
    })
    // A broken file never stops the server and never lets an agent run Off by accident: start() marks it, and every run is refused.
    await isolation.start()
    // Level 3's containers: labelled with this data dir's owner id, so a sweep removes only this server's.
    const containerOwner = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 12)
    // Every podman call below goes through it, so close() can end the ones still running (see endContainers).
    const podmanCalls = new PodmanCalls()
    const podmanOf = async () => {
      await runEnv.ready()
      return which(runEnv.env().PATH ?? '', existsSync, 'podman')
    }
    const sweepContainers = async (): Promise<void> => {
      const podman = await podmanOf().catch(() => null)
      if (podman === null) return
      const n = await sweepOwned(containerOwner, podmanCalls.exec(podman)).catch(() => 0)
      if (n > 0) console.error(`removed ${n} leftover agent container(s)`)
    }
    // Fake homes of chats deleted since: at start only (a running chat's home must stay).
    const pruneContainerHomes = async (): Promise<void> => {
      const podman = await podmanOf().catch(() => null)
      await pruneHomes(
        containerBase.stateRoot,
        (await chats.list()).map((c) => c.id),
        podman === null ? null : podmanCalls.exec(podman)
      ).catch(() => 0)
    }
    // At shutdown, after stopAll: a run killed past its grace may leave its container. Then the calls still running (a support
    // check from an open Agent Studio, the start-up prune) end too: one left behind outlives the server and writes into its HOME.
    const endContainers = async (): Promise<void> => {
      await sweepContainers()
      await podmanCalls.close()
    }
    const containerBase = {
      image: AGENT_IMAGE,
      owner: containerOwner,
      agentsDir: config.agentsDir,
      stateRoot: join(homedir(), '.local', 'state', 'zumibot-containers', containerOwner),
      priv: {
        home: homedir(),
        dataDir: resolve(dataDir),
        keyDir: dirname(resolve(config.vaultKeyFile)),
        claudeHome: join(homedir(), '.claude')
      },
      credential: serverCredential(
        () => process.env,
        join(homedir(), '.claude', '.credentials.json'),
        (p) => readFileText(p, 'utf8')
      )
    }
    isolation.useContainers({
      check: async () => {
        await runEnv.ready()
        return checkContainer(
          realContainerDeps(
            runEnv.env().PATH ?? '',
            async () => {
              const bin = await claude.locate()
              return bin === null ? null : realpathSync(bin)
            },
            podmanCalls
          )
        )
      },
      runner: (c) => {
        const rt = resolveBrowserRuntime()
        if (!isAbsolute(rt.containerEntry) || !existsSync(rt.containerEntry)) return null
        return new ContainerRunner({
          ...containerBase,
          podman: c.podman,
          exec: podmanCalls.exec(c.podman),
          claudeBin: c.claudeBin,
          node: rt.node,
          entry: rt.containerEntry,
          distDir: dirname(rt.containerEntry)
        })
      }
    })
    void sweepContainers().then(pruneContainerHomes)
    // Asked lazily by a chat's first attempt, after locate has readied the run env, so it sees the same PATH as the runs.
    const thinkingProbe = createThinkingProbe({ env: () => runEnv.env() })
    // The same, for the flag that makes a cut declare the turn it discards (docs/architecture/edit-resend-fork.md).
    const dropsTurnProbe = createDropsTurnProbe({ env: () => runEnv.env() })
    // Like claude.locate: resolved on first use, cached on success; a miss is not cached, so installing codex later works.
    let codexBin: Promise<string | null> | null = null
    const locateCodexOnce = (): Promise<string | null> => {
      if (!codexBin) {
        // On the interactive PATH runs get (nvm lives in .bashrc), not this process's: the desktop shell's lacks nvm.
        const p = runEnv.ready().then(() => locateCodex(defaultCodexLocateDeps(null, runEnv.env().PATH ?? '')))
        codexBin = p
        void p.then(
          (r) => {
            if (r === null && codexBin === p) codexBin = null
          },
          () => {
            if (codexBin === p) codexBin = null
          }
        )
      }
      return codexBin
    }
    const codexLocate = async (): Promise<string | null> => {
      return locateCodexOnce()
    }
    const codexInfo = createCodexInfo({ locate: codexLocate, list: (bin) => listCodexModels(bin, { env: runEnv.env() }) })
    let hub: Hub
    let tasks: TaskQueue // ChatService's onIdle needs it, and it needs ChatService
    let runner: RoutineRunner // the same for ChatService's onIdle and push
    let workflowRunner: WorkflowRunner // the same: its Agent steps follow their chats through onIdle and push
    // Built after the runner, but the sources it listens to (replies, to-dos, Inbox) are built before it and may fire
    // in between, so they reach it through this, which is undefined until then (nothing is lost: no workflow runs yet).
    let eventDispatcher: WorkflowEventDispatcher | undefined
    // Fire and forget: a workflow event never changes the turn, to-do or message that caused it.
    const fireEvent = (e: WorkflowEvent | null): void => {
      if (e) void eventDispatcher?.emit(e)
    }
    const fireChatEvent = (chatId: string, build: (meta: ChatMeta | null) => WorkflowEvent | null): void => {
      if (!eventDispatcher) return
      // A chat a run's step waits on (a Chat step posts into the user's own chat): its replies and to-dos are the run's, so
      // they start nothing, or a reply workflow posting back into it would loop. Read now: the step settles right after.
      if (workflowRunner.runsIn(chatId).length > 0) return
      void chats.get(chatId).then(
        (m) => fireEvent(build(m)),
        () => undefined
      )
    }
    let stepRuleSave: ReturnType<typeof stepRuleSaver> // the same: it saves through workflowEditing, built after the runner
    let limits: LimitResumes // the same for ChatService's onIdle and the task queue's onNewTurn
    // A run's new room goes first in its section: a routine's room and a Room step's copy.
    const placeRoom = async (chatId: string, sectionId: string): Promise<void> => {
      const layout = await sidebar.placeFirst(sectionId, groupKey(chatId))
      if (layout) sidebarChanged(layout)
    }
    let spendCaps: SpendCaps // ChatService prices turns into it, and it pauses chats through the task queue
    const capStore = new CapStore(join(dataDir, SPEND_CAPS_FILE))
    await capStore.load()
    const routineStore = new RoutineStore(dataDir)
    const workflowStore = new WorkflowStore(dataDir)
    const workflowMessages = new WorkflowMessages(dataDir, Date.now, (m) => fireEvent(inboxEvent(m)))
    const feed = createItemsFeed()
    const files = new AttachmentStore(join(dataDir, 'attachments'), () => randomUUID())
    const snapshots = new SnapshotStore(join(dataDir, 'file-snapshots'))
    // Screenshots an agent kept for itself; removed with the chat, never synced.
    const browserShots = new BrowserShots(join(dataDir, 'browser-shots'))
    // Each chat's CLAUDE_CODE_TMPDIR, kept in the data dir so an agent's working files survive a reboot (never synced).
    const tmp = new ChatTmp(join(dataDir, 'claude-tmp'))
    // The pause hook every main run gets, resolved once like the bridges. Without it runs are as before, and Pause is
    // refused (ChatService.canPause), since nothing would block new tool calls. Codex's comes from the same entry, so a
    // server has both or neither.
    const pauseHooks = (() => {
      try {
        const rt = resolveBrowserRuntime()
        const claude = pauseHookOf(rt, existsSync)
        const codex = codexPauseHook(rt, existsSync)
        return claude && codex ? { claude, codex } : null
      } catch {
        return null
      }
    })()
    if (!pauseHooks) console.error('pause hook unavailable: Pause is refused')
    // A subagent's edited file: a regular file only (no FIFO or device can block the turn), read at most one byte past the cap.
    // O_NONBLOCK, so opening a FIFO returns at once and the stat check can refuse it.
    const readFile = async (path: string): Promise<Buffer> => {
      const fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
      try {
        if (!(await fh.stat()).isFile()) throw new Error('not a regular file')
        const buf = Buffer.alloc(SNAPSHOT_MAX_BYTES + 1)
        let n = 0
        while (n < buf.length) {
          const { bytesRead } = await fh.read(buf, n, buf.length - n, n)
          if (bytesRead === 0) break
          n += bytesRead
        }
        return buf.subarray(0, n)
      } finally {
        await fh.close()
      }
    }
    // A card's first use on a site waits on a chat card; the fill call (browser manager) asks through this.
    const vaultApprovals = new VaultApprovals({ now: () => Date.now(), newId: () => randomUUID() })
    undo.push(() => vaultApprovals.close())
    const browsers = await createBrowserApplication({
      dataDir,
      agents,
      chats,
      feed,
      attachments: files,
      shots: browserShots,
      vault: browserVaultOf(vault, vaultApprovals)
    })
    undo.push(async () => {
      try {
        await browsers.close()
      } catch (err) {
        browserCleanupFailed = true
        throw err
      }
    })
    const browserHub = createBrowserHub({
      manager: browsers.manager,
      isValid: config.mode === 'vps' ? (k) => auth.checkSessionKey(k) : async () => true
    })
    undo.push(async () => {
      browserHub.drain()
      browserHub.closeAll(GOING_AWAY)
      browserHub.dispose()
    })
    // A crashed server's desktops, before any new one can take their display numbers. The same root the adapter keys on.
    try {
      await recoverDesktops(join(dataDir, 'desktops'))
    } catch (err) {
      console.error('recovering desktops failed:', err instanceof Error ? err.message : err)
    }
    const desktops = await createDesktopApplication({ dataDir, agents, chats, feed })
    undo.push(async () => {
      try {
        await desktops.close()
      } catch (err) {
        desktopCleanupFailed = true
        throw err
      }
    })
    const desktopHub = createDesktopHub({
      manager: desktops.manager,
      isValid: config.mode === 'vps' ? (k) => auth.checkSessionKey(k) : async () => true
    })
    undo.push(async () => {
      desktopHub.drain()
      desktopHub.closeAll(GOING_AWAY)
      desktopHub.dispose()
    })
    // Presence and the service need each other, and both need the hub: closures keep the construction order free.
    const notifyStore = new NotifyStore(dataDir)
    // Filled once the channel services exist (further down); notifications read it per event.
    let notifyTargets: NotifyTarget[] = []
    const presence = new Presence({
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref()
        return { clear: () => clearTimeout(t) }
      },
      onStarted: (c) => {
        notify.started(c)
        void reads.started(c)
      },
      onStopped: (c) => {
        notify.stopped(c)
        void reads.stopped(c)
      },
      onOpened: (c, at) => {
        void reads.opened(c, at)
      }
    })
    const notify = new NotifyService({
      store: notifyStore,
      presence,
      mode: config.mode,
      subject: () => config.origin,
      chats,
      routines: routineStore,
      routineOfChat: (id) => runner.routineOfChat(id),
      sessionValid: config.mode === 'vps' ? (k) => auth.checkSessionKey(k) : async () => true,
      sendTo: (connId, e) => hub.sendTo(connId, e),
      broadcast: (e) => hub.broadcast(e),
      send: (o) => sendPush({ ...o, fetch, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
      now: () => Date.now(),
      log: (line) => console.error(line),
      targets: () => notifyTargets
    })
    // Set once the board's service exists (it is built further down); a push before that has no card to move.
    let todoPush: ((p: ChatPush) => void) | null = null
    // Set once the channel service exists (it needs the handlers, built further down).
    let channelPush: ((p: ChatPush) => void) | null = null
    const push = (payload: ChatPush): void => {
      channelPush?.(payload)
      runner.chatPush(payload)
      workflowRunner.chatPush(payload)
      notify.chatPush(payload)
      todoPush?.(payload)
      hub.broadcast({ event: 'chats:push', payload: feed.wire(payload) })
    }
    // Declared after push, which it needs; presence only calls it later, from a timer or a socket.
    const reads = new ReadMarks({
      store: chats,
      lookingAt: (c) => presence.lookingAt(c),
      push,
      now: () => Date.now(),
      log: (line) => console.error(line)
    })
    // Reads the run env lazily and never awaits ready(): that spawns a login shell (seconds), and a plain chat create
    // asks git (topOf) before any turn. Until a turn readies it, git runs on the service's own PATH, which has git.
    const git: Git = makeGit(() => runEnv.env())
    // Declared before chatService, which will call ensure; `push` is declared above.
    const worktrees = new WorktreeService({
      git,
      store: chats,
      push: (meta) => push({ chatId: meta.id, kind: 'meta', meta }),
      hex: () => randomBytes(3).toString('hex'),
      log: (line) => console.error(line)
    })
    const routinesChanged = (): void => {
      void routineStore.snapshot().then(
        (payload) => hub.broadcast({ event: 'routines:changed', payload }),
        (err) => console.error('reading routines failed:', err instanceof Error ? err.message : err)
      )
    }
    // Summaries only: a visit's input and output go to the one tab that asks (workflows:getRun), never to every tab.
    // Every change also re-syncs the folder watches and mail polls (an enabled File or Email workflow, a new path or
    // mailbox), once they are running.
    let fileWatchers: FileWatchers | undefined
    let mailWatchers: MailWatchers | undefined
    let watching = false
    const syncWatchers = (): void => {
      if (!watching) return
      void workflowStore.list().then(
        (list) => {
          if (watching) {
            fileWatchers?.sync(list)
            mailWatchers?.sync(list)
          }
        },
        (err) => console.error('reading workflows failed:', err instanceof Error ? err.message : err)
      )
    }
    const workflowsChanged = (): void => {
      void workflowStore.snapshot().then(
        (payload) => hub.broadcast({ event: 'workflows:changed', payload }),
        (err) => console.error('reading workflows failed:', err instanceof Error ? err.message : err)
      )
      syncWatchers()
    }
    const stopWatchers = (): void => {
      watching = false
      fileWatchers?.stop()
      mailWatchers?.stop()
    }
    // An empty payload: message text never rides an event, the tab asks inbox:messages.
    const inboxChanged = (): void => hub.broadcast({ event: 'inbox:changed', payload: {} })
    const memoryStore = new MemoryStore({
      root: memoryRoot(),
      trash: (p) => trashPath(p, home, () => new Date()),
      log: (l) => console.error(l)
    })
    const memoryTurns = new MemoryTurns({ store: memoryStore, log: (l) => console.error(l) })
    const memoryChanged = (agent: string): void => hub.broadcast({ event: 'memory:changed', payload: { agent } })
    const autoMemoryOff = (): Promise<boolean> => isAutoMemoryOff(process.env, process.env['CLAUDE_CONFIG_DIR'] || join(home, '.claude'))
    // Once, before the hub serves any call: every chat's own to-do list from before the board moves onto it.
    try {
      const moved = await migrateToBoard({
        store: chats,
        copyFiles: (from, to, list) => files.copyFiles(from, to, list),
        removeFolder: (key) => files.removeChat(key),
        log: (l) => console.error(l)
      })
      if (moved > 0) console.log(`todo board: moved ${moved} to-dos from chats onto the board`)
    } catch (err) {
      // Only the code: an fs error names the data folder. The old lists stay where they were for the next start.
      const code = (err as { code?: unknown } | null)?.code
      console.error('todo board: migration failed', typeof code === 'string' ? code : 'error')
    }
    // Sent on every call, never deduped by rev: an agent turn's settle fires it again at the same rev.
    const todos = new TodoService({
      store: chats,
      files,
      now: () => Date.now(),
      newId: () => randomUUID(),
      onChanged: (rev) => hub.broadcast({ event: 'todos:changed', payload: { rev } }),
      onAdded: (chatId, items, by) => fireChatEvent(chatId, (meta) => todoEvent(meta, items, by))
    })
    // A comment whose routing call a stop cut short would show it is picking for ever: it asks nobody.
    await todos.clearRouting().catch((err) => {
      const code = (err as { code?: unknown } | null)?.code
      console.error('todo board: clearing routing comments failed', typeof code === 'string' ? code : 'error')
    })
    // A task chat's turn moves its card: In progress when it starts, then Blocked, In review or back to New as it ends.
    todoPush = (p) => todos.chatPush(p)
    // The agents' to-do tools reach the same service through this socket; ChatService hands out a capability per turn.
    // An agent's API key values never get into text that arrives over a bridge: scrubbed with the owner agent's grants before it is stored.
    const scrubOf = (agent: string): ReadonlyMap<string, string> => vaultEnvOf(vault.grantedTo(agent)).scrub
    const todoIpc = await serveTodoIpc({ service: scrubbedTodos(todos, scrubOf) })
    undo.push(() => todoIpc.close())
    // Background processes the agents start. Loaded before the hub serves a call: what was running is lost, never re-attached.
    // Its shutdown is pushed here, so the unwind runs it after the hub and the turns are gone and before the data lock goes.
    // A process's notify rule wakes its agent through the chat's task queue; TaskQueue, ChatService and SpendCaps are built
    // later and reached by closure (no event can come before the server listens: no process runs yet).
    const wakes = new ProcessWakes({
      submit: (chatId, text, messageId) => tasks.submit(chatId, text, [], undefined, messageId, undefined, undefined, 'process'),
      running: (chatId) => chatService.isRunning(chatId),
      chat: async (id) => {
        const m = await chats.get(id)
        return m ? { archived: isArchived(m), room: m.group !== undefined, taskIds: (m.tasks ?? []).map((x) => x.id) } : null
      },
      gate: (agents) => spendCaps.gate(agents),
      note: (id, note) => processes.noteWake(id, note),
      sent: (id) => processes.wakeSent(id),
      now: () => Date.now(),
      newId: () => randomUUID()
    })
    // Above the process service: its load() can raise a Run's end (a lost run) before the chat service below exists.
    const permissionMode = devEnv('ZUMIBOT_PERMISSION_MODE') === 'manual' ? 'manual' : 'auto'
    // Per turn, so a provider change applies from a chat's next message. Zumi Bot stays on Claude whatever its file says: its
    // deny rules and automations exist only on Claude runs.
    const engineOf = async (agent: string): Promise<Engine> =>
      agent === ZUMI_BOT_NAME ? 'claude' : engineOfAgent((await agents.list()).find((a) => a.name === agent))
    // One audit record per Run when it ends, whichever way it ends. Never throws or blocks the process service; codes only.
    const auditRun = (e: RunEndEvent): void => {
      void (async () => {
        const meta = await chats.get(e.chatId).catch(() => null)
        const runKind = meta?.workflow ? 'workflow' : meta?.group ? 'room' : 'chat'
        await audit.record(
          runAuditRecord(e, {
            engine: await engineOf(e.agent),
            isolation: isolation.levelOf(e.agent),
            mode: permissionMode,
            runKind,
            scrub: scrubOf(e.agent)
          })
        )
      })().catch((err) => console.error('run audit record not written:', (err as { code?: unknown } | null)?.code ?? 'error'))
    }
    // A Run's end goes to the block's author the same way, as a hidden message; a server restart ends the run and sends nothing.
    const runResults = new RunResults({
      submit: (chatId, text, run) => tasks.submit(chatId, text, [], undefined, undefined, undefined, undefined, 'run', undefined, { run }),
      chat: async (id) => {
        const m = await chats.get(id)
        return m ? { archived: isArchived(m), room: m.group !== undefined } : null
      }
    })
    const processes = new ProcessService({
      dataDir,
      onWake: (e) => wakes.event(e),
      onRunEnd: (e) => {
        runResults.ended(e)
        auditRun(e)
      },
      env: async () => {
        await runEnv.ready()
        return runEnv.env()
      },
      chat: async (id) => {
        const m = await chats.get(id)
        return m ? { cwd: m.cwd, archived: isArchived(m) } : null
      },
      push: (e) =>
        e.kind === 'changed'
          ? hub.broadcast({ event: 'processes:changed', payload: { chatId: e.chatId, running: e.running } })
          : hub.broadcast({ event: 'processes:output', payload: { chatId: e.chatId, id: e.id, to: e.to } }),
      scrubOf
    })
    await processes.load()
    undo.push(() => processes.shutdown())
    // Every removal path, not only the handler's: a deleted chat keeps no process.
    chats.setRemovedListener((id) => {
      search.remove(id)
      processes.removeChat(id).catch(() => console.error('ending deleted chat processes failed'))
      wakes.forget(id)
    })
    const processIpc = await serveProcessIpc({ service: processes })
    undo.push(() => processIpc.close())
    const vaultIpc = await serveVaultIpc({ items: (agent) => vault.agentItems(agent) })
    undo.push(() => vaultIpc.close())
    // Suggested replies: a chat gone idle on a reply that asks the user gets their likely next messages (replyOptions.ts).
    const replyOptions = new ReplyOptions({
      store: chats,
      push,
      enabled: async () => (await settings.get()).suggestedReplies,
      // Built later; only ever called once a chat goes idle, by which time it exists.
      running: (chatId) => chatService.isRunning(chatId),
      read: async (chatId, input, signal) => {
        const bin = await claude.locate()
        if (!bin) return null
        await runEnv.ready()
        // No tools and no session: the home folder is only where the call starts.
        return runReplyOptions({
          bin,
          cwd: homedir(),
          env: runEnv.env(),
          input,
          signal,
          onCost: (c, id) => usage.recordModerator(chatId, c, id, Date.now())
        })
      }
    })
    // Agent asks: B's turn runs through ChatService, which is built later, so `run` reaches it by closure.
    const asks = new AgentAsks({
      agents: () => agents.list(),
      chats,
      run: (id, o) => chatService.runAsked(id, o),
      // Same: SideQuestions is built after ChatService, and a side ask runs through it.
      side: (id, o) => side.askFrom(id, o),
      push
    })
    const askIpc = await serveAskIpc({ service: scrubbedAsks(asks, scrubOf) })
    undo.push(() => askIpc.close())
    // Zumi Bot's routine and workflow tools. Their service saves through the routineEditing and workflowEditing the editor's
    // RPCs use, which need the schedulers and the workflow runner made after ChatService, so it is set there and reached by
    // closure. Nothing calls before: only a Zumi Bot turn holds a capability, and none runs before the server listens.
    let automations: AutomationService | undefined
    const automationIpc = await serveAutomationIpc({
      service: {
        run: (owner, call) => (automations ? automations.run(owner, call) : Promise.reject(new Error('Routines and workflows unavailable')))
      }
    })
    undo.push(() => automationIpc.close())
    const sidebarChanged = (layout: SidebarLayout): void => hub.broadcast({ event: 'sidebar:changed', payload: layout })
    const voiceChanged = (payload: VoiceStatus): void => hub.broadcast({ event: 'voice:changed', payload })
    vault.onChange(() => hub.broadcast({ event: 'vault:changed', payload: null }))
    const approvalsChanged = (agent: string): void => hub.broadcast({ event: 'approvals:changed', payload: { agent } })
    const disallowedToolsFor = (n: string): string[] => (n === ZUMI_BOT_NAME ? zumiBotDenyRules(config.agentsDir) : [])
    // What a run of an agent adds for its file's servers, plugins, skills and hooks, read fresh each time (a Save applies from the
    // next run). Zumi Bot has none. A Vault that cannot be opened leaves out every own server naming a key. The probe passes
    // serversOff: false and skillsOff: false, so a server or a skill the agent turned off still shows and can be switched back on.
    // Every agent run also denies the catalog connectors the agent has not switched on (Zumi Bot: all of them, never any), even
    // an agent without a readable file. The probe's serversOff: false leaves that deny out too, so a switched-off connector still shows.
    const agentRunConfig = async (agent: string, opts?: { serversOff?: boolean; skillsOff?: boolean }): Promise<AgentRunConfig> => {
      if (agent === ZUMI_BOT_NAME)
        return opts?.serversOff === false ? NO_RUN_CONFIG : buildAgentRunConfig(NO_EXTENSIONS, [], { connectorsOff: CONNECTOR_IDS })
      const ext = await agents.extensionsOf(agent)
      // A run that needs catalog names (GitHub has none of its own, a renamed or "(2)" connector another) waits a bounded time for the
      // start-up read, or retries a failed one; the probe passes serversOff: false, uses no rules, and must not wait on a home read.
      const on = connectorStore.onFor(agent)
      if (opts?.serversOff !== false && (on === null || on.length > 0)) await connectors.ready(10_000)
      const connectorsOff = connectorStore.offFor(agent)
      if (ext === null)
        return buildAgentRunConfig(NO_EXTENSIONS, [], { ...opts, connectorsOff, connectorServers: connectors.serverNames() })
      const status = vault.status()
      return buildAgentRunConfig(ext, status === 'keyMissing' || status === 'keyMismatch' ? 'locked' : vault.grantedTo(agent), {
        ...opts,
        connectorsOff,
        connectorServers: connectors.serverNames()
      })
    }
    // What a folder or an agent loads (asked of the CLI, only when a page asks), and the page's writes to the user's Claude Code config.
    const extensions = new ExtensionsService({
      locate: async () => {
        const bin = await claude.locate()
        if (bin) await runEnv.ready()
        return bin
      },
      locateCodex: codexLocate,
      env: async () => {
        await runEnv.ready()
        return runEnv.env()
      },
      // The user's settings.json, skills and .claude.json follow CLAUDE_CONFIG_DIR of env(), the env every CLI run gets.
      home,
      agents: () => agents.list(),
      extensionsOf: (agent) => agents.extensionsOf(agent),
      // The same source as a main run's API key env (`keyEnv` in ChatService), so the probe's servers see what a run's do.
      agentKeys: async (agent) => vaultEnvOf(vault.grantedTo(agent)).env,
      runConfig: (agent, opts) => agentRunConfig(agent, opts),
      trash: (p) => trashPath(p, home, () => new Date()),
      now: () => Date.now(),
      // A Claude Code page write can add or remove a catalog server, so the connectors page refetches too.
      onChanged: () => {
        hub.broadcast({ event: 'extensions:changed', payload: null })
        hub.broadcast({ event: 'connectors:changed', payload: null })
      },
      log: (line) => console.error(line)
    })
    // The claude.ai connectors' switches: the catalog is read from the home loadout, the switch-over runs once after listen.
    const connectors = new ConnectorsService({
      store: connectorStore,
      loadout: (refresh, keep = true) => (keep ? extensions.loadout(home, null, refresh) : extensions.peek(home)),
      agents: () => agents.list(),
      extensionsOf: (agent) => agents.extensionsOf(agent),
      // The variable's name only, never its value.
      keyVar: async () => {
        await runEnv.ready()
        return keyVarInUse(runEnv.env())
      },
      now: Date.now,
      onChanged: () => hub.broadcast({ event: 'connectors:changed', payload: null }),
      log: (line) => console.error(line)
    })
    // A grant or a locked Vault changes which of an agent's own servers a run starts, so a cached card would be wrong.
    vault.onChange(() => extensions.forget())
    const account = new AccountService({
      configFile: claudeConfigFile(),
      usageFile: join(dataDir, 'usage.json'),
      osUser: () => userInfo().username,
      now: () => Date.now()
    })
    const codexUsage = new CodexUsage(() => Date.now())
    // The shell's env under a Codex run's own, and under its hook pre-flight's when it has one (that one lacks the agent's keys).
    const codexEnvs = (o: CodexRunOptions): CodexRunOptions => ({
      ...o,
      env: { ...runEnv.env(), ...o.env },
      ...(o.hookTrustEnv ? { hookTrustEnv: { ...runEnv.env(), ...o.hookTrustEnv } } : {})
    })
    const memoryNote = async (agent: string): Promise<string> => {
      const summary = (await agents.list()).find((a) => a.name === agent)
      if (summary?.memory !== 'user' || (await autoMemoryOff())) return ''
      return capNote(await memoryStore.count(agent), effectiveLimit(summary.memoryLimit))
    }
    const askRosterOf = async (agent: string): Promise<{ name: string; description: string }[]> => askRoster(await agents.list(), agent)
    // The second Claude adapter, behind its dev hook: its own chunk, imported only when the hook is on, so neither the
    // packaged build nor a normal server loads the SDK. It is given this service's caps and locate, the run env and the same
    // usage interception `run` below does, so only the spawn differs (see docs/architecture/engines.md).
    const claudeSdk = claudeSdkEngineOn() ? (await import('./core/engines/claudeSdkEngine')).claudeSdkEngine : null
    // On stdout, not stderr: the e2e suites treat anything a server writes to stderr as a failure, and this is a dev hook's
    // own announcement, not a fault.
    if (claudeSdk) console.log('ZUMIBOT_CLAUDE_SDK=1: Claude turns run through the Agent SDK adapter')
    const chatService = new ChatService({
      engineOf,
      codexSkill: (folder, agent, name) => extensions.codexSkill(folder, agent, name),
      // The CLI path asks each binary whether it takes the flag; the SDK path needs no probe, since its option is typed and
      // the SDK's own version pins the Claude Code version that has it.
      dropsTurn: claudeSdk ? async () => true : dropsTurnProbe,
      ...(claudeSdk
        ? {
            claudeEngine: (base) =>
              claudeSdk({
                ...base,
                env: () => runEnv.env(),
                intercept: (e, pass) => {
                  if (e.kind === 'rateLimit') {
                    const u = claudeUsageOf(e)
                    if (u) void account.record(u)
                  } else pass(e)
                }
              })
          }
        : {}),
      ensureFolder: (id) => worktrees.ensureChat(id, { forTurn: true }),
      // ACP agents: the file's launch per attempt, run only as confirmed (launch trust), its command found on the run env's
      // PATH, and the run env under the run's own (the runner strips every ZUMIBOT_* name).
      acp: {
        definitionOf: (agent) => agents.acpOf(agent),
        trust: (agent, launch) => launchTrust.check(agent, acpRecord(launch)),
        locate: async (command) => {
          await runEnv.ready()
          return acpLocate(command, runEnv.env())
        },
        run: (o) => startAcp({ ...o, env: { ...runEnv.env(), ...o.env } })
      },
      // Remote (AG-UI) agents: the file's endpoint per attempt, run only as confirmed (launch trust), with the dev hook read
      // through devEnv (so production never allows a local address), and the thread kept beside the chat.
      agui: {
        definitionOf: (agent) => agents.aguiOf(agent),
        trust: (agent, launch) => launchTrust.check(agent, aguiRecord(launch)),
        allowLocal: aguiAllowLocal(),
        run: (o) => startAgui(o),
        thread: { load: (id) => chats.loadAgui(id), save: (id, t) => chats.saveAgui(id, t) }
      },
      codex: {
        locate: codexLocate,
        run: (o) => runCodex(codexEnvs(codexReadingsOnly(o, codexUsage))),
        definitionOf: (agent) => agents.definitionOf(agent)
      },
      store: chats,
      files,
      snapshots,
      tmp,
      ...(pauseHooks ? { pauseHook: pauseHooks.claude, codexPauseHook: pauseHooks.codex } : {}),
      // Behind the same deny rules: the vault key and vault.json, the audit log, and now connectors.json (only the two RPCs write the switches).
      vaultGuard: mergeInlineJson(
        [
          vaultGuardSettings({ keyFile: config.vaultKeyFile, vaultFile: join(dataDir, 'vault.json'), home: homedir(), auditDir }),
          connectorsGuardSettings(join(dataDir, 'connectors.json'))
        ],
        '--settings'
      ),
      // The same paths as Codex hooks; a Codex agent's API keys ride only beside them.
      codexVaultHooks: codexVaultHooks({ keyFile: config.vaultKeyFile, vaultFile: join(dataDir, 'vault.json'), home: homedir(), auditDir }),
      audit,
      isolation,
      readFile,
      // The interactive-shell PATH is resolved with the first locate a chat needs, never at startup.
      locate: async () => {
        const bin = await claude.locate()
        if (bin) await runEnv.ready()
        return bin
      },
      // Usage readings go to the account (the rail's Usage popover), never to the chat.
      run: (o) =>
        runClaude({
          ...o,
          env: { ...runEnv.env(), ...o.env },
          onEvent: (e) => {
            if (e.kind === 'rateLimit') {
              const u = claudeUsageOf(e)
              if (u) void account.record(u)
            } else o.onEvent(e)
          }
        }),
      push,
      onTurnEnd: (e) => {
        notify.turnEnded(e)
        void reads.turnEnded(e)
        todos.turnEnded(e)
        attemptTurnEnded({ store: chats, push }, e)
        fireChatEvent(e.chatId, (meta) => replyEvent(e, meta, false))
      },
      memory: {
        begin: async (agent) => {
          memoryTurns.started(agent)
          const summary = (await agents.list()).find((a) => a.name === agent)
          if (summary?.memory !== 'user' || (await autoMemoryOff())) return null
          await memoryStore.repairIndex(agent)
          return { dir: memoryStore.dirOf(agent), note: capNote(await memoryStore.count(agent), effectiveLimit(summary.memoryLimit)) }
        },
        end: (agent, touched) => {
          memoryTurns.ended(agent)
          if (touched) memoryChanged(agent)
        }
      },
      now: () => Date.now(),
      newId: () => randomUUID(),
      permissionMode,
      disallowedToolsFor,
      houseStyle: async () => (await settings.get()).houseStyle,
      thinkingDisplay: thinkingProbe,
      // A handoff's reason is the agent's own text over a bridge: scrubbed with its grants before the card is stored.
      browserTurns: scrubbedHandoffs(browsers.turns, scrubOf),
      desktopTurns: scrubbedHandoffs(desktops.turns, scrubOf),
      todos,
      dispatch,
      todoTurns: { create: (owner) => todoIpc.createTodoTurn(owner) },
      vaultTurns: { create: (owner) => vaultIpc.createVaultTurn(owner) },
      vaultApprovals,
      vaultEnv: (agent) => vaultEnvOf(vault.grantedTo(agent)),
      vaultItemName: (id, agent) => vault.itemNameFor(id, agent),
      askTurns: { create: (owner) => askIpc.createAskTurn(owner) },
      askRoster: askRosterOf,
      askEnd: (turn) => asks.endTurn(turn),
      automationTurns: { create: (owner, o) => automationIpc.createAutomationTurn(owner, o) },
      processTurns: { create: (owner) => processIpc.createProcessTurn(owner) },
      onRunCost: (e) => {
        usage.recordRun(e)
        workflowRunner.chatCost(e.chatId, e.cost.totalUsd) // an Agent step's turn: its run shows what it cost
        runner.chatCost(e.chatId, e.cost.totalUsd) // a routine run's turn: its spend cap counts it
        // Once stored, the agent's day is judged again: the request that crossed its cap may have been the turn's last.
        void usage.flushed().then(() => spendCaps.settled(e.chatId, e.agent))
      },
      costBaseline,
      onContext: (chatId, agent, c) => keepWarm.note(chatId, agent, c.used, c.at ?? Date.now()),
      compactWindow: async (agent) => (await agents.list()).find((a) => a.name === agent)?.autoCompactWindow ?? null,
      acknowledge: async ({ chatId, agent, user, todos, signal }) => {
        const message = ackMessage(user)
        if (message === '') return null
        const bin = await claude.locate()
        if (!bin) return null
        await runEnv.ready()
        const description = (await agents.list()).find((a) => a.name === agent)?.description ?? ''
        // No tools and no session: the home folder is only where the call starts.
        return runAck({
          bin,
          cwd: homedir(),
          env: runEnv.env(),
          input: { agent, description, message, todos },
          signal,
          onCost: (c, id) => usage.recordModerator(chatId, c, id, Date.now())
        })
      },
      agentRunConfig: (agent) => agentRunConfig(agent),
      connectorRemembers: (id) => connectorStore.remembers(id),
      agentModel: async (agent) => (await agents.list()).find((a) => a.name === agent)?.model ?? null,
      onRunWithoutCost: (chatId, sessionId, agent) => usage.refreshSession(chatId, agent, sessionId),
      spend: { live: (e) => spendCaps.liveSpend(e), ended: (attempt) => spendCaps.ended(attempt) },
      onIdle: (id) => {
        // Read before chatIdle settles them: a routine run's turn follows its own limit policy, and a workflow step waits
        // out its limit itself, so the chat's own wait must leave both alone (else two continues go in).
        const owned = new Set([...runner.messagesOf(id), ...workflowRunner.messagesOf(id)])
        tasks.idle(id)
        runner.chatIdle(id)
        workflowRunner.chatIdle(id)
        limits.idle(id, owned)
        spendCaps.chatIdle(id)
        // Last: a wake-up queues behind whatever the queue, routines and limit waits just did with the idle chat.
        wakes.idle(id)
        // After everything that may start a new run: the reader skips a chat that is running again.
        void replyOptions.idle(id)
      },
      approvalRisk: async (chatId, r) => {
        const meta = await chats.get(chatId)
        return meta ? jev.approvalRisk({ ...r, cwd: meta.cwd }) : null
      },
      // A Room step's "Allow for this step": fire and forget; a failure logs its code only, never the rule or chat text.
      onStepRule: (chatId, rule) =>
        void stepRuleSave(chatId, rule).catch((err) =>
          console.error(
            'saving step rule failed',
            typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : 'error'
          )
        ),
      agentRules: {
        has: (a, k) => approvals.has(a, k),
        cli: (a) => approvals.cliRules(a),
        // Awaited: the user's Allow is stored before the continue message goes out.
        addCli: async (a, rule) => {
          const toolName = folderOfRule(rule) !== null ? 'Read' : 'Bash'
          await approvals.add(a, { key: JSON.stringify(['cli', rule]), toolName, command: null, cli: rule })
          approvalsChanged(a)
        },
        // Memory is already updated; the write and the broadcast must not hold up the reply.
        add: (a, r) =>
          void approvals.add(a, r).then(
            () => approvalsChanged(a),
            (err) => console.error('saving approval failed:', err)
          )
      }
    })
    const groupService = new GroupService({
      store: chats,
      chats: chatService,
      files,
      agents: () => agents.list(),
      engineOf,
      moderate: async (moderatorInput, cwd, signal, chatId) => {
        // Jev settles the easy cases; null (off, unsure or failed) leaves the call to the Haiku moderator, as before.
        const quick = await jev.moderate(moderatorInput, signal).catch(() => null)
        if (quick || signal.aborted) return quick
        const bin = await claude.locate()
        if (!bin) return null
        // The room's worktree may have been removed since it was archived; a throw is the room's failed moderator call.
        await worktrees.ensureChat(chatId)
        await runEnv.ready()
        return runModerator({
          bin,
          cwd,
          env: runEnv.env(),
          input: moderatorInput,
          signal,
          onCost: (c, id) => {
            usage.recordModerator(chatId, c, id, Date.now())
            // A Room step's room: the moderator's call belongs to the step's visit (counts only while one follows that chat).
            workflowRunner.chatCost(chatId, c.totalUsd)
          }
        })
      },
      push,
      onTurnEnd: (e) => {
        void reads.roomTurnEnded(e)
        fireChatEvent(e.chatId, (meta) => replyEvent(e, meta, true))
      },
      now: () => Date.now(),
      newId: () => randomUUID(),
      disallowedToolsFor
    })
    // An A to B chat's main run starts with this paragraph (askedTurn), so its side run must too, after a restart as well.
    // A workflow step's chat (or a step test's) starts with the workflow paragraph the same way: the cache prefix and
    // the material rule hold.
    const sideFirstPart = (meta: ChatMeta): string => {
      const workflowName = meta.workflow?.name ?? meta.workflowTest
      return meta.asked ? askedSystem(meta.asked.by, meta.asked.fromTitle) : workflowName !== undefined ? workflowSystem(workflowName) : ''
    }
    // Like runTurn's `askable`: single chats only, never Zumi Bot.
    // The ask IPC is always wired here.
    const sideAskable = (meta: ChatMeta, agent: string): boolean => !meta.group && agent !== ZUMI_BOT_NAME
    const sideRoster = async (agent: string): Promise<string> => {
      // A failing roster read costs the side run its roster, never the run.
      try {
        return askSystem(await askRosterOf(agent))
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code
        console.error('side ask roster not added:', typeof code === 'string' ? code : 'error')
        return ''
      }
    }
    // A room member's briefing, as its main run's spec.systemPrompt has it: the loadable members, the room's folder, role and handoff.
    const roomBriefing = async (meta: ChatMeta, agent: string): Promise<string> => {
      if (!meta.group) return ''
      const all = await agents.list()
      const members = meta.group.members.flatMap((name) => {
        const summary = all.find((a) => a.name === name && a.error === null)
        return summary ? [{ name, description: summary.description }] : []
      })
      return buildBriefing(agent, members, meta.cwd, meta.group.role, meta.group.handoff)
    }
    // A fresh base for a Codex agent: the instructions its main run's thread gets, in that order (the agent's body, then the
    // system parts: a room member's briefing first; no memory note, which Codex runs never get). No point: an idle base reads the
    // chat's stamps.
    const codexSideBase = async (meta: ChatMeta, agent: string): Promise<SideBase> => {
      // Thrown, so the entry reads the fixed sentence rather than "Claude CLI not found".
      const bin = await codexLocate()
      if (!bin) throw new Error(CODEX_REFUSALS.notFound)
      const def = await agents.definitionOf(agent).catch(() => null)
      const askable = sideAskable(meta, agent)
      const system = [
        sideFirstPart(meta),
        await roomBriefing(meta, agent),
        (await settings.get()).houseStyle ? HOUSE_STYLE : '',
        TODO_SYSTEM,
        VAULT_SYSTEM,
        RUN_SYSTEM,
        askable ? await sideRoster(agent) : ''
      ]
        .filter(Boolean)
        .join('\n\n')
      // A single chat's Codex pick by hand, as its main run's thread has it; a room member runs its agent file's.
      const model = codexModel((meta.group ? undefined : engineChatModel('codex', meta)) ?? def?.model)
      return {
        // The bridges are on every run, so the side turn makes them, as sideBrowser does for a Claude base.
        bin,
        cwd: meta.cwd,
        tmpDir: null,
        active: false,
        live: null,
        start: null,
        browser: true,
        asks: askable,
        ...(scrubOf(agent).size > 0 ? { scrub: new Map(scrubOf(agent)) } : {}),
        args: { agentName: agent, permissionMode, disallowedTools: [], extraArgs: [], appendSystemPrompt: '' },
        codex: {
          threadId: '',
          at: null,
          baseInstructions: [def?.body ?? '', system].filter(Boolean).join('\n\n'),
          ...(model !== undefined ? { model } : {})
        }
      }
    }
    const side = new SideQuestions({
      audit,
      store: chats,
      chats: chatService,
      groups: groupService,
      pick: async (input, cwd, signal, chatId) => {
        const bin = await claude.locate()
        if (!bin) return null
        // A throw here is a failed pick, which side questions already answer with the room fallback.
        await worktrees.ensureChat(chatId)
        await runEnv.ready()
        return runJsonCall({
          bin,
          cwd,
          env: runEnv.env(),
          args: pickArgs(),
          stdin: pickPrompt(input),
          signal,
          parse: (stdout) =>
            parsePick(
              stdout,
              input.members.map((m) => m.name)
            ),
          onCost: (cost, id) => usage.recordModerator(chatId, cost, id, Date.now())
        })
      },
      // The agent's engine now: a kept base of an engine the agent has left is dropped for baseFor's, so a side answer always
      // runs where the next main turn would (a room member too, on its own agent's engine).
      engineOf,
      ensure: (id) => worktrees.ensureChat(id),
      baseFor: async (chatId, agent) => {
        // Before the meta is read, and before either engine's base takes its cwd. A folder that can't be brought back means no base.
        try {
          await worktrees.ensureChat(chatId)
        } catch (err) {
          console.error('side base: worktree not ready:', err instanceof Error ? err.message : err)
          return null
        }
        const meta = await chats.get(chatId)
        // On the engine the agent's next main run would use: a Codex agent answers on Codex, from its own thread or seeded.
        if (meta) {
          const engine = await engineOf(agent)
          switch (engine) {
            case 'codex':
              return codexSideBase(meta, agent)
            case 'claude':
              break // the Claude base below
            // No side questions for ACP (`btw` off): stable v1 has no read-only fork to answer from.
            case 'acp':
              return null
            // Nor for a remote agent (`btw` off): a side thread could not stop its server's own tools.
            case 'ag-ui':
              return null
            default:
              return assertNever(engine)
          }
        }
        const bin = await claude.locate()
        if (!meta || !bin) return null
        await runEnv.ready()
        const items = await chats.loadItems(chatId)
        const briefing = await roomBriefing(meta, agent)
        const firstPart = sideFirstPart(meta)
        let note = ''
        try {
          note = await memoryNote(agent)
        } catch (err) {
          console.error('side memory note failed:', err instanceof Error ? err.message : err)
        }
        const askable = sideAskable(meta, agent)
        const asks = askable ? await sideRoster(agent) : ''
        // The same builder as the agent's main runs, so a side answer gets the same servers, skills and plugins (and drops the same
        // unfillable server). A failing read costs the side run those parts, never the run, and turns every connector off (not open).
        let own = CONNECTORS_ALL_OFF
        try {
          own = await agentRunConfig(agent)
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code
          console.error('side agent run config not read:', typeof code === 'string' ? code : 'error')
        }
        return {
          // The to-do and vault bridges are on every run, so a side run always gets them (through sideBrowser), like the main run.
          // The ask bridge too when the main run would have it: a fresh base must match a main run's tools and prompt.
          bin,
          cwd: meta.cwd,
          tmpDir: await tmp.ensure(chatId).catch(() => null),
          active: false,
          live: null,
          start: null,
          browser: true,
          asks: askable,
          desktop: Boolean(desktops.turns),
          // The agent's API key values: a side answer is scrubbed with them, as its main run is.
          ...(scrubOf(agent).size > 0 ? { scrub: new Map(scrubOf(agent)) } : {}),
          // Its own servers' Vault values (granted API keys' values, so in the scrub map above).
          ...(Object.keys(own.env).length > 0 ? { env: { ...own.env } } : {}),
          args: {
            // The chat's model too (a command may have set it): a side run on another model would miss the cache. Its effort likewise.
            agentName: agent,
            ...(!meta.group && engineChatModel('claude', meta) ? { model: engineChatModel('claude', meta) } : {}),
            ...(!meta.group && engineChatEffort('claude', meta) ? { effort: engineChatEffort('claude', meta) } : {}),
            permissionMode,
            // The agent's parts right after the turn's own, as agentTurn stores them.
            disallowedTools: [
              ...disallowedToolsFor(agent),
              ...(meta.group?.members.filter((n) => n !== agent).map((n) => `Agent(${n})`) ?? []),
              ...own.disallowedTools
            ],
            extraArgs: [...addDirArgs(items, files.dirOf(chatId)), ...own.extraArgs],
            // The same parts in the same order as agentTurn's system prompt (the asked or workflow paragraph is its spec.systemPrompt, first).
            appendSystemPrompt: [
              firstPart,
              briefing,
              (await settings.get()).houseStyle ? HOUSE_STYLE : '',
              note,
              TODO_SYSTEM,
              VAULT_SYSTEM,
              RUN_SYSTEM,
              asks
            ]
              .filter(Boolean)
              .join('\n\n'),
            // As a main run asks it, so the side run's thinking settings match the session's.
            ...((await thinkingProbe(bin).catch(() => false)) ? { thinking: true } : {})
          }
        }
      },
      run: (o) => runClaude({ ...o, env: { ...runEnv.env(), ...o.env } }),
      codexRun: (o) => runCodex(codexEnvs(codexReadingsOnly(o, codexUsage))),
      broadcast: (chatId, entry) => hub.broadcast({ event: 'btw:changed', payload: { chatId, entry } }),
      recordCost: (e) => usage.recordRun(e),
      costBaseline,
      now: () => Date.now()
    })
    // After side: its pings are side runs. In memory only, for sessions run here (see keepWarm.ts).
    const keepWarm: KeepWarm = new KeepWarm({
      settings: async () => (await settings.get()).keepWarm,
      chat: async (id) => {
        const meta = await chats.get(id)
        // A slot armed by a Claude-era context must not ping the abandoned Claude session once the agent is on Codex (null drops it).
        if (!meta || isCodexChat(meta, await agents.list())) return null
        return { room: meta.group !== undefined, archived: isArchived(meta), asked: meta.asked !== undefined }
      },
      isRunning: (id) => chatService.isRunning(id),
      warm: (chatId, agent) => side.warm(chatId, agent),
      // The cache was read at `at`, so the cold notice measures from there. In place: the sidebar order stays.
      warmed: (chatId, agent, at) => {
        void chats
          .patchInPlace(chatId, (cur) => {
            if (cur.group) {
              const c = cur.group.context?.[agent]
              return c ? { group: { ...cur.group, context: { ...cur.group.context, [agent]: { ...c, at } } } } : null
            }
            return cur.context ? { context: { ...cur.context, at } } : null
          })
          .then((meta) => {
            if (meta) push({ chatId, kind: 'meta', meta })
          })
          .catch(() => {
            /* a ping's stamp never matters enough to fail */
          })
      },
      now: () => Date.now(),
      // Dev hook (ignored in production): pings seconds apart, so the e2e can watch one.
      ...(Number(devEnv('ZUMIBOT_TEST_KEEPWARM_MS')) > 0 ? { everyMs: Number(devEnv('ZUMIBOT_TEST_KEEPWARM_MS')) } : {}),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return { clear: () => clearTimeout(t) }
      }
    })
    const summaries = new RoomSummaries({
      store: chats,
      agents: () => agents.list(),
      bin: () => claude.locate(),
      env: async () => {
        await runEnv.ready()
        return runEnv.env()
      },
      ensureFolder: (id) => worktrees.ensureChat(id),
      home,
      claudeDir: process.env['CLAUDE_CONFIG_DIR'] || undefined,
      onCost: (chatId, c, id) => usage.recordSummary(chatId, c, id, Date.now())
    })
    tasks = new TaskQueue({
      store: chats,
      chats: chatService,
      groups: groupService,
      files,
      push,
      now: () => Date.now(),
      newId: () => randomUUID(),
      onNewTurn: (id) => limits.cancel(id),
      limitChecked: (id) => limits.settled(id),
      onResume: (id, messageId) => {
        runner.chatResumed(id, messageId)
        workflowRunner.chatResumed(id, messageId)
      },
      capOverride: (id, cap) => spendCaps.override(id, cap)
    })
    // Pull requests from a chat's worktree branch, through the gh CLI. ZumiBot stores no GitHub token.
    const ghLocator = createGhLocator()
    const pullRequests = new PullRequests({
      git,
      gh: ghLocator.gh,
      ghState: () => ghLocator.state(),
      forgetAuth: () => ghLocator.forgetAuth(),
      store: chats,
      card: (todoId) => todos.card(todoId).catch(() => null),
      mirror: (todoId, pr) => todos.setCardPr(todoId, pr),
      submit: (chatId, text) => tasks.submit(chatId, text, []),
      push,
      now: () => Date.now()
    })
    const prWatcher = new PrWatcher({
      read: (chatId) => pullRequests.refreshPr(chatId),
      chat: (chatId) => chats.get(chatId),
      setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
      now: () => Date.now(),
      log: (line) => console.error(line)
    })
    // A PR whose checks were still running when the server stopped is picked up again, and nothing else is polled.
    for (const meta of await chats.list()) prWatcher.watch(meta)
    limits = new LimitResumes({
      store: chats,
      tasks,
      // True for group rooms too: GroupService claims its chat through ChatService.
      isRunning: (id) => chatService.isRunning(id),
      push,
      now: () => Date.now(),
      newId: () => randomUUID()
    })
    const commands = new CommandResolver({
      store: chats,
      commandsOf: (n) => agents.commandsOf(n),
      // An unreadable agents list or a failed probe means no engine rows: the text goes out as typed.
      engineCommandsOf: async (agent, folder, o) => {
        if (o?.cachedOnly) {
          const hit = await extensions.cachedEngineCommands(folder, agent).catch(() => null)
          if (hit) return hit
          // A cold cache never holds up a send: a Claude command goes out as typed (only its chip is lost); a Codex skill needs the list.
          const found = (await agents.list().catch(() => [])).find((a) => a.name === agent)
          if (!(found && engineOfAgent(found) === 'codex')) return null
        }
        return extensions.engineCommands(folder, agent).catch(() => null)
      }
    })
    // Whether a routine's or workflow's spend cap can hold for its agents' engines: at save, and again where a run starts.
    const capEngineCheck = capEngines({ agents: () => agents.list(), chats })
    runner = new RoutineRunner({
      store: routineStore,
      chats,
      tasks,
      commands,
      agents: () => agents.list(),
      // True for group rooms too: GroupService claims its chat through ChatService.
      isRunning: (id) => chatService.isRunning(id),
      builtInCwd: (n) => (n === ZUMI_BOT_NAME ? config.agentsDir : null),
      changed: routinesChanged,
      now: () => Date.now(),
      newId: () => randomUUID(),
      condition: (c, call) => jev.webhookCondition(c, call),
      onFailed: (e) => notify.routineFailed(e),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref()
        return { clear: () => clearTimeout(t) }
      },
      placeRoom,
      capGate: (names) => spendCaps.gate(names),
      capEngines: capEngineCheck
    })
    const scheduler = createScheduler({
      store: routineStore,
      runner,
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        return { clear: () => clearTimeout(t) }
      },
      onError: (err) => console.error('routine scheduler failed:', err instanceof Error ? err.message : err)
    })
    // LLM and Condition steps: bare calls built like the moderator's, run in the data dir, never in an agent's folder.
    const bare = new BareCalls({
      bin: () => claude.locate(),
      env: async () => {
        await runEnv.ready()
        return runEnv.env()
      },
      cwd: dataDir
    })
    const isDir = (p: string): Promise<boolean> =>
      stat(p).then(
        (st) => st.isDirectory(),
        () => false
      )
    workflowRunner = new WorkflowRunner({
      store: workflowStore,
      commands,
      condition: (c, call) => jev.webhookCondition(c, call),
      bare,
      chats,
      tasks,
      stopChat: (id) => chatService.stop(id),
      isRunning: (id) => chatService.isRunning(id),
      pushMeta: (meta) => push({ chatId: meta.id, kind: 'meta', meta }),
      endProcesses: (chatId) => processes.endChat(chatId, 'archive'),
      agents: () => agents.list(),
      zumiBot: ZUMI_BOT_NAME,
      builtInCwd: (n) => (n === ZUMI_BOT_NAME ? config.agentsDir : null),
      dirExists: isDir,
      notify: {
        waiting: (o) => notify.workflowWaiting(o),
        cleared: (runId) => notify.workflowWaitingCleared(runId),
        failed: (o) => notify.workflowFailed(o),
        message: (o) => notify.workflowMessage(o)
      },
      messages: workflowMessages,
      inboxChanged,
      recordCost: (workflowId, cost, id) => usage.recordWorkflow(workflowId, cost, id, Date.now()),
      changed: workflowsChanged,
      now: () => Date.now(),
      newId: () => randomUUID(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref()
        return { clear: () => clearTimeout(t) }
      },
      waitScale: testWaitScale(),
      // Read per request, so a key whose switch was turned off or that was deleted stops being sent at once.
      vaultKey: (id) => vault.workflowKey(id),
      // Read per check, as vaultKey: a login whose switch was turned off or that was deleted is a problem at once.
      mailAccount: (id) => vault.workflowLogin(id),
      rooms: {
        copy: (t) => {
          const d = {
            store: chats,
            allowed: chatService,
            agents: () => agents.list(),
            zumiBot: ZUMI_BOT_NAME,
            sectionOf: (id: string) => sidebar.sectionOf(groupKey(id)),
            placeRoom,
            now: Date.now
          }
          return t.agents ? newRoom(d, { ...t, agents: t.agents }) : copyRoom(d, t)
        }
      },
      capEngines: capEngineCheck,
      caps: {
        context: (workflowId, runId) => spendCaps.context(workflowId, runId),
        held: (run, name) => spendCaps.held(run, name),
        // An agent whose cap was removed, or that was renamed or deleted since, has nothing to raise: the hold still lifts.
        allowMore: async (agent) => {
          await spendCaps.allowMore(agent).catch(() => undefined)
        }
      }
    })
    spendCaps = new SpendCaps({
      store: capStore,
      chats,
      isRunning: (id) => chatService.isRunning(id),
      pause: (id, cap) => tasks.pause(id, cap),
      resume: (id) => tasks.resumePaused(id),
      agents: () => agents.list(),
      agentSpend: (agent, from, skip) => usage.agentSpend(agent, from, skip),
      timeZone: async () => (await settings.timeZone()) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      workflows: {
        get: (id) => workflowStore.get(id),
        getRun: (runId) => workflowStore.getRun(runId),
        checkCap: (runId) => workflowRunner.checkCap(runId),
        continueCap: (runId) => workflowRunner.continueCap(runId),
        runsIn: (chatId) => workflowRunner.runsIn(chatId)
      },
      routines: {
        get: (id) => routineStore.get(id),
        getRun: (routineId, runId) => routineStore.getRun(routineId, runId),
        runsIn: (chatId) => runner.runsIn(chatId),
        capMark: (routineId, runId, mark) => runner.capMark(routineId, runId, mark)
      },
      notify: (n) => notify.spendCap(n),
      changed: () => hub.broadcast({ event: 'usage:changed', payload: { chatId: null } }),
      now: () => Date.now()
    })
    // Before the server listens: recovery runs after listen (and after usage.start()), so until it is done a webhook,
    // Run, Approve, Retry or Stop waits rather than racing the runs it recovers. recover() and stop() open the gate.
    workflowRunner.holdUntilRecovered()
    // Starts the workflows whose trigger is an in-app event; log lines carry ids and messages only, never event text.
    eventDispatcher = new WorkflowEventDispatcher({
      workflows: () => workflowStore.list(),
      run: (w, via, o) => workflowRunner.run(w, via, o),
      chatMeta: (id) => chats.get(id),
      getRun: (id) => workflowStore.getRun(id),
      busy: (id) => workflowRunner.busy(id),
      activeDepths: (id) => workflowRunner.activeDepths(id),
      now: () => Date.now(),
      log: (line) => console.error(line)
    })
    // Folder watches for the File trigger; they start after recovery (below), so no event runs before the held runs do.
    fileWatchers = new FileWatchers({
      watch: (dir, onChange, onError) => {
        const w = fsWatch(dir, { recursive: true }, (type, name) => {
          if (name) onChange(String(name), type)
        })
        w.on('error', onError)
        return w
      },
      stat: (p) =>
        stat(p).then(
          (s) => (s.isDirectory() ? 'dir' : 'file'),
          () => null
        ),
      emit: (e, workflowId) => {
        void eventDispatcher?.emit(e, { only: workflowId })
      },
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref()
        return { clear: () => clearTimeout(t) }
      },
      log: (line) => console.error(line),
      busy: fileBusy(workflowRunner)
    })
    // Mail polls for the Email trigger, started with the folder watches. Logs name the workflow, never the user or password.
    const mailAccount = (id: string): { username: string; password: string } | null => vault.workflowLogin(id)
    mailWatchers = new MailWatchers({
      connect: connectImap,
      parse: parseMail,
      account: mailAccount,
      state: mailStateFile(join(dataDir, 'workflow-mail.json')),
      emit: (e, workflowId) => {
        void eventDispatcher?.emit(e, { only: workflowId })
      },
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref()
        return { clear: () => clearTimeout(t) }
      },
      log: (line) => console.error(line),
      freeRuns: (id) => workflowRunner.freeRuns(id)
    })
    const workflowScheduler = createScheduler<Workflow>({
      store: workflowStore,
      runner: workflowRunner,
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms)
        return { clear: () => clearTimeout(t) }
      },
      onError: (err) => console.error('workflow scheduler failed:', err instanceof Error ? err.message : err)
    })
    const hooks = createHookHandler({
      targets: [routineHookTarget({ store: routineStore, runner }), workflowHookTarget({ store: workflowStore, runner: workflowRunner })],
      badSecrets: createLimiter({ now: Date.now }),
      now: () => Date.now()
    })
    // Caught and logged by message only (never an item): a vault or connector-switch write failure must not stop the renames after it.
    const writeFailed =
      (what: string) =>
      (err: unknown): void =>
        console.error(`${what} failed:`, err instanceof Error ? err.message : 'unknown error')
    const routineHistory = new HistoryStore<RoutineDef>(join(dataDir, 'history', 'routines'), {
      newId: randomUUID,
      now: Date.now,
      label: 'routines'
    })
    const workflowHistory = new HistoryStore<WorkflowDef>(join(dataDir, 'history', 'workflows'), {
      newId: randomUUID,
      now: Date.now,
      label: 'workflows'
    })
    const renameAgent = async (from: string, to: string): Promise<void> => {
      // First: memory moves synchronously, so a reply asking meanwhile sees the new name.
      await approvals.renameAgent(from, to)
      // The confirmed launch follows the agent; caught, and by code only (the file holds commands and arguments).
      await launchTrust.rename(from, to).catch(() => console.error('moving the agent launch failed'))
      // Also synchronous in memory; caught, so a failed write never stops the renames after it.
      await connectorStore.renameAgent(from, to).catch(writeFailed('moving connector switches'))
      await vault.renameAgent(from, to).catch(writeFailed('moving vault grants'))
      await channelStore.renameAgent(from, to).catch(writeFailed('moving channel switches'))
      memoryTurns.renamed(from, to)
      // Running group rooms first, so none of them saves the old name back over the rewritten chats.
      side.renameAgent(from, to)
      groupService.renameAgent(from, to)
      chatService.renameAgent(from, to)
      dispatch.renameAgent(from, to)
      // Both start together; the sync job awaits them before its removal pass.
      await Promise.all([browsers.renameAgent(from, to), desktops.renameAgent(from, to)])
      await chats.renameAgent(from, to)
      // The "started by" label of each process, after stored chats; caught, since a process list is no reason to fail a rename.
      await processes.renameAgent(from, to).catch(() => console.error('renaming process owners failed'))
      await usage.renameAgent(from, to)
      await spendCaps
        .renameAgent(from, to)
        .catch((err) => console.error('renaming spend caps failed:', err instanceof Error ? err.message : err))
      feed.reset()
      await settings.renameAgent(from, to)
      const layout = await sidebar.renameAgent(from, to)
      if (layout) sidebarChanged(layout)
      // Last and caught: a routines-store failure must not skip the renames above.
      await routineStore
        .renameAgent(from, to)
        .then(routinesChanged, (err) => console.error('renaming routine agents failed:', err instanceof Error ? err.message : err))
      await workflowStore
        .renameAgent(from, to)
        .then(workflowsChanged, (err) => console.error('renaming workflow agents failed:', err instanceof Error ? err.message : err))
      // So a restored version names the agent as it is called now.
      await routineHistory.rewrite((def) => renameRoutineDef(def, from, to)).catch(logHistoryError)
      await workflowHistory.rewrite((def) => renameWorkflowDef(def, from, to)).catch(logHistoryError)
    }
    const sync = createAgentsSync({
      ensureBuiltIn: () => ensureZumiBot(config.agentsDir),
      list: () => agents.list(),
      rename: renameAgent,
      removed: async (names) => {
        await Promise.all([browsers.removeAgents(names), desktops.removeAgents(names)])
        await approvals.forgetAgents(names)
        await vault.forgetAgents(names).catch(writeFailed('dropping vault grants'))
        await connectorStore.forgetAgents(names).catch(writeFailed('dropping connector switches'))
        await channelStore.forgetAgents(names).catch(writeFailed('dropping channel switches'))
        await launchTrust.remove(names).catch(() => console.error('dropping agent launches failed'))
      },
      remembered: () => [
        ...new Set([
          ...approvals.agents(),
          ...browsers.agents(),
          ...desktops.agents(),
          ...vault.agents(),
          ...connectorStore.agents(),
          ...launchTrust.agents()
        ])
      ],
      notify: (renamed) => hub.broadcast({ event: 'agents:changed', payload: renamed }),
      onError: (err) => console.error('agents sync failed:', err)
    })

    try {
      await chats.recoverInterrupted()
    } catch (err) {
      console.error('recovering interrupted chats failed:', err)
    }
    try {
      await files.clearStaged() // staged files never survive a restart
    } catch (err) {
      console.error('clearing staged attachments failed:', err)
    }
    // Each step alone: one failing (a corrupt file, say) must not keep the server down. Messages only, never contents.
    const step = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn()
      } catch (err) {
        console.error(`${what} failed:`, err instanceof Error ? err.message : err)
      }
    }
    // Built once: the handlers use them now, and Zumi Bot's tools save through the same code.
    const newSecret = (): string => randomBytes(32).toString('base64url')
    const routineEdit = routineEditing({
      store: routineStore,
      scheduler,
      changed: routinesChanged,
      newSecret,
      history: routineHistory,
      capEngines: capEngineCheck
    })
    const workflowEdit = workflowEditing({
      store: workflowStore,
      runner: workflowRunner,
      scheduler: workflowScheduler,
      changed: workflowsChanged,
      newSecret,
      history: workflowHistory,
      capEngines: capEngineCheck
    })
    stepRuleSave = stepRuleSaver({ chats, workflows: workflowStore, save: (input) => workflowEdit.save(input) })
    automations = new AutomationService({
      routines: routineStore,
      workflows: workflowStore,
      routineEditing: routineEdit,
      workflowEditing: workflowEdit,
      workflowProblems: (w) => workflowRunner.problems(w),
      chats,
      agents: () => agents.list(),
      // Read per call: the zone the page last reported (else the server's), and the folders the new-chat screen would pick.
      ctx: async () => {
        const s = await settings.get()
        return {
          timeZone: s.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          folders: s.lastFolderByAgent,
          groupFolder: s.lastGroupFolder,
          home
        }
      }
    })
    // Self-update (docs/architecture/updates.md). Busy counts running replies, as deploy's control socket does. It starts after
    // the control socket below, and stop() runs in the unwind. Not for a container, a non-installer layout or a Local mode
    // shell that keeps no updates: availability says why.
    const update = new UpdateService({
      dataDir,
      // Tests point it at a fake site, and sign its releases with a key of their own; both ignored in production.
      site: devEnv('ZUMIBOT_UPDATE_URL') ?? UPDATE_SITE,
      publicKey: devEnv('ZUMIBOT_TEST_RELEASE_KEY'),
      ...detectAvailability(config.mode, process.env, existsSync),
      current: __SERVER_VERSION__,
      busy: () => chatService.runningCount() + side.runningCount(),
      broadcast: (s) => hub.broadcast({ event: 'update:changed', payload: s }),
      restart: io.restart
    })
    undo.push(async () => update.stop())
    // Channels (Telegram, Slack): other places to talk to the same agents, one service per platform. Their sends go through
    // the same queue as chats:send, and their commands and card answers through the same handlers, so a channel never
    // widens what an agent may do.
    const telegramOrigin = testChannelOrigin(devEnv('ZUMIBOT_TEST_TELEGRAM_URL')) ?? undefined
    const slackOrigin = testChannelOrigin(devEnv('ZUMIBOT_TEST_SLACK_URL')) ?? undefined
    const keyDir = dirname(resolve(config.vaultKeyFile))
    const inside = (dir: string, p: string): boolean => isInside(dir, p)
    const channelState = new ChannelStateStore(dataDir)
    const sleepUnref = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref())
    const audioFormat = (mime: string): VoiceFormat =>
      mime.includes('webm') ? 'webm' : mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac') ? 'm4a' : 'ogg'
    const platformDeps = (platform: ChannelPlatform) =>
      platform === 'telegram'
        ? {
            adapterFor: (t: { token: string }) =>
              new TelegramAdapter({
                api: createTelegramApi({ token: t.token, origin: telegramOrigin }),
                sleep: sleepUnref,
                now: () => Date.now(),
                log: (line: string) => console.error(line)
              }),
            checkToken: async (t: { token: string }): Promise<'ok' | 'refused' | 'unreachable'> => {
              try {
                await createTelegramApi({ token: t.token, origin: telegramOrigin }).call('getMe', {}, { timeoutMs: 15_000 })
                return 'ok'
              } catch (err) {
                return err instanceof TelegramError && (err.code === 401 || err.code === 404) ? 'refused' : 'unreachable'
              }
            }
          }
        : {
            adapterFor: (t: { token: string; appToken?: string }) =>
              new SlackAdapter({
                api: createSlackApi({ botToken: t.token, appToken: t.appToken ?? '', origin: slackOrigin }),
                sleep: sleepUnref,
                now: () => Date.now(),
                log: (line: string) => console.error(line)
              }),
            // Both tokens: auth.test with the bot token, apps.connections.open with the app token (the socket it opens is left unused).
            checkToken: async (t: { token: string; appToken?: string }): Promise<'ok' | 'refused' | 'unreachable'> => {
              const api = createSlackApi({ botToken: t.token, appToken: t.appToken ?? '', origin: slackOrigin })
              try {
                await api.call('auth.test', {}, { timeoutMs: 15_000 })
                await api.call('apps.connections.open', {}, { token: 'app', timeoutMs: 15_000 })
                return 'ok'
              } catch (err) {
                return isAuthError(err) ? 'refused' : 'unreachable'
              }
            }
          }
    const makeChannel = (platform: ChannelPlatform) =>
      new ChannelService({
        platform,
        store: channelStore,
        tokens: channelTokens,
        state: channelState.view(platform),
        ...platformDeps(platform),
        agents: () => agents.list(),
        chats,
        createChat: async (agent) => {
          // Never Zumi Bot (the service refuses it), so never its fixed folder: the new-chat screen's pick, else home.
          const last = (await settings.get()).lastFolderByAgent[agent]
          const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() === true
          const cwd = last && (await isDir(last)) ? last : home
          return (await handlers['chats:create'](agent, cwd)) as ChatMeta
        },
        submit: (chatId, text, staged, messageId, committed) =>
          tasks.submit(chatId, text, staged, undefined, messageId, undefined, undefined, 'user', undefined, { once: true, committed }),
        stop: (id) => handlers['chats:stop'](id),
        answer: (chatId, requestId, decision, agent) => handlers['chats:answer'](chatId, requestId, decision, agent),
        answerQuestions: (chatId, requestId, answers, agent) => handlers['chats:answerQuestions'](chatId, requestId, answers, agent),
        answerPlan: (chatId, requestId, approve, feedback, agent) =>
          handlers['chats:answerPlan'](chatId, requestId, approve, feedback, agent),
        pending: (chatId, requestId, agent) => chatService.isPending(chatId, requestId, agent),
        pause: (id) => handlers['chats:pause'](id),
        resume: (id) => handlers['chats:resume'](id),
        stage: (name, bytes) => files.stageBytes(name, bytes),
        discard: (id) => files.discard(id),
        transcribe: async (bytes, mime) => {
          if (!(await voiceStore.status()).on) return 'off'
          const out = await transcriber.transcribe(Buffer.from(bytes), audioFormat(mime), 'auto')
          if (!out.ok) return out.error === 'off' ? 'off' : null
          return cleanTranscript(out.text, { switches: await voiceStore.clean(), mode: 'full', cleaner })
        },
        snapshot: (chatId, id) => snapshots.read(chatId, id),
        forbidden: (p) => inside(resolve(dataDir), p) || inside(keyDir, p),
        scrub: (text) => scrubOutbound(text, vault.secrets()),
        pushMeta: (meta) => push({ chatId: meta.id, kind: 'meta', meta }),
        changed: () => hub.broadcast({ event: 'channels:changed', payload: null }),
        chatUrl: (id) => (config.mode === 'vps' && config.origin ? `${config.origin}${CHAT_PREFIX}${encodeURIComponent(id)}` : null),
        random: (n) => randomBytes(n),
        now: () => Date.now(),
        log: (line) => console.error(line)
      })
    const channels: Record<ChannelPlatform, ChannelService> = { telegram: makeChannel('telegram'), slack: makeChannel('slack') }
    channelPush = (p) => {
      channels.telegram.chatPush(p)
      channels.slack.chatPush(p)
    }
    notifyTargets = [channels.telegram.notifyTarget(), channels.slack.notifyTarget()]
    const handlers = createHandlers({
      side,
      spendCaps,
      agents,
      browsers,
      desktops,
      chats,
      settings,
      sidebar,
      sidebarChanged,
      suggestedRepliesChanged: (on) => hub.broadcast({ event: 'app:suggestedReplies', payload: { on } }),
      approvals,
      approvalsChanged,
      launchTrust,
      // agents:save checks a remote agent's endpoint as a run would, under the same dev hook.
      aguiEndpoint: { allowLocal: aguiAllowLocal() },
      // Agent Studio's Test: the run's own reads (file, launch trust, PATH, run env, granted keys), so it tests what a run would start.
      acpTest: createAcpTest({
        definitionOf: (agent) => agents.acpOf(agent),
        trust: (agent, launch) => launchTrust.check(agent, acpRecord(launch)),
        locate: async (command) => {
          await runEnv.ready()
          return acpLocate(command, runEnv.env())
        },
        env: async () => {
          await runEnv.ready()
          return runEnv.env()
        },
        vaultEnv: (agent) => vaultEnvOf(vault.grantedTo(agent)),
        caps: () => engineCaps('acp')
      }),
      // Agent Studio's Test of a remote agent: the run's own file read and launch trust, then a connection that sends nothing.
      aguiTest: createAguiTest({
        definitionOf: (agent) => agents.aguiOf(agent),
        trust: (agent, launch) => launchTrust.check(agent, aguiRecord(launch)),
        allowLocal: aguiAllowLocal(),
        keyNames: (agent) => Object.keys(vaultEnvOf(vault.grantedTo(agent)).env),
        caps: () => engineCaps('ag-ui')
      }),
      memory: { store: memoryStore, turns: memoryTurns, autoMemoryOff },
      memoryChanged,
      todos,
      dispatch,
      processes,
      search,
      routineStore,
      runner,
      scheduler,
      hookUrl: (id) => `${config.origin}/hooks/${encodeURIComponent(id)}`,
      routinesChanged,
      routineEditing: routineEdit,
      routineHistory,
      workflowHistory,
      workflowStore,
      workflowRunner,
      workflowScheduler,
      workflowsChanged,
      workflowEditing: workflowEdit,
      inbox: workflowMessages,
      inboxChanged,
      chatService,
      groupService,
      tasks,
      summaries,
      commands,
      push,
      reads,
      limits,
      chatRemoved: (id) => notify.chatRemoved(id),
      attachments: files,
      snapshots,
      restoreFile: (chatId, path, fromId, toId) =>
        restoreFile(
          {
            chat: (id) => chats.get(id),
            items: (id) => chats.loadItems(id),
            snapshots,
            home,
            ...(process.env['CLAUDE_CONFIG_DIR'] ? { claudeDir: process.env['CLAUDE_CONFIG_DIR'] } : {}),
            readFile,
            trash: (p) => trashPath(p, home, () => new Date()),
            // The code only: the path is the user's, and an error message can carry it.
            log: (msg, err) => console.error(`${msg}: ${(err as NodeJS.ErrnoException | undefined)?.code ?? 'error'}`)
          },
          chatId,
          path,
          fromId,
          toId
        ),
      browserShots,
      tmp,
      feed,
      claude: { status: claude.locate, setPath: claude.setPath },
      codexInfo,
      account: async () => withCodexUsage(await account.account(), codexUsage.latest()),
      // A card comment's addressees and the line for each, from one Haiku call made before the comment is stored.
      routeComment: async (input) => {
        const bin = await claude.locate()
        if (!bin) return null
        await runEnv.ready()
        let spent: { cost: RunCost; id: string | null; at: number } | null = null
        // No tools and no session: the home folder is only where the call starts.
        const asks = await runRoute({
          bin,
          cwd: homedir(),
          env: runEnv.env(),
          input,
          signal: new AbortController().signal,
          onCost: (cost, id) => {
            spent = { cost, id, at: Date.now() }
          }
        })
        if (asks === null) return null
        return {
          asks,
          // Usage counts by chat; the call ran before there was one, so it is put on the first chat the comment asks.
          record: (chatId) => {
            if (spent) usage.recordModerator(chatId, spent.cost, spent.id, spent.at)
          }
        }
      },
      usage,
      worktrees,
      gitChanges: new GitChangesService(git),
      github: { state: () => ghLocator.state(), prs: pullRequests, watcher: prWatcher },
      builtInCwd: (n) => (n === ZUMI_BOT_NAME ? config.agentsDir : null),
      home,
      mode: config.mode,
      testPickFolder: devEnv('ZUMIBOT_TEST_PICK_FOLDER') ?? null,
      jev: { store: jevStore, check: () => jevClient.check(), suggestAgent: (text, list) => jev.suggestAgent(text, list) },
      voice: { store: voiceStore, check: () => transcriber.check() },
      voiceChanged,
      vault,
      update,
      vaultApprovals,
      checkMail: (t) => checkMailbox({ connect: connectImap, account: mailAccount }, t),
      extensions,
      connectors,
      audit: auditLog,
      isolation,
      channels: { services: channels, store: channelStore }
    })
    // vps: a sign-out elsewhere closes the socket at the next ping. local: the secret never expires.
    const notifyHandlers = createNotifyHandlers({
      store: notifyStore,
      presence,
      notify,
      mode: config.mode,
      testOrigin: devEnv('ZUMIBOT_TEST_PUSH_ORIGIN') ?? null,
      now: () => Date.now()
    })
    hub = createHub(handlers, {
      isValid: config.mode === 'vps' ? (k) => auth.checkSessionKey(k) : async () => true,
      connHandlers: notifyHandlers,
      onDisconnect: (id) => presence.drop(id)
    })
    undo.push(async () => hub.dispose())
    undo.push(async () => {
      hub.drain()
      browserHub.drain()
      desktopHub.drain()
      scheduler.stop()
      workflowScheduler.stop()
      stopWatchers()
      limits.stop()
      tasks.shutdown()
      summaries.stopAll()
      keepWarm.stop()
      prWatcher.stopAll()
      workflowRunner.stop()
      bare.stopAll() // in that order: see close()
      const closing = browsers.close().catch((err) => {
        browserCleanupFailed = true
        throw err
      })
      const desktopClosing = desktops.close().catch((err) => {
        desktopCleanupFailed = true
        throw err
      })
      await Promise.allSettled([
        chatService.stopAll(),
        side.stopAll(),
        closing,
        desktopClosing,
        vaultApprovals.close(),
        connectors.stop(),
        extensions.stop()
      ])
      await endContainers()
    })
    // The old built-in agent's chats, approvals and routines move to Zumi Bot. After the hub exists (the rename
    // broadcasts), before any run can start, and before sync.start(), whose removal pass would drop the old approvals.
    const movedOldBuiltIn: string[] = []
    await step('moving the old built-in agent to Zumi Bot', async () => {
      for (const old of OLD_BUILT_IN_NAMES) {
        const moved = await migrateOldBuiltIn(
          {
            agentsDir: config.agentsDir,
            chats: () => chats.list(),
            approvals: () => approvals.agents(),
            routines: () => routineStore.list(),
            rename: renameAgent,
            trash: (p) => trashPath(p, home, () => new Date())
          },
          old
        )
        if (moved) movedOldBuiltIn.push(old)
      }
    })
    // After the hub exists (recovery broadcasts) and before tasks.resume(): recovery keeps only runs whose message still
    // waits as a task, and resume sends those.
    await step('recovering routine runs', () => runner.recover())
    // A chat the usage limit stopped before the restart still continues at its reset (or now, when that passed). A
    // paused chat's wait sends nothing: it is dropped when it comes due.
    await step('recovering usage limit waits', () => limits.recover())
    // Folders of chats deleted while the server was off (or of a copied-in data dir). Only the count is logged.
    await step('sweeping chat temp folders', async () => {
      const removed = await tmp.sweep((await chats.list()).map((c) => c.id))
      if (removed > 0) console.error(`swept ${removed} chat temp folder${removed === 1 ? '' : 's'}`)
    })

    const gate = createGate({
      config,
      auth,
      limiter: createLimiter({ now: Date.now }),
      hub: () => hub,
      browserHub: () => browserHub,
      desktopHub: () => desktopHub,
      sessionEnded: (k) => notify.sessionEnded(k),
      log: (line) => console.error(line),
      loginDir: loginDir()
    })
    const server = createAppServer({
      gate,
      hub,
      browserHub,
      desktopHub,
      browserFiles: browsers.files,
      attachments: files,
      snapshots,
      webDir: config.webDir,
      hooks,
      sessionKey: gate.sessionKey,
      voice: {
        on: async () => (await voiceStore.status()).on,
        transcriber,
        limiter: createVoiceLimiter(),
        clean: () => voiceStore.clean(),
        cleaner
      },
      exports: { get: (id) => chats.get(id), loadItems: (id) => chats.loadItems(id), timeZone: () => settings.timeZone() },
      audit: { each: (f) => auditLog.each(f) }
    })
    undo.push(async () => {
      hub.drain()
      browserHub.drain()
      desktopHub.drain()
      if (server.listening) server.close()
      hub.closeAll(GOING_AWAY)
      browserHub.closeAll(GOING_AWAY)
      desktopHub.closeAll(GOING_AWAY)
      server.closeAllConnections()
    })

    await sync.start()
    try {
      // An agent file changed on disk: its cached loadouts go too (their key holds the file's text, this only frees them sooner).
      const unwatch = agents.watch(() => {
        extensions.forget()
        void sync.changed()
      })
      undo.push(async () => unwatch())
    } catch (err) {
      console.error('watching the agents folder failed:', err)
    }
    // A skill, command or plugin added outside the app (a copied folder, `claude plugin install`) reaches the `/` menu without
    // a restart. extensions.stop() ends the watch.
    void extensions
      .watchConfig()
      .catch((err: unknown) => console.error('watching the Claude Code config failed:', err instanceof Error ? err.message : err))

    try {
      const stopMemory = memoryStore.watch(memoryChanged)
      undo.push(async () => stopMemory())
    } catch (err) {
      console.error('watching the memory folder failed:', err instanceof Error ? err.message : err)
    }

    // Processes are not replies: deploy and sync read `busy` as running replies, and a dev server may run for hours.
    undo.push(
      await serveControl(controlPath(dataDir), {
        busy: () => chatService.runningCount() + side.runningCount(),
        processes: () => processes.runningCount()
      })
    )

    await step('starting the updater', () => update.start())

    // 127.0.0.1 only and not configurable: the proxy (or the desktop) is the one way in.
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const port = (server.address() as AddressInfo).port
    // Reads every chat file, so not before listening; it reads through the store's queue, and stops before the lock goes.
    search.start()
    undo.push(() => search.stop())
    // The first-start switch-over (keeps what agents had on); a run waits for it at most 10 s (`ready`), then nothing is denied (`offFor` is empty), as before connectors.
    // A failed write is logged by class only. Stopped and awaited before the lock goes (and before the probe is aborted in close(),
    // so the abort is never recorded as a failed probe).
    undo.push(() => connectors.stop())
    // Then the names of the catalog servers the home folder holds, once the switch-over settles either way.
    void startConnectors(connectors, (code) => console.error('connectors switch-over failed:', code))
    if (config.mode === 'local') config.origin = `http://127.0.0.1:${port}`
    let closing: Promise<void> | null = null
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        server.close() // no new connections; the open ones are cut below
        hub.drain() // before stopAll, which waits on the kill grace: a send in that window would never be stopped
        await Promise.all([channels.telegram.stop(), channels.slack.stop()]).catch(() => undefined) // no channel message starts a turn while the runs stop
        browserHub.drain()
        desktopHub.drain()
        scheduler.stop() // no new routine run while the chats stop
        workflowScheduler.stop() // nor a workflow run
        stopWatchers() // nor a file change or a new mail starting one
        runner.stop() // nor a usage-limit wait resuming; recover() arms it again at the next start
        limits.stop() // the same for a chat's own wait
        // No Wait or limit timer fires and no step result is written from here on; the runs stay as stored for recover().
        workflowRunner.stop()
        bare.stopAll() // after stop(): a call killed before it would be written as a failed visit and reported
        tasks.shutdown() // before stopAll: the runs it stops must not start queued tasks
        asks.close() // before stopAll too: an ask made while runs end is refused, not started
        replyOptions.close() // its Haiku calls are child processes; none may outlive the server
        summaries.stopAll() // a summary call is a child process; it must not outlive the server
        keepWarm.stop() // before side.stopAll: no new ping may start while the running ones stop
        prWatcher.stopAll() // its timers only read GitHub, but none may outlive the server
        // Abort requestUserAction and process commands alongside stopping CLIs, so neither
        // waits behind a viewer's manual drain or a long-lived browser or desktop tool request.
        const browserClosing = browsers.close().catch((err) => {
          browserCleanupFailed = true
          throw err
        })
        const desktopClosing = desktops.close().catch((err) => {
          desktopCleanupFailed = true
          throw err
        })
        // With the runs: a waiting vault card ends interrupted and is saved before the server goes. The extensions page's probes and
        // CLI writes end too, an edit's restore of the old server waited for.
        await Promise.allSettled([
          chatService.stopAll(),
          side.stopAll(),
          browserClosing,
          desktopClosing,
          vaultApprovals.close(),
          connectors.stop(),
          extensions.stop()
        ])
        await endContainers()
        hub.closeAll(GOING_AWAY)
        browserHub.closeAll(GOING_AWAY)
        desktopHub.closeAll(GOING_AWAY)
        server.closeAllConnections()
        await unwind()
        if (browserCleanupFailed) throw new Error('Browser cleanup could not be confirmed; data lock retained')
        if (desktopCleanupFailed) throw new Error('Desktop cleanup could not be confirmed; data lock retained')
      })())

    // Before tasks.resume(): a resumed turn's cost must not append before load() has seen the file's tail.
    await step('starting usage', () => usage.start())
    // The usage records load only in start(), so the old built-in agent's costs move after its other data.
    for (const old of movedOldBuiltIn) {
      await step("moving the old built-in agent's usage", () => usage.renameAgent(old, ZUMI_BOT_NAME))
    }
    // Its estimate runs in the background and saves into the data dir: done before the lock (first in undo) is released.
    undo.push(() => usage.stop())
    // Workflow runs as routine runs above (after recoverInterrupted, before tasks.resume(): an Agent step whose message
    // still waits is followed again, and resume sends it), but after usage.start(): the LLM and Condition calls it asks
    // again record their cost, which must not append before load() has seen the file's tail.
    await step('recovering workflow runs', () => workflowRunner.recover())

    try {
      // Last of the steps that can start runs: one failing after it would unwind without stopping them (the routine
      // steps below are caught). Sends that come in meanwhile queue behind the held tasks. After recovery, so no chat
      // still looks running.
      await tasks.resume()
    } catch (err) {
      console.error('resuming queued messages failed:', err)
    }
    // After recovery and resume: a restart's cut reply is told, and a channel message still queued streams back.
    await step('starting channels', async () => {
      await channels.telegram.start()
      await channels.slack.start()
    })
    await step('dropping stale webhook drafts', () => routineStore.dropStaleDrafts(Date.now() - DRAFT_MAX_AGE_MS))
    await step('dropping stale workflow webhook drafts', () => workflowStore.hooks.dropStaleDrafts(Date.now() - DRAFT_MAX_AGE_MS))
    await step('starting the routine scheduler', () => scheduler.start())
    await step('starting the workflow scheduler', () => workflowScheduler.start())
    watching = true
    syncWatchers()

    out(`LISTENING ${port}`)
    return { port, origin: config.origin, close, releaseLock: releaseLock.sync }
  } catch (err) {
    await unwind()
    throw err
  }
}
