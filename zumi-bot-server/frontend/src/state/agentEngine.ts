// Pure rules for the engine (Claude or Codex) in Agent Studio, the agent rows, the Vault editor and a chat's composer.
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import {
  assertNever,
  byEngine,
  missingFeatures,
  spendCapRefusal,
  CODEX_REFUSALS,
  chatEngine,
  engineCaps,
  engineOfAgent,
  ENGINE_LABEL,
  ENGINES,
  markEngine,
  providerOf,
  type CodexInfo,
  type Engine,
  type EngineCaps,
  type Provider
} from '@zumibot/shared/engine'
import { MODEL_OPTIONS } from '@zumibot/shared/frontmatter'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import type { VaultKind } from '@zumibot/shared/vault'
import { ACP_API_KEY_NOTE } from '@zumibot/shared/acp'
import { AGUI_API_KEY_NOTE, AGUI_TEXT } from '@zumibot/shared/agui'

export const CODEX_UNUSED_NOTE = 'Tools, memory, computer use and command models are not used by Codex agents.'
export const API_KEY_CODEX_NOTE = 'API keys need a later version for Codex agents'
// The limit every agent lives with, as Settings › Vault's foot says it: the vault guard (a hook on Codex) is a speed bump, not a
// wall. Codex's own limit last: a run whose hook codex won't confirm goes on without it, and so without the keys.
export const CODEX_VAULT_NOTE =
  "Codex agents are kept off the vault's files as Claude agents are: a speed bump, not a wall. Agents run as the same user as this server, so a determined agent could still read the vault files. A reply whose guard can't start runs without it and without the agent's API keys, after a notice in the chat saying so."

/** A failed lookup must not lock Codex out: the server refuses a missing CLI itself, with the same sentence. */
export const CODEX_INFO_FALLBACK: CodexInfo = { found: true, models: [] }

export const CLAUDE_NOT_FOUND = 'Claude CLI not found'

/**
 * Why a chat can't send for want of its own CLI, or null: a Codex chat needs codex (a lookup not answered yet counts as
 * found, as CODEX_INFO_FALLBACK does), never claude; any other chat (a room too) needs claude.
 */
export function cliMissing(engine: Engine, claudeFound: boolean, codex: CodexInfo | undefined): string | null {
  switch (engine) {
    case 'claude':
      return claudeFound ? null : CLAUDE_NOT_FOUND
    case 'codex':
      return codex?.found === false ? CODEX_REFUSALS.notFound : null
    // Each ACP agent has its own command: the server says which one is missing, when the send runs.
    case 'acp':
      return null
    // A remote agent needs nothing installed here: the server checks its endpoint when the send runs.
    case 'ag-ui':
      return null
    default:
      return assertNever(engine)
  }
}

export const usesCodex = (fields: { provider?: Provider | null }): boolean => fields.provider === 'codex'

/** The engine an Agent Studio form's `provider` names: null or absent is Claude. */
export const engineOfFields = (fields: { provider?: Provider | null } | null | undefined): Engine =>
  markEngine(fields?.provider ?? undefined)

/** Agent Studio's Compact at card: shown only while the agent's engine compacts, so nothing about Compact is left half on. */
export const showsCompactAt = (provider: Provider | null | undefined, caps: (e: Engine) => EngineCaps = engineCaps): boolean =>
  caps(engineOfFields({ provider })).compact

/** The hint under the Engine select while Codex is picked; null for Claude. */
export const codexVaultNote = (provider: Provider | null | undefined): string | null => (provider === 'codex' ? CODEX_VAULT_NOTE : null)

export interface EngineChoice {
  value: Engine
  label: string
  /** What `onFields({provider})` gets: null is Claude (the key is absent). */
  provider: Provider | null
  active: boolean
  disabled: boolean
  title: string | undefined
}

// The Engine select's names: an ACP agent is any agent's CLI, so "ACP" alone would read as a product.
const CHOICE_LABEL: Record<Engine, string> = {
  claude: ENGINE_LABEL.claude,
  codex: ENGINE_LABEL.codex,
  acp: 'ACP agent',
  'ag-ui': 'Remote agent (AG-UI)'
}

/** The Engine select: Codex is off while the CLI is missing, with the fixed sentence as its title. */
export function engineChoices(provider: Provider | null | undefined, info: CodexInfo): EngineChoice[] {
  const current = engineOfFields({ provider })
  return ENGINES.map((engine) => {
    const off = unavailable(engine, info)
    return {
      value: engine,
      label: CHOICE_LABEL[engine],
      provider: providerOf(engine),
      active: engine === current,
      disabled: off !== null,
      title: off ?? undefined
    }
  })
}

/** Why the Engine select can't offer an engine on this machine (its CLI is missing), or null. */
function unavailable(engine: Engine, info: CodexInfo): string | null {
  switch (engine) {
    case 'claude':
      return null
    case 'codex':
      return info.found ? null : CODEX_REFUSALS.notFound
    case 'acp':
      return null // its command is per agent, checked by the server
    case 'ag-ui':
      return null // nothing to install: its endpoint is checked by the server
    default:
      return assertNever(engine)
  }
}

export interface CodexModelChoices {
  /** `value` null is no key (the CLI's own default). */
  choices: { value: string | null; label: string; active: boolean }[]
  /** A model the CLI does not list (typed by hand or read from the file): shown as free text. */
  custom: string | null
}

/** The Codex model buttons: Default, then what `codex` offers; anything else stays visible as custom text. */
export function codexModelChoices(model: string | null, info: CodexInfo): CodexModelChoices {
  const inherit = model === null || model === 'inherit'
  const listed = !inherit && info.models.includes(model)
  return {
    choices: [{ value: null, label: 'Default', active: inherit }, ...info.models.map((m) => ({ value: m, label: m, active: m === model }))],
    custom: inherit || listed ? null : model
  }
}

/** The small tag beside an agent's name. */
const ENGINE_TAG: Record<Engine, string | null> = { claude: null, codex: ENGINE_LABEL.codex, acp: ENGINE_LABEL.acp, 'ag-ui': 'Remote' }
// A stored attempt's engine may be one this build does not know: no tag, never a prototype member.
export const engineTagOf = (engine: Engine): string | null => byEngine(ENGINE_TAG, engine, null)
export const engineTag = (agent: { provider?: Provider }): string | null => engineTagOf(engineOfAgent(agent))

/** The note beside a Codex agent's checkbox on an API key item while Codex runs get no keys (the vaultKeys cap); the grant still saves. */
export function vaultGrantNote(
  kind: VaultKind,
  agent: { provider?: Provider },
  caps: (e: Engine) => EngineCaps = engineCaps
): string | null {
  const engine = engineOfAgent(agent)
  return kind === 'apiKey' && !caps(engine).vaultKeys ? apiKeyNote(engine) : null
}

function apiKeyNote(engine: Engine): string {
  switch (engine) {
    case 'claude':
      return 'API keys need a later version for this agent' // never today: Claude runs always get them
    case 'codex':
      return API_KEY_CODEX_NOTE
    case 'acp':
      return ACP_API_KEY_NOTE
    case 'ag-ui':
      return AGUI_API_KEY_NOTE
    default:
      return assertNever(engine)
  }
}

/**
 * The model to keep when the engine changes: only one the target engine knows, else null (the key is removed, the
 * agent's default). Claude's `opus` would otherwise reach Codex's thread/start, and `gpt-5` sit on a Claude agent.
 */
export function modelAfterEngineSwitch(model: string | null, to: Engine, codexModels: readonly string[]): string | null {
  if (model === null) return null
  switch (to) {
    case 'claude':
      return (MODEL_OPTIONS as readonly string[]).includes(model) ? model : null
    case 'codex':
      return codexModels.includes(model) ? model : null
    case 'acp':
      return null // an ACP agent's model is its own config option (no `models` cap)
    case 'ag-ui':
      return null // a remote agent's model is its server's (no `models` cap)
    default:
      return assertNever(to)
  }
}

/** Whether the member pickers offer an agent: never Zumi Bot, and a Codex agent only while Codex rooms are on. */
export const joinsRooms = (agent: Pick<AgentSummary, 'name' | 'provider'>, caps: (e: Engine) => EngineCaps = engineCaps): boolean =>
  agent.name !== ZUMI_BOT_NAME && caps(engineOfAgent(agent)).rooms

type EngineChat = Pick<ChatMeta, 'agentName' | 'group'>

/** What a room member's turn can do: its own agent's engine's caps (a single chat: its agent's). */
export const memberCaps = (
  chat: EngineChat,
  agents: readonly AgentSummary[],
  member: string,
  caps: (e: Engine) => EngineCaps = engineCaps
): EngineCaps => caps(chatEngine(chat, agents, member))

// What a room's controls need from every member: one press reaches all of them (Pause), or the message's turns span them
// (Edit, Resend, version switching and Fork rewind every member's session; a spend cap holds only if every member reports a cost).
const EVERY_MEMBER: readonly (keyof EngineCaps)[] = ['pause', 'resend', 'fork', 'cost']

/**
 * What a chat can do, for the controls that act on it as a whole. A single chat: its agent's engine. A room: a control shows
 * while any member's engine has it (a side question, a panel or Compact reaches one member at a time), except EVERY_MEMBER's,
 * which need every member's (the server refuses them otherwise).
 */
export function chatCaps(chat: EngineChat, agents: readonly AgentSummary[], caps: (e: Engine) => EngineCaps = engineCaps): EngineCaps {
  if (!chat.group) return caps(chatEngine(chat, agents))
  const each = chat.group.members.map((m) => memberCaps(chat, agents, m, caps))
  if (each.length === 0) return caps('claude')
  const out = { ...each[0] }
  for (const key of Object.keys(out) as (keyof EngineCaps)[]) {
    out[key] = EVERY_MEMBER.includes(key) ? each.every((c) => c[key]) : each.some((c) => c[key])
  }
  return out
}

// In shared, so agents:testAcp names what it hides the same way.
export { missingFeatures }

/** The agent label's tooltip in a chat: one sentence listing what the engine can't do, so the missing buttons are explained in one place. */
export function missingFeaturesTitle(engine: Engine, caps: EngineCaps): string | undefined {
  const list = missingFeatures(caps)
  return list.length === 0 ? undefined : `${ENGINE_LABEL[engine]} agents can't use: ${list.join(', ')}.`
}

/** The daily spend cap to keep when the engine changes: none on an engine without `cost`, where the field is hidden and a save is refused. */
export const dailyCapAfterEngineSwitch = (cap: number | null, to: Engine, caps: (e: Engine) => EngineCaps = engineCaps): number | null =>
  caps(to).cost ? cap : null

/**
 * The fixed sentence Agent Studio shows in place of the daily cap card when the file already holds a cap (a hand edit, a sync) on
 * an engine without `cost`, where it can never trip and a save is refused; null otherwise (the card shows, or nothing does).
 */
export const dailyCapBlocked = (
  engine: Engine,
  name: string,
  cap: number | null,
  caps: (e: Engine) => EngineCaps = engineCaps
): string | null => (cap !== null && !caps(engine).cost ? spendCapRefusal(engine, name) : null)

/** The same list for a room, whose caps are its members' (`chatCaps`): what the room as a whole can't do. */
export function roomMissingFeaturesTitle(caps: EngineCaps): string | undefined {
  const list = missingFeatures(caps)
  return list.length === 0 ? undefined : `This room can't use: ${list.join(', ')}.`
}

/** The chip beside a remote agent's name: where it runs, with the fixed notice as its title. Null for an agent that runs here, or a remote one with no endpoint yet. */
export function remoteChip(
  agent: Pick<AgentSummary, 'provider' | 'remoteHost'> | undefined,
  caps: (e: Engine) => EngineCaps = engineCaps
): { label: string; title: string } | null {
  const host = agent?.remoteHost
  if (agent === undefined || host === undefined || !caps(engineOfAgent(agent)).remote) return null
  return { label: `Remote · ${host}`, title: AGUI_TEXT.remoteNotice(host) }
}

/**
 * Whether the `/` menu offers `/todo`: only while every agent of the chat has the `bridges` cap. The request tells the agent to
 * use ZumiBot's to-do tools, so one without them (ACP, remote) never gets it, and a room's goes to every member that answers.
 */
export const offersTodo = (agents: readonly Pick<AgentSummary, 'provider'>[], caps: (e: Engine) => EngineCaps = engineCaps): boolean =>
  agents.every((a) => caps(engineOfAgent(a)).bridges)
