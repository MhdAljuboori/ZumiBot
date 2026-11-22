// Pure rules for Agent Studio's ACP card: the launch draft, sign-in keys, the confirmed launch (launch trust) and Test.
// See docs/architecture/protocol-engines.md, "Agent file and Agent Studio" and "Launch trust".
import {
  ACP_STUDIO_TEXT,
  ACP_TEXT,
  acpLaunchError,
  launchRecord,
  parseAcpLaunch,
  refusedArg,
  type AcpLaunch,
  type AcpTestInfo
} from '@zumibot/shared/acp'
import { AGUI_STUDIO_TEXT, aguiLaunchRecord, type AguiLaunch } from '@zumibot/shared/agui'
import { engineCaps, type Engine, type EngineCaps, type Provider } from '@zumibot/shared/engine'
import type { VaultListItem } from '@zumibot/shared/vault'
import { aguiLaunchLine, isAguiLaunch } from './aguiCard'

/** Which of Agent Studio's cards an engine gets. */
export interface StudioCards {
  models: boolean
  tools: boolean
  compact: boolean
  dailyCap: boolean
  /** "What this agent loads": the CLI's servers, skills and plugins. */
  loadout: boolean
  memory: boolean
  desktop: boolean
  /** The agent's browser profile, used only through ZumiBot's browser bridge. */
  browser: boolean
  acp: boolean
  /** A remote (AG-UI) agent's card: endpoint, auth key and header. */
  agui: boolean
  /** In place of the instructions hint: a remote agent's instructions are never sent. */
  instructionsNote: string | null
}

export function studioCards(engine: Engine, caps: (e: Engine) => EngineCaps = engineCaps): StudioCards {
  const c = caps(engine)
  return {
    models: c.models,
    // No cap for it: only Claude's CLI takes a `tools` list (Codex and ACP agents keep their own).
    tools: engine === 'claude',
    compact: c.compact,
    dailyCap: c.cost,
    // An engine without bridges is handed no MCP config at all (an ACP session gets `mcpServers: []`): it keeps its own.
    loadout: c.bridges,
    memory: c.memory,
    desktop: c.desktop,
    browser: c.bridges,
    acp: engine === 'acp',
    agui: engine === 'ag-ui',
    instructionsNote: engine === 'ag-ui' ? AGUI_STUDIO_TEXT.body : null
  }
}

/** What the card's fields hold as the user types: the arguments as text, one per line. */
export interface AcpDraft {
  command: string
  argsText: string
  authEnv: string[]
}

/** One argument per non-blank line, each trimmed (an argument with edge spaces is set in the Raw view). */
export const argsOfText = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')

export const acpDraftOf = (launch: AcpLaunch | null): AcpDraft => ({
  command: launch?.command ?? '',
  argsText: (launch?.args ?? []).join('\n'),
  authEnv: [...(launch?.authEnv ?? [])]
})

const draftValue = (d: AcpDraft) => ({ command: d.command.trim(), args: argsOfText(d.argsText), authEnv: d.authEnv })
/** A launch of either protocol engine: the card, the compare and the pending Save read both. */
export type ProtocolLaunch = AcpLaunch | AguiLaunch

const keyOf = (l: ProtocolLaunch | null): string => (l === null ? '' : isAguiLaunch(l) ? aguiLaunchRecord(l) : launchRecord(l))

/** The confirmed launch as the ACP card reads it: a remote agent's is none, and "not known yet" stays so. */
export const confirmedAcp = (c: ProtocolLaunch | null | undefined): AcpLaunch | null | undefined =>
  c === undefined || c === null ? c : isAguiLaunch(c) ? null : c

/**
 * One edit of the card: the draft to show next and the `acp` the form gets. That is null while the draft makes no launch (no
 * command yet), so Save is refused ("Command is required") rather than saving the last launch while the card shows another.
 */
export function editAcpDraft(shown: AcpDraft, patch: Partial<AcpDraft>): { draft: AcpDraft; acp: AcpLaunch | null } {
  const draft = { ...shown, ...patch }
  return { draft, acp: parseAcpLaunch(draftValue(draft)) }
}

/**
 * The draft the card shows: the user's own while the form still holds what it made (so a new line being typed, or a cleared
 * command, stays as typed), else the form's launch (Revert, a Raw edit, a reload from disk).
 */
export function shownAcpDraft(draft: AcpDraft | null, launch: AcpLaunch | null): AcpDraft {
  if (draft !== null && keyOf(parseAcpLaunch(draftValue(draft))) === keyOf(launch)) return draft
  return acpDraftOf(launch)
}

/** The draft's problem as the save would name it: no command, a bad shape, or a refused argument. */
export function acpDraftError(d: AcpDraft): string | null {
  const v = draftValue(d)
  const bad = acpLaunchError(v)
  if (bad !== null) return bad
  const flag = refusedArg(v.args)
  return flag === null ? null : ACP_TEXT.refusedArg(flag)
}

/** A sign-in key Agent Studio offers: an env name only, never a value. */
export interface SignInKeyChoice {
  env: string
  name: string | null
  picked: boolean
  granted: boolean
}

/**
 * The env names of the API keys granted to this (saved) agent, then any name the launch lists that is no longer granted, so it
 * can be removed (a run refuses it). An unsaved agent has no grants yet.
 */
export function signInKeyChoices(items: readonly VaultListItem[], agent: string | null, authEnv: readonly string[]): SignInKeyChoice[] {
  const out: SignInKeyChoice[] = []
  for (const i of items) {
    if (i.kind !== 'apiKey' || agent === null || !i.agents.includes(agent) || out.some((c) => c.env === i.env)) continue
    out.push({ env: i.env, name: i.name, picked: authEnv.includes(i.env), granted: true })
  }
  for (const env of authEnv) if (!out.some((c) => c.env === env)) out.push({ env, name: null, picked: true, granted: false })
  return out
}

export const toggleSignInKey = (authEnv: readonly string[], env: string, on: boolean): string[] =>
  on ? (authEnv.includes(env) ? [...authEnv] : [...authEnv, env]) : authEnv.filter((n) => n !== env)

const quoted = (a: string): string => (a === '' || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a)

/** A launch as one line: the command, its arguments (one with a space or quote in JSON quotes) and its sign-in keys. */
export function launchLine(l: AcpLaunch): string {
  const line = [l.command, ...l.args].map(quoted).join(' ')
  return l.authEnv.length > 0 ? `${line} (sign-in keys: ${l.authEnv.join(', ')})` : line
}

export interface LaunchCompare {
  confirmed: string | null
  current: string
  note: string
}

/**
 * The launch confirmed on this machine beside the form's, when they differ, so Save confirms a change the user has seen. Null
 * while they agree, before the confirmed one is known (`undefined`), or with no launch in the form (the command error shows).
 */
export function launchCompare(confirmed: ProtocolLaunch | null | undefined, current: ProtocolLaunch | null): LaunchCompare | null {
  if (current === null || confirmed === undefined) return null
  // Each kind says its own notes: a moved remote endpoint takes the existing chats along.
  const text = isAguiLaunch(current) ? AGUI_STUDIO_TEXT : ACP_STUDIO_TEXT
  const line = (l: ProtocolLaunch): string => (isAguiLaunch(l) ? aguiLaunchLine(l) : launchLine(l))
  if (confirmed === null) return { confirmed: null, current: line(current), note: text.unconfirmed }
  if (keyOf(confirmed) === keyOf(current)) return null
  return { confirmed: line(confirmed), current: line(current), note: text.changed }
}

/** A confirmed launch with the engine it was asked for, so a late answer never reads as another engine's. */
export interface ConfirmedLaunch {
  engine: Engine
  launch: ProtocolLaunch | null
}

/**
 * The confirmed launch for the form's engine: undefined (not known) while what was loaded belongs to another engine, such as the
 * render after the Engine select flips between ACP and remote, so neither "not confirmed" nor a Save prompt flashes.
 */
export const confirmedFor = (engine: Engine, loaded: ConfirmedLaunch | undefined): ProtocolLaunch | null | undefined =>
  loaded !== undefined && loaded.engine === engine ? loaded.launch : undefined

/**
 * Whose confirmed launch Agent Studio asks for: the saved agent's whenever the form's engine is ACP or remote, so a file that
 * kept an `acp:` or `agui:` while on another engine shows "not confirmed" once switched back. A new agent has none to ask for.
 */
export const confirmedLaunchName = (formEngine: Engine, savedName: string | null): string | null =>
  formEngine === 'acp' || formEngine === 'ag-ui' ? savedName : null

type SavedLaunch = { provider: Provider | null; acp: AcpLaunch | null; agui?: AguiLaunch | null }

/**
 * Whether Save has something to confirm with no edit in the form: a saved ACP or remote launch that is not the one confirmed
 * here (the file changed outside Agent Studio, or it was never saved here). Save is then on, and writes the file as it is.
 */
export function confirmPending(confirmed: ProtocolLaunch | null | undefined, saved: SavedLaunch | null): boolean {
  const launch = saved === null ? null : saved.provider === 'acp' ? saved.acp : saved.provider === 'ag-ui' ? (saved.agui ?? null) : null
  if (launch === null || confirmed === undefined) return false
  return confirmed === null || keyOf(confirmed) !== keyOf(launch)
}

/** Why Test is off (a fixed sentence), or null: it runs the saved file's launch, so nothing about it may be unsaved. */
export function acpTestBlocked(saved: ({ name: string } & SavedLaunch) | null, fields: SavedLaunch): string | null {
  if (saved === null || saved.provider !== 'acp') return ACP_STUDIO_TEXT.testSaveFirst
  if (fields.provider !== 'acp' || keyOf(fields.acp) !== keyOf(saved.acp)) return ACP_STUDIO_TEXT.testUnsaved
  return null
}

/**
 * What a Test press answers: the saved name and launch at the press. A result that comes back after a Save of another launch
 * (or a rename) answers a launch the card no longer shows, so it is dropped.
 */
export const acpTestKey = (saved: { name: string; acp: AcpLaunch | null } | null): string =>
  saved === null ? '' : JSON.stringify([saved.name, keyOf(saved.acp)])

export interface AcpTestRow {
  label: string
  value: string
}

/** The Test's answer as rows: what the agent supports and how ZumiBot works with it (as the runner reads the same fields). */
export function acpTestRows(r: AcpTestInfo): AcpTestRow[] {
  const agent = r.agentInfo === null ? 'Not named' : [r.agentInfo.title ?? r.agentInfo.name, r.agentInfo.version].filter(Boolean).join(' ')
  const sessions = r.resume
    ? "Each turn resumes the agent's session"
    : r.loadSession
      ? "Each turn loads the agent's session"
      : 'Each turn starts a new session and resends the chat so far'
  return [
    { label: 'Agent', value: agent },
    { label: 'Protocol', value: `ACP v${r.protocolVersion}` },
    { label: 'Sessions', value: sessions },
    { label: 'Instructions', value: r.systemPrompt ? 'Sent as a system prompt' : 'Sent in the first message of each session' },
    { label: 'Images', value: r.image ? 'Yes' : 'No: a message with an image is refused; other attachments go as their path' },
    {
      label: 'Sign-in',
      value:
        r.authMethods.length === 0
          ? 'None listed'
          : r.authMethods.map((m) => (m.terminal ? `${m.name} (run: ${m.terminal})` : m.name)).join(', ')
    },
    { label: 'ZumiBot hides', value: r.hidden.length === 0 ? 'Nothing' : r.hidden.join(', ') }
  ]
}
