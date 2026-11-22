import type { EngineCaps } from './engine'
import { envNameError } from './vault'

/** How an ACP agent is started. It lives in the agent file's `acp:` key and is confirmed per machine (launch trust). */
export interface AcpLaunch {
  command: string
  args: string[]
  authEnv: string[]
}

const MAX_TEXT = 4096
const MAX_ARGS = 64
const MAX_AUTH_ENV = 16

const text = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT && !v.includes('\0')

/** The launch an `acp:` value describes, or null for any shape that is not exactly one (never partially trusted). */
export function parseAcpLaunch(v: unknown): AcpLaunch | null {
  if (acpLaunchError(v) !== null) return null
  const o = v as { command: string; args?: string[]; authEnv?: string[] }
  return { command: o.command, args: [...(o.args ?? [])], authEnv: [...(o.authEnv ?? [])] }
}

/** Why an `acp:` value is not a launch (a fixed sentence, never the value), or null when `parseAcpLaunch` reads it. */
export function acpLaunchError(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return ACP_TEXT.commandRequired
  const o = v as Record<string, unknown>
  if (o.command === undefined || o.command === '') return ACP_TEXT.commandRequired
  if (!text(o.command)) return ACP_TEXT.commandInvalid
  const args = o.args ?? []
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every(text)) return ACP_TEXT.argsInvalid
  const authEnv = o.authEnv ?? []
  if (!Array.isArray(authEnv) || authEnv.length > MAX_AUTH_ENV || !authEnv.every((n) => typeof n === 'string' && envNameError(n) === null))
    return ACP_TEXT.authEnvInvalid
  return null
}

// Allow-everything arguments. A speed bump, not a guarantee: the agent's own config can still allow everything.
const REFUSED_FLAGS = new Set([
  '--yolo',
  '-y',
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--allow-all-tools',
  '--trust-all-tools',
  '--auto-approve',
  '--force',
  '-f'
])
// Flag -> the values that allow everything (compared lower case).
// Maps, not object literals: an argument is user text, and `toString` or `__proto__` must not resolve to an inherited member.
const REFUSED_VALUES: ReadonlyMap<string, readonly string[]> = new Map([
  ['--approval-mode', ['yolo']],
  ['--permission-mode', ['bypasspermissions', 'dontask']]
])
const SPELLING: ReadonlyMap<string, string> = new Map([
  ['yolo', 'yolo'],
  ['bypasspermissions', 'bypassPermissions'],
  ['dontask', 'dontAsk']
])

/** The refused flag (with its value, when the value is what allows everything), or null. */
export function refusedArg(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const eq = a.indexOf('=')
    const flag = eq < 0 ? a : a.slice(0, eq)
    // `--yolo=true` is still `--yolo`: the sentence names the flag, never the value.
    if (REFUSED_FLAGS.has(flag)) return flag
    const bad = REFUSED_VALUES.get(flag)
    if (!bad) continue
    const value = (eq < 0 ? args[i + 1] : a.slice(eq + 1))?.toLowerCase()
    if (value !== undefined && bad.includes(value)) return `${flag} ${SPELLING.get(value)}`
  }
  return null
}

/** A mode id that allows everything, which ZumiBot never selects for the user. */
export function refusedMode(id: string): boolean {
  if (id === 'bypassPermissions' || id === 'dontAsk' || id === 'yolo') return true
  const l = id.toLowerCase()
  return l.includes('bypass') || l.includes('yolo') || l.includes('dangerous')
}

/**
 * The mode id ZumiBot puts every ACP session in before its prompt, when the agent offers it: the conventional "ask before
 * acting" mode (the Claude adapter's Manual, Gemini CLI's default). An agent without it keeps its own mode.
 */
export const ACP_ASK_MODE = 'default'

/** A stable JSON of the three fields (fixed key order), for launch trust. */
export function launchRecord(l: AcpLaunch): string {
  return JSON.stringify({ command: l.command, args: l.args, authEnv: l.authEnv })
}

/**
 * Beside an ACP agent's checkbox on an API key item: its runs get no keys as env (no `vaultKeys`), only those its own sign-in
 * needs (`acp.authEnv`), so a grant alone gives it nothing.
 */
export const ACP_API_KEY_NOTE = 'API keys reach an ACP agent only when they are named in its sign-in keys'

/** The two options of a boolean question on the card. The card answers with the label, so both sides read these. */
export const ACP_YES_NO = { yes: 'Yes', no: 'No' } as const

// Fixed sentences. They name a command, a flag, a mode or an env name, never a value, argv or a key.
export const ACP_TEXT = {
  notFound: (command: string) =>
    `ZumiBot could not find the command "${command}" for this agent. Install it, or set the right command in Agent Studio.`,
  notSignedIn: (methods: readonly string[]) =>
    methods.length > 0
      ? `The agent is not signed in. Sign in with the agent's own tool (${methods.join(', ')}), then send again.`
      : "The agent is not signed in. Sign in with the agent's own tool, then send again.",
  protocol: 'The agent does not speak a version of the protocol ZumiBot supports.',
  unreadable: 'The agent sent a reply ZumiBot could not read',
  // -f and --force are refused whatever the agent: cursor-agent reads them as "run commands without asking".
  refusedArg: (flag: string) =>
    flag === '-f' || flag === '--force'
      ? `ZumiBot does not run an agent with ${flag}, which lets some agents (cursor-agent) run commands without asking. Remove it in Agent Studio.`
      : `ZumiBot does not run an agent with ${flag}, which lets it act without asking. Remove it in Agent Studio.`,
  // The session keeps that mode, so every later turn of the chat refuses too: the sentence says how to get past it.
  refusedMode: (id: string) =>
    `ZumiBot does not use the agent's "${id}" mode, which lets it act without asking. Start a new chat, or change the mode in the agent's own settings.`,
  askModeFailed: `The agent would not switch to its "${ACP_ASK_MODE}" mode, so ZumiBot did not send the message.`,
  untrusted: "This agent's command changed outside Agent Studio. Open it in Agent Studio and save to confirm.",
  /** An `acp:` that is absent or does not parse: there is nothing to run, so nothing is guessed. */
  noCommand: 'This agent has no command to run. Set one in Agent Studio and save.',
  authEnvMissing: (name: string) => `The agent needs the key ${name}, but it is not granted to this agent in the Vault.`,
  /** Images only: any other attachment reaches the agent as a path in the message, as for Codex. */
  noImages: 'This agent cannot take images. Send the message without them.',
  stopped: (code: number | string | null) => `The agent stopped unexpectedly (exit ${code === null ? 'unknown' : String(code)}).`,
  stopReason: (reason: string) => `The agent ended the turn: ${reason}.`,
  /** A tool row the agent never finished (the turn ended, stopped or crashed first). */
  toolUnfinished: 'The tool call did not finish.',
  /** Never shown while `rewind` is off for ACP (no cut run reaches an ACP agent); here so the engine names no other's text. */
  forkIgnored: "The agent did not start a separate session, so this reply was stopped before it could change an earlier version's memory.",
  // Agent Studio's checks on the launch (validateFields), in the style of its other field errors.
  commandRequired: 'Command is required for an ACP agent',
  commandInvalid: 'The command must be at most 4096 characters, with no NUL character',
  argsInvalid: 'Arguments must be text: at most 64 of them, each at most 4096 characters',
  authEnvInvalid: 'Sign-in keys must be env names of API keys, at most 16 of them',
  /** An `acp:` the file holds but that does not parse; most often a number YAML read as one. */
  launchUnreadable:
    'The acp: launch could not be read. Write the command and every argument as text (quote a number, such as "8080"), and authEnv as a list of env names. Fix it in the Raw view.',
  // agents:testAcp's answers.
  notAcp: 'This agent is not saved as an ACP agent. Pick ACP agent as its engine and save, then test it.',
  notStarted: (command: string) => `ZumiBot could not start the command "${command}".`,
  testTimeout: 'The agent did not answer within 20 seconds.',
  testRefused: 'The agent answered the test with an error.',
  testUnavailable: 'Testing ACP agents is not available on this server.'
} as const

/** Agent Studio's fixed notes on the ACP card (see docs/architecture/protocol-engines.md, Agent file and Agent Studio). */
export const ACP_STUDIO_TEXT = {
  asks: `ZumiBot puts the agent in its "${ACP_ASK_MODE}" mode before every message, when it has one. The agent's own settings still decide which of its calls ask first (its allow rules apply in that mode too), so ZumiBot can only show a card for a call the agent asks about.`,
  args: 'Never put a key in the arguments: the agent file syncs as plain text, and arguments show in the process list. Use a sign-in key instead.',
  signIn:
    'Each picked key reaches the agent as an env variable under its own name, for its own sign-in. A prompt-injected agent can read its own env, and no guard stands beside it. With none picked, the agent signs in with its own login on this machine.',
  noKeys: 'No API keys are granted to this agent. Grant one in Settings › Vault to pick it here.',
  notGranted: 'not granted to this agent',
  unused: 'Model, tools, memory, computer use, Compact at, the daily spend cap and the extension keys are not used by ACP agents.',
  confirmed: 'Confirmed on this machine',
  current: 'Save confirms',
  unconfirmed: "This launch is not confirmed on this machine, so the agent doesn't run until you save it here.",
  changed: "This agent's launch is not the one confirmed on this machine, so the agent doesn't run until you save it here.",
  testSaveFirst: 'Save this agent as an ACP agent to test it.',
  testUnsaved: 'Save first: Test runs the saved launch.',
  testNote: 'Test starts the saved launch in an empty folder and asks only what the agent supports; no model runs.'
} as const

/** A sign-in method the agent lists: its name, and for a terminal method the command line to run. */
export interface AcpAuthHint {
  name: string
  terminal: string | null
}

/** What `agents:testAcp` read from the agent's `initialize`, plus what ZumiBot enables and hides for it. */
export interface AcpTestInfo {
  agentInfo: { name: string; title: string | null; version: string | null } | null
  protocolVersion: number
  loadSession: boolean
  resume: boolean
  /** The agent takes ZumiBot's instructions as a system prompt (else they go in the first message). */
  systemPrompt: boolean
  image: boolean
  authMethods: AcpAuthHint[]
  caps: EngineCaps
  /** What ZumiBot hides for this engine, named as the buttons are (`missingFeatures`). */
  hidden: string[]
}

export type AcpTestResult = AcpTestInfo | { error: string }
