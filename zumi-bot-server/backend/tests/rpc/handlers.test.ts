import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createHandlers, type HandlerDeps, type Handlers } from '../../src/rpc/handlers'
import { HistoryStore } from '../../src/core/history/historyStore'
import type { RoutineDef, VersionSummary, WorkflowDef } from '@zumibot/shared/definitionHistory'
import { createItemsFeed } from '../../src/rpc/itemsFeed'
import { ChatStore } from '../../src/core/store/chatStore'
import { SettingsStore } from '../../src/core/store/settingsStore'
import { SidebarStore } from '../../src/core/store/sidebarStore'
import { ApprovalStore } from '../../src/core/store/approvalStore'
import { acpRecord, aguiRecord, LaunchTrust } from '../../src/core/acp/launchTrust'
import { AGUI_TEXT } from '@zumibot/shared/agui'
import { createAcpTest } from '../../src/core/acp/acpTest'
import { createAguiTest } from '../../src/core/agui/aguiTest'
import { startFakeAgui, stopFakeAgui, type FakeAgui } from '../support/fakeAgui'
import { acpLocate } from '../../src/core/acp/acpLocator'
import { AgentStore } from '../../src/core/agents/agentStore'
import { vaultEnvOf } from '../../src/core/vault/vaultEnv'
import { fileURLToPath } from 'node:url'
import { ACP_TEXT, refusedArg } from '@zumibot/shared/acp'
import { AttachmentStore } from '../../src/core/attachments/attachmentStore'
import { SnapshotStore } from '../../src/core/files/snapshotStore'
import { BrowserShots } from '../../src/core/browser/browserShots'
import { ChatService, MODEL_REFUSED } from '../../src/core/chat/chatService'
import { ReadMarks } from '../../src/core/chat/readMarks'
import { TaskQueue } from '../../src/core/chat/taskQueue'
import { ChatTmp } from '../../src/core/chat/chatTmp'
import { pauseSettings } from '../../src/core/chat/pauseSettings'
import type { RunHandle, RunOutcome } from '../../src/core/chat/claudeRunner'
import type { RunEvent } from '../../src/core/chat/streamParser'
import type { SidebarLayout } from '@zumibot/shared/sidebarLayout'
import { HANDOFF_MAX_CHARS, CLONE_TITLE_MAX } from '@zumibot/shared/roomClone'
import { ARCHIVE_RUNNING, isArchived } from '@zumibot/shared/archive'
import { scratchChild } from '@zumibot/shared/scratch'
import {
  CODEX_REFUSALS,
  bridgeRefusal,
  capRefusal,
  engineCaps,
  missingFeatures,
  spendCapRefusal,
  todoRefusal,
  type Engine
} from '@zumibot/shared/engine'
import { COMPACT_NOTE_MAX, type AgentSummary, type ChatItem, type ChatMeta, type ChatPush } from '@zumibot/shared/types'
import type { Routine, RoutineInput, RoutineTarget, WebhookCall } from '@zumibot/shared/routines'
import { JEV_KEY_MAX } from '@zumibot/shared/jev'
import { RoutineStore } from '../../src/core/routines/routineStore'
import { SearchIndex } from '../../src/core/search/searchIndex'
import type { SearchResult } from '@zumibot/shared/search'
import { RoutineRunner } from '../../src/core/routines/routineRunner'
import { JevStore } from '../../src/core/jev/jevStore'
import { VoiceStore } from '../../src/core/voice/voiceStore'
import { DEFAULT_CLEAN, DEFAULT_TALK, VOICE_KEY_MAX } from '@zumibot/shared/voice'
import { COMMAND_PROMPT_MAX } from '@zumibot/shared/commands'
import { RESUME_TEXT } from '@zumibot/shared/pause'
import { SideQuestions } from '../../src/core/btw/sideQuestions'
import { TodoService } from '../../src/core/todos/todoService'
import { DispatchService } from '../../src/core/dispatch/dispatchService'
import type { VoiceStatus } from '@zumibot/shared/voice'
import { VaultStore } from '../../src/core/vault/vaultStore'
import { VaultApprovals } from '../../src/core/vault/vaultApprovals'
import { WorkflowStore } from '../../src/core/workflows/workflowStore'
import { WorkflowMessages } from '../../src/core/workflows/workflowMessages'
import { PROBLEMS_TEXT } from '../../src/core/workflows/workflowRunner'
import { SAVED_TEXT_MAX } from '../../src/core/workflows/workflowInput'
import { newState } from '@zumibot/shared/workflowEngine'
import { NO_WORKFLOW_NAMED, sameNameText } from '@zumibot/shared/runWorkflow'
import { REPLY_TEXT_MAX } from '@zumibot/shared/workflowEvents'
import {
  APPROVAL_TEXT_MAX,
  FOREACH_OUTPUT_MAX,
  OUTPUT_MAX,
  TRIGGER_BODY_MAX,
  type Step,
  type Workflow,
  type WorkflowInput,
  type WorkflowRun,
  type WorkflowsSnapshot
} from '@zumibot/shared/workflows'
import type { Problem } from '@zumibot/shared/workflowGraph'

let dir: string
let agentsDir: string
let home: string
let store: ChatStore
let settings: SettingsStore
let sidebar: SidebarStore
let told: SidebarLayout[]
let approvals: ApprovalStore
let approvalsTold: string[]
let saveResult: unknown
let memCalls: string[]
let memStore: Record<string, Mock>
let memTold: string[]
let agentList: AgentSummary[]
let trashed: Set<string>
let svc: ChatService
let sent: object[]
let testPick: string | null
let h: Handlers
let handlerDeps: HandlerDeps
let snapshots: SnapshotStore
let restoreCalls: unknown[][]
let browserShots: BrowserShots
let order: string[]
let tmpRemove: (id: string) => Promise<void>
let routineStore: RoutineStore
let runner: RoutineRunner
let rearmed: number
let routinesTold: number
let jevStore: JevStore
let voiceStore: VoiceStore
let vaultStore: VaultStore
let vaultApprovals: VaultApprovals
let voiceTold: VoiceStatus[]
let side: SideQuestions
let todoSvc: TodoService
let todosTold: number[]
let dispatchSvc: DispatchService
let tasks: TaskQueue
let cancelled: string[]
let continued: string[]
let forSend: Mock<(...a: any[]) => Promise<unknown>>
let forRerun: Mock<(...a: any[]) => Promise<unknown>>
let pushed: ChatPush[]
let summaryCalls: string[]
let usageQueries: unknown[]
let suggested: { text: string; agents: { name: string; description: string }[] }[]
let workflowStore: WorkflowStore
let wfRunner: { [K in keyof HandlerDeps['workflowRunner']]: Mock }
let wfProblems: Problem[]
let wfRearmed: number
let workflowsTold: number
let inboxMessages: WorkflowMessages
let inboxTold: unknown[]
let search: SearchIndex
const alpha: AgentSummary = {
  filePath: '/agents/alpha.md',
  name: 'alpha',
  description: '',
  color: null,
  icon: null,
  error: null,
  builtIn: false
}

const req: RunEvent = {
  kind: 'permissionRequest',
  requestId: 'r1',
  toolName: 'Bash',
  input: { command: 'ls' },
  description: 'd',
  reason: 'r',
  toolUseId: null
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-rpc-'))
  agentsDir = join(dir, 'agents')
  home = join(dir, 'home')
  await fs.mkdir(home)
  store = new ChatStore(dir)
  settings = new SettingsStore(dir)
  sidebar = new SidebarStore(dir)
  told = []
  approvals = new ApprovalStore(dir)
  approvalsTold = []
  saveResult = { ok: true, name: 'new', renamedFrom: 'old' }
  memCalls = []
  memTold = []
  trashed = new Set()
  agentList = [alpha, { ...alpha, name: 'broken', error: 'bad frontmatter' }]
  memStore = {
    list: vi.fn(async (agent: string, o: unknown) => ({ agent, o })),
    save: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
  const files = new AttachmentStore(join(dir, 'attachments'), () => 'unused')
  snapshots = new SnapshotStore(join(dir, 'file-snapshots'))
  browserShots = new BrowserShots(join(dir, 'browser-shots'))
  order = []
  tmpRemove = async (id) => {
    order.push(`tmp:${id}`)
  }
  sent = []
  testPick = null
  let n = 0
  svc = new ChatService({
    store,
    files,
    locate: async () => '/bin/claude',
    run: (o) => {
      let release: (r: RunOutcome) => void = () => {}
      const done = new Promise<RunOutcome>((r) => {
        release = r
      })
      setImmediate(() => o.onEvent(req))
      return {
        stop: () => release({ exitCode: null, signal: 'SIGINT', stderr: '', spawnError: null, result: null, stopped: true }),
        send: (m: object) => {
          sent.push(m)
          return true
        },
        done
      } as RunHandle
    },
    push: () => {},
    now: () => 1000 + n,
    newId: () => `x${++n}`,
    permissionMode: 'manual',
    disallowedToolsFor: () => [],
    tmp: new ChatTmp(join(dir, 'claude-tmp')),
    pauseHook: { settings: pauseSettings({ node: '/opt/node', entry: '/opt/pauseHook.mjs', electronNode: false }) }
  })
  routineStore = new RoutineStore(dir)
  rearmed = 0
  routinesTold = 0
  let rid = 0
  runner = new RoutineRunner({
    store: routineStore,
    chats: store,
    tasks: { submit: async () => 'sent' },
    agents: async () => [alpha],
    isRunning: (id) => svc.isRunning(id),
    builtInCwd: () => null,
    changed: () => {},
    now: () => 5000,
    newId: () => `rid${++rid}`
  })
  jevStore = new JevStore(dir)
  voiceStore = new VoiceStore(dir)
  vaultStore = new VaultStore({ dataDir: join(dir, 'vault-data'), keyFile: join(dir, 'vault-conf', 'vault.key') })
  vaultApprovals = new VaultApprovals({ now: () => 1000, newId: () => 'vault-req' })
  voiceTold = []
  pushed = []
  summaryCalls = []
  tasks = new TaskQueue({ store, chats: svc, groups: {} as never, files, push: () => {}, now: () => 5000, newId: () => `t${++n}` })
  cancelled = []
  continued = []
  suggested = []
  forSend = vi.fn(async () => undefined)
  forRerun = vi.fn(async () => undefined)
  usageQueries = []
  side = new SideQuestions({
    store,
    chats: svc,
    groups: {} as never,
    pick: async () => null,
    baseFor: async () => null,
    run: () => {
      throw new Error('no CLI')
    },
    broadcast: () => {},
    recordCost: () => {},
    now: () => 6000
  })
  todosTold = []
  let tid = 0
  search = new SearchIndex({ store, log: () => {}, settleMs: 0 })
  todoSvc = new TodoService({ store, now: () => 9000, newId: () => `todo${++tid}`, onChanged: (r) => todosTold.push(r) })
  dispatchSvc = new DispatchService({ store, onChanged: () => {}, now: () => 9000, privateTool: () => null })
  workflowStore = new WorkflowStore(dir)
  wfProblems = []
  wfRearmed = 0
  workflowsTold = 0
  inboxMessages = new WorkflowMessages(dir, () => 5000)
  inboxTold = []
  wfRunner = {
    run: vi.fn(async (w: Workflow, via: string) => ({
      id: 'wr1',
      workflowId: w.id,
      via,
      status: 'running',
      late: false,
      startedAt: 1,
      waiting: [],
      failed: []
    })),
    stopRun: vi.fn(async () => {}),
    stopAllOf: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
    testStep: vi.fn(async () => ({ output: 'x' })),
    problems: vi.fn(async () => wfProblems),
    taskDropped: vi.fn(),
    chatRemoved: vi.fn()
  }
  restoreCalls = []
  const deps: HandlerDeps = {
    side,
    todos: todoSvc,
    dispatch: dispatchSvc,
    search,
    agents: {
      save: async () => saveResult,
      list: async () => agentList.filter((a) => !trashed.has(a.filePath)),
      trash: async (p: string) => {
        trashed.add(p)
      }
    } as unknown as HandlerDeps['agents'],
    memory: {
      store: memStore as unknown as HandlerDeps['memory']['store'],
      turns: {
        renamed: (a: string, b: string) => memCalls.push(`renamed:${a}>${b}`),
        deleted: async (n: string) => {
          memCalls.push(`deleted:${n}`)
        }
      } as unknown as HandlerDeps['memory']['turns'],
      autoMemoryOff: async () => true
    },
    memoryChanged: (a) => memTold.push(a),
    jev: {
      store: jevStore,
      check: async () => ({ ok: false, error: 'Could not reach OpenRouter.' }),
      suggestAgent: async (text, agents) => {
        suggested.push({ text, agents: [...agents] })
        return 'alpha'
      }
    },
    voice: { store: voiceStore, check: async () => ({ ok: false, reason: 'unreachable' }) },
    voiceChanged: (s) => voiceTold.push(s),
    vault: vaultStore,
    update: { status: vi.fn(), check: vi.fn(), install: vi.fn(), rollBack: vi.fn() } as unknown as HandlerDeps['update'],
    vaultApprovals,
    // extensionsHandlers.test.ts covers these; here only agents:save's forget() runs.
    extensions: { forget: () => {} } as unknown as HandlerDeps['extensions'],
    // connectorsHandlers.test.ts covers these.
    connectors: {} as unknown as HandlerDeps['connectors'],
    approvals,
    approvalsChanged: (a) => approvalsTold.push(a),
    routineStore,
    runner,
    scheduler: {
      rearm: async () => {
        rearmed++
      }
    },
    hookUrl: (id) => `http://x/hooks/${id}`,
    routinesChanged: () => {
      routinesTold++
    },
    workflowStore,
    workflowRunner: wfRunner as unknown as HandlerDeps['workflowRunner'],
    workflowScheduler: {
      rearm: async () => {
        wfRearmed++
      }
    },
    workflowsChanged: () => {
      workflowsTold++
    },
    inbox: inboxMessages,
    inboxChanged: () => {
      inboxTold.push({})
    },
    codexInfo: async () => ({ found: true, models: ['gpt-x'] }),
    chats: store,
    settings,
    sidebar,
    sidebarChanged: (l) => told.push(l),
    chatService: svc,
    groupService: { renameAgent: () => {} } as unknown as HandlerDeps['groupService'],
    tasks,
    summaries: {
      summarize: async (id: string) => {
        summaryCalls.push(`summarize:${id}`)
        return 'draft'
      },
      cancel: (id: string) => {
        summaryCalls.push(`cancel:${id}`)
      }
    },
    commands: { forSend: (...a) => forSend(...a), forRerun: (...a) => forRerun(...a) } as HandlerDeps['commands'],
    push: (p) => {
      pushed.push(p)
    },
    reads: new ReadMarks({ store, lookingAt: () => false, push: (p) => pushed.push(p), now: () => 7000, log: () => {} }),
    limits: {
      dontContinue: async (id) => {
        cancelled.push(id)
      },
      continueNow: async (id) => {
        continued.push(id)
      }
    },
    attachments: files,
    snapshots,
    restoreFile: async (...args) => {
      restoreCalls.push(args)
      return { done: 'written' }
    },
    browserShots,
    tmp: { remove: (id: string) => tmpRemove(id) },
    feed: createItemsFeed(),
    claude: { status: async () => null, setPath: async () => null },
    account: async () => ({ name: 'x', email: null, plan: null, usage: null }),
    usage: {
      query: async (q) => {
        usageQueries.push(q)
        return {} as never
      }
    },
    builtInCwd: (n) => (n === 'zumi-bot' ? agentsDir : null),
    home,
    mode: 'local',
    get testPickFolder() {
      return testPick
    }
  }
  handlerDeps = deps
  h = createHandlers(deps)
})
afterEach(async () => {
  await side.stopAll()
  await fs.rm(dir, { recursive: true, force: true })
})

const KEPT = [
  'browsers:status',
  'browsers:clear',
  'desktops:status',
  'desktops:clear',
  'btw:ask',
  'btw:follow',
  'btw:list',
  'btw:stop',
  'btw:again',
  'channels:status',
  'channels:setToken',
  'channels:removeToken',
  'channels:setRun',
  'channels:setSharedCards',
  'channels:setNotify',
  'channels:pairStart',
  'channels:pairCancel',
  'channels:unpair',
  'channels:setAgents',
  'channels:link',
  'channels:unlink',
  'agents:list',
  'agents:read',
  'agents:save',
  'agents:trash',
  'agents:codexInfo',
  'agents:testAcp',
  'agents:acpLaunch',
  'agents:testAgui',
  'agents:aguiLaunch',
  'agents:engineCommands',
  'chats:list',
  'chats:create',
  'chats:createVoice',
  'chats:createGroup',
  'chats:setMembers',
  'chats:setRole',
  'chats:items',
  'chats:pending',
  'chats:search',
  'chats:send',
  'chats:sendTask',
  'chats:dropTask',
  'chats:edit',
  'chats:resend',
  'chats:switchVersion',
  'chats:fork',
  'chats:summarizeRoom',
  'chats:cancelSummary',
  'chats:cloneRoom',
  'chats:compact',
  'chats:setModel',
  'chats:setPermissionMode',
  'chats:allowBlocked',
  'chats:setEffort',
  'chats:cancelResume',
  'chats:continueNow',
  'chats:answer',
  'chats:answerQuestions',
  'chats:answerPlan',
  'chats:stop',
  'chats:pause',
  'chats:resume',
  'chats:rename',
  'chats:react',
  'chats:markUnread',
  'chats:archive',
  'chats:remove',
  'chats:gitStatus',
  'chats:gitChanges',
  'chats:gitDiff',
  'attachments:stageBytes',
  'attachments:discard',
  'files:list',
  'files:restore',
  'app:lastFolder',
  'app:lastGroupFolder',
  'app:claudeStatus',
  'app:setClaudePath',
  'app:getTheme',
  'app:account',
  'app:setTheme',
  'app:getAccent',
  'app:setAccent',
  'app:getHouseStyle',
  'app:setHouseStyle',
  'app:getKeepWarm',
  'app:setKeepWarm',
  'app:setTimeZone',
  'app:folderStart',
  'app:mode',
  'app:gitFolder',
  'app:setWorktreeFolder',
  'fs:listDirs',
  'fs:makeDir',
  'sidebar:get',
  'sidebar:save',
  'approvals:list',
  'approvals:remove',
  'memory:list',
  'memory:save',
  'memory:remove',
  'todos:board',
  'todos:list',
  'todos:check',
  'todos:remove',
  'todos:restore',
  'todos:add',
  'todos:edit',
  'todos:assign',
  'todos:answer',
  'todos:reply',
  'todos:move',
  'todos:comment',
  'todos:editComment',
  'todos:deleteComment',
  'attempts:start',
  'attempts:keep',
  'attempts:cancel',
  'audit:list',
  'audit:get',
  'audit:facets',
  'audit:status',
  'audit:verify',
  'audit:setCap',
  'isolation:status',
  'isolation:get',
  'isolation:set',
  'github:state',
  'github:draftPr',
  'github:createPr',
  'github:refreshPr',
  'github:sendCheck',
  'dispatch:list',
  'dispatch:get',
  'processes:list',
  'processes:logs',
  'processes:stop',
  'processes:restart',
  'processes:forget',
  'processes:counts',
  'routines:list',
  'routines:save',
  'routines:remove',
  'routines:duplicate',
  'routines:setEnabled',
  'routines:runNow',
  'routines:history',
  'routines:version',
  'routines:draftWebhook',
  'routines:dropDraft',
  'routines:webhook',
  'routines:newSecret',
  'workflows:list',
  'workflows:getRun',
  'workflows:save',
  'workflows:remove',
  'workflows:setEnabled',
  'workflows:run',
  'workflows:history',
  'workflows:version',
  'workflows:stop',
  'workflows:retry',
  'workflows:approve',
  'workflows:testStep',
  'workflows:draftWebhook',
  'workflows:dropDraft',
  'workflows:webhook',
  'workflows:newSecret',
  'workflows:duplicate',
  'workflows:approvals',
  'workflows:checkMail',
  'workflows:runFromChat',
  'inbox:messages',
  'inbox:archive',
  'inbox:remove',
  'inbox:restore',
  'inbox:seen',
  'jev:status',
  'jev:setKey',
  'jev:setSwitches',
  'jev:check',
  'jev:suggestAgent',
  'voice:status',
  'voice:set',
  'voice:check',
  'update:status',
  'update:check',
  'update:install',
  'update:rollBack',
  'vault:status',
  'vault:keyFile',
  'vault:list',
  'vault:reveal',
  'vault:save',
  'vault:delete',
  'vault:removeApproval',
  'vault:reset',
  'vault:answer',
  'usage:query',
  'usage:caps',
  'usage:allowMore',
  'workflows:continueCap',
  'extensions:loadout',
  'extensions:server',
  'extensions:saveServer',
  'extensions:removeServer',
  'extensions:setPlugin',
  'extensions:skill',
  'extensions:saveSkill',
  'extensions:removeSkill',
  'extensions:setSkill',
  'extensions:saveHook',
  'extensions:removeHook',
  'connectors:list',
  'connectors:setAgent',
  'connectors:setRemember'
]

describe('createHandlers', () => {
  describe('inbox', () => {
    const msg = { id: 'm1', workflowId: 'w1', workflowName: 'Flow', runId: 'r1', stepName: 'Tell', title: 'Hello', at: 4000 }
    it('inbox:archive refuses a non-boolean on', async () => {
      await inboxMessages.add(msg)
      await expect(h['inbox:archive']('m1', 'yes')).rejects.toThrow(TypeError)
      await expect(h['inbox:archive'](7, true)).rejects.toThrow(TypeError)
      expect(inboxTold).toEqual([])
      await h['inbox:archive']('m1', true)
      expect((await inboxMessages.list()).messages[0]?.archivedAt).toBe(5000)
      expect(inboxTold).toEqual([{}])
    })
    it('inbox:remove broadcasts inbox:changed with an empty payload', async () => {
      await inboxMessages.add(msg)
      await h['inbox:remove']('m1')
      expect(inboxTold).toEqual([{}])
      expect(((await h['inbox:messages']()) as { messages: unknown[] }).messages).toEqual([])
      await h['inbox:restore']('m1')
      expect(inboxTold).toEqual([{}, {}])
      expect(((await h['inbox:messages']()) as { messages: unknown[] }).messages).toHaveLength(1)
      await expect(h['inbox:remove']('nope')).rejects.toThrow('Message not found')
      expect(inboxTold).toHaveLength(2)
    })
    it('inbox:seen refuses a non-number and clamps to now', async () => {
      await expect(h['inbox:seen']('1')).rejects.toThrow(TypeError)
      await expect(h['inbox:seen'](Number.NaN)).rejects.toThrow(TypeError)
      await expect(h['inbox:seen'](Infinity)).rejects.toThrow(TypeError)
      const before = Date.now()
      await h['inbox:seen'](Date.now() + 10 * 86_400_000)
      const { seenAt } = (await h['inbox:messages']()) as { seenAt: number }
      expect(seenAt).toBeGreaterThanOrEqual(before)
      expect(seenAt).toBeLessThanOrEqual(Date.now())
      expect(inboxTold).toEqual([{}])
    })
  })

  describe('btw', () => {
    it('btw:ask rejects a non-string question', async () => {
      await expect(h['btw:ask']('chat', 42, 'side')).rejects.toThrow('question must be a string')
    })
    it('channels: checks every argument, and never echoes a refused token', async () => {
      const token = 'secret words that are not a token'
      await expect(h['channels:setToken']('discord', token)).rejects.toThrow('platform must be a known channel')
      // Slack needs both tokens, each in its own shape.
      await expect(h['channels:setToken']('slack', 'xoxb-1234567890-abc')).rejects.toThrow("doesn't look like a Slack bot token")
      await expect(h['channels:setToken']('slack', 'xoxb-1234567890-abc', 'xoxb-1234567890-abc')).rejects.toThrow(
        "doesn't look like a Slack bot token"
      )
      await expect(h['channels:setToken']('telegram', '123456789:' + 'A'.repeat(35), 'xapp-1-ABCDEFGHIJ')).rejects.toThrow(
        "doesn't look like a Telegram bot token"
      )
      await expect(h['channels:setSharedCards']('telegram', true)).rejects.toThrow('only Slack has shared channels')
      const err = await h['channels:setToken']('telegram', token).catch((e: Error) => e)
      expect((err as Error).message).toBe("That doesn't look like a Telegram bot token.")
      await expect(h['channels:setToken']('telegram', 42)).rejects.toThrow("doesn't look like")
      await expect(h['channels:setRun']('telegram', 'yes')).rejects.toThrow('on must be a boolean')
      await expect(h['channels:setAgents']('telegram', 'a')).rejects.toThrow()
      await expect(h['channels:link'](42, 'telegram')).rejects.toThrow('chatId')
      // Built without the service: a clear refusal, and an empty status.
      expect(await h['channels:status']()).toEqual([])
      await expect(h['channels:pairStart']('telegram')).rejects.toThrow('Channels are not available on this server')
    })
    it('btw:ask returns the stored entry', async () => {
      const chat = await store.create('alpha', home)
      const entry = await h['btw:ask'](chat.id, 'What is happening?', 'side')
      expect(entry).toMatchObject({ id: 'side', question: 'What is happening?', state: 'running' })
      expect(await h['btw:list'](chat.id)).toEqual(await store.loadSide(chat.id))
    })
    it('btw:ask rejects overlong questions before storing', async () => {
      const chat = await store.create('alpha', home)
      await expect(h['btw:ask'](chat.id, 'x'.repeat(COMMAND_PROMPT_MAX + 1), 'side')).rejects.toThrow(/longer/)
      expect(await store.loadSide(chat.id)).toEqual([])
    })
    it.each([
      ['btw:ask', [42, 'question', 'side'], 'chatId'],
      ['btw:ask', ['chat', 'question', 42], 'id'],
      ['btw:list', [42], 'chatId'],
      ['btw:stop', [42, 'side'], 'chatId'],
      ['btw:stop', ['chat', 42], 'id'],
      ['btw:again', [42, 'side'], 'chatId'],
      ['btw:again', ['chat', 42], 'id'],
      ['btw:follow', [42, 'root', 'question', 'side'], 'chatId'],
      ['btw:follow', ['chat', 42, 'question', 'side'], 'threadId'],
      ['btw:follow', ['chat', 'root', 42, 'side'], 'question'],
      ['btw:follow', ['chat', 'root', 'question', 42], 'id']
    ])('%s validates every argument: %s', async (name, args, field) => {
      await expect(h[name](...args)).rejects.toThrow(`${field} must be a string`)
    })
    it('chats:remove stops the chat’s btw side runs before removing files', async () => {
      const chat = await store.create('alpha', home)
      const stop = vi.spyOn(side, 'stopChat').mockImplementation((id) => {
        expect(id).toBe(chat.id)
      })
      await h['chats:remove'](chat.id)
      expect(stop).toHaveBeenCalledWith(chat.id)
      expect(await store.get(chat.id)).toBeNull()
    })
    it('agents:save moves vault grants to the new name', async () => {
      await vaultStore.save({ kind: 'apiKey', name: 'PAT', agents: ['old'], env: 'AZURE_PAT', value: 'sk-test-12345678', description: '' })
      const saving = h['agents:save']('/agents/old.md', 'raw')
      // Before the save's first await settles the grants are already moved, so the watcher's removal pass finds them.
      await saving
      expect(vaultStore.agents()).toEqual(['new'])
    })
    it('agents:save renames btw in-memory entries before stored chats', async () => {
      const rename = vi.spyOn(side, 'renameAgent')
      await h['agents:save']('/agents/old.md', 'raw')
      expect(rename).toHaveBeenCalledWith('old', 'new')
    })
    it('btw stop and again forward to the side service', async () => {
      const stop = vi.spyOn(side, 'stop')
      const again = vi.spyOn(side, 'again').mockResolvedValue({ id: 'side' } as never)
      await h['btw:stop']('chat', 'side')
      expect(stop).toHaveBeenCalledWith('chat', 'side')
      expect(await h['btw:again']('chat', 'side')).toEqual({ id: 'side' })
      expect(again).toHaveBeenCalledWith('chat', 'side')
    })
    it('btw:follow forwards to the side service', async () => {
      const follow = vi.spyOn(side, 'follow').mockResolvedValue({ id: 'next' } as never)
      expect(await h['btw:follow']('chat', 'root', 'And now?', 'next')).toEqual({ id: 'next' })
      expect(follow).toHaveBeenCalledWith('chat', 'root', 'And now?', 'next')
    })
    it('btw:follow rejects overlong questions before the side service', async () => {
      const follow = vi.spyOn(side, 'follow')
      await expect(h['btw:follow']('chat', 'root', 'x'.repeat(COMMAND_PROMPT_MAX + 1), 'next')).rejects.toThrow(
        `Question is longer than ${COMMAND_PROMPT_MAX} characters`
      )
      expect(follow).not.toHaveBeenCalled()
    })
  })
  describe('vault approvals', () => {
    it('vault:answer needs a request pending for that chat', async () => {
      const chat = await store.create('alpha', home),
        other = await store.create('alpha', home)
      const got: string[] = []
      vaultApprovals.registerTurn('turn', async (r) => {
        got.push(r.status)
      })
      const result = vaultApprovals.request(
        {
          chatId: chat.id,
          turnId: 'turn',
          profileId: 'profile',
          itemId: 'i',
          itemName: 'Work Visa',
          label: 'Visa •4242',
          site: 'shop.example.com',
          frameSite: 'shop.example.com'
        },
        new AbortController().signal
      )
      // Another chat, a bad decision, a bad id and an unknown request are all refused.
      await expect(h['vault:answer'](other.id, 'vault-req', 'allow')).rejects.toThrow('Stale vault request')
      await expect(h['vault:answer'](chat.id, 'vault-req', 'maybe')).rejects.toThrow()
      await expect(h['vault:answer'](chat.id, 42, 'allow')).rejects.toThrow('requestId must be a string')
      await expect(h['vault:answer']('missing', 'vault-req', 'allow')).rejects.toThrow('Stale vault request')
      await expect(h['vault:answer'](chat.id, 'other-req', 'allow')).rejects.toThrow('Stale vault request')
      expect(got).toEqual(['pending'])
      await h['vault:answer'](chat.id, 'vault-req', 'allow')
      expect(await result).toBe('allow')
      // Answered once: a second answer finds the request no longer pending.
      await expect(h['vault:answer'](chat.id, 'vault-req', 'deny')).rejects.toThrow('Stale vault request')
    })
    it("vault:answer takes a click that comes before the card's save reached the disk", async () => {
      const chat = await store.create('alpha', home)
      vaultApprovals.registerTurn('turn', async () => {})
      const result = vaultApprovals.request(
        {
          chatId: chat.id,
          turnId: 'turn',
          profileId: 'profile',
          itemId: 'i',
          itemName: 'Work Visa',
          label: 'Visa •4242',
          site: 'shop.example.com',
          frameSite: 'shop.example.com'
        },
        new AbortController().signal
      )
      // ChatService pushes a card before its save lands: the chat's stored items do not hold it yet.
      expect((await store.loadItems(chat.id)).some((i) => i.type === 'vault-approval')).toBe(false)
      await h['vault:answer'](chat.id, 'vault-req', 'deny')
      expect(await result).toBe('deny')
    })
  })

  describe('desktops', () => {
    const withDesktops = (desktops: HandlerDeps['desktops']): Handlers => createHandlers({ ...handlerDeps, desktops })
    it('desktops:status returns the application status for the agent', async () => {
      const status = vi.fn(async (agent: string) => ({ agent, state: 'stopped' }))
      const hh = withDesktops({ status, clear: vi.fn(), renameAgent: vi.fn(), removeAgents: vi.fn() } as never)
      expect(await hh['desktops:status']('alpha')).toEqual({ agent: 'alpha', state: 'stopped' })
      expect(status).toHaveBeenCalledWith('alpha')
    })
    it('desktops:clear calls clear for the agent', async () => {
      const clear = vi.fn(async () => undefined)
      const hh = withDesktops({ status: vi.fn(), clear, renameAgent: vi.fn(), removeAgents: vi.fn() } as never)
      await hh['desktops:clear']('alpha')
      expect(clear).toHaveBeenCalledWith('alpha')
    })
    it('rejects a non-string agent before reaching the application', async () => {
      const status = vi.fn(),
        clear = vi.fn()
      const hh = withDesktops({ status, clear, renameAgent: vi.fn(), removeAgents: vi.fn() } as never)
      await expect(Promise.resolve().then(() => hh['desktops:status'](42))).rejects.toThrow('agent must be a string')
      await expect(Promise.resolve().then(() => hh['desktops:clear'](null))).rejects.toThrow('agent must be a string')
      expect(status).not.toHaveBeenCalled()
      expect(clear).not.toHaveBeenCalled()
    })
    it('throws the fixed error when the desktop is not wired', async () => {
      const hh = withDesktops(undefined)
      await expect(Promise.resolve().then(() => hh['desktops:status']('alpha'))).rejects.toThrow('Desktop unavailable')
      await expect(Promise.resolve().then(() => hh['desktops:clear']('alpha'))).rejects.toThrow('Desktop unavailable')
    })
  })
  it('exposes exactly the kept channels', () => {
    expect(Object.keys(h).sort()).toEqual([...KEPT].sort())
  })

  describe('voice', () => {
    const KEY = 'sk-or-XYZ'

    it('voice:set trims the key and never returns it', async () => {
      const status = await h['voice:set']({ key: `  ${KEY}\n` })
      expect(status).toEqual({ on: true, enabled: true, keySaved: true, talk: DEFAULT_TALK, talkOn: true, clean: DEFAULT_CLEAN })
      expect(await voiceStore.key()).toBe(KEY)
      expect(JSON.stringify(status)).not.toContain(KEY)
      expect(JSON.stringify(await h['voice:status']())).not.toContain(KEY)
      expect(voiceTold).toEqual([status])
    })

    it('voice:set rejects bad input without quoting the key', async () => {
      const long = 'x'.repeat(VOICE_KEY_MAX + 1)
      for (const bad of [{ key: 'sk-or-ab cd' }, { key: long }, { key: '   ' }, { key: 5 }, { enabled: 'yes' }, { other: 1 }, null, []]) {
        const err = await h['voice:set'](bad).then(
          () => null,
          (e: Error) => e
        )
        expect(err, JSON.stringify(bad).slice(0, 30)).toBeInstanceOf(Error)
        for (const k of ['sk-or-ab', 'cd', long]) expect(err!.message).not.toContain(k)
      }
      expect(await voiceStore.key()).toBeNull()
      expect(voiceTold).toEqual([])
    })

    it('voice:set takes the switch, and key null removes the key', async () => {
      await h['voice:set']({ key: KEY })
      expect(await h['voice:set']({ enabled: false })).toEqual({
        on: false,
        enabled: false,
        keySaved: true,
        talk: DEFAULT_TALK,
        talkOn: false,
        clean: DEFAULT_CLEAN
      })
      expect(await h['voice:set']({ key: null })).toEqual({
        on: false,
        enabled: false,
        keySaved: false,
        talk: DEFAULT_TALK,
        talkOn: false,
        clean: DEFAULT_CLEAN
      })
      expect(await voiceStore.key()).toBeNull()
      expect(voiceTold).toHaveLength(3)
    })

    it('voice:set takes talk settings and rejects bad ones', async () => {
      const aliases = { 'work-assistant': ['مساعد العمل'] }
      expect(((await h['voice:set']({ talk: { aliases } })) as VoiceStatus).talk).toEqual({ ...DEFAULT_TALK, aliases })
      expect(((await h['voice:set']({ talk: { defaultAgent: 'x' } })) as VoiceStatus).talk).toEqual({
        enabled: true,
        defaultAgent: 'x',
        aliases
      })
      for (const bad of [
        { talk: { defaultAgent: '' } },
        { talk: { aliases: { a: ['x'.repeat(61)] } } },
        { talk: 5 },
        { talk: { other: 1 } }
      ]) {
        const err = await h['voice:set'](bad).then(
          () => null,
          (e: Error) => e
        )
        expect(err?.message, JSON.stringify(bad)).toBe('bad talk settings')
      }
      expect(voiceTold).toHaveLength(2)
    })

    it('voice:set takes clean switches and rejects bad ones', async () => {
      expect(((await h['voice:set']({ clean: { fillers: true } })) as VoiceStatus).clean).toEqual({ fillers: true, rewrite: false })
      expect(((await h['voice:set']({ clean: { rewrite: true } })) as VoiceStatus).clean).toEqual({ fillers: true, rewrite: true })
      for (const bad of [{ clean: { fillers: 1 } }, { clean: 5 }, { clean: { other: true } }]) {
        const err = await h['voice:set'](bad).then(
          () => null,
          (e: Error) => e
        )
        expect(err?.message, JSON.stringify(bad)).toBe('bad clean settings')
      }
      expect(voiceTold).toHaveLength(2)
    })

    it('voice:check passes the transcriber answer through', async () => {
      expect(await h['voice:check']()).toEqual({ ok: false, reason: 'unreachable' })
    })
  })

  describe('jev', () => {
    const KEY = 'sk-or-v1-0123456789abcdef'

    it('saves a trimmed key and never sends it back', async () => {
      const status = await h['jev:setKey'](`  ${KEY}\n`)
      expect(status).toEqual({ keySet: true, enabled: true, moderator: true, approvalRisk: true, agentSuggest: true })
      expect(await jevStore.key()).toBe(KEY)
      expect(JSON.stringify(await h['jev:status']())).not.toContain(KEY)
      expect(await h['jev:setKey'](null)).toMatchObject({ keySet: false })
    })

    it('refuses a bad key without quoting it', async () => {
      for (const bad of [42, '   ', 'two words', 'k'.repeat(JEV_KEY_MAX + 1)]) {
        const err = await h['jev:setKey'](bad).then(
          () => null,
          (e: Error) => e
        )
        expect(err).toBeInstanceOf(Error)
        if (typeof bad === 'string' && bad.trim()) expect(err!.message).not.toContain(bad.trim())
      }
      expect(await jevStore.key()).toBeNull()
    })

    it('sets only known switches, as booleans', async () => {
      expect(await h['jev:setSwitches']({ enabled: false })).toMatchObject({ enabled: false, moderator: true })
      await expect(h['jev:setSwitches']({ enabled: 'no' })).rejects.toThrow('enabled must be a boolean')
      await expect(h['jev:setSwitches']({ keySet: true })).rejects.toThrow('keySet is not a Jev switch')
      await expect(h['jev:setSwitches'](null)).rejects.toThrow('switches must be an object')
    })

    it('checks the key', async () => {
      expect(await h['jev:check']()).toEqual({ ok: false, error: 'Could not reach OpenRouter.' })
    })

    it('suggests among working agents only, and not for a short message', async () => {
      expect(await h['jev:suggestAgent']('Please fix the failing login test')).toBe('alpha')
      expect(suggested).toEqual([{ text: 'Please fix the failing login test', agents: [{ name: 'alpha', description: '' }] }])
      expect(await h['jev:suggestAgent']('hi there')).toBeNull()
      expect(suggested).toHaveLength(1)
      await expect(h['jev:suggestAgent'](5)).rejects.toThrow('text must be a string')
    })

    it('never suggests a remote agent', async () => {
      agentList.push(
        { ...alpha, filePath: '/agents/remote.md', name: 'remote', provider: 'ag-ui', remoteHost: 'agents.example.com' },
        { ...alpha, filePath: '/agents/gem.md', name: 'gem', provider: 'acp' }
      )
      await h['jev:suggestAgent']('Please fix the failing login test')
      expect(suggested[0]!.agents.map((x) => x.name)).toEqual(['alpha', 'gem'])
    })
  })

  it('approvals:list and approvals:remove use the store and reject a non-string agent', async () => {
    await approvals.add('a', { key: 'Bash:ls', toolName: 'Bash', command: 'ls' })
    expect(await h['approvals:list']('a')).toEqual([{ key: 'Bash:ls', toolName: 'Bash', command: 'ls' }])
    expect(await h['approvals:remove']('a', 'Bash:ls')).toEqual([])
    expect(approvals.has('a', 'Bash:ls')).toBe(false)
    expect(approvalsTold).toEqual(['a'])
    await expect(h['approvals:list'](5)).rejects.toThrow(/agentName must be a string/)
    await expect(h['approvals:remove'](5, 'k')).rejects.toThrow(/agentName must be a string/)
    await expect(h['approvals:remove']('a', 5)).rejects.toThrow(/key must be a string/)
  })

  describe('agents:save and launch trust (ACP)', () => {
    const acpFile = (name: string, args: string[] = ['--acp'], extra = '') =>
      `---\nname: ${name}\ndescription: Gemini\nprovider: acp\nacp:\n  command: gemini\n  args: ${JSON.stringify(args)}\n  authEnv: [GEMINI_API_KEY]\n${extra}---\nYou help.\n`
    const launchOf = (args: string[] = ['--acp']) => acpRecord({ command: 'gemini', args, authEnv: ['GEMINI_API_KEY'] })
    let trust: LaunchTrust
    let saveSpy: Mock
    let hl: Handlers
    beforeEach(async () => {
      trust = new LaunchTrust(join(dir, 'trust'))
      await trust.load()
      saveSpy = vi.fn(async () => saveResult)
      hl = createHandlers({
        ...handlerDeps,
        agents: { ...handlerDeps.agents, save: saveSpy } as unknown as HandlerDeps['agents'],
        launchTrust: trust
      })
    })

    it('a save confirms the launch it writes, for the saved name', async () => {
      saveResult = { ok: true, filePath: '/agents/gem.md', name: 'gem', renamedFrom: null }
      expect(await hl['agents:save'](null, acpFile('gem'))).toEqual(saveResult)
      expect(trust.check('gem', launchOf())).toBe('ok')
    })

    it('a save holding a refused argument is rejected before anything is written, naming the flag', async () => {
      for (const args of [
        ['--acp', '--yolo'],
        ['--permission-mode', 'bypassPermissions']
      ]) {
        const r = await hl['agents:save'](null, acpFile('gem', args))
        expect(r).toEqual({ ok: false, error: ACP_TEXT.refusedArg(refusedArg(args)!) })
      }
      expect(saveSpy).not.toHaveBeenCalled()
      expect(trust.agents()).toEqual([])
    })

    it('a failed save confirms nothing', async () => {
      saveResult = { ok: false, error: 'nope' }
      await hl['agents:save'](null, acpFile('gem'))
      expect(trust.agents()).toEqual([])
    })

    it('a rename moves the entry and confirms the launch now saved', async () => {
      await trust.confirm('old', launchOf(['--old']))
      saveResult = { ok: true, filePath: '/agents/new.md', name: 'new', renamedFrom: 'old' }
      await hl['agents:save']('/agents/old.md', acpFile('new'))
      expect(trust.check('old', launchOf(['--old']))).toBe('none')
      expect(trust.check('new', launchOf())).toBe('ok')
    })

    it('a save that is no longer an ACP agent drops its entry, so switching back needs a new confirm', async () => {
      await trust.confirm('gem', launchOf())
      saveResult = { ok: true, filePath: '/agents/gem.md', name: 'gem', renamedFrom: null }
      await hl['agents:save']('/agents/gem.md', '---\nname: gem\ndescription: Gemini\n---\nYou help.\n')
      expect(trust.agents()).toEqual([])
    })

    it("while the trust file cannot be read, a Claude agent's save logs nothing; an ACP save that cannot confirm says so, by code only", async () => {
      await fs.mkdir(join(dir, 'trust2', 'protocol-launch.json'), { recursive: true })
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const broken = new LaunchTrust(join(dir, 'trust2'))
        await broken.load()
        log.mockClear()
        const hb = createHandlers({
          ...handlerDeps,
          agents: { ...handlerDeps.agents, save: saveSpy } as unknown as HandlerDeps['agents'],
          launchTrust: broken
        })
        saveResult = { ok: true, filePath: '/agents/gem.md', name: 'gem', renamedFrom: null }
        expect(await hb['agents:save']('/agents/gem.md', '---\nname: gem\ndescription: Gemini\n---\nYou help.\n')).toEqual(saveResult)
        expect(log).not.toHaveBeenCalled()
        expect(await hb['agents:save']('/agents/gem.md', acpFile('gem'))).toEqual(saveResult)
        const lines = log.mock.calls.map((a) => a.map(String).join(' '))
        expect(lines.filter((l) => l.startsWith('confirming the agent launch failed'))).toHaveLength(1)
        expect(lines.join('\n')).not.toContain('gemini')
      } finally {
        log.mockRestore()
      }
    })

    it('trashing the last file of a name drops its entry', async () => {
      await trust.confirm('alpha', launchOf())
      await hl['agents:trash']('/agents/alpha.md')
      expect(trust.agents()).toEqual([])
    })
  })

  describe('agents:save and launch trust (AG-UI)', () => {
    const EP = 'https://agents.example.com/run'
    const remoteFile = (name: string, endpoint = EP, provider = 'provider: ag-ui\n') =>
      `---\nname: ${name}\ndescription: Remote\n${provider}agui:\n  endpoint: ${endpoint}\n  authKey: EXAMPLE_AGENT_KEY\n---\nYou help.\n`
    const record = (endpoint = EP) => aguiRecord({ endpoint, authKey: 'EXAMPLE_AGENT_KEY', authHeader: null })
    let trust: LaunchTrust
    let saveSpy: Mock
    let looked: string[]
    let answer: string[]
    const lookup = async (host: string) => {
      looked.push(host)
      return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    }
    const make = (allowLocal = false) =>
      createHandlers({
        ...handlerDeps,
        agents: { ...handlerDeps.agents, save: saveSpy } as unknown as HandlerDeps['agents'],
        launchTrust: trust,
        aguiEndpoint: { allowLocal, lookup }
      })
    beforeEach(async () => {
      trust = new LaunchTrust(join(dir, 'agui-trust'))
      await trust.load()
      saveSpy = vi.fn(async () => saveResult)
      looked = []
      answer = ['93.184.216.34']
      saveResult = { ok: true, filePath: '/agents/rem.md', name: 'rem', renamedFrom: null }
    })

    it('a public endpoint is checked (its name resolved), saved and confirmed for the saved name', async () => {
      expect(await make()['agents:save'](null, remoteFile('rem'))).toEqual(saveResult)
      expect(looked).toEqual(['agents.example.com'])
      expect(saveSpy).toHaveBeenCalledTimes(1)
      expect(trust.check('rem', record())).toBe('ok')
      expect(trust.confirmed('rem')).toEqual(record())
    })

    it('a private, loopback or mixed answer is refused with the sentence before anything is written', async () => {
      for (const a of [['10.0.0.5'], ['127.0.0.1'], ['93.184.216.34', '192.168.1.2'], ['::ffff:10.0.0.1']]) {
        answer = a
        expect(await make()['agents:save'](null, remoteFile('rem'))).toEqual({
          ok: false,
          error: AGUI_TEXT.notPublic('agents.example.com')
        })
      }
      // A literal private address needs no lookup to be refused; plain http is refused outside the dev hook.
      expect(await make()['agents:save'](null, remoteFile('rem', 'https://10.1.2.3/run'))).toEqual({
        ok: false,
        error: AGUI_TEXT.notPublic('10.1.2.3')
      })
      expect(await make()['agents:save'](null, remoteFile('rem', 'http://127.0.0.1:9/run'))).toEqual({
        ok: false,
        error: AGUI_TEXT.endpointInvalid
      })
      // A name that does not resolve is refused too.
      answer = []
      expect(await make()['agents:save'](null, remoteFile('rem'))).toEqual({
        ok: false,
        error: AGUI_TEXT.resolveFailed('agents.example.com')
      })
      expect(saveSpy).not.toHaveBeenCalled()
      expect(trust.agents()).toEqual([])
    })

    it('the dev hook allows a loopback endpoint, plain http included', async () => {
      expect(await make(true)['agents:save'](null, remoteFile('rem', 'http://127.0.0.1:9/run'))).toEqual(saveResult)
      expect(trust.check('rem', record('http://127.0.0.1:9/run'))).toBe('ok')
    })

    it('an agui: on an agent that is not remote is inert: not checked, and no record is kept', async () => {
      await trust.confirm('rem', record())
      expect(await make()['agents:save'](null, remoteFile('rem', 'https://10.1.2.3/run', ''))).toEqual(saveResult)
      expect(looked).toEqual([])
      expect(trust.agents()).toEqual([])
    })

    it('switching a remote agent to ACP replaces its record, and a rename moves it', async () => {
      await trust.confirm('old', record())
      saveResult = { ok: true, filePath: '/agents/rem.md', name: 'rem', renamedFrom: 'old' }
      await make()['agents:save']('/agents/old.md', remoteFile('rem'))
      expect(trust.agents()).toEqual(['rem'])
      expect(trust.check('rem', record())).toBe('ok')
      saveResult = { ok: true, filePath: '/agents/rem.md', name: 'rem', renamedFrom: null }
      const acp = '---\nname: rem\ndescription: Remote\nprovider: acp\nacp:\n  command: gemini\n  args: [--acp]\n---\nYou help.\n'
      await make()['agents:save']('/agents/rem.md', acp)
      expect(trust.check('rem', record())).toBe('changed')
      expect(trust.check('rem', acpRecord({ command: 'gemini', args: ['--acp'], authEnv: [] }))).toBe('ok')
    })
  })

  describe('agents:testAgui and agents:aguiLaunch', () => {
    let aguiDir: string
    let trust: LaunchTrust
    let fake: FakeAgui
    let hl: Handlers
    const write = (name: string, head: string) =>
      fs.writeFile(join(aguiDir, `${name}.md`), `---\nname: ${name}\ndescription: Remote\n${head}---\nYou help.\n`)
    const head = (endpoint: string, authKey: string | null = 'REMOTE_KEY') =>
      `provider: ag-ui\nagui:\n  endpoint: ${endpoint}\n${authKey === null ? '' : `  authKey: ${authKey}\n`}`
    const launchOf = (endpoint: string, authKey: string | null = 'REMOTE_KEY') => ({ endpoint, authKey, authHeader: null })
    beforeEach(async () => {
      aguiDir = join(dir, 'agui-agents')
      await fs.mkdir(aguiDir, { recursive: true })
      trust = new LaunchTrust(join(dir, 'agui-test-trust'))
      await trust.load()
      fake = await startFakeAgui([[{ text: 'never sent' }]])
      const agents = new AgentStore(aguiDir, async () => {})
      const aguiTest = createAguiTest({
        definitionOf: (a) => agents.aguiOf(a),
        trust: (a, l) => trust.check(a, aguiRecord(l)),
        allowLocal: true,
        keyNames: (a) => Object.keys(vaultEnvOf(vaultStore.grantedTo(a)).env),
        caps: () => engineCaps('ag-ui')
      })
      hl = createHandlers({ ...handlerDeps, launchTrust: trust, aguiTest })
    })
    afterEach(stopFakeAgui)

    it('checks the name as agents:save does, and every argument must be a string', async () => {
      await expect(hl['agents:testAgui'](5)).rejects.toThrow(/agentName must be a string/)
      await expect(hl['agents:testAgui']('Bad Name')).rejects.toThrow('Name must be lowercase letters, digits and single hyphens')
      await expect(hl['agents:aguiLaunch']({})).rejects.toThrow(/agentName must be a string/)
      await expect(hl['agents:aguiLaunch']('../x')).rejects.toThrow('Name must be lowercase letters, digits and single hyphens')
    })

    it('refuses an endpoint never confirmed in Agent Studio, or changed outside it, connecting to nothing', async () => {
      await write('rem', head(fake.url))
      expect(await hl['agents:testAgui']('rem')).toEqual({ error: AGUI_TEXT.untrusted })
      await trust.confirm('rem', aguiRecord(launchOf(fake.url)))
      await write('rem', head(fake.url, 'OTHER_KEY'))
      expect(await hl['agents:testAgui']('rem')).toEqual({ error: AGUI_TEXT.untrusted })
      await new Promise((r) => setTimeout(r, 30))
      expect(fake.logText()).toBe('')
    })

    it('answers the checked host, the handshake and the key, and the fake server never sees a request (no message, no key)', async () => {
      await vaultStore.save({
        kind: 'apiKey',
        name: 'Remote key',
        agents: ['rem'],
        env: 'REMOTE_KEY',
        value: 'sk-remote-12345678',
        description: ''
      })
      await write('rem', head(fake.url))
      await trust.confirm('rem', aguiRecord(launchOf(fake.url)))
      const r = await hl['agents:testAgui']('rem')
      expect(r).toEqual({
        host: `127.0.0.1:${fake.port}`,
        addresses: ['127.0.0.1'],
        tls: false,
        authKey: 'REMOTE_KEY',
        authKeyGranted: true,
        caps: engineCaps('ag-ui'),
        hidden: missingFeatures(engineCaps('ag-ui'))
      })
      expect(JSON.stringify(r)).not.toContain('sk-remote-12345678')
      await new Promise((res) => setTimeout(res, 50))
      expect(fake.log()).toEqual([])
      expect(fake.logText()).toBe('')
    })

    it('an auth key not granted to the agent says so', async () => {
      await write('rem', head(fake.url))
      await trust.confirm('rem', aguiRecord(launchOf(fake.url)))
      expect(await hl['agents:testAgui']('rem')).toMatchObject({ authKey: 'REMOTE_KEY', authKeyGranted: false })
    })

    it('a saved file that is not a remote agent, no agent, or no endpoint is the fixed sentence', async () => {
      await write('plain', `agui:\n  endpoint: ${fake.url}\n`)
      expect(await hl['agents:testAgui']('plain')).toEqual({ error: AGUI_TEXT.notAgui })
      expect(await hl['agents:testAgui']('missing')).toEqual({ error: AGUI_TEXT.notAgui })
      await write('bare', 'provider: ag-ui\n')
      expect(await hl['agents:testAgui']('bare')).toEqual({ error: AGUI_TEXT.noEndpoint })
    })

    it('without the test service it is refused with the fixed sentence', async () => {
      const bare = createHandlers({ ...handlerDeps, launchTrust: trust })
      expect(await bare['agents:testAgui']('rem')).toEqual({ error: AGUI_TEXT.testUnavailable })
    })

    it('agents:aguiLaunch gives the endpoint confirmed on this machine, or null', async () => {
      expect(await hl['agents:aguiLaunch']('rem')).toBeNull()
      const l = { endpoint: 'https://agents.example.com/run', authKey: 'REMOTE_KEY', authHeader: 'X-Api-Key' }
      await trust.confirm('rem', aguiRecord(l))
      expect(await hl['agents:aguiLaunch']('rem')).toEqual(l)
      expect(await createHandlers(handlerDeps)['agents:aguiLaunch']('rem')).toBeNull()
      // An ACP launch is no endpoint.
      await trust.confirm('rem', acpRecord({ command: 'gemini', args: ['--acp'], authEnv: [] }))
      expect(await hl['agents:aguiLaunch']('rem')).toBeNull()
    })
  })

  describe('agents:testAcp and agents:acpLaunch', () => {
    const FAKE = fileURLToPath(new URL('../fixtures/fake-acp-agent.mjs', import.meta.url))
    const fakeLaunch = (authEnv: string[] = []) => ({ command: process.execPath, args: [FAKE], authEnv })
    let acpDir: string
    let trust: LaunchTrust
    let script: object
    let hl: Handlers
    const file = (n: string) => join(dir, 'acp-run', n)
    const lines = async (p: string): Promise<any[]> =>
      (await fs.readFile(p, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    const write = (name: string, head: string) =>
      fs.writeFile(join(acpDir, `${name}.md`), `---\nname: ${name}\ndescription: Test agent\n${head}---\nYou help.\n`)
    const acpHead = (l: { command: string; args: string[]; authEnv: string[] }) =>
      `provider: acp\nacp:\n  command: ${JSON.stringify(l.command)}\n  args: ${JSON.stringify(l.args)}\n  authEnv: ${JSON.stringify(l.authEnv)}\n`
    beforeEach(async () => {
      acpDir = join(dir, 'acp-agents')
      await fs.mkdir(acpDir, { recursive: true })
      await fs.mkdir(join(dir, 'acp-run'), { recursive: true })
      trust = new LaunchTrust(join(dir, 'acp-trust'))
      await trust.load()
      script = {}
      const agents = new AgentStore(acpDir, async () => {})
      const acpTest = createAcpTest({
        definitionOf: (a) => agents.acpOf(a),
        trust: (a, l) => trust.check(a, acpRecord(l)),
        locate: (c) => acpLocate(c, process.env),
        env: async () => ({
          ...process.env,
          FAKE_ACP_SCRIPT: JSON.stringify(script),
          FAKE_ACP_LOG: file('log.jsonl'),
          FAKE_ACP_START: file('start.jsonl')
        }),
        vaultEnv: (a) => vaultEnvOf(vaultStore.grantedTo(a)),
        caps: () => engineCaps('acp')
      })
      hl = createHandlers({ ...handlerDeps, launchTrust: trust, acpTest })
    })

    it('checks the name as agents:save does', async () => {
      await expect(hl['agents:testAcp'](5)).rejects.toThrow(/agentName must be a string/)
      await expect(hl['agents:testAcp']('Bad Name')).rejects.toThrow('Name must be lowercase letters, digits and single hyphens')
      await expect(hl['agents:acpLaunch']({})).rejects.toThrow(/agentName must be a string/)
      await expect(hl['agents:acpLaunch']('../x')).rejects.toThrow('Name must be lowercase letters, digits and single hyphens')
    })

    it('refuses a launch never confirmed in Agent Studio, starting nothing', async () => {
      await write('gem', acpHead(fakeLaunch()))
      expect(await hl['agents:testAcp']('gem')).toEqual({ error: ACP_TEXT.untrusted })
      expect(await lines(file('start.jsonl'))).toEqual([])
    })

    it('refuses a launch changed outside Agent Studio since its Save', async () => {
      await trust.confirm('gem', acpRecord(fakeLaunch()))
      await write('gem', acpHead({ ...fakeLaunch(), args: [FAKE, '--other'] }))
      expect(await hl['agents:testAcp']('gem')).toEqual({ error: ACP_TEXT.untrusted })
      expect(await lines(file('start.jsonl'))).toEqual([])
    })

    it("answers with the fake agent's initialize, the caps ZumiBot enables and what it hides; never session/new", async () => {
      script = {
        initialize: {
          agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '0.0.1' },
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
          authMethods: [{ id: 'login', name: 'Fake login' }]
        }
      }
      await write('gem', acpHead(fakeLaunch()))
      await trust.confirm('gem', acpRecord(fakeLaunch()))
      expect(await hl['agents:testAcp']('gem')).toEqual({
        agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '0.0.1' },
        protocolVersion: 1,
        loadSession: true,
        resume: true,
        systemPrompt: false,
        image: false,
        authMethods: [{ name: 'Fake login', terminal: null }],
        caps: engineCaps('acp'),
        hidden: missingFeatures(engineCaps('acp'))
      })
      const sent = (await lines(file('log.jsonl'))).filter((m) => typeof m.method === 'string').map((m) => m.method)
      expect(sent).toEqual(['initialize'])
    })

    it('a saved file that is not an ACP agent, or no agent, is the fixed sentence', async () => {
      await write('plain', 'acp:\n  command: gemini\n')
      expect(await hl['agents:testAcp']('plain')).toEqual({ error: ACP_TEXT.notAcp })
      expect(await hl['agents:testAcp']('missing')).toEqual({ error: ACP_TEXT.notAcp })
      await write('bare', 'provider: acp\n')
      expect(await hl['agents:testAcp']('bare')).toEqual({ error: ACP_TEXT.noCommand })
    })

    it('a refused argument refuses the test, even with an entry that matches', async () => {
      const bad = { ...fakeLaunch(), args: [FAKE, '--yolo'] }
      await write('gem', acpHead(bad))
      await trust.confirm('gem', acpRecord(bad))
      expect(await hl['agents:testAcp']('gem')).toEqual({ error: ACP_TEXT.refusedArg('--yolo') })
      expect(await lines(file('start.jsonl'))).toEqual([])
    })

    it('a sign-in key must be granted; a granted one reaches the agent under its own name, and its value never comes back', async () => {
      const launch = fakeLaunch(['FAKE_API_KEY'])
      await write('gem', acpHead(launch))
      await trust.confirm('gem', acpRecord(launch))
      expect(await hl['agents:testAcp']('gem')).toEqual({ error: ACP_TEXT.authEnvMissing('FAKE_API_KEY') })
      await vaultStore.save({
        kind: 'apiKey',
        name: 'Fake key',
        agents: ['gem'],
        env: 'FAKE_API_KEY',
        value: 'sk-fake-12345678',
        description: ''
      })
      script = { initialize: { agentInfo: { name: 'fake-acp', title: 'echo sk-fake-12345678' } } }
      const r = (await hl['agents:testAcp']('gem')) as { agentInfo: { title: string } }
      expect(r.agentInfo.title).toBe('echo [vault: Fake key]')
      expect((await lines(file('start.jsonl')))[0].envKeys).toContain('FAKE_API_KEY')
    })

    it('without the test service it is refused with the fixed sentence', async () => {
      const bare = createHandlers({ ...handlerDeps, launchTrust: trust })
      expect(await bare['agents:testAcp']('gem')).toEqual({ error: ACP_TEXT.testUnavailable })
    })

    it('agents:acpLaunch gives the launch confirmed on this machine, or null', async () => {
      expect(await hl['agents:acpLaunch']('gem')).toBeNull()
      await trust.confirm('gem', acpRecord(fakeLaunch(['FAKE_API_KEY'])))
      expect(await hl['agents:acpLaunch']('gem')).toEqual(fakeLaunch(['FAKE_API_KEY']))
      expect(await createHandlers(handlerDeps)['agents:acpLaunch']('gem')).toBeNull()
      // A remote agent's confirmed endpoint is no ACP launch.
      await trust.confirm('gem', aguiRecord({ endpoint: 'https://agents.example.com/run', authKey: null, authHeader: null }))
      expect(await hl['agents:acpLaunch']('gem')).toBeNull()
    })
  })

  it('agents:save with a rename moves the remembered rules', async () => {
    await approvals.add('old', { key: 'Bash:ls', toolName: 'Bash', command: 'ls' })
    await h['agents:save']('/a/old.md', 'raw')
    expect(approvals.has('new', 'Bash:ls')).toBe(true)
    expect(approvals.has('old', 'Bash:ls')).toBe(false)
  })

  it('rejects a non-string chatId', async () => {
    await expect(h['chats:items'](5)).rejects.toThrow(/chatId must be a string/)
  })

  it("chats:pending answers the chat service's counts, none while nothing runs", async () => {
    expect(await h['chats:pending']()).toEqual({})
    vi.spyOn(svc, 'pendingCounts').mockReturnValue({ c1: 2 })
    expect(await h['chats:pending']()).toEqual({ c1: 2 })
  })

  it('app:folderStart returns the fixed folder for Zumi Bot', async () => {
    expect(await h['app:folderStart']('zumi-bot')).toEqual({ fixed: true, path: agentsDir })
  })

  it('app:folderStart otherwise starts at last folder or home', async () => {
    expect(await h['app:folderStart']('helper')).toEqual({ fixed: false, path: home })
    expect(await h['app:folderStart'](null)).toEqual({ fixed: false, path: home })
    const last = join(dir, 'last')
    await fs.mkdir(last)
    await settings.setLastFolder('helper', last)
    expect(await h['app:folderStart']('helper')).toEqual({ fixed: false, path: last })
    await fs.rmdir(last)
    expect(await h['app:folderStart']('helper')).toEqual({ fixed: false, path: home })
  })

  it('app:folderStart returns testPickFolder as fixed when set', async () => {
    testPick = '/tmp/picked'
    expect(await h['app:folderStart']('helper')).toEqual({ fixed: true, path: '/tmp/picked' })
  })

  it('app:setKeepWarm saves the offered hours and rejects others', async () => {
    expect(await h['app:getKeepWarm']()).toEqual({ roomHours: 12, chatHours: 2 })
    expect(await h['app:setKeepWarm']({ roomHours: 8, chatHours: 0 })).toEqual({ roomHours: 8, chatHours: 0 })
    expect(await h['app:getKeepWarm']()).toEqual({ roomHours: 8, chatHours: 0 })
    await expect(h['app:setKeepWarm']({ roomHours: 5, chatHours: 0 })).rejects.toThrow(/roomHours/)
    await expect(h['app:setKeepWarm']({ roomHours: 4, chatHours: 3 })).rejects.toThrow(/chatHours/)
  })

  it('app:setTimeZone stores a valid zone, ignores a bad one and rejects a non-string', async () => {
    expect(await settings.timeZone()).toBeNull()
    await h['app:setTimeZone']('Europe/Istanbul')
    expect(await settings.timeZone()).toBe('Europe/Istanbul')
    await h['app:setTimeZone']('Not/AZone')
    expect(await settings.timeZone()).toBe('Europe/Istanbul')
    await expect(h['app:setTimeZone'](5)).rejects.toThrow(TypeError)
    await expect(h['app:setTimeZone'](null)).rejects.toThrow(TypeError)
  })

  it('app:setHouseStyle saves a boolean and rejects anything else', async () => {
    expect(await h['app:getHouseStyle']()).toBe(true)
    expect(await h['app:setHouseStyle'](false)).toBe(false)
    expect(await h['app:getHouseStyle']()).toBe(false)
    await expect(h['app:setHouseStyle']('true')).rejects.toThrow(/on must be a boolean/)
    expect((await settings.get()).houseStyle).toBe(false)
  })

  it('app:setAccent saves one of the color themes and rejects anything else', async () => {
    expect(await h['app:getAccent']()).toBe('blue')
    expect(await h['app:setAccent']('graphite')).toBe('graphite')
    expect(await h['app:getAccent']()).toBe('graphite')
    await expect(h['app:setAccent']('purple')).rejects.toThrow(/accent must be blue, teal, coral or graphite/)
    expect((await settings.get()).accent).toBe('graphite')
  })

  it('sidebar:save stores a clean layout, tells every tab, and refuses a malformed one', async () => {
    expect(await h['sidebar:get']()).toEqual({ sections: [], unassigned: [] })
    const raw = {
      sections: [{ id: 's1', name: '  Work  ', collapsed: false, items: ['agent:a', 'agent:a'] }],
      unassigned: ['agent:a', 'agent:b']
    }
    const clean = { sections: [{ id: 's1', name: 'Work', collapsed: false, items: ['agent:a'] }], unassigned: ['agent:b'] }
    expect(await h['sidebar:save'](raw)).toEqual(clean)
    expect(await h['sidebar:get']()).toEqual(clean)
    expect(told).toEqual([clean])
    await expect(h['sidebar:save']({ sections: 'x', unassigned: [] })).rejects.toThrow(/layout must be a sidebar layout/)
    expect(await sidebar.get()).toEqual(clean)
  })

  it('chats:remove drops the chat from the sidebar and tells every tab', async () => {
    const c = await store.create('helper', dir)
    await sidebar.save({ sections: [{ id: 's1', name: 'Work', collapsed: false, items: [`group:${c.id}`] }], unassigned: [] })
    await h['chats:remove'](c.id)
    const left = { sections: [{ id: 's1', name: 'Work', collapsed: false, items: [] }], unassigned: [] }
    expect(await sidebar.get()).toEqual(left)
    expect(told).toEqual([left])
  })

  describe('worktree handlers', () => {
    const wt = { root: '/wt/repo-alpha-a1b2c3', branch: 'zumibot/alpha-a1b2c3', source: '/repo', folder: '/repo', links: [] }
    let fake: { topOf: Mock; create: Mock; status: Mock; release: Mock }
    let hw: Handlers
    beforeEach(() => {
      fake = {
        topOf: vi.fn(async (d: string) => (d === '/repo' || d.startsWith('/repo/') ? '/repo' : null)),
        create: vi.fn(async (picked: string) => ({ cwd: '/wt/repo-alpha-a1b2c3', worktree: { ...wt, folder: picked } })),
        status: vi.fn(async () => ({ branch: 'zumibot/alpha-a1b2c3', head: 'abc1234', changed: 2 })),
        release: vi.fn(async () => {})
      }
      hw = createHandlers({ ...handlerDeps, worktrees: fake as unknown as HandlerDeps['worktrees'] })
    })

    it("chats:create isolates only when the repo's toggle is on", async () => {
      const plain = (await hw['chats:create']('alpha', '/repo/sub')) as ChatMeta
      expect(fake.create).not.toHaveBeenCalled()
      expect(plain.cwd).toBe('/repo/sub')
      expect(plain.worktree).toBeUndefined()
      await settings.setWorktreeFolder('/repo', true)
      const made = (await hw['chats:create']('alpha', '/repo/sub')) as ChatMeta
      expect(fake.create).toHaveBeenCalledWith('/repo/sub', 'alpha')
      expect(made.cwd).toBe('/wt/repo-alpha-a1b2c3')
      expect(made.worktree).toMatchObject({ branch: wt.branch, folder: '/repo/sub' })
      expect((await settings.get()).lastFolderByAgent['alpha']).toBe('/repo/sub')
      // a folder outside any repo stays plain even with the toggle on elsewhere
      const out = (await hw['chats:create']('alpha', '/elsewhere')) as ChatMeta
      expect(out.worktree).toBeUndefined()
      expect(fake.create).toHaveBeenCalledTimes(1)
    })

    it('chats:create refuses when the worktree cannot be made, and stores no chat', async () => {
      await settings.setWorktreeFolder('/repo', true)
      fake.create.mockRejectedValueOnce(new Error('fatal: nope'))
      await expect(hw['chats:create']('alpha', '/repo')).rejects.toThrow('fatal: nope')
      expect(await store.list()).toEqual([])
      expect((await settings.get()).lastFolderByAgent['alpha']).toBeUndefined()
    })

    it('chats:create never asks git while no toggle is on, so a machine without git still chats', async () => {
      fake.topOf.mockRejectedValue(new Error('git not found'))
      const chat = (await hw['chats:create']('alpha', '/repo')) as ChatMeta
      expect(fake.topOf).not.toHaveBeenCalled()
      expect(chat.worktree).toBeUndefined()
    })

    it("chats:create fails with git's line when a toggle is on and git cannot answer, and stores no chat", async () => {
      await settings.setWorktreeFolder('/repo', true)
      fake.topOf.mockRejectedValue(new Error('git timed out'))
      await expect(hw['chats:create']('alpha', '/repo')).rejects.toThrow('git timed out')
      expect(await store.list()).toEqual([])
    })

    it('chats:create for the built-in agent never isolates', async () => {
      await settings.setWorktreeFolder(agentsDir, true)
      fake.topOf.mockResolvedValue(agentsDir)
      const chat = (await hw['chats:create']('zumi-bot', '/ignored')) as ChatMeta
      expect(fake.topOf).not.toHaveBeenCalled()
      expect(fake.create).not.toHaveBeenCalled()
      expect(chat.cwd).toBe(agentsDir)
      expect(chat.worktree).toBeUndefined()
    })

    it('chats:createGroup isolates with slug base room', async () => {
      agentList = [alpha, { ...alpha, name: 'beta', filePath: '/agents/beta.md' }]
      await settings.setWorktreeFolder('/repo', true)
      const room = (await hw['chats:createGroup'](['alpha', 'beta'], '/repo', '')) as ChatMeta
      expect(fake.create).toHaveBeenCalledWith('/repo', 'room')
      expect(room.cwd).toBe('/wt/repo-alpha-a1b2c3')
      expect(room.worktree).toMatchObject({ branch: wt.branch })
      expect((await settings.get()).lastGroupFolder).toBe('/repo')
    })

    it('chats:create with no folder (or the scratch root) gives each chat its own scratch folder, never isolated or remembered', async () => {
      await settings.setWorktreeFolder('/repo', true)
      const a = (await hw['chats:create']('alpha', null)) as ChatMeta
      const b = (await hw['chats:create']('alpha', `${home}/zumibot/cache`)) as ChatMeta
      // `<home>/zumibot/cache/`, with the home's separator (a backslash on Windows).
      const root = scratchChild(home, '')
      for (const c of [a, b]) {
        expect(c.cwd.startsWith(root)).toBe(true)
        expect(c.cwd.slice(root.length)).toMatch(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/)
        expect((await fs.stat(c.cwd)).isDirectory()).toBe(true)
        expect(c.worktree).toBeUndefined()
      }
      expect(a.cwd).not.toBe(b.cwd)
      expect(fake.topOf).not.toHaveBeenCalled()
      expect((await settings.get()).lastFolderByAgent['alpha']).toBeUndefined()
    })

    it('chats:createGroup with no folder runs in a scratch folder and leaves the last group folder alone', async () => {
      agentList = [alpha, { ...alpha, name: 'beta', filePath: '/agents/beta.md' }]
      const room = (await hw['chats:createGroup'](['alpha', 'beta'], null, '')) as ChatMeta
      expect(room.cwd.startsWith(scratchChild(home, ''))).toBe(true)
      expect((await fs.stat(room.cwd)).isDirectory()).toBe(true)
      expect((await settings.get()).lastGroupFolder).toBeNull()
    })

    it('chats:createGroup stays plain with the toggle off', async () => {
      agentList = [alpha, { ...alpha, name: 'beta', filePath: '/agents/beta.md' }]
      const room = (await hw['chats:createGroup'](['alpha', 'beta'], '/repo', '')) as ChatMeta
      expect(fake.create).not.toHaveBeenCalled()
      expect(room.cwd).toBe('/repo')
      expect(room.worktree).toBeUndefined()
    })

    it('app:gitFolder and app:setWorktreeFolder', async () => {
      expect(await hw['app:gitFolder']('/x')).toEqual({ repo: false, worktree: false })
      await expect(hw['app:setWorktreeFolder']('/x', true)).rejects.toThrow('Not a git repository: x')
      expect(await hw['app:gitFolder']('/repo/sub')).toEqual({ repo: true, worktree: false })
      await hw['app:setWorktreeFolder']('/repo/sub', true)
      expect(await hw['app:gitFolder']('/repo')).toEqual({ repo: true, worktree: true })
      expect((await settings.get()).worktreeFolders).toEqual(['/repo'])
      await hw['app:setWorktreeFolder']('/repo', false)
      expect(await hw['app:gitFolder']('/repo/sub')).toEqual({ repo: true, worktree: false })
      await expect(hw['app:setWorktreeFolder']('/repo', 'yes')).rejects.toThrow(TypeError)
      await expect(hw['app:gitFolder'](5)).rejects.toThrow(TypeError)
    })

    it('app:gitFolder without the service says not a repo, and setting is refused', async () => {
      expect(await h['app:gitFolder']('/repo')).toEqual({ repo: false, worktree: false })
      await expect(h['app:setWorktreeFolder']('/repo', true)).rejects.toThrow('Not a git repository: repo')
    })

    it('archive releases a worktree chat, remove releases with deleted', async () => {
      const c = await store.create('alpha', wt.root, { worktree: wt })
      await hw['chats:archive'](c.id, false)
      expect(fake.release).not.toHaveBeenCalled()
      await hw['chats:archive'](c.id, true)
      expect(fake.release).toHaveBeenCalledTimes(1)
      expect(fake.release).toHaveBeenLastCalledWith(expect.objectContaining({ id: c.id, worktree: wt }), { deleted: false })
      await hw['chats:remove'](c.id)
      expect(fake.release).toHaveBeenCalledTimes(2)
      expect(fake.release).toHaveBeenLastCalledWith(expect.objectContaining({ id: c.id, worktree: wt }), { deleted: true })
    })

    it('a plain chat is never released, and a release failure does not fail the archive or the delete', async () => {
      const plain = await store.create('alpha', '/repo')
      await hw['chats:archive'](plain.id, true)
      await hw['chats:remove'](plain.id)
      expect(fake.release).not.toHaveBeenCalled()
      const c = await store.create('alpha', wt.root, { worktree: wt })
      fake.release.mockRejectedValue(new Error('boom'))
      await expect(hw['chats:archive'](c.id, true)).resolves.toBeDefined()
      await expect(hw['chats:remove'](c.id)).resolves.toBeUndefined()
    })

    it("chats:gitStatus returns the service's answer, null without the dep", async () => {
      const c = await store.create('alpha', '/repo')
      expect(await hw['chats:gitStatus'](c.id)).toEqual({ branch: 'zumibot/alpha-a1b2c3', head: 'abc1234', changed: 2 })
      expect(fake.status).toHaveBeenCalledWith(expect.objectContaining({ id: c.id }))
      expect(await h['chats:gitStatus'](c.id)).toBeNull()
      await expect(hw['chats:gitStatus']('nope')).rejects.toThrow('Chat not found: nope')
      await expect(h['chats:gitStatus']('nope')).rejects.toThrow('Chat not found: nope')
    })

    it('chats:gitChanges and chats:gitDiff ask the service for the chat, and check their arguments', async () => {
      const changes = { top: '/repo', branch: 'main', head: 'abc1234', files: [], more: 0 }
      const got = { path: 'a.ts', before: { text: 'a' }, after: { text: 'b' } }
      const svc = { list: vi.fn(async () => changes), diff: vi.fn(async () => got) }
      const hg = createHandlers({ ...handlerDeps, gitChanges: svc as unknown as HandlerDeps['gitChanges'] })
      const c = await store.create('alpha', '/repo')
      expect(await hg['chats:gitChanges'](c.id)).toEqual(changes)
      expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ id: c.id }), 'uncommitted')
      expect(await hg['chats:gitDiff'](c.id, 'a.ts')).toEqual(got)
      expect(svc.diff).toHaveBeenCalledWith(expect.objectContaining({ id: c.id }), 'a.ts', 'uncommitted')
      // An omitted scope (null over the wire) is the uncommitted diff, as before base diffs.
      await hg['chats:gitChanges'](c.id, null)
      expect(svc.list).toHaveBeenLastCalledWith(expect.objectContaining({ id: c.id }), 'uncommitted')
      await hg['chats:gitChanges'](c.id, 'base')
      expect(svc.list).toHaveBeenLastCalledWith(expect.objectContaining({ id: c.id }), 'base')
      await hg['chats:gitDiff'](c.id, 'a.ts', 'base')
      expect(svc.diff).toHaveBeenLastCalledWith(expect.objectContaining({ id: c.id }), 'a.ts', 'base')
      await expect(hg['chats:gitChanges'](c.id, 'HEAD~1')).rejects.toThrow(TypeError)
      await expect(hg['chats:gitDiff'](c.id, 'a.ts', 'staged')).rejects.toThrow(TypeError)
      await expect(hg['chats:gitDiff'](c.id, 5)).rejects.toThrow(TypeError)
      await expect(hg['chats:gitChanges']('nope')).rejects.toThrow('Chat not found: nope')
      await expect(hg['chats:gitDiff']('nope', 'a.ts')).rejects.toThrow('Chat not found: nope')
      // Without the service: no list, and no diff.
      expect(await h['chats:gitChanges'](c.id)).toBeNull()
      await expect(h['chats:gitDiff'](c.id, 'a.ts')).rejects.toThrow('Not in a git repository')
    })

    it("chats:cloneRoom keeps the room's worktree", async () => {
      agentList = [alpha, { ...alpha, name: 'beta', filePath: '/agents/beta.md' }]
      const room = await store.createGroup(['alpha', 'beta'], wt.root, '', { worktree: wt })
      const clone = (await hw['chats:cloneRoom'](room.id, 'Next', null)) as ChatMeta
      expect(clone.worktree).toEqual(wt)
      expect(clone.cwd).toBe(wt.root)
    })
  })

  it("files:list builds the list from the chat's stored items", async () => {
    const c = await store.create('helper', '/work')
    await store.saveItems(c.id, [
      {
        type: 'tool',
        id: 't1',
        name: 'Write',
        input: {},
        result: 'ok',
        isError: false,
        blocked: false,
        ts: 5,
        changes: [{ id: 't1', ts: 5, path: '/work/src/a.ts', op: 'create', patch: null, before: null, after: null }]
      }
    ] as ChatItem[])
    const list = (await h['files:list'](c.id)) as { changed: { path: string; shown: string; created: boolean }[]; attached: unknown[] }
    expect(list.attached).toEqual([])
    expect(list.changed).toMatchObject([{ path: '/work/src/a.ts', shown: 'src/a.ts', created: true }])
    await expect(h['files:list']('nope')).rejects.toThrow('Chat not found: nope')
    await expect(h['files:list'](5)).rejects.toThrow()
  })

  it('files:restore checks its arguments and hands them to the restorer', async () => {
    expect(await h['files:restore']('c1', '/work/a.ts', 's1', 's2')).toEqual({ done: 'written' })
    expect(restoreCalls).toEqual([['c1', '/work/a.ts', 's1', 's2']])
    await expect(h['files:restore']('c1', 5, 's1', 's2')).rejects.toThrow(TypeError)
    expect(restoreCalls).toHaveLength(1)
  })

  it("chats:remove removes the chat's file copies, and a failure there does not fail the delete", async () => {
    const c = await store.create('helper', dir)
    const kept = await snapshots.put(c.id, 'text')
    const file = snapshots.pathOf(c.id, (kept as { id: string }).id)!
    await h['chats:remove'](c.id)
    await expect(fs.access(file)).rejects.toThrow()

    const d = await store.create('helper', dir)
    const fail = vi.spyOn(snapshots, 'removeChat').mockRejectedValueOnce(new Error('busy'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(h['chats:remove'](d.id)).resolves.toBeUndefined()
    expect(fail).toHaveBeenCalledWith(d.id)
    expect(log).toHaveBeenCalledWith('removing file copies failed:', expect.any(Error))
    log.mockRestore()
  })

  it("chats:remove removes the chat's kept browser screenshots, and a failure there does not fail the delete", async () => {
    const c = await store.create('helper', dir)
    const { path } = await browserShots.save(c.id, 'home', new Uint8Array([1, 2]))
    await h['chats:remove'](c.id)
    await expect(fs.access(path)).rejects.toThrow()

    const d = await store.create('helper', dir)
    const fail = vi.spyOn(browserShots, 'removeChat').mockRejectedValueOnce(new Error('busy'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(h['chats:remove'](d.id)).resolves.toBeUndefined()
    expect(fail).toHaveBeenCalledWith(d.id)
    expect(log).toHaveBeenCalledWith('removing browser screenshots failed:', expect.any(Error))
    log.mockRestore()
  })

  it("chats:remove removes the chat's CLI temp folder after stopping it, and a failure there does not fail the delete", async () => {
    const c = await store.create('helper', dir)
    vi.spyOn(svc, 'stop').mockImplementation((id: string) => {
      order.push(`stop:${id}`)
    })
    await h['chats:remove'](c.id)
    expect(order).toEqual([`stop:${c.id}`, `tmp:${c.id}`])

    const d = await store.create('helper', dir)
    const fail = vi.spyOn(console, 'error').mockImplementation(() => {})
    tmpRemove = async () => {
      throw new Error('busy')
    }
    await expect(h['chats:remove'](d.id)).resolves.toBeUndefined()
    expect(fail).toHaveBeenCalledWith('removing chat temp folder failed:', expect.any(Error))
    fail.mockRestore()
  })

  it('app:mode returns the mode', async () => {
    expect(await h['app:mode']()).toBe('local')
  })

  it('chats:send accepts the nulls a browser sends for omitted attachmentIds and replyTo', async () => {
    // JSON turns the client's undefined arguments into null
    const c = await store.create('helper', dir)
    let failure: unknown = null
    const p = h['chats:send'](c.id, 'go', null, null).catch((e) => {
      failure = e
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(failure).toBeNull()
    svc.stop(c.id)
    await p
  })

  it('chats:send stores the message under the id the client picked; a malformed id is refused before anything runs', async () => {
    const c = await store.create('helper', dir)
    await expect(h['chats:send'](c.id, 'go', null, null, 'bad id!')).rejects.toThrow(/messageId/)
    expect(svc.isRunning(c.id)).toBe(false)
    const p = h['chats:send'](c.id, 'go', null, null, 'm-1')
    await new Promise((r) => setTimeout(r, 20))
    expect((await store.loadItems(c.id))[0]).toMatchObject({ type: 'user', id: 'm-1', text: 'go' })
    svc.stop(c.id)
    await p
  })

  describe('an asked chat is read-only', () => {
    const askedChat = async (): Promise<ChatMeta> => {
      const c = await store.create('helper', dir)
      await store.saveItems(c.id, [{ type: 'assistant', id: 'a1', text: 'hi', ts: 5 }] as ChatItem[])
      return (await store.update(c.id, { asked: { by: 'alpha', from: 'root', fromTitle: 'T', chain: ['alpha'] } }))!
    }
    const calls: [string, (c: ChatMeta) => unknown[]][] = [
      ['chats:send', (c) => [c.id, 'go', null, null]],
      ['chats:edit', (c) => [c.id, 'u1', 'go']],
      ['chats:resend', (c) => [c.id, 'u1']],
      ['chats:switchVersion', (c) => [c.id, 'u1', 0]],
      ['chats:compact', (c) => [c.id, '']],
      ['chats:fork', (c) => [c.id, 'a1']],
      ['chats:markUnread', (c) => [c.id, 'a1']],
      ['chats:setModel', (c) => [c.id, 'opus']],
      ['chats:setPermissionMode', (c) => [c.id, 'plan']],
      ['chats:allowBlocked', (c) => [c.id, 't1', ['git status'], 'chat']],
      ['chats:setEffort', (c) => [c.id, 'high']],
      ['chats:pause', (c) => [c.id]],
      ['chats:resume', (c) => [c.id]],
      ['chats:continueNow', (c) => [c.id]]
    ]
    it.each(calls)('%s rejects and runs nothing', async (name, args) => {
      const c = await askedChat()
      const submit = vi.spyOn(tasks, 'submit'),
        rerun = vi.spyOn(tasks, 'rerun'),
        compact = vi.spyOn(tasks, 'compact')
      const pause = vi.spyOn(tasks, 'pause'),
        resume = vi.spyOn(tasks, 'resumePaused')
      const ask = vi.spyOn(side, 'ask')
      await expect(h[name](...args(c))).rejects.toThrow('This chat is read-only')
      expect(svc.isRunning(c.id)).toBe(false)
      for (const spy of [submit, rerun, compact, pause, resume, ask]) expect(spy).not.toHaveBeenCalled()
      expect(await store.loadItems(c.id)).toHaveLength(1)
      expect(continued).toEqual([])
    })
    it('btw:ask is still taken, while chats:send on the same chat is refused', async () => {
      const c = await askedChat()
      const ask = vi.spyOn(side, 'ask')
      expect(await h['btw:ask'](c.id, 'why?', 'side')).toMatchObject({ id: 'side', question: 'why?', agent: 'helper' })
      expect(ask).toHaveBeenCalledWith(c.id, 'why?', 'side')
      await expect(h['chats:send'](c.id, 'go', null, null)).rejects.toThrow('This chat is read-only')
      expect(await store.loadItems(c.id)).toHaveLength(1)
    })
    it('btw:follow is still taken', async () => {
      const c = await askedChat()
      const follow = vi.spyOn(side, 'follow').mockResolvedValue({ id: 'next' } as never)
      expect(await h['btw:follow'](c.id, 'root', 'And?', 'next')).toEqual({ id: 'next' })
      expect(follow).toHaveBeenCalledWith(c.id, 'root', 'And?', 'next')
    })
  })

  it('chats:send resolves the command before queueing', async () => {
    const found = { agent: 'helper', name: 'check', prompt: 'Use check on L' }
    forSend.mockResolvedValueOnce(found)
    const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
    await h['chats:send']('c1', '/check L', null, null, 'm-1', { agent: 'helper', name: 'check' })
    expect(forSend).toHaveBeenCalledWith('c1', '/check L', { agent: 'helper', name: 'check' })
    expect(submit).toHaveBeenCalledWith('c1', '/check L', [], undefined, 'm-1', found)
  })

  it("chats:send splits /todo off before resolving: '/todo /my-day' resolves my-day and passes todo last", async () => {
    const found = { agent: 'helper', name: 'my-day', prompt: 'Plan' }
    forSend.mockResolvedValueOnce(found)
    const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
    await h['chats:send']('c1', '/todo /my-day', null, null, 'm-1', null)
    expect(forSend).toHaveBeenLastCalledWith('c1', '/my-day', undefined)
    expect(submit).toHaveBeenLastCalledWith('c1', '/todo /my-day', [], undefined, 'm-1', found, true)
  })

  it('chats:send: a plain /todo message passes todo with no command, a plain one passes no todo', async () => {
    const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
    await h['chats:send']('c1', '/todo plan my day', null, null, 'm-1', null)
    expect(forSend).toHaveBeenLastCalledWith('c1', 'plan my day', undefined)
    expect(submit).toHaveBeenLastCalledWith('c1', '/todo plan my day', [], undefined, 'm-1', undefined, true)
    await h['chats:send']('c1', '/todos x', null, null, 'm-2', null)
    expect(forSend).toHaveBeenLastCalledWith('c1', '/todos x', undefined)
    expect(submit).toHaveBeenLastCalledWith('c1', '/todos x', [], undefined, 'm-2', undefined)
  })

  it('chats:send: a flagged command sets todo by itself', async () => {
    const found = { agent: 'helper', name: 'day', prompt: 'Plan', todos: true }
    forSend.mockResolvedValueOnce(found)
    const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
    await h['chats:send']('c1', '/day', null, null, 'm-1', null)
    expect(submit).toHaveBeenLastCalledWith('c1', '/day', [], undefined, 'm-1', found, true)
  })

  it('edit reads /todo and a flagged command the same way, and resend passes nothing', async () => {
    const found = { agent: 'helper', name: 'day', prompt: 'Plan', todos: true }
    forRerun.mockResolvedValueOnce(undefined)
    const rerun = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined)
    await h['chats:edit']('c1', 'u1', '/todo plan')
    expect(forRerun).toHaveBeenLastCalledWith('c1', 'u1', '/todo plan', undefined)
    expect(rerun).toHaveBeenLastCalledWith('c1', 'u1', '/todo plan', undefined, true)
    forRerun.mockResolvedValueOnce(found)
    await h['chats:edit']('c1', 'u1', '/day')
    expect(rerun).toHaveBeenLastCalledWith('c1', 'u1', '/day', found, true)
    forRerun.mockResolvedValueOnce(found)
    await h['chats:resend']('c1', 'u1')
    expect(rerun).toHaveBeenLastCalledWith('c1', 'u1', null, found)
    await h['chats:edit']('c1', 'u1', 'plain words')
    expect(rerun).toHaveBeenLastCalledWith('c1', 'u1', 'plain words', undefined)
  })

  it('chats:send refuses a malformed pick and passes the resolver refusal on', async () => {
    const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
    await expect(h['chats:send']('c1', '/check', null, null, null, { agent: 1 })).rejects.toThrow('Invalid command')
    await expect(h['chats:send']('c1', '/check', null, null, null, 'x')).rejects.toThrow('Invalid command')
    forSend.mockRejectedValueOnce(new Error('Several members have /check'))
    await expect(h['chats:send']('c1', '/check', null, null, null, null)).rejects.toThrow('Several members have /check')
    expect(submit).not.toHaveBeenCalled()
    await h['chats:send']('c1', 'plain', null, null, null, null)
    expect(forSend).toHaveBeenLastCalledWith('c1', 'plain', undefined)
  })

  it('chats:send passes an engine pick on and refuses any other engine value', async () => {
    const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
    for (const engine of ['claude', 'codex'] as const) {
      await h['chats:send']('c1', '/goal x', null, null, null, { agent: 'a', name: 'goal', engine })
      expect(forSend).toHaveBeenLastCalledWith('c1', '/goal x', { agent: 'a', name: 'goal', engine })
    }
    await h['chats:send']('c1', '/check', null, null, null, { agent: 'a', name: 'check' })
    expect(forSend).toHaveBeenLastCalledWith('c1', '/check', { agent: 'a', name: 'check' })
    submit.mockClear()
    for (const engine of ['gemini', 1, null, true]) {
      await expect(h['chats:send']('c1', '/goal x', null, null, null, { agent: 'a', name: 'goal', engine })).rejects.toThrow('Invalid command')
    }
    expect(submit).not.toHaveBeenCalled()
  })

  describe("/todo and an agent without ZumiBot's tools", () => {
    const gem: AgentSummary = { ...alpha, filePath: '/agents/gem.md', name: 'gem', provider: 'acp' }
    const rem: AgentSummary = { ...alpha, filePath: '/agents/rem.md', name: 'rem', provider: 'ag-ui', remoteHost: 'agents.example.com' }
    const cx: AgentSummary = { ...alpha, filePath: '/agents/cx.md', name: 'cx', provider: 'codex' }
    beforeEach(() => {
      agentList.push(gem, rem, cx, { ...alpha, filePath: '/agents/beta.md', name: 'beta' })
    })

    it('chats:send refuses /todo for an ACP or AG-UI chat with the /todo sentence, before resolving or queueing anything', async () => {
      const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
      forSend.mockClear()
      for (const [name, engine] of [
        ['gem', 'acp'],
        ['rem', 'ag-ui']
      ] as const) {
        const c = await store.create(name, dir)
        await expect(h['chats:send'](c.id, '/todo plan my day', null, null, 'm-1', null)).rejects.toThrow(todoRefusal(engine, name))
        await expect(h['chats:send'](c.id, '/todo', null, null, 'm-1', null)).rejects.toThrow(todoRefusal(engine, name))
      }
      expect(submit).not.toHaveBeenCalled()
      expect(forSend).not.toHaveBeenCalled()
    })

    it('a command that makes to-dos is refused the same way, a plain message and a look-alike are not', async () => {
      const c = await store.create('gem', dir)
      const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
      forSend.mockResolvedValueOnce({ agent: 'gem', name: 'day', prompt: 'Plan', todos: true })
      await expect(h['chats:send'](c.id, '/day', null, null, 'm-1', null)).rejects.toThrow(todoRefusal('acp', 'gem'))
      expect(submit).not.toHaveBeenCalled()
      await h['chats:send'](c.id, 'plan my day', null, null, 'm-2', null)
      await h['chats:send'](c.id, '/todos x', null, null, 'm-3', null)
      expect(submit).toHaveBeenCalledTimes(2)
    })

    it('chats:edit refuses an edit that starts with /todo, and keeps editing it away', async () => {
      const c = await store.create('rem', dir)
      const rerun = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined)
      forRerun.mockResolvedValue(undefined)
      await expect(h['chats:edit'](c.id, 'u1', '/todo plan')).rejects.toThrow(todoRefusal('ag-ui', 'rem'))
      expect(rerun).not.toHaveBeenCalled()
      await h['chats:edit'](c.id, 'u1', 'plan')
      expect(rerun).toHaveBeenCalledOnce()
    })

    it('a room is refused while any member lacks the tools, and takes /todo when every member has them', async () => {
      const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
      const mixed = await store.createGroup(['alpha', 'gem'], dir, '')
      await expect(h['chats:send'](mixed.id, '/todo plan', null, null, 'm-1', null)).rejects.toThrow(todoRefusal('acp', 'gem'))
      expect(submit).not.toHaveBeenCalled()
      const fine = await store.createGroup(['alpha', 'beta'], dir, '')
      await h['chats:send'](fine.id, '/todo plan', null, null, 'm-2', null)
      expect(submit).toHaveBeenLastCalledWith(fine.id, '/todo plan', [], undefined, 'm-2', undefined, true)
    })

    it('Claude and Codex chats keep /todo exactly as before', async () => {
      const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
      for (const name of ['alpha', 'cx']) {
        const c = await store.create(name, dir)
        await h['chats:send'](c.id, '/todo plan my day', null, null, 'm-1', null)
        expect(submit).toHaveBeenLastCalledWith(c.id, '/todo plan my day', [], undefined, 'm-1', undefined, true)
      }
    })

    it('reads the bridges cap, not the engine: a Claude chat is refused when its cap is off', async () => {
      const hh = createHandlers({ ...handlerDeps, caps: (e) => ({ ...engineCaps(e), ...(e === 'claude' ? { bridges: false } : {}) }) })
      const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
      const c = await store.create('alpha', dir)
      await expect(hh['chats:send'](c.id, '/todo x', null, null, 'm-1', null)).rejects.toThrow(todoRefusal('claude', 'alpha'))
      expect(submit).not.toHaveBeenCalled()
    })
  })

  it('edit and resend resolve the command and pass it to rerun', async () => {
    const found = { agent: 'helper', name: 'check', prompt: 'Use check on L' }
    forRerun.mockResolvedValue(found)
    const rerun = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined)
    await h['chats:edit']('c1', 'u1', '/check L')
    expect(forRerun).toHaveBeenLastCalledWith('c1', 'u1', '/check L', undefined)
    expect(rerun).toHaveBeenLastCalledWith('c1', 'u1', '/check L', found)
    await h['chats:resend']('c1', 'u1')
    expect(forRerun).toHaveBeenLastCalledWith('c1', 'u1', null)
    expect(rerun).toHaveBeenLastCalledWith('c1', 'u1', null, found)
  })

  it('edit passes the editor menu pick to the resolver and refuses a malformed one', async () => {
    const found = { agent: 'rv', name: 'check', prompt: 'Review L' }
    forRerun.mockResolvedValue(found)
    const rerun = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined)
    await h['chats:edit']('c1', 'u1', '/check L', { agent: 'rv', name: 'check', extra: 1 })
    expect(forRerun).toHaveBeenLastCalledWith('c1', 'u1', '/check L', { agent: 'rv', name: 'check' })
    expect(rerun).toHaveBeenLastCalledWith('c1', 'u1', '/check L', found)
    await h['chats:edit']('c1', 'u1', '/check L', null)
    expect(forRerun).toHaveBeenLastCalledWith('c1', 'u1', '/check L', undefined)
    rerun.mockClear()
    await expect(h['chats:edit']('c1', 'u1', '/check L', { agent: 1 })).rejects.toThrow('Invalid command')
    await expect(h['chats:edit']('c1', 'u1', '/check L', 'x')).rejects.toThrow('Invalid command')
    expect(rerun).not.toHaveBeenCalled()
  })

  it('chats:send while the chat runs queues the message and resolves queued', async () => {
    const c = await store.create('helper', dir)
    const first = h['chats:send'](c.id, 'one', null, null)
    await new Promise((r) => setTimeout(r, 20))
    expect(await h['chats:send'](c.id, 'two', null, null)).toBe('queued')
    const queued = (await store.get(c.id))!.tasks![0]!
    expect(queued.text).toBe('two')
    await h['chats:dropTask'](c.id, queued.id) // else the run's end would send it into the removed dir
    svc.stop(c.id)
    await first
  })

  it('chats:dropTask removes a queued message; a bad taskId type is refused', async () => {
    const c = await store.create('helper', dir)
    const first = h['chats:send'](c.id, 'one', null, null)
    await new Promise((r) => setTimeout(r, 20))
    await h['chats:send'](c.id, 'two', null, null)
    const id = (await store.get(c.id))!.tasks![0]!.id
    await expect(h['chats:dropTask'](c.id, 5)).rejects.toThrow(/taskId must be a string/)
    await h['chats:dropTask'](c.id, id)
    expect((await store.get(c.id))!.tasks ?? []).toEqual([])
    svc.stop(c.id)
    await first
  })

  it('chats:sendTask sends a held task on an idle chat; a bad taskId type is refused', async () => {
    const c = await store.create('helper', dir)
    await store.addTask(c.id, { id: 'q1', text: 'held', ts: 1 })
    await expect(h['chats:sendTask'](c.id, 5)).rejects.toThrow(/taskId must be a string/)
    const p = h['chats:sendTask'](c.id, 'q1')
    await new Promise((r) => setTimeout(r, 20))
    expect(svc.isRunning(c.id)).toBe(true)
    expect((await store.loadItems(c.id))[0]).toMatchObject({ type: 'user', id: 'q1', text: 'held' })
    expect((await store.get(c.id))!.tasks ?? []).toEqual([])
    svc.stop(c.id)
    expect(await p).toBe('sent')
  })

  it('edit validates its arguments and calls rerun', async () => {
    const rerun = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined)
    await expect(h['chats:edit'](5, 'u1', 'x')).rejects.toThrow(/chatId must be a string/)
    await expect(h['chats:edit']('c1', null, 'x')).rejects.toThrow(/itemId must be a string/)
    await expect(h['chats:edit']('c1', 'u1', 7)).rejects.toThrow(/text must be a string/)
    expect(rerun).not.toHaveBeenCalled()
    await h['chats:edit']('c1', 'u1', 'new text')
    expect(rerun).toHaveBeenCalledWith('c1', 'u1', 'new text', undefined)
  })

  it('resend calls rerun with null', async () => {
    const rerun = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined)
    await expect(h['chats:resend']('c1', 3)).rejects.toThrow(/itemId must be a string/)
    await h['chats:resend']('c1', 'u1')
    expect(rerun).toHaveBeenCalledWith('c1', 'u1', null, undefined)
  })

  it('compact checks the note and the member, then goes through the queue', async () => {
    const compact = vi.spyOn(tasks, 'compact').mockResolvedValue(undefined)
    await expect(h['chats:compact'](5, '')).rejects.toThrow(/chatId must be a string/)
    await expect(h['chats:compact']('c1', 7)).rejects.toThrow(/note must be a string/)
    await expect(h['chats:compact']('c1', 'x'.repeat(COMPACT_NOTE_MAX + 1))).rejects.toThrow(
      `note must be at most ${COMPACT_NOTE_MAX} characters`
    )
    await expect(h['chats:compact']('c1', '', 3)).rejects.toThrow(/agent must be a string/)
    expect(compact).not.toHaveBeenCalled()
    await h['chats:compact']('c1', 'keep it', null)
    await h['chats:compact']('c2', '', 'wk')
    expect(compact.mock.calls).toEqual([
      ['c1', 'keep it', undefined],
      ['c2', '', 'wk']
    ])
  })

  it('pause and resume check the chat id, then go through the queue', async () => {
    const pause = vi.spyOn(tasks, 'pause').mockResolvedValue(undefined)
    const resume = vi.spyOn(tasks, 'resumePaused').mockResolvedValue(undefined)
    await expect(h['chats:pause'](5)).rejects.toThrow(/chatId must be a string/)
    await expect(h['chats:resume'](null)).rejects.toThrow(/chatId must be a string/)
    expect(pause).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    await h['chats:pause']('c1')
    await h['chats:resume']('c2')
    expect(pause.mock.calls).toEqual([['c1']])
    expect(resume.mock.calls).toEqual([['c2']])
  })

  it('pause on a server built without the pause hook is refused with a clear message, and the chat runs on', async () => {
    vi.spyOn(svc, 'canPause').mockResolvedValue(false)
    const c = await store.create('helper', dir)
    const first = h['chats:send'](c.id, 'go', null, null)
    await new Promise((r) => setTimeout(r, 20))
    await expect(h['chats:pause'](c.id)).rejects.toThrow('Pause is unavailable: the pause hook is missing from this build')
    expect(await store.get(c.id)).not.toHaveProperty('pause')
    expect(svc.isRunning(c.id)).toBe(true)
    svc.stop(c.id)
    await first
  })

  it('pause lands when the reply ends, then resume sends Continue; an idle or unpaused chat is refused', async () => {
    const c = await store.create('helper', dir)
    await expect(h['chats:pause'](c.id)).rejects.toThrow('Chat is not running')
    await expect(h['chats:resume'](c.id)).rejects.toThrow('Chat is not paused')
    const first = h['chats:send'](c.id, 'go', null, null)
    await new Promise((r) => setTimeout(r, 20))
    await h['chats:pause'](c.id)
    expect(await store.get(c.id)).toMatchObject({ pause: 'pausing', held: true })
    svc.stop(c.id) // a Stop while pausing still ends paused
    await first
    expect(await store.get(c.id)).toMatchObject({ pause: 'paused', inFlight: false })
    expect((await store.loadItems(c.id)).at(-1)).toMatchObject({ type: 'notice', kind: 'userPaused' })
    const resumed = h['chats:resume'](c.id)
    await new Promise((r) => setTimeout(r, 20))
    expect(svc.isRunning(c.id)).toBe(true)
    const meta = (await store.get(c.id))!
    expect(meta.pause).toBeUndefined()
    expect(meta.held).toBeUndefined()
    expect((await store.loadItems(c.id)).filter((i) => i.type === 'user').at(-1)).toMatchObject({ text: RESUME_TEXT })
    svc.stop(c.id)
    await resumed
  })

  it('setModel checks the chat id and the model type, and passes a pick or null on', async () => {
    const set = vi.spyOn(svc, 'setModel').mockResolvedValue(undefined)
    await expect(h['chats:setModel'](5, 'opus')).rejects.toThrow(/chatId must be a string/)
    await expect(h['chats:setModel']('c1', 7)).rejects.toThrow(TypeError)
    await expect(h['chats:setModel']('c1', undefined)).rejects.toThrow(TypeError)
    await h['chats:setModel']('c1', 'haiku')
    await h['chats:setModel']('c1', null)
    expect(set.mock.calls).toEqual([
      ['c1', 'haiku'],
      ['c1', null]
    ])
  })

  it('setPermissionMode passes a chat mode or null on, and refuses auto and the modes that skip approvals', async () => {
    const set = vi.spyOn(svc, 'setPermissionMode').mockResolvedValue(undefined)
    await expect(h['chats:setPermissionMode'](5, 'plan')).rejects.toThrow(/chatId must be a string/)
    for (const bad of ['auto', 'bypassPermissions', 'dontAsk', 7, undefined])
      await expect(h['chats:setPermissionMode']('c1', bad)).rejects.toThrow(TypeError)
    await h['chats:setPermissionMode']('c1', 'plan')
    await h['chats:setPermissionMode']('c1', null)
    expect(set.mock.calls).toEqual([
      ['c1', 'plan'],
      ['c1', null]
    ])
  })

  it('allowBlocked checks its arguments and returns the text without the agent', async () => {
    const allow = vi.spyOn(svc, 'allowBlocked').mockResolvedValue({ rules: ['Bash(git status:*)'], text: 'go', agent: 'helper' })
    await expect(h['chats:allowBlocked'](5, 't1', ['git status'], 'chat')).rejects.toThrow(/chatId must be a string/)
    await expect(h['chats:allowBlocked']('c1', 7, ['git status'], 'chat')).rejects.toThrow(TypeError)
    await expect(h['chats:allowBlocked']('c1', 't1', 'git status', 'chat')).rejects.toThrow(TypeError)
    await expect(h['chats:allowBlocked']('c1', 't1', ['git status'], 'all')).rejects.toThrow(TypeError)
    expect(allow).not.toHaveBeenCalled()
    expect(await h['chats:allowBlocked']('c1', 't1', ['git status'], 'agent')).toEqual({ rules: ['Bash(git status:*)'], text: 'go' })
    expect(allow).toHaveBeenCalledWith('c1', 't1', ['git status'], 'agent')
    expect(approvalsTold.at(-1)).toBe('helper')
  })

  it('setEffort passes an effort level or null on, and refuses anything else', async () => {
    const set = vi.spyOn(svc, 'setEffort').mockResolvedValue(undefined)
    await expect(h['chats:setEffort'](5, 'max')).rejects.toThrow(/chatId must be a string/)
    for (const bad of ['minimal', 'High', 7, undefined]) await expect(h['chats:setEffort']('c1', bad)).rejects.toThrow(TypeError)
    await h['chats:setEffort']('c1', 'max')
    await h['chats:setEffort']('c1', null)
    expect(set.mock.calls).toEqual([
      ['c1', 'max'],
      ['c1', null]
    ])
  })

  it("cancelResume checks the chat id and ends the chat's usage limit wait", async () => {
    await expect(h['chats:cancelResume'](5)).rejects.toThrow(/chatId must be a string/)
    await h['chats:cancelResume']('c1')
    expect(cancelled).toEqual(['c1'])
  })

  it("continueNow checks the chat id and sends the chat's usage limit continue", async () => {
    await expect(h['chats:continueNow'](5)).rejects.toThrow(/chatId must be a string/)
    const c = await store.create('alpha', dir)
    await h['chats:continueNow'](c.id)
    expect(continued).toEqual([c.id])
  })

  it("switchVersion rejects -1, 1.5 and '2'", async () => {
    const sw = vi.spyOn(tasks, 'switchVersion').mockResolvedValue(undefined)
    for (const bad of [-1, 1.5, '2', null, NaN]) {
      await expect(h['chats:switchVersion']('c1', 'u1', bad)).rejects.toThrow(/index must be a non-negative integer/)
    }
    expect(sw).not.toHaveBeenCalled()
    await h['chats:switchVersion']('c1', 'u1', 2)
    expect(sw).toHaveBeenCalledWith('c1', 'u1', 2)
  })

  it("fork broadcasts the new chat's meta", async () => {
    const c = await store.create('helper', dir)
    await store.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'yo', ts: 2 }
    ] as ChatItem[])
    const r = (await h['chats:fork'](c.id, 'a1')) as { chat: { id: string; title: string }; draft: unknown }
    expect(r.chat.id).not.toBe(c.id)
    expect(r.draft).toBeNull()
    expect(pushed).toEqual([{ chatId: r.chat.id, kind: 'meta', meta: r.chat }])
    expect(await store.loadItems(r.chat.id)).toHaveLength(2)
    await expect(h['chats:fork'](c.id, 'nope')).rejects.toThrow(/Message not found/)
    expect(pushed).toHaveLength(1)
  })

  describe('ACP agents and the caps they lack', () => {
    const gem: AgentSummary = { ...alpha, filePath: '/agents/gem.md', name: 'gem', provider: 'acp' }
    beforeEach(() => {
      agentList.push(gem, { ...alpha, filePath: '/agents/beta.md', name: 'beta' })
    })

    it("chats:edit, chats:resend, chats:switchVersion and chats:fork refuse an ACP chat with the engine's sentence and touch nothing", async () => {
      const c = await store.create('gem', dir)
      const rerun = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined),
        sw = vi.spyOn(tasks, 'switchVersion').mockResolvedValue(undefined)
      await expect(h['chats:edit'](c.id, 'u1', 'new text')).rejects.toThrow(capRefusal('acp', 'resend'))
      await expect(h['chats:resend'](c.id, 'u1')).rejects.toThrow(capRefusal('acp', 'resend'))
      await expect(h['chats:switchVersion'](c.id, 'u1', 1)).rejects.toThrow(capRefusal('acp', 'resend'))
      await expect(h['chats:fork'](c.id, 'a1')).rejects.toThrow(capRefusal('acp', 'fork'))
      expect(rerun).not.toHaveBeenCalled()
      expect(sw).not.toHaveBeenCalled()
      expect(pushed).toEqual([])
      expect(await store.list()).toHaveLength(1)
    })

    it('the same calls still reach the queue for a Claude chat', async () => {
      const c = await store.create('alpha', dir)
      await store.saveItems(c.id, [
        { type: 'user', id: 'u1', text: 'hi', ts: 1 },
        { type: 'assistant', id: 'a1', text: 'yo', ts: 2 }
      ] as ChatItem[])
      const rerun = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined),
        sw = vi.spyOn(tasks, 'switchVersion').mockResolvedValue(undefined)
      await h['chats:resend'](c.id, 'u1')
      await h['chats:switchVersion'](c.id, 'u1', 0)
      await h['chats:fork'](c.id, 'a1')
      expect(rerun).toHaveBeenCalledOnce()
      expect(sw).toHaveBeenCalledOnce()
    })

    it('in a room every member must have resend and fork, like pause', async () => {
      const mixed = await store.createGroup(['alpha', 'gem'], dir, '')
      const rerun0 = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined),
        sw0 = vi.spyOn(tasks, 'switchVersion').mockResolvedValue(undefined)
      await expect(h['chats:edit'](mixed.id, 'u1', 'new text')).rejects.toThrow(capRefusal('acp', 'resend'))
      await expect(h['chats:resend'](mixed.id, 'u1')).rejects.toThrow(capRefusal('acp', 'resend'))
      await expect(h['chats:switchVersion'](mixed.id, 'u1', 0)).rejects.toThrow(capRefusal('acp', 'resend'))
      await expect(h['chats:fork'](mixed.id, 'a1')).rejects.toThrow(capRefusal('acp', 'fork'))
      expect(rerun0).not.toHaveBeenCalled()
      expect(sw0).not.toHaveBeenCalled()
      rerun0.mockClear()
      const claudes = await store.createGroup(['alpha', 'beta'], dir, '')
      const rerun = vi.spyOn(tasks, 'rerun').mockResolvedValue(undefined)
      await h['chats:resend'](claudes.id, 'u1')
      expect(rerun).toHaveBeenCalledOnce()
    })

    it('reads the caps, not the engine: a Claude chat is refused when its resend cap is off', async () => {
      const hh = createHandlers({ ...handlerDeps, caps: (e) => ({ ...engineCaps(e), ...(e === 'claude' ? { resend: false } : {}) }) })
      const c = await store.create('alpha', dir)
      await expect(hh['chats:resend'](c.id, 'u1')).rejects.toThrow(capRefusal('claude', 'resend'))
    })

    it('agents:save refuses a dailySpendCap on an ACP agent with the fixed sentence, before anything is written', async () => {
      const saveSpy = vi.fn(async () => saveResult)
      const hl = createHandlers({ ...handlerDeps, agents: { ...handlerDeps.agents, save: saveSpy } as unknown as HandlerDeps['agents'] })
      const raw = (provider: string, cap: string) => `---\nname: gem\ndescription: Gemini\n${provider}${cap}---\nYou help.\n`
      const acp = 'provider: acp\nacp:\n  command: gemini\n  args: ["--acp"]\n'
      expect(await hl['agents:save'](null, raw(acp, 'dailySpendCap: 5\n'))).toEqual({ ok: false, error: spendCapRefusal('acp', 'gem') })
      expect(saveSpy).not.toHaveBeenCalled()
      // No cap on it, or a cap on an agent whose engine reports a cost, saves as before.
      await hl['agents:save'](null, raw(acp, ''))
      await hl['agents:save'](null, raw('', 'dailySpendCap: 5\n'))
      await hl['agents:save'](null, raw('provider: codex\n', 'dailySpendCap: 5\n'))
      expect(saveSpy).toHaveBeenCalledTimes(3)
    })

    it('chats:setModel refuses a model for an ACP chat (no models cap) before it is stored, and still takes one for Claude', async () => {
      const acpSvc = new ChatService({
        store,
        files: handlerDeps.attachments,
        locate: async () => '/bin/claude',
        run: () => {
          throw new Error('no run')
        },
        push: () => {},
        now: () => 1000,
        newId: () => 'x',
        permissionMode: 'manual',
        disallowedToolsFor: () => [],
        engineOf: async (agent) => (agent === 'gem' ? 'acp' : 'claude')
      })
      const hh = createHandlers({ ...handlerDeps, chatService: acpSvc })
      const c = await store.create('gem', dir)
      await expect(hh['chats:setModel'](c.id, 'opus')).rejects.toThrow(MODEL_REFUSED)
      await expect(hh['chats:setModel'](c.id, 'gpt-5')).rejects.toThrow(MODEL_REFUSED)
      expect((await store.get(c.id))?.model).toBeUndefined()
      const a = await store.create('alpha', dir)
      await hh['chats:setModel'](a.id, 'opus')
      expect((await store.get(a.id))?.model).toBe('opus')
    })

    describe('a spend cap on a routine or workflow', () => {
      const routine = (o: Partial<RoutineInput> = {}): RoutineInput => ({
        id: null,
        name: 'Daily',
        enabled: true,
        timeZone: 'UTC',
        trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
        target: { kind: 'new-chat', agent: 'gem', cwd: '/work' },
        prompt: 'Go',
        limitPolicy: 'wait',
        missedPolicy: 'run-once',
        sessionPolicy: 'continue',
        command: null,
        ...o
      })
      const T: Step = { id: 't', handle: 'start', name: 'Start', x: 0, y: 0, kind: 'trigger' }
      const step = (agent: string): Step => ({
        id: 'a',
        handle: 'agent',
        name: 'Agent',
        x: 400,
        y: 0,
        kind: 'agent',
        agent,
        prompt: 'Go',
        cwd: '/w'
      })
      const flow = (agent: string, o: Partial<WorkflowInput> = {}): WorkflowInput => ({
        id: null,
        name: 'Flow',
        enabled: false,
        timeZone: 'UTC',
        trigger: { kind: 'manual' },
        steps: [T, step(agent)],
        edges: [{ id: 'e1', from: 't', port: 'out', to: 'a' }],
        ...o
      })

      it('routines:save refuses a spendCap whose agent has no cost, and saves it without the cap, or for another engine', async () => {
        await expect(h['routines:save'](routine({ spendCap: 5 }))).rejects.toThrow(spendCapRefusal('acp', 'gem'))
        expect(await routineStore.list()).toEqual([])
        expect(routinesTold).toBe(0)
        await h['routines:save'](routine())
        await h['routines:save'](routine({ target: { kind: 'new-chat', agent: 'beta', cwd: '/work' }, spendCap: 5 }))
        expect(await routineStore.list()).toHaveLength(2)
      })

      it("routines:save judges every room member, and an existing chat's agent", async () => {
        const group: RoutineTarget = { kind: 'new-group', members: ['alpha', 'gem'], role: '', cwd: '/work' }
        await expect(h['routines:save'](routine({ target: group, spendCap: 5 }))).rejects.toThrow(spendCapRefusal('acp', 'gem'))
        const chat = await store.create('gem', dir)
        await expect(h['routines:save'](routine({ target: { kind: 'chat', chatId: chat.id }, spendCap: 5 }))).rejects.toThrow(
          spendCapRefusal('acp', 'gem')
        )
        expect(await routineStore.list()).toEqual([])
      })

      it('workflows:save refuses a spendCap whose Agent step has no cost, and saves the same workflow without it', async () => {
        await expect(h['workflows:save'](flow('gem', { spendCap: 2 }))).rejects.toThrow(spendCapRefusal('acp', 'gem'))
        expect(await workflowStore.list()).toEqual([])
        expect(workflowsTold).toBe(0)
        await h['workflows:save'](flow('gem'))
        await h['workflows:save'](flow('beta', { spendCap: 2 }))
        expect(await workflowStore.list()).toHaveLength(2)
      })
    })
  })

  describe('Codex agents', () => {
    const cx: AgentSummary = { ...alpha, filePath: '/agents/cx.md', name: 'cx', provider: 'codex' }
    beforeEach(() => {
      agentList.push(cx, { ...alpha, filePath: '/agents/beta.md', name: 'beta' })
    })

    it('btw:ask and btw:follow take a Codex chat like any other', async () => {
      const c = await store.create('cx', dir)
      const ask = vi.spyOn(side, 'ask').mockResolvedValue({ id: 'side' } as never)
      const follow = vi.spyOn(side, 'follow').mockResolvedValue({ id: 'next' } as never)
      expect(await h['btw:ask'](c.id, 'why?', 'side')).toEqual({ id: 'side' })
      expect(await h['btw:follow'](c.id, 'root', 'and?', 'next')).toEqual({ id: 'next' })
      expect(ask).toHaveBeenCalledWith(c.id, 'why?', 'side')
      expect(follow).toHaveBeenCalledWith(c.id, 'root', 'and?', 'next')
    })

    it('btw:ask is still taken for a Claude chat', async () => {
      const c = await store.create('alpha', dir)
      const ask = vi.spyOn(side, 'ask').mockResolvedValue({ id: 'side' } as never)
      await h['btw:ask'](c.id, 'why?', 'side')
      expect(ask).toHaveBeenCalled()
    })

    it('chats:pause and chats:compact reach the queue for a Codex chat', async () => {
      const c = await store.create('cx', dir)
      const compact = vi.spyOn(tasks, 'compact').mockResolvedValue(undefined),
        pause = vi.spyOn(tasks, 'pause').mockResolvedValue(undefined)
      await h['chats:compact'](c.id, '')
      await h['chats:pause'](c.id)
      expect(compact).toHaveBeenCalledOnce()
      expect(pause).toHaveBeenCalledWith(c.id)
    })

    it('with the pause cap off for Codex (a later probe failed), chats:pause refuses a Codex chat with the Phase 1 sentence and touches no queue', async () => {
      const hh = createHandlers({ ...handlerDeps, caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { pause: false } : {}) }) })
      const c = await store.create('cx', dir)
      const pause = vi.spyOn(tasks, 'pause').mockResolvedValue(undefined)
      await expect(hh['chats:pause'](c.id)).rejects.toThrow(CODEX_REFUSALS.pause)
      expect(pause).not.toHaveBeenCalled()
      // A Claude chat on the same server still pauses.
      const a = await store.create('alpha', dir)
      await hh['chats:pause'](a.id)
      expect(pause).toHaveBeenCalledWith(a.id)
    })

    it('with btw and compact off for Codex (a later probe failed), their RPCs refuse a Codex chat with the Phase 1 sentences and touch nothing', async () => {
      const hh = createHandlers({
        ...handlerDeps,
        caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { btw: false, compact: false } : {}) })
      })
      const c = await store.create('cx', dir)
      const ask = vi.spyOn(side, 'ask').mockResolvedValue({ id: 'side' } as never)
      const follow = vi.spyOn(side, 'follow').mockResolvedValue({ id: 'next' } as never)
      const compact = vi.spyOn(tasks, 'compact').mockResolvedValue(undefined)
      await expect(hh['btw:ask'](c.id, 'why?', 'side')).rejects.toThrow(CODEX_REFUSALS.btw)
      await expect(hh['btw:follow'](c.id, 'root', 'and?', 'next')).rejects.toThrow(CODEX_REFUSALS.btw)
      await expect(hh['chats:compact'](c.id, '')).rejects.toThrow(CODEX_REFUSALS.compact)
      expect(ask).not.toHaveBeenCalled()
      expect(follow).not.toHaveBeenCalled()
      expect(compact).not.toHaveBeenCalled()
      // A Claude chat on the same server is untouched.
      const a = await store.create('alpha', dir)
      await hh['btw:ask'](a.id, 'why?', 'side2')
      await hh['chats:compact'](a.id, '')
      expect(ask).toHaveBeenCalledOnce()
      expect(compact).toHaveBeenCalledOnce()
    })

    it('chats:compact and chats:pause still reach the queue for a Claude chat', async () => {
      const c = await store.create('alpha', dir)
      const compact = vi.spyOn(tasks, 'compact').mockResolvedValue(undefined)
      const pause = vi.spyOn(tasks, 'pause').mockResolvedValue(undefined)
      await h['chats:compact'](c.id, '')
      await h['chats:pause'](c.id)
      expect(compact).toHaveBeenCalledOnce()
      expect(pause).toHaveBeenCalledOnce()
    })

    // A later probe turning Codex rooms off: every room refusal comes back.
    const noRooms = (e: Engine) => ({ ...engineCaps(e), ...(e === 'codex' ? { rooms: false } : {}) })

    describe('chats:createVoice', () => {
      const voiceHandlers = () => createHandlers(handlerDeps)
      beforeEach(() => {
        agentList.push(
          { ...alpha, filePath: '/agents/codex-agent.md', name: 'codex-agent', provider: 'codex' },
          { ...alpha, filePath: '/agents/zumi-bot.md', name: 'zumi-bot' }
        )
      })

      it('makes a voice chat titled by day, in the folder the new-chat screen would open', async () => {
        await settings.setLastFolder('alpha', dir)
        const chat = (await voiceHandlers()['chats:createVoice']('Alpha')) as ChatMeta
        expect(chat).toMatchObject({
          agentName: 'alpha',
          cwd: dir,
          voice: true,
          title: expect.stringMatching(/^Voice · [A-Z][a-z]{2} \d{1,2}$/)
        })
        expect(await store.get(chat.id)).toMatchObject({ voice: true })
      })

      it('falls back to home when the agent has no saved folder', async () => {
        const chat = (await voiceHandlers()['chats:createVoice']('alpha')) as ChatMeta
        expect(chat.cwd).toBe(home)
      })

      it('makes a voice chat for a Codex agent too', async () => {
        const chat = (await voiceHandlers()['chats:createVoice']('Codex Agent')) as ChatMeta
        expect(chat).toMatchObject({ agentName: 'codex-agent', voice: true })
      })

      it('refuses a remote agent as an unknown one, by file name or display name, and makes no chat', async () => {
        agentList.push({
          ...alpha,
          filePath: '/agents/remote-bot.md',
          name: 'remote-bot',
          provider: 'ag-ui',
          remoteHost: 'agents.example.com'
        })
        const hh = voiceHandlers()
        await expect(hh['chats:createVoice']('remote-bot')).rejects.toThrow('No agent named remote-bot')
        await expect(hh['chats:createVoice']('Remote Bot')).rejects.toThrow('No agent named Remote Bot')
        expect((await store.list()).filter((c) => c.voice)).toEqual([])
        // Reads the cap, not the engine name.
        const open = createHandlers({ ...handlerDeps, caps: (e) => ({ ...engineCaps(e), remote: false }) })
        expect(await open['chats:createVoice']('remote-bot')).toMatchObject({ agentName: 'remote-bot', voice: true })
      })

      it('refuses Zumi Bot, a broken agent, an unknown one and a non-string', async () => {
        const hh = voiceHandlers()
        await expect(hh['chats:createVoice']('Zumi Bot')).rejects.toThrow(/Zumi Bot/)
        await expect(hh['chats:createVoice']('broken')).rejects.toThrow(/broken|Unknown|find/i)
        await expect(hh['chats:createVoice']('nobody')).rejects.toThrow(/nobody|Unknown|find/i)
        await expect(hh['chats:createVoice'](7)).rejects.toThrow(TypeError)
        expect((await store.list()).filter((c) => c.voice)).toEqual([])
      })
    })

    it('chats:createGroup, chats:setMembers and chats:cloneRoom take a Codex member', async () => {
      const room = (await h['chats:createGroup'](['alpha', 'cx'], dir, '')) as ChatMeta
      expect(room.group?.members).toEqual(['alpha', 'cx'])
      const setMembers = vi.fn(async () => room)
      const hh = createHandlers({
        ...handlerDeps,
        groupService: { renameAgent: () => {}, setMembers } as unknown as HandlerDeps['groupService']
      })
      await hh['chats:setMembers'](room.id, ['alpha', 'beta', 'cx'])
      expect(setMembers).toHaveBeenCalledWith(room.id, ['alpha', 'beta', 'cx'])
      const clone = (await h['chats:cloneRoom'](room.id, 'Next', null)) as ChatMeta
      expect(clone.group?.members).toEqual(['alpha', 'cx'])
    })

    it('with Codex rooms off, chats:createGroup refuses a Codex member and creates nothing', async () => {
      const hh = createHandlers({ ...handlerDeps, caps: noRooms })
      const before = (await store.list()).length
      await expect(hh['chats:createGroup'](['alpha', 'cx'], dir, '')).rejects.toThrow(CODEX_REFUSALS.room('cx'))
      expect((await store.list()).length).toBe(before)
    })

    it('with Codex rooms off, chats:setMembers refuses a Codex member before the room service', async () => {
      const room = await store.createGroup(['alpha', 'beta'], dir, '')
      const setMembers = vi.fn(async () => room)
      handlerDeps.groupService = { renameAgent: () => {}, setMembers } as unknown as HandlerDeps['groupService']
      const hh = createHandlers({ ...handlerDeps, caps: noRooms })
      await expect(hh['chats:setMembers'](room.id, ['alpha', 'cx'])).rejects.toThrow(CODEX_REFUSALS.room('cx'))
      expect(setMembers).not.toHaveBeenCalled()
      await hh['chats:setMembers'](room.id, ['alpha', 'beta'])
      expect(setMembers).toHaveBeenCalledOnce()
    })

    it('with Codex rooms off, chats:cloneRoom refuses a room that holds an agent now on Codex', async () => {
      const hh = createHandlers({ ...handlerDeps, caps: noRooms })
      const room = await store.createGroup(['alpha', 'cx'], dir, '')
      const before = (await store.list()).length
      await expect(hh['chats:cloneRoom'](room.id, 'Next', null)).rejects.toThrow(CODEX_REFUSALS.room('cx'))
      expect((await store.list()).length).toBe(before)
    })

    it("in a room, Compact is judged by the member it names and Pause by every member's engine", async () => {
      const hh = createHandlers({
        ...handlerDeps,
        caps: (e) => ({ ...engineCaps(e), ...(e === 'codex' ? { compact: false, pause: false } : {}) })
      })
      const room = await store.createGroup(['alpha', 'cx'], dir, '')
      const compact = vi.spyOn(tasks, 'compact').mockResolvedValue(undefined),
        pause = vi.spyOn(tasks, 'pause').mockResolvedValue(undefined)
      await expect(hh['chats:compact'](room.id, '', 'cx')).rejects.toThrow(CODEX_REFUSALS.compact)
      await hh['chats:compact'](room.id, '', 'alpha')
      expect(compact).toHaveBeenCalledExactlyOnceWith(room.id, '', 'alpha')
      // One Pause stops every member, so a member whose engine can't pause refuses it for the room.
      await expect(hh['chats:pause'](room.id)).rejects.toThrow(CODEX_REFUSALS.pause)
      expect(pause).not.toHaveBeenCalled()
      const claudeRoom = await store.createGroup(['alpha', 'beta'], dir, '')
      await hh['chats:pause'](claudeRoom.id)
      expect(pause).toHaveBeenCalledWith(claudeRoom.id)
      // With every cap on, both reach the queue for the Codex member too.
      await h['chats:compact'](room.id, '', 'cx')
      await h['chats:pause'](room.id)
      expect(compact).toHaveBeenLastCalledWith(room.id, '', 'cx')
      expect(pause).toHaveBeenLastCalledWith(room.id)
    })

    it('agents:codexInfo answers through the provider', async () => {
      expect(await h['agents:codexInfo']()).toEqual({ found: true, models: ['gpt-x'] })
    })
  })

  describe('room clone', () => {
    const makeRoom = async () => store.createGroup(['alpha', 'beta'], dir, 'review')

    it('summarizeRoom and cancelSummary validate chatId and call through', async () => {
      expect(await h['chats:summarizeRoom']('c1')).toBe('draft')
      await h['chats:cancelSummary']('c1')
      expect(summaryCalls).toEqual(['summarize:c1', 'cancel:c1'])
      await expect(h['chats:summarizeRoom'](5)).rejects.toThrow(/chatId must be a string/)
      await expect(h['chats:cancelSummary'](null)).rejects.toThrow(/chatId must be a string/)
      expect(summaryCalls).toHaveLength(2)
    })

    it('cloneRoom trims the title, accepts a null handoff and broadcasts the new meta once', async () => {
      const room = await makeRoom()
      const meta = (await h['chats:cloneRoom'](room.id, '  Next  ', null)) as ChatMeta
      expect(meta.id).not.toBe(room.id)
      expect(meta.title).toBe('Next')
      expect(meta.group?.handoff).toBeUndefined()
      expect(pushed).toEqual([{ chatId: meta.id, kind: 'meta', meta }])
    })

    it('cloneRoom keeps a handoff', async () => {
      const room = await makeRoom()
      const meta = (await h['chats:cloneRoom'](room.id, 'Next', 'where we left off')) as ChatMeta
      expect(meta.group?.handoff?.text).toBe('where we left off')
      expect(pushed).toHaveLength(1)
    })

    it('cloneRoom rejects a bad title and creates nothing', async () => {
      const room = await makeRoom()
      const before = (await store.list()).length
      for (const bad of ['', '   ', 'x'.repeat(CLONE_TITLE_MAX + 1), 5, null, undefined]) {
        await expect(h['chats:cloneRoom'](room.id, bad, null), String(bad).slice(0, 10)).rejects.toThrow(/title/)
      }
      await expect(h['chats:cloneRoom'](room.id, 'x'.repeat(CLONE_TITLE_MAX), null)).resolves.toBeTruthy()
      expect((await store.list()).length).toBe(before + 1)
    })

    it('cloneRoom rejects a bad handoff and creates nothing', async () => {
      const room = await makeRoom()
      const before = (await store.list()).length
      for (const bad of ['', '  \n ', 'x'.repeat(HANDOFF_MAX_CHARS + 1), 7, undefined, {}]) {
        await expect(h['chats:cloneRoom'](room.id, 'Next', bad), String(bad).slice(0, 10)).rejects.toThrow(/handoff/)
      }
      expect((await store.list()).length).toBe(before)
      expect(pushed).toHaveLength(0)
      await expect(h['chats:cloneRoom'](room.id, 'Next', 'x'.repeat(HANDOFF_MAX_CHARS))).resolves.toBeTruthy()
    })
  })

  it('markUnread marks from just before an agent message and broadcasts the meta', async () => {
    const c = await store.create('helper', dir)
    await store.saveItems(c.id, [
      { type: 'user', id: 'u1', text: 'hi', ts: 1 },
      { type: 'assistant', id: 'a1', text: 'yo', ts: 2 }
    ] as ChatItem[])
    const meta = (await h['chats:markUnread'](c.id, 'a1')) as ChatMeta
    expect(meta.mark).toEqual({ at: 7000, from: 1 })
    expect(pushed).toEqual([{ chatId: c.id, kind: 'meta', meta }])
  })

  it("markUnread refuses the user's own message, an unknown one and a bad id", async () => {
    const c = await store.create('helper', dir)
    await store.saveItems(c.id, [{ type: 'user', id: 'u1', text: 'hi', ts: 1 }] as ChatItem[])
    await expect(h['chats:markUnread'](c.id, 'u1')).rejects.toThrow(/Message not found/)
    await expect(h['chats:markUnread'](c.id, 'nope')).rejects.toThrow(/Message not found/)
    await expect(h['chats:markUnread'](c.id, 5)).rejects.toThrow(/itemId/)
    await expect(h['chats:markUnread']('gone', 'u1')).rejects.toThrow(/Message not found/)
    expect(pushed).toEqual([])
    expect((await store.get(c.id))!.mark).toBeUndefined()
  })

  it('archive takes a chat out of the list and back, broadcasting the meta', async () => {
    const c = await store.create('helper', dir)
    const off = (await h['chats:archive'](c.id, true)) as ChatMeta
    expect(isArchived(off)).toBe(true)
    expect(off.updatedAt).toBe(c.updatedAt) // the sidebar order is left alone
    expect(pushed).toEqual([{ chatId: c.id, kind: 'meta', meta: off }])
    // Again is a no-op, not a new time.
    expect(((await h['chats:archive'](c.id, true)) as ChatMeta).archivedAt).toBe(off.archivedAt)
    const back = (await h['chats:archive'](c.id, false)) as ChatMeta
    expect(isArchived(back)).toBe(false)
    expect(await store.get(c.id)).toEqual(back)
  })

  it('archive refuses a running chat, an unknown one and bad args', async () => {
    const c = await store.create('helper', dir)
    await store.update(c.id, { inFlight: true })
    await expect(h['chats:archive'](c.id, true)).rejects.toThrow(ARCHIVE_RUNNING)
    await expect(h['chats:archive']('gone', true)).rejects.toThrow(/Chat not found/)
    await expect(h['chats:archive'](c.id, 'yes')).rejects.toThrow(/on/)
    await expect(h['chats:archive'](5, true)).rejects.toThrow(/chatId/)
    expect(pushed).toEqual([])
    expect(isArchived((await store.get(c.id))!)).toBe(false)
  })

  it('chats:answer accepts the null a browser sends for an omitted agent', async () => {
    const c = await store.create('helper', dir)
    const p = svc.send(c.id, 'go')
    await vi.waitFor(async () => expect((await store.loadItems(c.id)).some((i: ChatItem) => i.type === 'approval')).toBe(true))
    await h['chats:answer'](c.id, 'r1', 'allow-once', null)
    expect(sent).toHaveLength(1)
    svc.stop(c.id)
    await p
  })

  it('chats:answerQuestions rejects answers that are not an object or null', async () => {
    const c = await store.create('helper', dir)
    await expect(h['chats:answerQuestions'](c.id, 'r1', 'B')).rejects.toThrow(TypeError)
    await expect(h['chats:answerQuestions'](c.id, 'r1', ['B'])).rejects.toThrow(TypeError)
  })

  it('chats:answerQuestions accepts null answers and a null agent', async () => {
    const c = await store.create('helper', dir)
    await expect(h['chats:answerQuestions'](c.id, 'r1', null, null)).resolves.toBeUndefined()
  })

  it('chats:answerPlan checks its arguments', async () => {
    const c = await store.create('helper', dir)
    await expect(h['chats:answerPlan'](c.id, 'r1', 'yes')).rejects.toThrow(TypeError)
    await expect(h['chats:answerPlan'](c.id, 'r1', 1)).rejects.toThrow(TypeError)
    await expect(h['chats:answerPlan'](c.id, 'r1', false, 5)).rejects.toThrow(TypeError)
    await expect(h['chats:answerPlan'](c.id, 7, true)).rejects.toThrow(TypeError)
    await expect(h['chats:answerPlan'](c.id, 'r1', true, null, 3)).rejects.toThrow(TypeError)
  })

  it('chats:answerPlan accepts a missing or null feedback and agent', async () => {
    const c = await store.create('helper', dir)
    await expect(h['chats:answerPlan'](c.id, 'r1', true)).resolves.toBeUndefined()
    await expect(h['chats:answerPlan'](c.id, 'r1', false, null, null)).resolves.toBeUndefined()
  })

  it('answering an approval twice is harmless', async () => {
    const c = await store.create('helper', dir)
    const p = svc.send(c.id, 'go')
    const status = async () =>
      (await store.loadItems(c.id)).filter((i: ChatItem) => i.type === 'approval').map((i) => (i as { status: string }).status)
    // Answered once the card waits, not after a fixed sleep: on a loaded runner the request had not come in yet.
    await vi.waitFor(async () => expect(await status()).toEqual(['pending']))
    let second: Promise<unknown> | undefined
    await h['chats:answer'](c.id, 'r1', 'allow-once')
    expect(() => {
      second = h['chats:answer'](c.id, 'r1', 'deny')
    }).not.toThrow()
    await second!.catch((e) => expect(e).toBeInstanceOf(Error))
    expect(sent).toHaveLength(1)
    svc.stop(c.id)
    await p
    expect(await status()).toEqual(['allowed-once'])
  })

  describe('routines', () => {
    const input = (o: Partial<RoutineInput> = {}): RoutineInput => ({
      id: null,
      name: 'Daily',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } },
      target: { kind: 'new-chat', agent: 'alpha', cwd: '/work' },
      prompt: 'Go',
      limitPolicy: 'wait',
      missedPolicy: 'run-once',
      sessionPolicy: 'continue',
      command: null,
      ...o
    })
    const call: WebhookCall = { method: 'POST', query: {}, body: { a: 1 }, receivedAt: 7 }

    it('routines:history and routines:version list and give back the saved versions', async () => {
      let n = 0
      const routineHistory = new HistoryStore<RoutineDef>(join(dir, 'history', 'routines'), {
        newId: () => `v${++n}`,
        now: () => 100 + n,
        label: 'routines'
      })
      const hh = createHandlers({ ...handlerDeps, routineHistory })
      const r = (await hh['routines:save'](input())) as Routine
      await hh['routines:save'](input({ id: r.id, prompt: 'Go now' }))
      const list = (await hh['routines:history'](r.id)) as VersionSummary[]
      expect(list.map((v) => [v.current, v.changes])).toEqual([
        [true, ['Prompt changed']],
        [false, []]
      ])
      expect(((await hh['routines:version'](r.id, list[1]!.id)) as RoutineDef).prompt).toBe('Go')
      await expect(hh['routines:history']('nope')).rejects.toThrow('Routine not found')
      await expect(hh['routines:version'](r.id, 'gone')).rejects.toThrow('That version is no longer kept')
      // Without a history store the list is empty.
      expect(await h['routines:history'](r.id)).toEqual([])
    })

    it('routines:save of a schedule routine sets nextRunAt, rearms and broadcasts', async () => {
      const r = (await h['routines:save'](input())) as Routine
      expect(r.nextRunAt).toBeGreaterThan(Date.now() - 1)
      expect(await routineStore.get(r.id)).toEqual(r)
      expect(rearmed).toBe(1)
      expect(routinesTold).toBe(1)
    })

    it('routines:save stores the limit and missed policies, on a new routine and an edit', async () => {
      const r = (await h['routines:save'](input({ limitPolicy: 'skip' }))) as Routine
      expect(r).toMatchObject({ limitPolicy: 'skip', missedPolicy: 'run-once' })
      const edited = (await h['routines:save'](input({ id: r.id, missedPolicy: 'skip' }))) as Routine
      expect(await routineStore.get(r.id)).toMatchObject({ limitPolicy: 'wait', missedPolicy: 'skip', nextRunAt: edited.nextRunAt })
    })

    it('routines:save stores the session policy', async () => {
      const r = (await h['routines:save'](input({ target: { kind: 'chat', chatId: 'c1' }, sessionPolicy: 'fresh' }))) as Routine
      expect(await routineStore.get(r.id)).toMatchObject({ sessionPolicy: 'fresh' })
    })

    it('routines:save keeps a command pick only while the prompt starts with its name, and an edit can drop it', async () => {
      const command = { agent: 'alpha', name: 'check' }
      const r = (await h['routines:save'](input({ prompt: '/check today', command }))) as Routine
      expect(await routineStore.get(r.id)).toMatchObject({ command })
      await h['routines:save'](input({ id: r.id, prompt: '/check today', command: null }))
      expect(await routineStore.get(r.id)).not.toHaveProperty('command')
      const stale = (await h['routines:save'](input({ prompt: '/fix today', command }))) as Routine
      expect(stale).not.toHaveProperty('command')
      // A page from before routines took commands sends no command field at all.
      const { command: _gone, ...old } = input({ prompt: '/check today' })
      expect(await h['routines:save'](old)).not.toHaveProperty('command')
    })

    it('routines:save refuses Zumi Bot as a new group member, like chats:createGroup', async () => {
      const target: RoutineTarget = { kind: 'new-group', members: ['alpha', 'zumi-bot'], role: '', cwd: '/work' }
      await expect(h['routines:save'](input({ target }))).rejects.toThrow("Zumi Bot can't join a group chat")
      expect(await routineStore.list()).toEqual([])
    })

    it('keeps nextRunAt of an existing routine unless the schedule, zone or enabled flag changed', async () => {
      const r = (await h['routines:save'](input())) as Routine
      await routineStore.put({ ...r, nextRunAt: 123 })
      const same = (await h['routines:save'](input({ id: r.id, name: 'Renamed' }))) as Routine
      expect(same).toMatchObject({ name: 'Renamed', nextRunAt: 123, createdAt: r.createdAt })
      const off = (await h['routines:save'](input({ id: r.id, enabled: false }))) as Routine
      expect(off.nextRunAt).toBeNull()
      const on = (await h['routines:setEnabled'](r.id, true)) as Routine
      expect(on.enabled).toBe(true)
      expect(on.nextRunAt).toBeGreaterThan(123)
    })

    it('a webhook save without a test call rejects; with one it saves with sample = latest and clears the draft', async () => {
      const webhook = { kind: 'webhook', sample: null } as const
      await expect(h['routines:save'](input({ trigger: webhook }))).rejects.toThrow('Webhook needs a test call before saving')
      const draft = (await h['routines:draftWebhook']()) as { id: string }
      await expect(h['routines:save'](input({ id: draft.id, trigger: webhook }))).rejects.toThrow('Webhook needs a test call before saving')
      await routineStore.putHook({ ...(await routineStore.hook(draft.id))!, latest: call })
      const r = (await h['routines:save'](input({ id: draft.id, trigger: webhook }))) as Routine
      expect(r.trigger).toEqual({ kind: 'webhook', sample: call })
      expect(r.nextRunAt).toBeNull()
      expect((await routineStore.hook(draft.id))?.draftAt).toBeNull()
      expect((await routineStore.hook(draft.id))?.latest).toEqual(call)
    })

    it('a webhook save keeps its condition', async () => {
      const draft = (await h['routines:draftWebhook']()) as { id: string }
      await routineStore.putHook({ ...(await routineStore.hook(draft.id))!, latest: call })
      const r = (await h['routines:save'](
        input({ id: draft.id, trigger: { kind: 'webhook', sample: null, condition: ' the build failed ' } })
      )) as Routine
      expect(r.trigger).toEqual({ kind: 'webhook', sample: call, condition: 'the build failed' })
    })

    it('routines:list carries no secret', async () => {
      const draft = (await h['routines:draftWebhook']()) as { id: string; secret: string }
      await routineStore.putHook({ ...(await routineStore.hook(draft.id))!, latest: call })
      await h['routines:save'](input({ id: draft.id, trigger: { kind: 'webhook', sample: null } }))
      const text = JSON.stringify(await h['routines:list']())
      expect(text).not.toContain(draft.secret)
      expect(text).not.toContain('secret')
    })

    it('routines:webhook returns hookUrl(id), makes a secret once, and newSecret rotates it', async () => {
      const r = (await h['routines:save'](input())) as Routine
      const a = (await h['routines:webhook'](r.id)) as { url: string; secret: string; latest: unknown }
      expect(a.url).toBe(`http://x/hooks/${r.id}`)
      expect(a.latest).toBeNull()
      expect(a.secret.length).toBeGreaterThanOrEqual(32)
      expect(((await h['routines:webhook'](r.id)) as { secret: string }).secret).toBe(a.secret)
      const fresh = (await h['routines:newSecret'](r.id)) as string
      expect(fresh).not.toBe(a.secret)
      expect(((await h['routines:webhook'](r.id)) as { secret: string }).secret).toBe(fresh)
      await expect(h['routines:webhook']('nope')).rejects.toThrow('Routine not found')
      await expect(h['routines:newSecret']('nope')).rejects.toThrow('Routine not found')
    })

    it("dropDraft removes a draft hook but never a saved routine's hook", async () => {
      const draft = (await h['routines:draftWebhook']()) as { id: string }
      await h['routines:dropDraft'](draft.id)
      expect(await routineStore.hook(draft.id)).toBeNull()
      const r = (await h['routines:save'](input())) as Routine
      await h['routines:webhook'](r.id)
      await h['routines:dropDraft'](r.id)
      expect(await routineStore.hook(r.id)).not.toBeNull()
    })

    it('routines:runNow calls the runner with manual; remove drops the routine and rearms', async () => {
      const r = (await h['routines:save'](input())) as Routine
      const spy = vi.spyOn(runner, 'run')
      const run = (await h['routines:runNow'](r.id)) as { routineId: string }
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: r.id }), 'manual')
      expect(run.routineId).toBe(r.id)
      await expect(h['routines:runNow']('nope')).rejects.toThrow('Routine not found')
      const before = rearmed
      await h['routines:remove'](r.id)
      expect(await routineStore.get(r.id)).toBeNull()
      expect(rearmed).toBe(before + 1)
      await expect(h['routines:save'](5)).rejects.toThrow()
      await expect(h['routines:remove'](5)).rejects.toThrow(/id must be a string/)
    })

    it('routines:duplicate adds an off copy named "<name> (n)" with the same settings, no runs, and broadcasts', async () => {
      const command = { agent: 'alpha', name: 'check' }
      const r = (await h['routines:save'](input({ prompt: '/check today', command, limitPolicy: 'skip', missedPolicy: 'skip' }))) as Routine
      expect(r.nextRunAt).toBeGreaterThan(0)
      await runner.run(r, 'manual')
      const [before, told] = [rearmed, routinesTold]
      const copy = (await h['routines:duplicate'](r.id)) as Routine
      expect(copy.id).not.toBe(r.id)
      // Off, so its schedule never fires beside the source's; nothing to rearm.
      expect(copy).toMatchObject({
        name: 'Daily (2)',
        enabled: false,
        nextRunAt: null,
        timeZone: 'UTC',
        trigger: r.trigger,
        target: r.target,
        prompt: '/check today',
        command,
        limitPolicy: 'skip',
        missedPolicy: 'skip',
        sessionPolicy: 'continue'
      })
      expect(copy.createdAt).toBeGreaterThanOrEqual(r.createdAt)
      expect(await routineStore.get(copy.id)).toEqual(copy)
      expect(await routineStore.get(r.id)).toEqual(r)
      expect((await routineStore.runs())[r.id]).toHaveLength(1)
      expect((await routineStore.runs())[copy.id]).toBeUndefined()
      expect([rearmed, routinesTold]).toEqual([before, told + 1])
      // A copy of a copy, and a second copy of the source, take the next free number.
      expect(((await h['routines:duplicate'](copy.id)) as Routine).name).toBe('Daily (3)')
      expect(((await h['routines:duplicate'](r.id)) as Routine).name).toBe('Daily (4)')
      await expect(h['routines:duplicate']('nope')).rejects.toThrow(/^Routine not found$/)
      await expect(h['routines:duplicate'](5)).rejects.toThrow(/id must be a string/)
    })

    it('a webhook routine copy gets its own URL and secret, carrying the latest call as its sample, and saves again', async () => {
      const draft = (await h['routines:draftWebhook']()) as { id: string; secret: string }
      await routineStore.putHook({ ...(await routineStore.hook(draft.id))!, latest: call })
      const r = (await h['routines:save'](
        input({ id: draft.id, trigger: { kind: 'webhook', sample: null, condition: 'it failed' } })
      )) as Routine
      const newer: WebhookCall = { ...call, body: { a: 2 }, receivedAt: 8 }
      await routineStore.recordCall(r.id, draft.secret, newer)
      const copy = (await h['routines:duplicate'](r.id)) as Routine
      expect(copy.trigger).toEqual({ kind: 'webhook', sample: newer, condition: 'it failed' })
      const hook = await routineStore.hook(copy.id)
      expect(hook).toMatchObject({ latest: newer, draftAt: null })
      expect(hook!.secret).not.toBe(draft.secret)
      expect(hook!.secret.length).toBeGreaterThanOrEqual(32)
      const theirs = (await h['routines:webhook'](copy.id)) as { url: string; secret: string; latest: unknown }
      expect(theirs).toEqual({ url: `http://x/hooks/${copy.id}`, secret: hook!.secret, latest: newer })
      expect((await routineStore.hook(r.id))?.secret).toBe(draft.secret) // the source keeps its own
      // The copy's editor saves it as any webhook routine: its own hook holds the call a save needs.
      const resaved = (await h['routines:save'](
        input({ id: copy.id, name: copy.name, enabled: false, trigger: { kind: 'webhook', sample: null } })
      )) as Routine
      expect(resaved.trigger).toEqual({ kind: 'webhook', sample: newer })
      // A source whose hook is gone still copies with its saved sample, so the copy can be saved again.
      await routineStore.dropHook(r.id)
      const bare = (await h['routines:duplicate'](r.id)) as Routine
      expect(bare.trigger).toMatchObject({ kind: 'webhook', sample: call })
      expect((await routineStore.hook(bare.id))?.latest).toEqual(call)
    })

    it('an agent rename keeps the routine and its running run attached', async () => {
      const r = (await h['routines:save'](input({ trigger: { kind: 'manual' } }))) as Routine
      const run = await runner.run(r, 'manual')
      const chatId = run.chatId!
      await store.saveItems(chatId, [
        { type: 'user', id: run.messageId!, text: 'Go', ts: 1 },
        { type: 'assistant', id: 'a1', text: 'ok', ts: 2 }
      ])
      const before = routinesTold
      saveResult = { ok: true, name: 'alpha2', renamedFrom: 'alpha' }
      await h['agents:save']('/a/alpha.md', 'raw')
      expect((await routineStore.get(r.id))?.target).toMatchObject({ kind: 'new-chat', agent: 'alpha2' })
      expect(routinesTold).toBeGreaterThan(before)
      runner.chatIdle(chatId)
      await vi.waitFor(async () => expect((await routineStore.runs())[r.id]?.[0]?.status).toBe('done'))
    })

    it('chats:remove tells the runner; chats:dropTask tells it only when a queued task was removed', async () => {
      const gone = vi.spyOn(runner, 'chatRemoved')
      const dropped = vi.spyOn(runner, 'taskDropped')
      const c = await store.create('a', '/tmp')
      await h['chats:dropTask'](c.id, 'missing')
      expect(dropped).not.toHaveBeenCalled()
      await store.addTask(c.id, { id: 't1', text: 'x', ts: 1 })
      await h['chats:dropTask'](c.id, 't1')
      expect(dropped).toHaveBeenCalledWith(c.id, 't1')
      await h['chats:remove'](c.id)
      expect(gone).toHaveBeenCalledWith(c.id)
    })

    it('a hook made for a saved routine carries draftAt, and save clears it', async () => {
      const r = (await h['routines:save'](input())) as Routine
      await h['routines:webhook'](r.id)
      expect((await routineStore.hook(r.id))?.draftAt).not.toBeNull() // swept after 24h if a racing remove orphans it
      await h['routines:save'](input({ id: r.id }))
      expect((await routineStore.hook(r.id))?.draftAt).toBeNull()
    })

    it('an agent rename follows into the talk settings and tells the pages', async () => {
      await voiceStore.set({ talk: { defaultAgent: 'old', aliases: { old: ['x'] } } })
      saveResult = { ok: true, name: 'new', renamedFrom: 'old' }
      await h['agents:save']('/a/old.md', 'raw')
      const talk = (await voiceStore.status()).talk
      expect(talk.defaultAgent).toBe('new')
      expect(talk.aliases).toEqual({ new: ['x'] })
      expect(voiceTold).toHaveLength(1)
      expect(voiceTold[0].talk.defaultAgent).toBe('new')
    })

    it('a talk-settings failure is logged and neither skips the routines nor rejects agents:save', async () => {
      vi.spyOn(voiceStore, 'renameAgent').mockRejectedValue(new Error('disk'))
      const routines = vi.spyOn(routineStore, 'renameAgent')
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      saveResult = { ok: true, name: 'new', renamedFrom: 'old' }
      await expect(h['agents:save']('/a/old.md', 'raw')).resolves.toMatchObject({ ok: true })
      expect(routines).toHaveBeenCalledWith('old', 'new')
      expect(err).toHaveBeenCalled()
      err.mockRestore()
    })

    it('a routines-store failure does not skip the other renames or reject agents:save', async () => {
      vi.spyOn(routineStore, 'renameAgent').mockRejectedValue(new Error('disk'))
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      await settings.setLastFolder('old', '/x')
      saveResult = { ok: true, name: 'new', renamedFrom: 'old' }
      await expect(h['agents:save']('/a/old.md', 'raw')).resolves.toMatchObject({ ok: true })
      expect((await settings.get()).lastFolderByAgent['new']).toBe('/x')
      err.mockRestore()
    })
  })

  describe('workflows', () => {
    const T: Step = { id: 't', handle: 'start', name: 'Start', x: 0, y: 0, kind: 'trigger' }
    const L: Step = { id: 'l', handle: 'sum', name: 'Sum', x: 200, y: 0, kind: 'llm', prompt: 'Sum up {{input}}', model: 'haiku' }
    const A: Step = { id: 'a', handle: 'agent', name: 'Agent', x: 400, y: 0, kind: 'agent', agent: 'alpha', prompt: 'Go', cwd: '/w' }
    const wfInput = (o: Partial<WorkflowInput> = {}): WorkflowInput => ({
      id: null,
      name: 'Flow',
      enabled: false,
      timeZone: 'UTC',
      trigger: { kind: 'manual' },
      steps: [T, L],
      edges: [{ id: 'e1', from: 't', port: 'out', to: 'l' }],
      ...o
    })
    const daily: WorkflowInput['trigger'] = { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] } }
    const call: WebhookCall = { method: 'POST', query: {}, body: { a: 1 }, receivedAt: 7 }
    const save = async (o: Partial<WorkflowInput> = {}): Promise<Workflow> => (await h['workflows:save'](wfInput(o))) as Workflow

    describe('history', () => {
      let hh: Handlers
      beforeEach(() => {
        let n = 0
        const workflowHistory = new HistoryStore<WorkflowDef>(join(dir, 'history', 'workflows'), {
          newId: () => `v${++n}`,
          now: () => 100 + n,
          label: 'workflows'
        })
        hh = createHandlers({ ...handlerDeps, workflowHistory })
      })

      it('lists versions newest first with their changes, gives one back, and marks a restored save', async () => {
        const w = (await hh['workflows:save'](wfInput())) as Workflow
        await hh['workflows:save']({ ...wfInput(), id: w.id, name: 'Renamed' })
        const list = (await hh['workflows:history'](w.id)) as VersionSummary[]
        expect(list.map((v) => [v.source, v.current, v.changes])).toEqual([
          ['editor', true, ['Renamed']],
          ['editor', false, []]
        ])
        const old = (await hh['workflows:version'](w.id, list[1]!.id)) as WorkflowDef
        expect(old.name).toBe('Flow')
        await hh['workflows:save']({ ...wfInput(), id: w.id }, { restoredFrom: list[1]!.savedAt })
        expect(((await hh['workflows:history'](w.id)) as VersionSummary[])[0]).toMatchObject({
          source: 'restore',
          restoredFrom: list[1]!.savedAt,
          current: true
        })
      })

      it('refuses an unknown workflow, an unknown version and a bad meta', async () => {
        await expect(hh['workflows:history']('nope')).rejects.toThrow('Workflow not found')
        const w = (await hh['workflows:save'](wfInput())) as Workflow
        await expect(hh['workflows:version'](w.id, 'gone')).rejects.toThrow('That version is no longer kept')
        await expect(hh['workflows:version']('../x', 'v1')).rejects.toThrow(TypeError)
        await expect(hh['workflows:save'](wfInput(), { restoredFrom: 'x' })).rejects.toThrow(TypeError)
        await expect(hh['workflows:save'](wfInput(), [1])).rejects.toThrow(TypeError)
      })
    })

    it('workflows:save rejects bad kinds and oversized prompt with Invalid workflow', async () => {
      const bad: unknown[] = [
        5,
        null,
        'x',
        { ...wfInput(), name: 7 },
        { ...wfInput(), name: '' },
        { ...wfInput(), timeZone: 'Mars/Base' },
        wfInput({ steps: [T, { ...L, kind: 'shell' } as unknown as Step] }),
        wfInput({ steps: [T, { ...L, prompt: 'x'.repeat(SAVED_TEXT_MAX + 1) }] }),
        wfInput({ steps: [T, { ...L, model: 'gpt' } as unknown as Step] }),
        wfInput({ steps: [T, { ...L, x: Number.NaN }] }),
        wfInput({ steps: [T, { ...L, y: Number.POSITIVE_INFINITY }] }),
        wfInput({ steps: [T, { ...L, id: 'has space' }], edges: [] }),
        wfInput({ steps: [T, { ...L, id: 't' }], edges: [] }), // two steps with one id
        wfInput({ steps: [T, { ...L, handle: 'Not A Handle' }] }),
        wfInput({ steps: [T, { id: 'w', handle: 'w', name: 'W', x: 0, y: 0, kind: 'wait', minutes: '5' } as unknown as Step], edges: [] }),
        wfInput({ edges: [{ id: 'e1', from: 't', port: 'yes', to: 'l' }] }), // a trigger has no yes port
        wfInput({ edges: [{ id: 'e1', from: 't', port: 'out', to: 'nope' }] }),
        wfInput({
          edges: [
            { id: 'e1', from: 't', port: 'out', to: 'l' },
            { id: 'e1', from: 't', port: 'out', to: 'l' }
          ]
        }),
        wfInput({ trigger: { kind: 'cron' } as unknown as WorkflowInput['trigger'] }),
        wfInput({
          trigger: { kind: 'webhook', sample: null, filters: [{ field: 'body.a', equals: 1 }] } as unknown as WorkflowInput['trigger']
        }),
        wfInput({ id: '../x' }),
        // Names an Object.prototype member: run state keeps plain objects keyed by these ids.
        ...['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'].flatMap((name) => [
          wfInput({ id: name }),
          wfInput({ steps: [T, { ...L, id: name }], edges: [{ id: 'e1', from: 't', port: 'out', to: name }] }),
          wfInput({ edges: [{ id: name, from: 't', port: 'out', to: 'l' }] })
        ])
      ]
      for (const raw of bad)
        await expect(h['workflows:save'](raw), JSON.stringify(raw)?.slice(0, 120)).rejects.toThrow(/^Invalid workflow$/)
      expect(await workflowStore.list()).toEqual([])
      expect(workflowsTold).toBe(0)
    })

    it("workflows:save keeps a foreach step's agent, prompt, folder and model", async () => {
      const F: Step = {
        id: 'f',
        handle: 'each',
        name: 'Each',
        x: 400,
        y: 0,
        kind: 'foreach',
        agent: 'alpha',
        prompt: 'Do {{item}}',
        cwd: '/w',
        model: 'sonnet'
      }
      const w = await save({ steps: [T, F], edges: [{ id: 'e1', from: 't', port: 'out', to: 'f' }] })
      expect(w.steps[1]).toEqual(F)
      expect((await workflowStore.get(w.id))!.steps[1]).toEqual(F)
    })

    it('workflows:save refuses a foreach step without a prompt string', async () => {
      const F = { id: 'f', handle: 'each', name: 'Each', x: 400, y: 0, kind: 'foreach', agent: 'alpha', cwd: '/w' }
      await expect(h['workflows:save'](wfInput({ steps: [T, F as unknown as Step], edges: [] }))).rejects.toThrow(/^Invalid workflow$/)
      await expect(h['workflows:save'](wfInput({ steps: [T, { ...F, prompt: 5 } as unknown as Step], edges: [] }))).rejects.toThrow(
        /^Invalid workflow$/
      )
    })

    it('workflows:save always saves, sets nextRunAt like routines, rearms and broadcasts', async () => {
      // Half-drawn: an empty prompt, a dangling step and a prompt over its cap are problems, never a refusal.
      const w = await save({ steps: [T, { ...L, prompt: '' }, { ...A, prompt: 'p'.repeat(25_000) }] })
      expect(w).toMatchObject({ name: 'Flow', enabled: false, nextRunAt: null, trigger: { kind: 'manual' } })
      expect(await workflowStore.get(w.id)).toEqual(w)
      expect([wfRearmed, workflowsTold]).toEqual([1, 1])
      const on = await save({ id: w.id, enabled: true, trigger: daily })
      expect(on.nextRunAt).toBeGreaterThan(0)
      expect(on.createdAt).toBe(w.createdAt)
      await workflowStore.update(w.id, (cur) => ({ ...cur, nextRunAt: 42 })) // the scheduler moved it meanwhile
      expect((await save({ id: w.id, enabled: true, trigger: daily, name: 'Other' })).nextRunAt).toBe(42)
      expect((await save({ id: w.id, enabled: false, trigger: daily })).nextRunAt).toBeNull()
      expect([wfRearmed, workflowsTold]).toEqual([4, 4])
    })

    it('workflows:save keeps notes, and workflows:duplicate copies them with the same ids', async () => {
      const note = { id: 'n1', x: 5, y: 6, width: 240, height: 160, color: 3, text: '## Hi' } as const
      const w = await save({ notes: [note] })
      expect(w.notes).toEqual([note])
      expect(((await h['workflows:list']()) as { workflows: Workflow[] }).workflows.find((x) => x.id === w.id)?.notes).toEqual([note])
      expect(((await h['workflows:duplicate'](w.id)) as Workflow).notes).toEqual([note])
      expect((await save({ id: w.id })).notes).toEqual([]) // a save without notes clears them
    })

    describe('groups', () => {
      // t -> a -> b -> c -> d
      const step = (id: string): Step => ({ ...L, id, handle: id, name: id })
      const chain = {
        steps: [T, step('a'), step('b'), step('c'), step('d')],
        edges: [
          ['t', 'a'],
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'd']
        ].map(([from, to]) => ({ id: `${from}${to}`, from: from!, port: 'out' as const, to: to! }))
      }
      const ok = { id: 'ok', name: 'OK', steps: ['b', 'c'], notes: [] }

      it('workflows:save keeps a valid group and drops a broken one, still saving the rest', async () => {
        const bad = { id: 'bad', name: 'Bad', description: 'd', steps: ['a', 'd'], notes: [] } // a and d are not connected
        const w = await save({ ...chain, name: 'Kept', groups: [ok, bad] })
        expect(w.groups).toEqual([ok])
        expect(w).toMatchObject({ name: 'Kept' })
        expect(w.steps).toHaveLength(5)
        expect(await workflowStore.get(w.id)).toEqual(w)
        expect((await save({ ...chain, id: w.id })).groups).toEqual([]) // a save without groups clears them
        expect((await save({ ...chain, id: w.id, groups: [{ ...ok, steps: ['c'] }] })).groups).toEqual([]) // one step alone is too few
      })

      it('workflows:save refuses a group whose members do not exist, with Invalid workflow', async () => {
        await expect(h['workflows:save'](wfInput({ ...chain, groups: [{ ...ok, steps: ['b', 'zz'] }] }))).rejects.toThrow(
          /^Invalid workflow$/
        )
      })

      it('workflows:duplicate copies groups', async () => {
        const w = await save({ ...chain, groups: [ok] })
        expect(((await h['workflows:duplicate'](w.id)) as Workflow).groups).toEqual([ok])
      })
    })

    it('a save with an id that no longer exists is refused, so a stale tab cannot bring a deleted workflow back', async () => {
      const w = await save()
      await h['workflows:remove'](w.id)
      const told = workflowsTold
      await expect(h['workflows:save'](wfInput({ id: w.id, name: 'Back' }))).rejects.toThrow(/^Workflow not found$/)
      await expect(h['workflows:save'](wfInput({ id: 'never-saved' }))).rejects.toThrow(/^Workflow not found$/)
      expect(await workflowStore.list()).toEqual([])
      expect(workflowsTold).toBe(told)
    })

    it('ids named like Object.prototype members are refused wherever a workflow, run, visit or step id is taken', async () => {
      const w = await save()
      const draft = wfInput({ id: w.id })
      for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
        for (const call of [
          () => h['workflows:getRun'](name),
          () => h['workflows:remove'](name),
          () => h['workflows:setEnabled'](name, false),
          () => h['workflows:run'](name),
          () => h['workflows:stop'](name),
          () => h['workflows:retry'](name, 'v1'),
          () => h['workflows:retry']('r1', name),
          () => h['workflows:approve'](name, 'v1', true),
          () => h['workflows:approve']('r1', name, true),
          () => h['workflows:testStep'](draft, name, ''),
          () => h['workflows:webhook'](name),
          () => h['workflows:newSecret'](name),
          () => h['workflows:duplicate'](name)
        ])
          await expect(call(), name).rejects.toThrow(TypeError)
      }
      for (const m of [wfRunner.stopAllOf, wfRunner.run, wfRunner.stopRun, wfRunner.retry, wfRunner.approve, wfRunner.testStep])
        expect(m).not.toHaveBeenCalled()
    })

    it('workflows:duplicate adds an off copy named "<name> (n)" with the same steps, no runs, and broadcasts', async () => {
      const w = await save({
        enabled: true,
        trigger: daily,
        steps: [T, L, A],
        edges: [
          { id: 'e1', from: 't', port: 'out', to: 'l' },
          { id: 'e2', from: 'l', port: 'out', to: 'a' }
        ]
      })
      expect(w.nextRunAt).toBeGreaterThan(0)
      await workflowStore.addRun({
        id: 'run1',
        workflowId: w.id,
        via: 'manual',
        late: false,
        status: 'done',
        snapshot: { steps: w.steps, edges: w.edges },
        visits: [],
        inbox: {},
        allowance: { perStep: {}, total: 200 },
        halted: false,
        startedAt: 1
      })
      const [rearmed, told] = [wfRearmed, workflowsTold]
      const copy = (await h['workflows:duplicate'](w.id)) as Workflow
      expect(copy.id).not.toBe(w.id)
      // Off, so its schedule never fires beside the source's; nothing to rearm.
      expect(copy).toMatchObject({
        name: 'Flow (2)',
        enabled: false,
        nextRunAt: null,
        timeZone: 'UTC',
        trigger: daily,
        steps: w.steps,
        edges: w.edges
      })
      expect(copy.createdAt).toBeGreaterThanOrEqual(w.createdAt)
      expect(await workflowStore.get(copy.id)).toEqual(copy)
      expect(await workflowStore.get(w.id)).toEqual(w)
      expect((await workflowStore.runs())[copy.id]).toBeUndefined()
      expect([wfRearmed, workflowsTold]).toEqual([rearmed, told + 1])
      // A copy of a copy, and a second copy of the source, take the next free number.
      expect(((await h['workflows:duplicate'](copy.id)) as Workflow).name).toBe('Flow (3)')
      expect(((await h['workflows:duplicate'](w.id)) as Workflow).name).toBe('Flow (4)')
      await expect(h['workflows:duplicate']('nope')).rejects.toThrow(/^Workflow not found$/)
      await expect(h['workflows:duplicate'](5)).rejects.toThrow(TypeError)
    })

    it('a webhook workflow copy gets its own URL and secret, carrying the latest call as its sample', async () => {
      const w = await save({ trigger: { kind: 'webhook', sample: null, filters: [{ field: 'body.a', equals: '1' }] } })
      const { secret } = (await h['workflows:webhook'](w.id)) as { secret: string }
      await workflowStore.hooks.recordCall(w.id, secret, call)
      const saved = await save({ id: w.id, trigger: { kind: 'webhook', sample: null, filters: [{ field: 'body.a', equals: '1' }] } })
      const copy = (await h['workflows:duplicate'](w.id)) as Workflow
      expect(copy.trigger).toEqual(saved.trigger)
      const hook = await workflowStore.hooks.hook(copy.id)
      expect(hook).toMatchObject({ latest: call, draftAt: null })
      expect(hook!.secret).not.toBe(secret)
      expect(hook!.secret.length).toBeGreaterThanOrEqual(32)
      const theirs = (await h['workflows:webhook'](copy.id)) as { url: string; secret: string; latest: unknown }
      expect(theirs).toEqual({ url: `http://x/hooks/${copy.id}`, secret: hook!.secret, latest: call })
      expect((await workflowStore.hooks.hook(w.id))?.secret).toBe(secret) // the source keeps its own
      // A webhook workflow that never got a call: no hook yet; opening the copy's editor makes one as for any workflow.
      const bare = await save({ name: 'Bare', trigger: { kind: 'webhook', sample: null, filters: [] } })
      const bareCopy = (await h['workflows:duplicate'](bare.id)) as Workflow
      expect(bareCopy.trigger).toEqual({ kind: 'webhook', sample: null, filters: [] })
      expect(await workflowStore.hooks.hook(bareCopy.id)).toBeNull()
    })

    it('a save never turns a workflow with problems on; one already on stays on', async () => {
      wfProblems = [{ stepId: 'l', text: 'Write a prompt' }]
      const w = await save({ enabled: true })
      expect(w.enabled).toBe(false)
      wfProblems = []
      expect((await save({ id: w.id, enabled: true })).enabled).toBe(true)
      wfProblems = [{ stepId: 'l', text: 'Write a prompt' }]
      expect((await save({ id: w.id, enabled: true })).enabled).toBe(true)
    })

    it('workflows:setEnabled refuses to turn on a workflow with problems, with the run text', async () => {
      const w = await save({ trigger: daily })
      wfProblems = [{ stepId: 'l', text: 'Write a prompt' }]
      await expect(h['workflows:setEnabled'](w.id, true)).rejects.toThrow(PROBLEMS_TEXT)
      expect((await workflowStore.get(w.id))?.enabled).toBe(false)
      wfProblems = []
      const on = (await h['workflows:setEnabled'](w.id, true)) as Workflow
      expect(on.enabled).toBe(true)
      expect(on.nextRunAt).toBeGreaterThan(0)
      wfProblems = [{ stepId: 'l', text: 'Write a prompt' }]
      const off = (await h['workflows:setEnabled'](w.id, false)) as Workflow // off always works
      expect([off.enabled, off.nextRunAt]).toEqual([false, null])
      await expect(h['workflows:setEnabled']('nope', false)).rejects.toThrow('Workflow not found')
      await expect(h['workflows:setEnabled'](w.id, 'yes')).rejects.toThrow(TypeError)
    })

    it('workflows:approve checks note length', async () => {
      await h['workflows:approve']('r1', 'v1', true, 'edited', 'n'.repeat(2000))
      expect(wfRunner.approve).toHaveBeenCalledWith('r1', 'v1', { ok: true, text: 'edited', note: 'n'.repeat(2000) })
      await expect(h['workflows:approve']('r1', 'v1', true, 'edited', 'n'.repeat(2001))).rejects.toThrow(/Note/)
      await expect(h['workflows:approve']('r1', 'v1', true, 'x'.repeat(APPROVAL_TEXT_MAX + 1))).rejects.toThrow(
        /Text is longer than 100000 characters/
      )
      await expect(h['workflows:approve']('r1', 'v1', 'yes')).rejects.toThrow(TypeError)
      await expect(h['workflows:approve']('r1', 'v 1', true)).rejects.toThrow(TypeError)
      // Optional arguments arrive as null over the socket.
      await h['workflows:approve']('r1', 'v1', false, null, null)
      expect(wfRunner.approve).toHaveBeenLastCalledWith('r1', 'v1', { ok: false })
      expect(wfRunner.approve).toHaveBeenCalledTimes(2)
    })

    it('workflows:approve takes the whole text a For each step can hand an editable Approval', async () => {
      // The box starts at the visit's input, up to FOREACH_OUTPUT_MAX, and sends it back on Approve and on Reject.
      expect(APPROVAL_TEXT_MAX).toBeGreaterThanOrEqual(FOREACH_OUTPUT_MAX)
      const whole = 'x'.repeat(FOREACH_OUTPUT_MAX)
      await h['workflows:approve']('r1', 'v1', true, whole)
      expect(wfRunner.approve).toHaveBeenLastCalledWith('r1', 'v1', { ok: true, text: whole })
      await h['workflows:approve']('r1', 'v1', false, whole)
      expect(wfRunner.approve).toHaveBeenLastCalledWith('r1', 'v1', { ok: false, text: whole })
      await expect(h['workflows:approve']('r1', 'v1', true, 'x'.repeat(APPROVAL_TEXT_MAX + 1))).rejects.toThrow(
        /Text is longer than 100000 characters/
      )
    })

    it("workflows:approvals returns the store's list", async () => {
      const w = await save()
      await workflowStore.addRun({
        id: 'run1',
        workflowId: w.id,
        via: 'manual',
        late: false,
        status: 'waiting',
        snapshot: {
          steps: [{ id: 'ap', kind: 'approval', handle: 'ok', name: 'OK?', x: 0, y: 0, question: 'q', editable: false }],
          edges: []
        },
        visits: [{ id: 'v1', stepId: 'ap', n: 1, status: 'waiting', input: '', inputs: [], startedAt: 1 }],
        inbox: {},
        allowance: { perStep: {}, total: 200 },
        halted: false,
        startedAt: 1
      })
      const got = (await h['workflows:approvals']()) as { runId: string; workflowName: string }[]
      expect(got.map((a) => [a.runId, a.workflowName])).toEqual([['run1', w.name]])
      expect(got).toEqual(await workflowStore.waitingApprovals())
    })

    it('workflows:getRun returns visits, list does not', async () => {
      const w = await save()
      const run: WorkflowRun = {
        id: 'run1',
        workflowId: w.id,
        via: 'manual',
        late: false,
        status: 'waiting',
        ...newState({ steps: w.steps, edges: w.edges }),
        input: 'typed input',
        startedAt: 1,
        visits: [
          {
            id: 'v1',
            stepId: 'l',
            n: 1,
            status: 'done',
            input: 'in',
            inputs: [],
            output: 'secret output',
            port: 'out',
            startedAt: 1,
            endedAt: 2
          }
        ]
      }
      await workflowStore.addRun(run)
      expect(((await h['workflows:getRun']('run1')) as WorkflowRun).visits[0]?.output).toBe('secret output')
      expect(await h['workflows:getRun']('missing')).toBeNull()
      await expect(h['workflows:getRun'](5)).rejects.toThrow(TypeError)
      const list = (await h['workflows:list']()) as WorkflowsSnapshot
      expect(list.runs[w.id]).toEqual([expect.objectContaining({ id: 'run1', status: 'waiting' })])
      expect(list.runs[w.id]![0]).not.toHaveProperty('visits')
      expect(JSON.stringify(list)).not.toContain('secret output')
      expect(JSON.stringify(list)).not.toContain('typed input')
    })

    it('workflows:remove stops the runs first, then drops the workflow', async () => {
      const w = await save()
      const seen: string[] = []
      wfRunner.stopAllOf.mockImplementation(async (id: string) => {
        seen.push(`${id}:${(await workflowStore.get(id)) ? 'kept' : 'gone'}`)
      })
      await h['workflows:remove'](w.id)
      expect(seen).toEqual([`${w.id}:kept`])
      expect(await workflowStore.get(w.id)).toBeNull()
      expect([wfRearmed, workflowsTold]).toEqual([2, 2])
      await expect(h['workflows:remove'](5)).rejects.toThrow(TypeError)
    })

    it('workflows:run starts a manual run with the typed input; stop and retry reach the runner', async () => {
      const w = await save()
      expect(await h['workflows:run'](w.id, 'hello')).toMatchObject({ id: 'wr1', via: 'manual' })
      expect(wfRunner.run).toHaveBeenLastCalledWith(expect.objectContaining({ id: w.id }), 'manual', { input: 'hello' })
      await h['workflows:run'](w.id, null)
      expect(wfRunner.run).toHaveBeenLastCalledWith(expect.objectContaining({ id: w.id }), 'manual', {})
      await expect(h['workflows:run']('nope')).rejects.toThrow('Workflow not found')
      await expect(h['workflows:run'](w.id, 'x'.repeat(TRIGGER_BODY_MAX + 1))).rejects.toThrow(/Input/)
      await h['workflows:stop']('run1')
      expect(wfRunner.stopRun).toHaveBeenCalledWith('run1')
      await h['workflows:retry']('run1', 'v1')
      expect(wfRunner.retry).toHaveBeenCalledWith('run1', 'v1')
      await expect(h['workflows:stop'](5)).rejects.toThrow(TypeError)
    })

    it('workflows:runFromChat starts a chat run with the typed input, the chat and its last agent reply', async () => {
      const w = await save({ name: 'Daily report' })
      const chat = await store.create('alpha', home)
      await store.update(chat.id, { title: 'Talk' })
      const long = 'r'.repeat(REPLY_TEXT_MAX + 50)
      await store.saveItems(chat.id, [
        { type: 'assistant', id: 'a1', text: 'old', ts: 1 },
        { type: 'user', id: 'u1', text: 'q', ts: 2 },
        { type: 'assistant', id: 'a2', text: long, ts: 3 },
        { type: 'user', id: 'u2', text: '/run-workflow Daily report go', ts: 4 }
      ] as ChatItem[])
      expect(await h['workflows:runFromChat'](chat.id, 'daily REPORT  go now ')).toMatchObject({ id: 'wr1', via: 'chat' })
      expect(wfRunner.run).toHaveBeenLastCalledWith(expect.objectContaining({ id: w.id }), 'chat', {
        input: 'go now',
        chat: { chatId: chat.id, title: 'Talk' },
        call: {
          method: 'EVENT',
          query: {},
          body: { chat: { id: chat.id, title: 'Talk', folder: home }, text: 'go now', lastReply: 'r'.repeat(REPLY_TEXT_MAX) },
          receivedAt: expect.any(Number)
        }
      })
    })

    it("workflows:runFromChat takes the composer's whole text, the command and all, as well as the bare rest", async () => {
      const w = await save({ name: 'Daily report' })
      const chat = await store.create('alpha', home)
      await h['workflows:runFromChat'](chat.id, '/run-workflow Daily report go')
      expect(wfRunner.run).toHaveBeenLastCalledWith(expect.objectContaining({ id: w.id }), 'chat', expect.objectContaining({ input: 'go' }))
      await h['workflows:runFromChat'](chat.id, 'Daily report go')
      expect(wfRunner.run).toHaveBeenLastCalledWith(expect.objectContaining({ id: w.id }), 'chat', expect.objectContaining({ input: 'go' }))
      await h['workflows:runFromChat'](chat.id, '/run-workflow   Daily report')
      expect(wfRunner.run).toHaveBeenLastCalledWith(expect.objectContaining({ id: w.id }), 'chat', expect.objectContaining({ input: '' }))
      await expect(h['workflows:runFromChat'](chat.id, '/run-workflow')).rejects.toThrow(NO_WORKFLOW_NAMED)
      expect(wfRunner.run).toHaveBeenCalledTimes(3)
    })

    it('workflows:runFromChat runs a picked workflow by its id, even when another has the same name', async () => {
      const a = await save({ name: 'Report' })
      const b = await save({ name: 'report' })
      const chat = await store.create('alpha', home)
      await h['workflows:runFromChat'](chat.id, '/run-workflow Report go now', b.id)
      expect(wfRunner.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: b.id }),
        'chat',
        expect.objectContaining({ input: 'go now' })
      )
      // The name stripped case-insensitively, at a word's end only.
      await h['workflows:runFromChat'](chat.id, '/run-workflow REPORT', a.id)
      expect(wfRunner.run).toHaveBeenLastCalledWith(expect.objectContaining({ id: a.id }), 'chat', expect.objectContaining({ input: '' }))
      // A rest that does not start with the picked name is the input, whole.
      await h['workflows:runFromChat'](chat.id, '/run-workflow Reports due', a.id)
      expect(wfRunner.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: a.id }),
        'chat',
        expect.objectContaining({ input: 'Reports due' })
      )
      await h['workflows:runFromChat'](chat.id, 'other text', a.id)
      expect(wfRunner.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: a.id }),
        'chat',
        expect.objectContaining({ input: 'other text' })
      )
      await expect(h['workflows:runFromChat'](chat.id, '/run-workflow Report go', 'nope')).rejects.toThrow(/^Workflow not found$/)
      await expect(h['workflows:runFromChat'](chat.id, '/run-workflow Report go', 5)).rejects.toThrow(TypeError)
      // Over the socket an absent id arrives as null: the name decides, and two of them refuse.
      await expect(h['workflows:runFromChat'](chat.id, '/run-workflow Report go', null)).rejects.toThrow(sameNameText('Report'))
      expect(wfRunner.run).toHaveBeenCalledTimes(4)
    })

    it('workflows:runFromChat gives an empty lastReply when the chat has no agent reply, and an empty input for a bare name', async () => {
      await save({ name: 'Daily report' })
      const chat = await store.create('alpha', home)
      await h['workflows:runFromChat'](chat.id, 'Daily report')
      const o = wfRunner.run.mock.calls.at(-1)![2] as { input: string; call: { body: { lastReply: string; text: string } } }
      expect([o.input, o.call.body.text, o.call.body.lastReply]).toEqual(['', '', ''])
    })

    it('workflows:runFromChat refuses an unknown chat, no or several workflows with the name, and bad arguments', async () => {
      const w = await save({ name: 'Daily report' })
      const chat = await store.create('alpha', home)
      await expect(h['workflows:runFromChat']('nope', 'Daily report')).rejects.toThrow(/^Chat not found$/)
      await expect(h['workflows:runFromChat'](chat.id, 'Other')).rejects.toThrow(NO_WORKFLOW_NAMED)
      await expect(h['workflows:runFromChat'](chat.id, '')).rejects.toThrow(NO_WORKFLOW_NAMED)
      await save({ name: 'daily report' })
      await expect(h['workflows:runFromChat'](chat.id, 'Daily report x')).rejects.toThrow(sameNameText('Daily report'))
      await expect(h['workflows:runFromChat'](5, 'x')).rejects.toThrow(TypeError)
      await expect(h['workflows:runFromChat'](chat.id, 5)).rejects.toThrow(TypeError)
      await expect(h['workflows:runFromChat'](chat.id, 'x'.repeat(TRIGGER_BODY_MAX + 1))).rejects.toThrow(/Input/)
      expect(wfRunner.run).not.toHaveBeenCalled()
      expect(w.id).toBeTruthy()
    })

    it('workflows:runFromChat lets the runner refuse a workflow with problems, as a manual run does', async () => {
      await save({ name: 'Daily report' })
      const chat = await store.create('alpha', home)
      wfRunner.run.mockRejectedValueOnce(new Error(PROBLEMS_TEXT))
      await expect(h['workflows:runFromChat'](chat.id, 'Daily report')).rejects.toThrow(PROBLEMS_TEXT)
    })

    it('workflows:retry passes an optional item id', async () => {
      await h['workflows:retry']('run1', 'v1', 'item1')
      expect(wfRunner.retry).toHaveBeenLastCalledWith('run1', 'v1', 'item1')
      // Over the socket an absent item id arrives as null.
      await h['workflows:retry']('run1', 'v1', null)
      expect(wfRunner.retry).toHaveBeenLastCalledWith('run1', 'v1')
      for (const bad of [5, '', 'constructor', 'a b', { id: 'item1' }]) {
        await expect(h['workflows:retry']('run1', 'v1', bad), String(bad)).rejects.toThrow(TypeError)
      }
      expect(wfRunner.retry).toHaveBeenCalledTimes(2)
    })

    it('workflows:testStep takes the unsaved draft, with the hook sample, never the client one', async () => {
      const w = await save()
      const { secret } = (await h['workflows:webhook'](w.id)) as { secret: string }
      await workflowStore.hooks.recordCall(w.id, secret, call)
      const forged = { ...call, body: { forged: true } }
      const draft = wfInput({
        id: w.id,
        trigger: { kind: 'webhook', sample: forged, filters: [] },
        steps: [T, { ...L, prompt: 'Unsaved {{input}}' }]
      })
      expect(await h['workflows:testStep'](draft, 'l', 'in')).toEqual({ output: 'x' })
      const [sent, stepId, input] = wfRunner.testStep.mock.calls[0]!
      expect(sent).toMatchObject({ id: w.id, trigger: { kind: 'webhook', sample: call }, steps: [T, { prompt: 'Unsaved {{input}}' }] })
      expect([stepId, input]).toEqual(['l', 'in'])
      await expect(h['workflows:testStep']({ ...draft, steps: 'x' }, 'l', 'in')).rejects.toThrow(/^Invalid workflow$/)
      await expect(h['workflows:testStep'](draft, 'l', 5)).rejects.toThrow(TypeError)
    })

    it('workflows:checkMail checks an email trigger the editor holds, and refuses anything else', async () => {
      const checked: unknown[] = []
      h = createHandlers({
        ...handlerDeps,
        checkMail: async (t) => {
          checked.push(t)
          return { messages: 3 }
        }
      })
      const t = { kind: 'email', account: 'v1', host: 'imap.example.com', port: 993, folder: 'INBOX', filters: [], evil: 1 }
      expect(await h['workflows:checkMail'](t)).toEqual({ messages: 3 })
      expect(checked).toEqual([{ kind: 'email', account: 'v1', host: 'imap.example.com', port: 993, folder: 'INBOX', filters: [] }])
      for (const bad of [null, 'x', { kind: 'manual' }, { kind: 'reply', filters: [] }, { ...t, port: 0 }]) {
        await expect(h['workflows:checkMail'](bad), JSON.stringify(bad)).rejects.toThrow(/^Invalid workflow$/)
      }
      expect(checked).toHaveLength(1)
      // Without the mail side wired (tests), it answers with an error rather than failing the call.
      h = createHandlers({ ...handlerDeps, checkMail: undefined })
      expect(await h['workflows:checkMail'](t)).toEqual({ error: expect.any(String) })
    })

    it('creates a testable workflow webhook before saving and keeps its identity and sample on save', async () => {
      expect(h['workflows:draftWebhook']).toBeTypeOf('function')
      const draft = (await h['workflows:draftWebhook']()) as { id: string; url: string; secret: string }
      expect(draft.url).toBe(`http://x/hooks/${draft.id}`)
      expect(await workflowStore.get(draft.id)).toBeNull()
      const secret = (await h['workflows:newSecret'](draft.id)) as string
      expect(secret).not.toBe(draft.secret)
      await workflowStore.hooks.recordCall(draft.id, secret, call)
      expect(await h['workflows:webhook'](draft.id)).toMatchObject({ secret, latest: call })
      const saved = await save({ id: draft.id, trigger: { kind: 'webhook', sample: null, filters: [] } })
      expect(saved.id).toBe(draft.id)
      expect(saved.trigger).toMatchObject({ sample: call })
      expect((await workflowStore.hooks.hook(draft.id))?.draftAt).toBeNull()
      expect((await workflowStore.hooks.hook(draft.id))?.reserved).toBeUndefined()
      await h['workflows:dropDraft'](draft.id)
      expect((await workflowStore.hooks.hook(draft.id))?.secret).toBe(secret)
      await h['workflows:remove'](draft.id)
      await expect(save({ id: draft.id })).rejects.toThrow('Workflow not found')
    })

    it('removes an abandoned workflow webhook draft', async () => {
      expect(h['workflows:draftWebhook']).toBeTypeOf('function')
      const draft = (await h['workflows:draftWebhook']()) as { id: string }
      await h['workflows:dropDraft'](draft.id)
      expect(await workflowStore.hooks.hook(draft.id)).toBeNull()
      await expect(h['workflows:webhook'](draft.id)).rejects.toThrow('Workflow not found')
      await expect(save({ id: draft.id })).rejects.toThrow('Workflow not found')
    })

    it('does not treat a hook recreated after deletion as a new workflow reservation', async () => {
      const w = await save()
      await h['workflows:remove'](w.id)
      // A webhook read that passed its existence check before remove can recreate an orphan here.
      await workflowStore.hooks.ensureHook(w.id, () => 'orphan-secret-long-enough', Date.now())
      await expect(save({ id: w.id })).rejects.toThrow('Workflow not found')
    })

    it('workflows:webhook uses the routines URL base and newSecret rotates; save takes the sample from the hook', async () => {
      const w = await save()
      const a = (await h['workflows:webhook'](w.id)) as { url: string; secret: string; latest: unknown }
      expect(a.url).toBe(`http://x/hooks/${w.id}`)
      expect(a.secret.length).toBeGreaterThanOrEqual(32)
      expect(a.latest).toBeNull()
      expect(((await h['workflows:webhook'](w.id)) as { secret: string }).secret).toBe(a.secret)
      const fresh = (await h['workflows:newSecret'](w.id)) as string
      expect(fresh).not.toBe(a.secret)
      expect(((await h['workflows:webhook'](w.id)) as { secret: string }).secret).toBe(fresh)
      await expect(h['workflows:webhook']('nope')).rejects.toThrow('Workflow not found')
      await expect(h['workflows:newSecret']('nope')).rejects.toThrow('Workflow not found')
      expect((await workflowStore.hooks.hook(w.id))?.draftAt).not.toBeNull()

      await workflowStore.hooks.recordCall(w.id, fresh, call)
      const forged = { ...call, body: { forged: true } }
      const filters = [{ field: 'body.a', equals: '1' }]
      const hooked = await save({ id: w.id, trigger: { kind: 'webhook', sample: forged, filters } })
      expect(hooked.trigger).toEqual({ kind: 'webhook', sample: call, filters })
      expect((await workflowStore.hooks.hook(w.id))?.draftAt).toBeNull()
      expect(JSON.stringify(await h['workflows:list']())).not.toContain(fresh)
      // A new webhook workflow has no call yet: it saves with no sample.
      expect((await save({ trigger: { kind: 'webhook', sample: forged, filters: [] } })).trigger).toEqual({
        kind: 'webhook',
        sample: null,
        filters: []
      })
    })

    it('chats:remove and chats:dropTask tell the workflow runner too', async () => {
      const c = await store.create('a', '/tmp')
      await h['chats:dropTask'](c.id, 'missing')
      expect(wfRunner.taskDropped).not.toHaveBeenCalled()
      await store.addTask(c.id, { id: 't1', text: 'x', ts: 1 })
      await h['chats:dropTask'](c.id, 't1')
      expect(wfRunner.taskDropped).toHaveBeenCalledWith(c.id, 't1')
      await h['chats:remove'](c.id)
      expect(wfRunner.chatRemoved).toHaveBeenCalledWith(c.id)
    })

    it('an agent rename moves workflow step agents after routines, and a failure there is caught', async () => {
      const w = await save({ steps: [T, A], edges: [{ id: 'e1', from: 't', port: 'out', to: 'a' }] })
      const seq: string[] = []
      const routines = routineStore.renameAgent.bind(routineStore)
      const workflows = workflowStore.renameAgent.bind(workflowStore)
      vi.spyOn(routineStore, 'renameAgent').mockImplementation(async (f, t) => {
        seq.push('routines')
        await routines(f, t)
      })
      vi.spyOn(workflowStore, 'renameAgent').mockImplementation(async (f, t) => {
        seq.push('workflows')
        await workflows(f, t)
      })
      const told = workflowsTold
      saveResult = { ok: true, name: 'alpha2', renamedFrom: 'alpha' }
      await h['agents:save']('/a/alpha.md', 'raw')
      expect(seq).toEqual(['routines', 'workflows'])
      expect((await workflowStore.get(w.id))?.steps.find((s) => s.id === 'a')).toMatchObject({ agent: 'alpha2' })
      expect(workflowsTold).toBe(told + 1)

      vi.spyOn(workflowStore, 'renameAgent').mockRejectedValue(new Error('disk'))
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      saveResult = { ok: true, name: 'alpha3', renamedFrom: 'alpha2' }
      await expect(h['agents:save']('/a/alpha2.md', 'raw')).resolves.toMatchObject({ ok: true })
      expect(err).toHaveBeenCalledWith('renaming workflow agents failed:', 'disk')
      err.mockRestore()
    })
  })

  describe('memory', () => {
    const input = { title: 'T', description: '', type: 'user', body: 'b' }
    beforeEach(() => {
      agentList = [
        alpha,
        { ...alpha, name: 'broken', error: 'bad frontmatter' },
        { ...alpha, name: 'mem', memory: 'project', memoryLimit: 50 }
      ]
    })
    it('memory:list uses the summary scope and limit, rejects unknown or broken agents', async () => {
      await expect(h['memory:list']('nope')).rejects.toThrow(/Unknown agent/)
      await expect(h['memory:list']('broken')).rejects.toThrow(/Unknown agent/)
      expect(await h['memory:list']('mem')).toEqual({ agent: 'mem', o: { scope: 'project', limit: 50, autoMemoryOff: true } })
      expect(await h['memory:list']('alpha')).toEqual({ agent: 'alpha', o: { scope: null, limit: 100, autoMemoryOff: true } })
    })
    it('memory:save checks args, saves, broadcasts and returns the list', async () => {
      await expect(h['memory:save']('mem', '../x.md', input, null)).rejects.toThrow(TypeError)
      await expect(h['memory:save']('mem', 5, input, null)).rejects.toThrow()
      await expect(h['memory:save']('mem', null, input, 'x')).rejects.toThrow(/modified/)
      await expect(h['memory:save']('mem', null, input, NaN)).rejects.toThrow(/modified/)
      await expect(h['memory:save']('mem', null, { ...input, title: '' }, null)).rejects.toThrow(TypeError)
      expect(memStore['save']).not.toHaveBeenCalled()
      const r = await h['memory:save']('mem', 'a.md', input, 7)
      expect(memStore['save']).toHaveBeenCalledWith('mem', 'a.md', input, 7, 50)
      expect(memTold).toEqual(['mem'])
      expect(r).toMatchObject({ agent: 'mem' })
      await h['memory:save']('mem', null, input, null)
      expect(memStore['save']).toHaveBeenLastCalledWith('mem', null, input, null, 50)
    })
    it('memory:remove checks args, removes, broadcasts', async () => {
      await expect(h['memory:remove']('mem', 'MEMORY.md', 1)).rejects.toThrow(TypeError)
      await expect(h['memory:remove']('mem', 'a.md', null)).rejects.toThrow(/modified/)
      expect(memStore['remove']).not.toHaveBeenCalled()
      await h['memory:remove']('mem', 'a.md', 3)
      expect(memStore['remove']).toHaveBeenCalledWith('mem', 'a.md', 3)
      expect(memTold).toEqual(['mem'])
    })
    it('agents:save rename calls turns.renamed in the same tick as approvals, before any other await', async () => {
      const order: string[] = []
      vi.spyOn(approvals, 'renameAgent').mockImplementation(async () => {
        order.push('approvals')
      })
      const origRenamed = memCalls.push.bind(memCalls)
      memCalls.push = (...a: string[]) => {
        order.push('memory')
        return origRenamed(...a)
      }
      const p = h['agents:save']('/a/old.md', 'raw')
      await Promise.resolve()
      await Promise.resolve() // only the save's own await
      expect(order).toEqual(['approvals', 'memory'])
      await p
      expect([...memCalls]).toEqual(['renamed:old>new'])
    })
    it('agents:trash deletes memory only when the name is really gone', async () => {
      // another file still carries the name: the trash fake only drops the trashed path
      agentList = [
        { ...alpha, filePath: '/a/x.md', name: 'x' },
        { ...alpha, filePath: '/b/x.md', name: 'x' }
      ]
      await h['agents:trash']('/a/x.md')
      expect(memCalls).toEqual([])
      agentList = [{ ...alpha, filePath: '/c/z.md', name: 'z' }]
      await h['agents:trash']('/c/z.md')
      expect(memCalls).toEqual(['deleted:z'])
    })
  })

  describe('usage:query', () => {
    it('rejects a non-number from', async () => {
      await expect(h['usage:query']({ from: 'x', to: null, agent: null, chatId: null, timeZone: 'UTC' })).rejects.toThrow(/from/)
      await expect(h['usage:query']({ from: Infinity, to: null })).rejects.toThrow(/from/)
      await expect(h['usage:query']({ from: null, to: null, agent: 5 })).rejects.toThrow(/agent/)
      expect(usageQueries).toEqual([])
    })

    it('falls back to UTC for an unknown time zone', async () => {
      await h['usage:query']({ from: 1, to: 2, agent: 'a', chatId: null, timeZone: 'Mars/Base' })
      await h['usage:query']({ from: null, to: null, agent: null, chatId: 'c', timeZone: 'Asia/Baghdad' })
      expect(usageQueries).toEqual([
        { from: 1, to: 2, agent: 'a', chatId: null, timeZone: 'UTC' },
        { from: null, to: null, agent: null, chatId: 'c', timeZone: 'Asia/Baghdad' }
      ])
    })
  })
  describe('dispatch', () => {
    it("dispatch:list serves the chat's summaries and checks its id", async () => {
      const chat = await store.create('alpha', home)
      const rec = dispatchSvc.begin(chat.id, { turn: 't' })
      rec.event({ kind: 'toolUse', id: 'a', name: 'Agent', input: { description: 'A', prompt: 'p' } })
      expect(await h['dispatch:list'](chat.id)).toMatchObject([{ id: 'a', status: 'running' }])
      await expect(h['dispatch:list'](5)).rejects.toThrow(TypeError)
    })
    it('dispatch:get takes an optional whole non-negative from and rejects anything else', async () => {
      const chat = await store.create('alpha', home)
      const rec = dispatchSvc.begin(chat.id, { turn: 't' })
      rec.event({ kind: 'toolUse', id: 'a', name: 'Agent', input: { description: 'A', prompt: 'p' } })
      rec.event({ kind: 'subText', parent: 'a', text: 'one' })
      rec.event({ kind: 'subText', parent: 'a', text: 'two' })
      expect(await h['dispatch:get'](chat.id, 'a', null)).toMatchObject({ from: 0, entry: { steps: [{ text: 'one' }, { text: 'two' }] } })
      expect(await h['dispatch:get'](chat.id, 'a', 1)).toMatchObject({ from: 1, entry: { steps: [{ text: 'two' }] } })
      expect(await h['dispatch:get'](chat.id, 'nope', undefined)).toBeNull()
      for (const bad of [-1, 1.5, '1', Number.NaN]) await expect(h['dispatch:get'](chat.id, 'a', bad)).rejects.toThrow(TypeError)
      await expect(h['dispatch:get'](chat.id, 7, 0)).rejects.toThrow(TypeError)
    })
  })

  describe('search', () => {
    it('chats:search finds messages of listed chats only', async () => {
      const kept = await store.create('alpha', home)
      const gone = await store.create('alpha', home)
      const items = (text: string): ChatItem[] => [
        { type: 'user', id: 'u1', text, ts: 1 },
        { type: 'assistant', id: 'a1', text: 'The deploy script is ready', ts: 2 }
      ]
      // Indexed straight from the items, as the store's listener would; the removed chat stays in the index here.
      search.note(kept.id, items('Write a deploy script'))
      search.note(gone.id, items('Another deploy'))
      search.flush()
      await store.remove(gone.id)
      const r = (await h['chats:search']('deploy', undefined)) as SearchResult
      expect(r.hits.map((x) => [x.chatId, x.itemId, x.role])).toEqual([
        [kept.id, 'a1', 'assistant'],
        [kept.id, 'u1', 'user']
      ])
      expect(r.total).toBe(2)
      expect(r.hits[0].snippet).toBe('The deploy script is ready')
      expect(r.hits[0].marks).toEqual([[4, 10]])
      expect(((await h['chats:search']('deploy', 1)) as SearchResult).hits.map((x) => x.itemId)).toEqual(['u1'])
    })
    it('chats:search checks its arguments', async () => {
      await expect(h['chats:search'](5, 0)).rejects.toThrow(TypeError)
      await expect(h['chats:search']('x'.repeat(201), 0)).rejects.toThrow(/at most 200/)
      for (const bad of [-1, 1.5, '1', 991]) await expect(h['chats:search']('x', bad)).rejects.toThrow(TypeError)
      expect(await h['chats:search']('  ', null)).toMatchObject({ hits: [], total: 0 })
    })
    it('chats:items takes an item to reach back to', async () => {
      const chat = await store.create('alpha', home)
      const list: ChatItem[] = Array.from({ length: 200 }, (_, i) => ({ type: 'user', id: `m${i}`, text: `${i}`, ts: i }))
      await store.saveItems(chat.id, list)
      expect(await h['chats:items'](chat.id, null, 'm25')).toMatchObject({ start: 15 })
      expect(await h['chats:items'](chat.id, 'm100', 'm25')).toMatchObject({ start: 15, items: list.slice(15, 100) })
      await expect(h['chats:items'](chat.id, null, 7)).rejects.toThrow(/until must be a string/)
    })
  })

  describe('todos', () => {
    const seed = async (): Promise<string> => {
      const chat = await store.create('alpha', home)
      await todoSvc.agentAdd(chat.id, 'alpha', 't1', 'Reply', [{ text: 'one' }, { text: 'two' }])
      todosTold.length = 0
      return chat.id
    }
    it('todos:list returns the live items made in a chat; todos:board every open one and the done ones', async () => {
      const id = await seed()
      await h['todos:add']('Renew the passport', null)
      await h['todos:remove'](['todo1'])
      const r = (await h['todos:list'](id)) as { rev: number; items: { id: string }[] }
      expect(r.items.map((i) => i.id)).toEqual(['todo2'])
      await h['todos:check'](['todo2'], true)
      const b = (await h['todos:board']()) as { open: { text: string }[]; done: { text: string }[]; doneTotal: number }
      expect([b.open.map((i) => i.text), b.done.map((i) => i.text), b.doneTotal]).toEqual([['Renew the passport'], ['two'], 1])
      await expect(h['todos:list'](null)).rejects.toThrow(TypeError)
    })
    it('todos:add takes the text, and a chat for its panel or null for the board', async () => {
      const id = await seed()
      expect(await h['todos:add']('Buy milk', id)).toEqual({ added: true })
      expect(await h['todos:add']('Buy milk', null)).toEqual({ added: false }) // the board is one list
      expect(await h['todos:add']('Call the bank', null)).toEqual({ added: true })
      const board = (await h['todos:board']()) as { open: { text: string; from: { chatId: string | null }; addedBy: string }[] }
      expect(board.open.map((i) => [i.text, i.from.chatId, i.addedBy])).toEqual([
        ['one', id, 'alpha'],
        ['two', id, 'alpha'],
        ['Buy milk', id, 'user'],
        ['Call the bank', null, 'user']
      ])
      expect(todosTold).toEqual([2, 3])
      await expect(h['todos:add'](5, null)).rejects.toThrow(TypeError)
      await expect(h['todos:add']('x', 'nope')).rejects.toThrow(/Chat not found/)
    })
    it('todos:check, remove and restore take ids only, and check their arguments', async () => {
      await seed()
      await h['todos:check'](['todo1'], true)
      await expect(h['todos:check'](['todo1'], 'yes')).rejects.toThrow(/done must be a boolean/)
      await expect(h['todos:remove'](Array.from({ length: 201 }, (_, i) => `i${i}`))).rejects.toThrow(/ids/)
      await expect(h['todos:remove']([])).rejects.toThrow(/ids/)
      await expect(h['todos:remove'](['x'.repeat(65)])).rejects.toThrow(/ids/)
      await h['todos:remove'](['todo2'])
      await h['todos:restore'](['todo2'])
      expect(((await h['todos:list']((await store.list())[0]!.id)) as { items: unknown[] }).items).toHaveLength(2)
    })
    it('todos:edit checks its patch: known keys, strings, distinct file ids', async () => {
      await seed()
      await h['todos:edit']('todo1', { text: 'one, renamed', description: 'notes' })
      expect(((await h['todos:board']()) as { open: { text: string; description?: string }[] }).open[0]).toMatchObject({
        text: 'one, renamed',
        description: 'notes'
      })
      await expect(h['todos:edit']('todo1', { title: 'x' })).rejects.toThrow(/unknown key/)
      await expect(h['todos:edit']('todo1', { text: 5 })).rejects.toThrow(TypeError)
      await expect(h['todos:edit']('todo1', { addFiles: ['a', 'a'] })).rejects.toThrow(/distinct/)
      await expect(h['todos:edit']('todo1', null)).rejects.toThrow(/object/)
      await expect(h['todos:edit']('', {})).rejects.toThrow(/id must be/)
    })
    it('todos:move takes a status; To do needs an assignee', async () => {
      await seed()
      type Open = { open: { id: string; status?: string; assignee?: string }[] }
      const open = async (id: string) => ((await h['todos:board']()) as Open).open.find((i) => i.id === id)
      await expect(h['todos:move']('todo1', 'todo')).rejects.toThrow('Assign it to you or an agent first.')
      await h['todos:move']('todo1', 'review')
      expect((await open('todo1'))?.status).toBe('review')
      await h['todos:move']('todo1', 'done')
      expect(((await h['todos:board']()) as { doneTotal: number }).doneTotal).toBe(1)
      await expect(h['todos:move']('todo1', 'mine')).rejects.toThrow(/status must be/)
    })
    it('todos:assign and a move to To do make the task chat in the picked folder, tell every tab, and send the card', async () => {
      await seed()
      const submit = vi.spyOn(tasks, 'submit').mockResolvedValue('sent')
      await fs.mkdir(home, { recursive: true })
      await h['todos:assign']('todo2', 'alpha', home)
      expect(pushed.some((p) => p.kind === 'meta' && p.meta.task)).toBe(false) // assigning starts nothing
      await h['todos:move']('todo2', 'todo')
      const meta = pushed.flatMap((p) => (p.kind === 'meta' && p.meta.task ? [p.meta] : []))[0]!
      expect(meta).toMatchObject({ agentName: 'alpha', cwd: home, title: 'two', task: { todoId: 'todo2' } })
      await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(meta.id, 'Task: two', []))
      await expect(h['todos:assign']('todo1', 'alpha', join(home, 'missing'))).rejects.toThrow('Folder not found')
      await expect(h['todos:assign']('todo1', 5, home)).rejects.toThrow(TypeError)
      await expect(h['todos:assign']('todo1', 'user', 5)).rejects.toThrow(TypeError)
      await h['todos:assign']('todo1', 'user', null)
      await h['todos:assign']('todo1', null, null)
    })
    it('todos:assign and attempts:start refuse an agent whose engine has no bridges, naming it, before anything is made', async () => {
      await seed()
      agentList.push({ ...alpha, filePath: '/agents/gem.md', name: 'gem', provider: 'acp' })
      await fs.mkdir(home, { recursive: true })
      await expect(h['todos:assign']('todo1', 'gem', home)).rejects.toThrow(bridgeRefusal('acp', 'gem'))
      await expect(h['attempts:start']('todo1', [{ agent: 'alpha' }, { agent: 'gem' }], home)).rejects.toThrow(bridgeRefusal('acp', 'gem'))
      expect(pushed.some((p) => p.kind === 'meta' && (p.meta.task || p.meta.attempt))).toBe(false)
      // The same call for a Claude agent is not refused for its engine.
      await h['todos:assign']('todo1', 'alpha', home)
    })
    it('attempts:start checks the picks and the folder before anything is made', async () => {
      await seed()
      await expect(h['attempts:start']('todo1', [{ agent: 'alpha' }])).rejects.toThrow(TypeError)
      await expect(
        h['attempts:start'](
          'todo1',
          Array.from({ length: 6 }, () => ({ agent: 'alpha' }))
        )
      ).rejects.toThrow(TypeError)
      await expect(h['attempts:start']('todo1', ['alpha', 'alpha'])).rejects.toThrow(/each pick must be/)
      await expect(h['attempts:start']('todo1', 'alpha')).rejects.toThrow(/picks must be an array/)
      await expect(h['attempts:start']('todo1', [{ agent: 'alpha' }, { agent: 'alpha' }], 5)).rejects.toThrow(TypeError)
      // Picks that pass the shape are refused by the card's own folder, not by the validator.
      await expect(h['attempts:start']('todo1', [{ agent: 'alpha' }, { agent: 'alpha' }])).rejects.toThrow(/Pick the folder/)
      expect(pushed.some((p) => p.kind === 'meta' && p.meta.attempt)).toBe(false)
    })
    it('attempts:keep and attempts:cancel check their arguments', async () => {
      await seed()
      await expect(h['attempts:keep']('todo1', 5)).rejects.toThrow(TypeError)
      await expect(h['attempts:keep'](5, 'chat')).rejects.toThrow(TypeError)
      await expect(h['attempts:keep']('todo1', 'chat')).rejects.toThrow(/no attempts/i)
      await expect(h['attempts:cancel']('todo1')).rejects.toThrow(/no attempts running/i)
    })
    it('the github handlers check their arguments, and say gh is missing without it', async () => {
      await seed()
      const c = await store.create('alpha', '/repo')
      // No gh dep at all: every PR handler says so, and none of them reaches anything.
      expect(await h['github:state']()).toEqual({ gh: 'missing' })
      await expect(h['github:draftPr'](c.id)).rejects.toThrow(/gh is not installed/)
      await expect(h['github:createPr'](c.id, { title: 'T', body: '', draft: false })).rejects.toThrow(/gh is not installed/)
      await expect(h['github:refreshPr'](c.id)).rejects.toThrow(/gh is not installed/)
      await expect(h['github:sendCheck'](c.id, 'unit')).rejects.toThrow(/gh is not installed/)
      // The argument checks run whatever the deps are.
      const prs = {
        draftPr: vi.fn(async () => ({})),
        createPr: vi.fn(async () => ({})),
        refreshPr: vi.fn(async () => ({})),
        sendCheck: vi.fn(async () => undefined)
      }
      const hg = createHandlers({
        ...handlerDeps,
        github: { state: async () => 'ready' as const, prs: prs as never, watcher: { watch: () => {}, stop: () => {} } }
      })
      await expect(hg['github:draftPr'](7)).rejects.toThrow(TypeError)
      await expect(hg['github:createPr'](c.id, null)).rejects.toThrow(TypeError)
      await expect(hg['github:createPr'](c.id, { title: '  ', body: '' })).rejects.toThrow(TypeError)
      await expect(hg['github:createPr'](c.id, { title: 'x'.repeat(257), body: '' })).rejects.toThrow(TypeError)
      await expect(hg['github:createPr'](c.id, { title: 'T', body: 'x'.repeat(60_001) })).rejects.toThrow(TypeError)
      await expect(hg['github:createPr'](c.id, { title: 'T', body: '', draft: 'yes' })).rejects.toThrow(TypeError)
      await expect(hg['github:sendCheck'](c.id, '')).rejects.toThrow(TypeError)
      await expect(hg['github:sendCheck'](c.id, 'x'.repeat(301))).rejects.toThrow(TypeError)
      expect(prs.createPr).not.toHaveBeenCalled()
      // A body left out is empty, and a draft left out is false.
      await hg['github:createPr'](c.id, { title: 'T' })
      expect(prs.createPr).toHaveBeenCalledWith(c.id, { title: 'T', body: '', draft: false })
      expect(await hg['github:state']()).toEqual({ gh: 'ready' })
    })
    it('todos:answer and todos:reply check their arguments', async () => {
      await seed()
      await expect(h['todos:answer']('todo1', [])).rejects.toThrow(/answers must hold/)
      await expect(h['todos:answer']('todo1', [{ id: 'q', text: 'a', extra: 1 }])).rejects.toThrow(/id, text/)
      await expect(h['todos:answer']('todo1', [{ id: 'q', text: 'a' }])).rejects.toThrow('No agent has worked on this to-do yet.')
      await expect(h['todos:reply']('todo1', 7)).rejects.toThrow(TypeError)
    })
  })
})
