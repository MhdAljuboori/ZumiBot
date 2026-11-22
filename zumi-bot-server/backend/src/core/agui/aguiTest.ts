import { isIP, connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { AGUI_TEXT, aguiLaunchRecord, type AguiLaunch, type AguiTestResult } from '@zumibot/shared/agui'
import { missingFeatures, type EngineCaps, type Provider } from '@zumibot/shared/engine'
import type { LaunchCheck } from '../acp/launchTrust'
import { checkUrl, pinnedLookup, resolveTarget, type AguiLookup } from './aguiEndpoint'

// Agent Studio's Test of a remote agent (docs/architecture/protocol-engines.md). It checks the saved endpoint as a run does,
// then only opens a connection to the checked address and closes it: no HTTP request is made, so no message and no key leaves
// this machine. Plain `tls` and `net`, because a handshake with no request is not something `https` offers.

const TEST_MS = 10_000

/** Where to connect: the checked address(es) to pin, and whether the endpoint is https. */
export interface DialTarget {
  host: string
  port: number
  addresses: readonly string[]
  secure: boolean
}
/** Starts the connection. Injected so tests can drive a socket; the real one pins the checked addresses. */
export type Dialer = (t: DialTarget) => Socket

const dialReal: Dialer = ({ host, port, addresses, secure }) => {
  const lookup = pinnedLookup(addresses)
  // Node's certificate verification, asked for so NODE_TLS_REJECT_UNAUTHORIZED=0 cannot turn it off. SNI keeps the name (an
  // IP literal has none).
  return secure
    ? tlsConnect({ host, port, lookup, rejectUnauthorized: true, ...(isIP(host) === 0 ? { servername: host } : {}) })
    : netConnect({ host, port, lookup })
}

// Only a plain code reaches a sentence: an error's message may hold the address or more.
const codeOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'error'
}

/**
 * Opens the connection and closes it once it is up (the TLS handshake, or the TCP connect for the dev hook's plain loopback
 * http). Resolves null on success, else the sentence why not. `host` is how errors name the endpoint.
 */
export function handshake(t: DialTarget, host: string, ms = TEST_MS, dial: Dialer = dialReal): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: Socket | null = null
    let timer: NodeJS.Timeout | null = null
    const done = (r: string | null) => {
      if (timer) clearTimeout(timer)
      socket?.destroy()
      resolve(r)
    }
    try {
      socket = dial(t)
    } catch (e) {
      return resolve(AGUI_TEXT.testFailed(host, codeOf(e)))
    }
    timer = setTimeout(() => done(AGUI_TEXT.testTimeout(host)), ms)
    // A settled promise ignores what comes after, so the first of these wins.
    socket.once(t.secure ? 'secureConnect' : 'connect', () => done(null))
    socket.once('error', (e) => done(AGUI_TEXT.testFailed(host, codeOf(e))))
  })
}

export interface AguiTestDeps {
  /** The saved file as a run reads it (AgentStore.aguiOf); null when no loadable agent has the name. */
  definitionOf(agent: string): Promise<{ provider: Provider | null; launch: AguiLaunch | null } | null>
  trust(agent: string, launch: AguiLaunch): LaunchCheck
  /** The dev hook (`aguiAllowLocal`): loopback and private addresses, and plain http to loopback. */
  allowLocal: boolean
  /** Tests only: the name lookup. */
  lookup?: AguiLookup
  /** The env names of the API keys granted to the agent (names only; a Vault that cannot be opened may throw). */
  keyNames(agent: string): string[]
  caps(): EngineCaps
  dial?: Dialer
}

/**
 * The saved file's endpoint only, checked as a run checks it (`notAgui`, `noEndpoint`, the URL check, launch trust, then the
 * address check), so the RPC never connects anywhere a run would not. Tests of one agent's one launch made together share one
 * probe; a Save of another launch gets its own.
 */
export function createAguiTest(d: AguiTestDeps): (agent: string) => Promise<AguiTestResult> {
  const running = new Map<string, Promise<AguiTestResult>>()
  const test = async (agent: string, launch: AguiLaunch): Promise<AguiTestResult> => {
    const url = checkUrl(launch.endpoint, d.allowLocal)
    if ('error' in url) return { error: url.error }
    if (d.trust(agent, launch) !== 'ok') return { error: AGUI_TEXT.untrusted }
    const target = await resolveTarget(url.url, d.allowLocal, d.lookup)
    if ('error' in target) return { error: target.error }
    const secure = url.url.protocol === 'https:'
    const failed = await handshake(
      { host: target.host, port: target.port, addresses: target.addresses, secure },
      url.url.host,
      TEST_MS,
      d.dial
    )
    if (failed !== null) return { error: failed }
    // As a run: a Vault that cannot be opened grants nothing. Names only: a value is never returned or logged.
    let granted: string[] = []
    try {
      granted = d.keyNames(agent)
    } catch {
      /* left empty */
    }
    const caps = d.caps()
    return {
      host: url.url.host,
      addresses: target.addresses,
      tls: secure,
      authKey: launch.authKey,
      authKeyGranted: launch.authKey !== null && granted.includes(launch.authKey),
      caps,
      hidden: missingFeatures(caps)
    }
  }
  return async (agent) => {
    const def = await d.definitionOf(agent).catch(() => null)
    if (!def || def.provider !== 'ag-ui') return { error: AGUI_TEXT.notAgui }
    const launch = def.launch
    if (!launch) return { error: AGUI_TEXT.noEndpoint }
    const key = JSON.stringify([agent, aguiLaunchRecord(launch)])
    const now = running.get(key)
    if (now) return now
    const p = test(agent, launch).finally(() => running.delete(key))
    running.set(key, p)
    return p
  }
}
