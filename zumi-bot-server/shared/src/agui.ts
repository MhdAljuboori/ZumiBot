import type { EngineCaps } from './engine'
import { envNameError } from './vault'

/**
 * Where a remote AG-UI agent is reached. It lives in the agent file's `agui:` key and is confirmed per machine (launch trust).
 * `authKey` is the env name of a Vault API key, never its value.
 */
export interface AguiLaunch {
  endpoint: string
  authKey: string | null
  authHeader: string | null
}

const MAX_ENDPOINT = 2048
const MAX_HEADER = 64

// RFC 9110 token. The header name is written into a request, so anything wider could split it.
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// Hop-by-hop headers (the proxy and the connection own them), plus Host, and Accept and Accept-Encoding, which the client sets itself.
const REFUSED_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'accept',
  'accept-encoding'
])

const isToken = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= MAX_HEADER && TOKEN.test(v)

/** Why a header name cannot carry the key (a fixed sentence), or null. */
export function authHeaderError(name: string): string | null {
  if (!isToken(name)) return AGUI_TEXT.authHeaderInvalid('')
  const l = name.toLowerCase()
  return REFUSED_HEADERS.has(l) || l.startsWith('content-') ? AGUI_TEXT.authHeaderInvalid(name) : null
}

// An address with a space, a control character or NUL could smuggle a second line into the request; checked on the raw text, since `new URL` strips some.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHAR = /[\s\u0000-\u001f\u007f-\u009f]/

/** Why an endpoint is not usable (the shape only: the address checks run at save, Test and every run), or null. */
function endpointError(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > MAX_ENDPOINT || UNSAFE_CHAR.test(v) || v.includes('#')) return AGUI_TEXT.endpointInvalid
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return AGUI_TEXT.endpointInvalid
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username !== '' || u.password !== '' || u.host === '')
    return AGUI_TEXT.endpointInvalid
  return null
}

/** The launch an `agui:` value describes, or null for any shape that is not exactly one (never partially trusted). */
export function parseAguiLaunch(v: unknown): AguiLaunch | null {
  if (aguiLaunchError(v) !== null) return null
  const o = v as { endpoint: string; authKey?: string | null; authHeader?: string | null }
  return { endpoint: o.endpoint, authKey: o.authKey ?? null, authHeader: o.authHeader ?? null }
}

/** Why an `agui:` value is not a launch (a fixed sentence, never the value), or null when `parseAguiLaunch` reads it. */
export function aguiLaunchError(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return AGUI_TEXT.endpointRequired
  const o = v as Record<string, unknown>
  if (o.endpoint === undefined || o.endpoint === '') return AGUI_TEXT.endpointRequired
  const bad = endpointError(o.endpoint)
  if (bad !== null) return bad
  const key = o.authKey ?? null
  if (key !== null && (typeof key !== 'string' || envNameError(key) !== null)) return AGUI_TEXT.authKeyInvalid
  const header = o.authHeader ?? null
  if (header !== null) {
    const refused = typeof header === 'string' ? authHeaderError(header) : AGUI_TEXT.authHeaderInvalid('')
    if (refused !== null) return refused
    if (key === null) return AGUI_TEXT.authHeaderWithoutKey
  }
  return null
}

/** A stable JSON of the three fields (fixed key order), for launch trust. */
export function aguiLaunchRecord(l: AguiLaunch): string {
  return JSON.stringify({ endpoint: l.endpoint, authKey: l.authKey, authHeader: l.authHeader })
}

/** The host (with a non-default port) the endpoint names, or null. Logs and errors name this and never the path or query. */
export function aguiHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).host || null
  } catch {
    return null
  }
}

/** What `chats/<id>.agui.json` holds: the thread id, the kept state and the interrupts still open. */
export interface AguiThread {
  v: 1
  threadId: string
  state: unknown | null
  interrupts: { id: string; expiresAt: string | null }[]
}

/** The record a file holds, or null for any other shape (read as "no thread yet", so a damaged file starts a fresh thread). */
export function parseAguiThread(v: unknown): AguiThread | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o.v !== 1 || typeof o.threadId !== 'string' || o.threadId === '' || !Array.isArray(o.interrupts)) return null
  const interrupts: AguiThread['interrupts'] = []
  for (const i of o.interrupts) {
    if (i === null || typeof i !== 'object' || Array.isArray(i)) return null
    const r = i as Record<string, unknown>
    const expiresAt = r.expiresAt ?? null
    if (typeof r.id !== 'string' || r.id === '' || (expiresAt !== null && typeof expiresAt !== 'string')) return null
    interrupts.push({ id: r.id, expiresAt })
  }
  return { v: 1, threadId: o.threadId, state: o.state ?? null, interrupts }
}

/** A remote tool's row (its input `{tool, args}`, or `argsText` for arguments that are not JSON): it ran on the agent's server. */
export const AGUI_TOOL = 'AguiTool'

/**
 * Beside a remote agent's checkbox on an API key item: its runs get no keys as env (no `vaultKeys`), only the one named as its
 * auth key, in one request header.
 */
export const AGUI_API_KEY_NOTE = 'API keys reach a remote agent only as its auth key, in one request header'

// Fixed sentences. They name a host, an env name or a status, never a value, a path or a query.
export const AGUI_TEXT = {
  /** An `agui:` that is absent or does not parse: there is nothing to call, so nothing is guessed. */
  noEndpoint: 'This agent has no endpoint to call. Set one in Agent Studio and save.',
  untrusted: "This agent's endpoint changed outside Agent Studio. Open it in Agent Studio and save to confirm.",
  redirected: 'The endpoint redirected to another host',
  cut: 'The connection ended before the agent finished.',
  noTools: 'ZumiBot runs no tools for this agent',
  remoteNotice: (host: string) =>
    `Runs outside this machine, at ${host}. Every message of its chats, and the chat's history, is sent there.`,
  // Agent Studio's checks on the launch (validateFields), in the style of its other field errors.
  endpointRequired: 'Endpoint is required for a remote agent',
  endpointInvalid: `The endpoint must be an https address of at most ${MAX_ENDPOINT} characters, with no spaces, no username or password and no #`,
  /** An `agui:` the file holds but that does not parse. */
  launchUnreadable:
    'The agui: launch could not be read. Write the endpoint, authKey and authHeader as text (authKey as an env name). Fix it in the Raw view.',
  authKeyInvalid: 'The auth key must be the env name of an API key',
  // The name is shown only when it is a plain token, so a header with a line break in it never reaches a sentence.
  authHeaderInvalid: (name: string) =>
    `The auth header${name !== '' && isToken(name) ? ` ${name}` : ''} must be a plain header name of at most ${MAX_HEADER} characters, and not Host, Accept, Accept-Encoding, Content-* or a connection header`,
  authHeaderWithoutKey: 'An auth header needs an auth key to send',
  authKeyMissing: (name: string) => `The agent needs the key ${name} as its authKey, but it is not granted to this agent in the Vault.`,
  authKeyUnusable: (name: string) => `The key ${name} cannot be sent as a header value. Check the authKey in the Vault.`,
  // The network.
  resolveFailed: (host: string) => `ZumiBot could not find the address of ${host}.`,
  notPublic: (host: string) => `${host} is not a public address, so ZumiBot does not connect to it.`,
  status: (code: number) => `The agent's server answered with status ${code}.`,
  unauthorized: (code: number, authKey: string | null) =>
    authKey === null
      ? `The agent's server answered with status ${code}: it wants a key. Set an authKey for this agent in Agent Studio.`
      : `The agent's server answered with status ${code}: it did not accept the key ${authKey}. Check authKey in Agent Studio and the key in the Vault.`,
  notSse: 'The endpoint did not answer with an event stream.',
  connectTimeout: (host: string) => `ZumiBot could not connect to ${host} within 10 seconds.`,
  headersTimeout: 'The agent did not start answering within 30 seconds.',
  idleTimeout: 'The agent sent nothing for 120 seconds, so ZumiBot ended the run.',
  runTimeout: 'The run took longer than 30 minutes, so ZumiBot ended it.',
  bodyTooBig: "The agent's reply is over 16 MiB, so ZumiBot ended the run.",
  eventTooBig: 'The agent sent an event over 1 MiB, so ZumiBot ended the run.',
  network: (host: string, code: string) => `The connection to ${host} failed (${code}).`,
  // The stream.
  unreadable: 'The agent sent an event ZumiBot could not read.',
  protocol: 'The agent speaks a major version of the protocol that ZumiBot does not support.',
  /** `message` is the server's, already cut to 500 characters and scrubbed by the caller. */
  runError: (message: string, code: string | null) =>
    code === null || code === '' ? `The agent reported an error: ${message}` : `The agent reported an error (${code}): ${message}`,
  // The turn.
  noAttachments: 'Attachments are not sent to remote agents. Send the message without them.',
  otherEngine: 'This chat began on another engine, so its history is never sent to a remote agent: start a new chat for this agent.',
  pendingTools: 'The agent asked for tools ZumiBot does not run for it, so each call was answered with an error.',
  interruptDeclined: (reason: string) => `The agent asked for an approval ZumiBot could not show (${reason}), so it was cancelled.`,
  tooManyRounds: 'The agent kept asking for approvals, so ZumiBot ended the turn after 10 rounds.',
  /** A tool row the agent never finished (the turn ended, stopped or crashed first). */
  toolUnfinished: 'The tool call did not finish.',
  /** A remote tool row's title: the name is the server's, already made visible and cut by the caller. */
  remoteTool: (name: string | null) => (name === null ? 'A tool (ran on the remote server)' : `${name} (ran on the remote server)`),
  zumiBotPick: (name: string) => `Zumi Bot does not pick ${name}: it is a remote agent, and only you choose one.`,
  /** Never shown while `rewind` is off for AG-UI (no cut run reaches a remote agent); here so the engine names no other's text. */
  forkIgnored: "The agent did not start a separate thread, so this reply was stopped before it could change an earlier version's memory.",
  // agents:testAgui's answers.
  notAgui: 'This agent is not saved as a remote agent. Pick Remote agent (AG-UI) as its engine and save, then test it.',
  testUnavailable: 'Testing remote agents is not available on this server.',
  testTimeout: (host: string) => `${host} did not complete a secure connection within 10 seconds.`,
  testFailed: (host: string, code: string) => `ZumiBot could not connect to ${host} (${code}).`
} as const

/** Agent Studio's fixed notes on the remote agent card (see docs/architecture/protocol-engines.md, Agent file, auth and the remote notice). */
export const AGUI_STUDIO_TEXT = {
  remote: (host: string) => AGUI_TEXT.remoteNotice(host),
  body: "This agent's instructions are not sent: a remote agent's behaviour is its server's",
  header: 'Authorization sends Bearer <value>, any other header the bare value',
  testNote: 'Test checks the address and connects. It sends no request, so no message or key leaves this machine',
  olderChats:
    'Chats this agent had on another engine do not continue on a remote agent: their history would be sent to its host. Start a new chat for it.',
  noKeys: 'No API keys are granted to this agent. Grant one in Settings › Vault to pick it here.',
  notGranted: 'not granted to this agent',
  unused: 'Model, tools, memory, computer use, Compact at, the daily spend cap and the extension keys are not used by remote agents.',
  confirmed: 'Confirmed on this machine',
  current: 'Save confirms',
  unconfirmed: "This endpoint is not confirmed on this machine, so the agent doesn't run until you save it here.",
  // A moved endpoint takes the existing chats along: their history is sent to the new host from the next message.
  changed:
    "This agent's endpoint is not the one confirmed on this machine, so the agent doesn't run until you save it here. Existing chats continue at the new host.",
  testSaveFirst: 'Save this agent as a remote agent to test it.',
  testUnsaved: 'Save first: Test checks the saved endpoint.',
  // The card's own labels and hints.
  title: 'Remote agent',
  meta: 'AG-UI',
  endpointLabel: 'Endpoint',
  endpointPlaceholder: 'https://agents.example.com/run',
  endpointHint: 'An https address. Save checks that it resolves to a public address.',
  keyLabel: 'Auth key',
  keyNone: 'None',
  headerLabel: 'Auth header',
  headerPlaceholder: 'Authorization',
  test: 'Test',
  testing: 'Testing…',
  // Test's answer, one row each.
  rowHost: 'Host',
  rowAddresses: 'Addresses',
  rowConnection: 'Connection',
  rowAuthKey: 'Auth key',
  rowHides: 'ZumiBot hides',
  secure: 'Secure (TLS), certificate verified',
  plain: 'Plain, to this machine only (development)',
  noKey: 'None: requests carry no key',
  keyGranted: 'granted to this agent',
  hidesNothing: 'Nothing'
} as const

/** What `agents:testAgui` read: the checked host and its addresses, the TLS handshake, the key, and what ZumiBot enables and hides. */
export interface AguiTestInfo {
  host: string
  /** Every address the name resolved to; all were public, or the test is an error. */
  addresses: string[]
  /** The TLS handshake completed with Node's default verification. false for a plain loopback `http:` under the dev hook. */
  tls: boolean
  authKey: string | null
  /** The auth key is granted to this agent in the Vault (false with no key). */
  authKeyGranted: boolean
  caps: EngineCaps
  /** What ZumiBot hides for this engine, named as the buttons are (`missingFeatures`). */
  hidden: string[]
}

export type AguiTestResult = AguiTestInfo | { error: string }
