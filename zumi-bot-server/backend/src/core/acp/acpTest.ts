import { ACP_TEXT, launchRecord, refusedArg, type AcpLaunch, type AcpTestResult } from '@zumibot/shared/acp'
import { missingFeatures, type EngineCaps, type Provider } from '@zumibot/shared/engine'
import { scrubValue } from '../vault/scrub'
import { probeAcp, type AcpProbeOptions, type AcpProbeResult } from './acpProbe'
import type { LaunchCheck } from './launchTrust'

export interface AcpTestDeps {
  /** The saved file as a run reads it (AgentStore.acpOf); null when no loadable agent has the name. */
  definitionOf(agent: string): Promise<{ provider: Provider | null; launch: AcpLaunch | null } | null>
  trust(agent: string, launch: AcpLaunch): LaunchCheck
  locate(command: string): Promise<string | null>
  /** The base run env (the interactive shell's PATH), as a run gets it. */
  env(): Promise<NodeJS.ProcessEnv>
  /** The agent's granted API keys and their scrub labels (vaultEnvOf); may throw when the Vault cannot be opened. */
  vaultEnv(agent: string): { env: Record<string, string>; scrub: ReadonlyMap<string, string> }
  caps(): EngineCaps
  probe?(o: AcpProbeOptions): Promise<AcpProbeResult>
}

/**
 * Agent Studio's Test: only the saved file's launch, and only as a run would start it (the same refusals in the same order as
 * ChatService's acpLaunch, then its sign-in keys). So the RPC never runs a command typed into the browser or written by anything
 * but Agent Studio. Tests of one agent's one launch made together share one probe; a Save of another launch gets its own.
 */
export function createAcpTest(d: AcpTestDeps): (agent: string) => Promise<AcpTestResult> {
  const running = new Map<string, Promise<AcpTestResult>>()
  const test = async (agent: string, launch: AcpLaunch): Promise<AcpTestResult> => {
    const flag = refusedArg(launch.args)
    if (flag !== null) return { error: ACP_TEXT.refusedArg(flag) }
    if (d.trust(agent, launch) !== 'ok') return { error: ACP_TEXT.untrusted }
    const bin = await d.locate(launch.command).catch(() => null)
    if (!bin) return { error: ACP_TEXT.notFound(launch.command) }
    let keys: { env: Record<string, string>; scrub: ReadonlyMap<string, string> } = { env: {}, scrub: new Map() }
    // As a run: a Vault that cannot be opened grants nothing, so a listed key is missing.
    try {
      keys = d.vaultEnv(agent)
    } catch {
      /* left empty */
    }
    const missing = launch.authEnv.find((name) => !Object.hasOwn(keys.env, name))
    if (missing !== undefined) return { error: ACP_TEXT.authEnvMissing(missing) }
    // Its own sign-in keys only, so the auth methods it reports are the ones a run would see.
    const env = { ...(await d.env()), ...Object.fromEntries(launch.authEnv.map((name) => [name, keys.env[name]])) }
    const r = await (d.probe ?? probeAcp)({ command: launch.command, bin, args: launch.args, env })
    if ('error' in r) return r
    const caps = d.caps()
    // The agent's own text, shown in Agent Studio: scrubbed of the agent's keys as a run's output is.
    return { ...scrubValue(r, keys.scrub), caps, hidden: missingFeatures(caps) }
  }
  return async (agent) => {
    const def = await d.definitionOf(agent).catch(() => null)
    if (!def || def.provider !== 'acp') return { error: ACP_TEXT.notAcp }
    const launch = def.launch
    if (!launch) return { error: ACP_TEXT.noCommand }
    const key = JSON.stringify([agent, launchRecord(launch)])
    const now = running.get(key)
    if (now) return now
    const p = test(agent, launch).finally(() => running.delete(key))
    running.set(key, p)
    return p
  }
}
