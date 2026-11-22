import type { AgentSummary, ChatMeta } from './types'

export type Engine = 'claude' | 'codex' | 'acp' | 'ag-ui'

/** Every engine but Claude: an agent's `provider:` value and a session's engine mark, where absent means Claude. */
export type Provider = Exclude<Engine, 'claude'>

/**
 * Each engine's name as the UI and fixed texts say it. A Record, so a new engine must name itself here, and `ENGINES` (its keys)
 * reaches every list that offers or checks each engine.
 */
export const ENGINE_LABEL: Record<Engine, string> = { claude: 'Claude', codex: 'Codex', acp: 'ACP', 'ag-ui': 'AG-UI' }
export const ENGINES = Object.keys(ENGINE_LABEL) as Engine[]

/** For the default of an exhaustive `switch (engine)`: a new engine fails typecheck there until that place decides. */
export function assertNever(x: never): never {
  throw new Error(`No case for engine ${String(x)}`)
}

const PROVIDERS: Record<Provider, true> = { codex: true, acp: true, 'ag-ui': true }

/** The engine an agent file's `provider:` names. Strict: "Codex", "codex " and `claude` are no provider (= Claude). */
export function parseProvider(v: unknown): Provider | null {
  return typeof v === 'string' && Object.hasOwn(PROVIDERS, v) ? (v as Provider) : null
}

/** The mark a session of this engine is stored with (`ChatMeta.sessionEngine`, a stamp's `engine`): none for Claude. */
export const sessionMark = (engine: Engine): Provider | undefined => (engine === 'claude' ? undefined : engine)
/** The engine a stored mark names. Kept raw, so a mark this build does not know never reads as Claude's own session. */
export const markEngine = (mark: Provider | undefined): Engine => mark ?? 'claude'
/** The `provider:` value Agent Studio writes for an engine: none for Claude, whose absence is the key. */
export const providerOf = (engine: Engine): Provider | null => (engine === 'claude' ? null : engine)

/** What the Codex CLI reports on this machine: whether it runs, and the models it offers. */
export interface CodexInfo {
  found: boolean
  models: string[]
}

/** The features an engine supports; the UI and the handlers read these instead of testing the engine's name. */
export interface EngineCaps {
  pause: boolean
  btw: boolean
  compact: boolean
  rewind: boolean
  files: boolean
  desktop: boolean
  vaultKeys: boolean
  rooms: boolean
  questions: boolean
  plan: boolean
  memory: boolean
  keepWarm: boolean
  dispatch: boolean
  processes: boolean
  /** Edit and Resend on a user message, and the version switcher. */
  resend: boolean
  /** Fork from a message. */
  fork: boolean
  /** Every turn reports a USD cost, so a spend cap can hold. */
  cost: boolean
  /** The model picker. */
  models: boolean
  /** Runs outside this machine. */
  remote: boolean
  /** ZumiBot's own MCP bridges: to-dos, vault list, ask, browser and background processes. */
  bridges: boolean
  /**
   * Sandboxed and Container isolation (governance.md 2.3, 2.4): ZumiBot can hold the run inside them. Off, an agent set to
   * either level has its runs refused with `isolationRefusal`, never run as Off, and Agent Studio offers neither level.
   */
  isolation: boolean
}

const CLAUDE_CAPS: EngineCaps = {
  pause: true,
  btw: true,
  compact: true,
  rewind: true,
  files: true,
  desktop: true,
  vaultKeys: true,
  rooms: true,
  questions: true,
  plan: true,
  memory: true,
  keepWarm: true,
  dispatch: true,
  processes: true,
  resend: true,
  fork: true,
  cost: true,
  models: true,
  remote: false,
  bridges: true,
  isolation: true
}
// vaultKeys: a Codex run's API keys ride only beside the vault guard's hook, which the runner proves trusted before any thread.
// pause: the pause hook rides beside it, trusted the same way.
// dispatch: a main run turns on Codex subagents (multi_agent); each child is an Agent dispatch, ended with the process on Stop.
// processes: a Codex MCP call gets no client review in auto mode (probe check 12), so a process start's card could not be forced.
// rooms: a member runs on its own agent's engine through the same turn as a single chat; the moderator stays Claude.
// isolation: the sandbox settings and the container are the Claude CLI's; Codex keeps its own workspace-write sandbox.
const CODEX_CAPS: EngineCaps = {
  pause: true,
  btw: true,
  compact: true,
  rewind: true,
  files: true,
  desktop: false,
  vaultKeys: true,
  rooms: true,
  questions: true,
  plan: false,
  memory: false,
  keepWarm: false,
  dispatch: true,
  processes: false,
  resend: true,
  fork: true,
  cost: true,
  models: true,
  remote: false,
  bridges: true,
  isolation: false
}
// See docs/architecture/protocol-engines.md, Capability table. In short: exact diffs (files), one prompt per member turn (rooms)
// and stable form elicitation (questions). No rewind at a point in stable v1, so no Edit, Resend or Fork; no guard beside the
// agent, so no vault keys as env (only its own `authEnv`) and no bridges; a cost that may be in any currency, so no spend caps.
// No isolation: the sandbox and the container hold the Claude CLI, never an ACP agent's own process tree.
const ACP_CAPS: EngineCaps = {
  pause: false,
  btw: false,
  compact: false,
  rewind: false,
  files: true,
  desktop: false,
  vaultKeys: false,
  rooms: true,
  questions: true,
  plan: false,
  memory: false,
  keepWarm: false,
  dispatch: false,
  processes: false,
  resend: false,
  fork: false,
  cost: false,
  models: false,
  remote: false,
  bridges: false,
  isolation: false
}
// See docs/architecture/protocol-engines.md, Capability table. A remote agent gets nothing local (no files, keys, bridges,
// desktop or rooms) and no Pause, side questions or Compact. Every run sends the whole visible history, so a rewind is a new
// thread with the visible items: Edit, Resend and Fork stay on. Interrupts with a schema are question cards. Tokens, no cost.
// No isolation: its tools run on its own server, which no sandbox or container here can hold.
const AGUI_CAPS: EngineCaps = {
  pause: false,
  btw: false,
  compact: false,
  rewind: false,
  files: false,
  desktop: false,
  vaultKeys: false,
  rooms: false,
  questions: true,
  plan: false,
  memory: false,
  keepWarm: false,
  dispatch: false,
  processes: false,
  resend: true,
  fork: true,
  cost: false,
  models: false,
  remote: true,
  bridges: false,
  isolation: false
}

// The features whose buttons or pickers an engine's missing cap takes away, in the order a user meets them. Plan mode and the
// like are left out: nothing visible goes missing in a chat that never had them.
const FEATURE_LABELS: readonly [keyof EngineCaps, string][] = [
  ['resend', 'Edit and Resend'],
  ['fork', 'Fork'],
  ['pause', 'Pause'],
  ['btw', 'Side questions'],
  ['compact', 'Compact'],
  ['models', 'The model picker'],
  ['cost', 'Spend caps'],
  ['bridges', "ZumiBot's to-do, vault, ask and browser tools"]
]

/** What an engine can't do that its sibling engines can, named as the buttons and menus are (a chat's "i", Agent Studio's Test). */
export const missingFeatures = (caps: EngineCaps): string[] => FEATURE_LABELS.filter(([cap]) => !caps[cap]).map(([, label]) => label)

/**
 * A per-engine table read with an engine name that may come from stored data (a mark a newer build wrote, a corrupt file):
 * a name no engine has gets `fallback`, never an `Object.prototype` member such as `toString`.
 */
export function byEngine<T>(table: Readonly<Record<Engine, T>>, engine: string, fallback: T): T {
  return Object.hasOwn(table, engine) ? table[engine as Engine] : fallback
}

const CAPS: Record<Engine, EngineCaps> = { claude: CLAUDE_CAPS, codex: CODEX_CAPS, acp: ACP_CAPS, 'ag-ui': AGUI_CAPS }

// An unknown name keeps what it always got (Claude's), so stored data this build does not know changes nothing here.
export function engineCaps(engine: Engine): EngineCaps {
  return { ...byEngine(CAPS, engine, CLAUDE_CAPS) }
}

export function engineOfAgent(a: Pick<AgentSummary, 'provider'> | undefined): Engine {
  return parseProvider(a?.provider) ?? 'claude'
}

/** Whether an agent runs outside this machine (the `remote` cap): never an ask target, and never picked for the user. */
export const isRemoteAgent = (a: Pick<AgentSummary, 'provider'> | undefined, caps: (e: Engine) => EngineCaps = engineCaps): boolean =>
  caps(engineOfAgent(a)).remote

/**
 * The engine a chat's agent runs on. In a room, `member`'s own agent's; the room itself (its moderator, the CLI it needs to
 * route a message) is Claude's. A single chat ignores `member`.
 */
export function chatEngine(chat: Pick<ChatMeta, 'agentName' | 'group'>, agents: readonly AgentSummary[], member?: string): Engine {
  if (chat.group) return member === undefined ? 'claude' : engineOfAgent(agents.find((a) => a.name === member))
  return engineOfAgent(agents.find((a) => a.name === chat.agentName))
}

// `btw`, `compact` and `pause` are what a Codex chat says while that cap is off (a later probe failed); all of them are fixed text, never CLI output.
export const CODEX_REFUSALS = {
  btw: 'Side questions are not available for Codex agents yet.',
  compact: 'Compact is not available for Codex agents yet.',
  pause: 'Pause is not available for Codex agents yet.',
  resend: 'Edit, Resend and switching versions are not available for Codex agents yet.',
  fork: 'Fork is not available for Codex agents yet.',
  room: (name: string) => `${name} runs on Codex, and Codex agents can't join a room yet.`,
  notFound: 'Codex CLI not found. Install it and run `codex login` on this machine.',
  signedOut: 'Codex is not signed in on this machine. Run `codex login` in a terminal.',
  /** A side run's fork found no thread; the caller then seeds a new one, so it shows only if that is ever skipped. */
  threadGone: 'The Codex thread to answer from is gone.',
  /** A cut run whose thread/fork answered with the thread it was asked to fork (Claude's FORK_IGNORED, for Codex). */
  forkIgnored: (version: string | undefined) =>
    `Codex${version ? ` ${version}` : ''} did not fork the thread, so this reply was stopped before it could change an earlier version's memory. Edit, Resend, Fork and switching versions need an update for this Codex version.`
}

/** What an ACP chat says for a cap its engine lacks: fixed text, never agent output. */
export const ACP_REFUSALS = {
  btw: 'Side questions are not available for ACP agents.',
  compact: 'Compact is not available for ACP agents.',
  pause: 'Pause is not available for ACP agents.',
  resend: 'Edit, Resend and switching versions are not available for ACP agents.',
  fork: 'Fork is not available for ACP agents.',
  room: (name: string) => `${name} runs on an ACP agent, and it can't join a room.`
}

/** What a remote (AG-UI) agent's chat says for a cap its engine lacks: fixed text, never server output. */
export const AGUI_REFUSALS = {
  btw: 'Side questions are not available for remote agents.',
  compact: 'Compact is not available for remote agents.',
  pause: 'Pause is not available for remote agents.',
  resend: 'Edit, Resend and switching versions are not available for remote agents.', // never while its `resend` is on
  fork: 'Fork is not available for remote agents.', // never while its `fork` is on
  room: (name: string) => `${name} is a remote agent, and it can't join a room.`
}

/** Why a room refuses a member whose engine has no `rooms` (a later probe turned it off): fixed text per engine. */
export function roomRefusal(engine: Engine, member: string): string {
  switch (engine) {
    case 'claude':
      return `${member} can't join a room.` // never today: Claude rooms are always on
    case 'codex':
      return CODEX_REFUSALS.room(member)
    case 'acp':
      return ACP_REFUSALS.room(member) // never while ACP rooms are on
    case 'ag-ui':
      return AGUI_REFUSALS.room(member)
    default:
      return assertNever(engine)
  }
}

/** The caps a handler or service refuses a request for with a fixed sentence when the chat's engine lacks them. */
export type RefusedCap = 'btw' | 'compact' | 'pause' | 'resend' | 'fork'

// Never shown today: Claude has every cap. Here so a probe that turns one off has a sentence that names no other engine.
const CLAUDE_REFUSALS: Record<RefusedCap, string> = {
  btw: 'Side questions are not available for this agent.',
  compact: 'Compact is not available for this agent.',
  pause: 'Pause is not available for this agent.',
  resend: 'Edit, Resend and switching versions are not available for this agent.',
  fork: 'Fork is not available for this agent.'
}

/** Why a request is refused on an engine without that cap: fixed text per engine, never CLI output. */
export function capRefusal(engine: Engine, cap: RefusedCap): string {
  switch (engine) {
    case 'claude':
      return CLAUDE_REFUSALS[cap]
    case 'codex':
      return CODEX_REFUSALS[cap]
    case 'acp':
      return ACP_REFUSALS[cap]
    case 'ag-ui':
      return AGUI_REFUSALS[cap]
    default:
      return assertNever(engine)
  }
}

/**
 * Why a spend cap is refused for an agent whose engine has no `cost` (an ACP cost may be in credits or another currency): the
 * agent's name is the caller's own, never agent output. Fixed text per engine.
 */
export function spendCapRefusal(engine: Engine, agent: string): string {
  switch (engine) {
    case 'claude':
      return `${agent} reports no cost, so a spend cap can't hold for it.` // never today: Claude reports one
    case 'codex':
      return `${agent} runs on Codex, which reports no cost here, so a spend cap can't hold for it.` // never today
    case 'acp':
      return `${agent} is an ACP agent, whose cost may not be in dollars, so a spend cap can't hold for it.`
    case 'ag-ui':
      return `${agent} runs on a remote server that reports no cost, so a spend cap can't hold for it.`
    default:
      return assertNever(engine)
  }
}

/** A run's spend cap that could not be checked against its agents' engines (a lookup failed): the run is refused, never run uncapped. */
export const SPEND_CAP_UNCHECKED = "The spend cap could not be checked against this run's agents, so the run did not start."

/** Why an agent whose engine has no `bridges` (ZumiBot's own to-do, vault, ask and browser tools) can't be given a card. */
export function bridgeRefusal(engine: Engine, agent: string): string {
  switch (engine) {
    case 'claude':
      return `${agent} gets none of ZumiBot's to-do, vault, ask or browser tools, so it can't be given cards.` // never today
    case 'codex':
      return `${agent} runs on Codex, which gets none of ZumiBot's to-do, vault, ask or browser tools here, so it can't be given cards.` // never today
    case 'acp':
      return `${agent} is an ACP agent and gets none of ZumiBot's to-do, vault, ask or browser tools, so it can't be given cards.`
    case 'ag-ui':
      return `${agent} is a remote agent and gets none of ZumiBot's to-do, vault, ask or browser tools, so it can't be given cards.`
    default:
      return assertNever(engine)
  }
}

/**
 * Why `/todo`, or a command that makes to-dos, is refused for an agent without `bridges`: its request asks for ZumiBot's
 * to-do tools, which that agent does not have. Fixed text per engine.
 */
export function todoRefusal(engine: Engine, agent: string): string {
  const tail = "gets none of ZumiBot's to-do tools, so /todo and commands that make to-dos can't be used with it."
  switch (engine) {
    case 'claude':
      return `${agent} ${tail}` // never today
    case 'codex':
      return `${agent} runs on Codex, which ${tail}` // never today
    case 'acp':
      return `${agent} is an ACP agent and ${tail}`
    case 'ag-ui':
      return `${agent} is a remote agent and ${tail}`
    default:
      return assertNever(engine)
  }
}

/** Why an isolation level is refused for an agent whose engine has no `isolation`; `null` is Agent Studio's reason for both. */
export function isolationRefusal(engine: Engine, level: 'sandbox' | 'container' | null): string {
  switch (engine) {
    case 'claude':
      return level === null
        ? 'Isolation is not available for this agent.'
        : `${level === 'sandbox' ? 'Sandboxed' : 'Container'} isolation is not available for this agent.` // never today
    // Master's Codex sentences, word for word.
    case 'codex':
      return level === null
        ? 'Isolation is not available for Codex agents yet.'
        : `${level === 'sandbox' ? 'Sandboxed' : 'Container'} isolation is not available for Codex agents yet.`
    case 'acp':
      return level === null
        ? "Isolation is not available for ACP agents: ZumiBot can't sandbox or contain an ACP agent's own processes."
        : `${level === 'sandbox' ? 'Sandboxed' : 'Container'} isolation is not available for ACP agents, so the run was not started. Set this agent's Isolation to Off in Agent Studio to run it.`
    case 'ag-ui':
      return level === null
        ? 'Isolation is not available for remote agents: their tools run on their own server, outside this machine.'
        : `${level === 'sandbox' ? 'Sandboxed' : 'Container'} isolation is not available for remote agents, so the run was not started. Set this agent's Isolation to Off in Agent Studio to run it.`
    default:
      return assertNever(engine)
  }
}

/**
 * Why a comment that mentions an agent without `bridges` is refused: the agent would answer in a chat for the card, which
 * relies on ZumiBot's to-do tools. Fixed text per engine; the agent's name is the user's own.
 */
export function commentAskRefusal(engine: Engine, agent: string): string {
  const tail = "gets none of ZumiBot's to-do tools, so it can't answer comments on a card."
  switch (engine) {
    case 'claude':
      return `${agent} ${tail}` // never today
    case 'codex':
      return `${agent} runs on Codex, which ${tail}` // never today
    case 'acp':
      return `${agent} is an ACP agent and ${tail}`
    case 'ag-ui':
      return `${agent} is a remote agent and ${tail}`
    default:
      return assertNever(engine)
  }
}

/**
 * The `unguarded` notice: codex never confirmed ZumiBot's hooks, so a turn runs without them (see ChatService). It names only
 * what that run lost: the vault guard, the agent's API keys (granted ones only, and they ride only beside the guard) and the
 * pause hook, after which a Pause lands only when the reply ends. `member` is a room member's display name. Fixed text.
 */
export function unguardedNoticeText(o: { vault: boolean; keys: boolean; pause: boolean; member?: string }): string {
  const reply = o.member === undefined ? 'this reply' : `${o.member}'s reply`
  const lost = [...(o.vault ? ['the vault guard'] : []), ...(o.vault && o.keys ? ["the agent's API keys"] : [])]
  const head = "Codex didn't confirm ZumiBot's hooks, so"
  if (lost.length)
    return `${head} ${reply} runs without ${lost.join(' or ')}${o.pause ? ', and Pause takes effect only when it ends' : ''}.`
  return o.pause ? `${head} Pause takes effect only when ${reply} ends.` : `${head} ${reply} runs without them.`
}
