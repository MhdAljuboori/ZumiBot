import { randomUUID } from 'node:crypto'
import type { EngineCaps } from '@zumibot/shared/engine'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool, Options, PermissionResult, PermissionUpdate, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mergeInlineJson } from '../chat/claudeRunner'
import { DENIED_BY_USER, UNKNOWN_REQUEST_ERROR } from '../chat/controlProtocol'
import { parseLine, type RunEvent } from '../chat/streamParser'
import { claudeRunEnv } from '../chat/runEnv'
import type { ClaudeTurnConfig } from './claudeEngine'
import type { EngineAdapter, EngineTurn, RunHandle, RunOutcome, TurnStart } from './engine'

/**
 * The second Claude adapter: the same `claude` binary, driven through the Claude Agent SDK instead of hand-built argv and a
 * hand-read stdio control protocol. It exists so the three things ZumiBot depends on that the CLI does not document —
 * `--resume-session-at`, `--fork-session` and the stdio permission protocol — become typed options the SDK pins against a
 * Claude Code version. Everything the SDK has no typed home for is still passed as the flag ZumiBot already sends, so the
 * argv stays what the CLI adapter would have produced; see docs/architecture/engines.md.
 *
 * Off unless `ZUMIBOT_CLAUDE_SDK=1` (a `devEnv()` hook, so a packaged build never takes it).
 */

/** `query()` as this adapter uses it: streaming input, so the run can be interrupted. Injected, so a test needs no CLI. */
export type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query

export interface ClaudeSdkEngineDeps {
  caps(): EngineCaps
  locate(): Promise<string | null>
  /** The SDK's own `query()` unless a test injects one. */
  query?: QueryFn
  /** Under the turn's own env, as the CLI runner's dep does; the SDK replaces the child's environment, it does not merge it. */
  env?(): NodeJS.ProcessEnv
  /** Every event before the turn's handler sees it, for the usage readings the account takes off a run. */
  intercept?(e: RunEvent, pass: (e: RunEvent) => void): void
}

/**
 * A `TurnStart` as the SDK takes it — the documented form of what `claudeResume` spells as hidden flags, `resumeDropsTurn`
 * included. The SDK's own version pins the Claude Code version that takes it, so no probe is needed on this path.
 */
export const sdkResume = (start: TurnStart): Pick<Options, 'resume' | 'resumeSessionAt' | 'resumeDropsTurn' | 'forkSession'> =>
  start.kind === 'new'
    ? {}
    : start.kind === 'resume'
      ? { resume: start.sessionId }
      : {
          resume: start.sessionId,
          resumeSessionAt: start.at,
          forkSession: true,
          ...(start.drops !== undefined ? { resumeDropsTurn: start.drops } : {})
        }

/**
 * What ZumiBot's `extraArgs` hold, split by what the SDK can take. `flags` are passed through as themselves, since the SDK's
 * `extraArgs` is one value per flag name: a flag ZumiBot repeats is merged first (`--mcp-config`, `--settings`), and anything
 * else repeated lands in `unsupported`, which fails the run rather than silently dropping a bridge or a guard.
 */
export interface SplitArgs {
  mcpConfigs: string[]
  settings: string[]
  addDirs: string[]
  flags: Record<string, string | null>
  unsupported: string[]
}

const REPEATED = new Set(['--mcp-config', '--settings', '--add-dir'])

export function splitExtraArgs(args: readonly string[]): SplitArgs {
  const out: SplitArgs = { mcpConfigs: [], settings: [], addDirs: [], flags: {}, unsupported: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) {
      out.unsupported.push(a)
      continue
    }
    const next = i + 1 < args.length ? args[i + 1] : undefined
    const takesValue = next !== undefined && !next.startsWith('--')
    if (REPEATED.has(a)) {
      if (!takesValue) {
        out.unsupported.push(a)
        continue
      }
      if (a === '--mcp-config') out.mcpConfigs.push(next)
      else if (a === '--settings') out.settings.push(next)
      else out.addDirs.push(next)
      i++
      continue
    }
    const name = a.slice(2)
    // The SDK's extraArgs is a record, so a second value for one name would silently replace the first.
    if (name in out.flags) {
      out.unsupported.push(a)
      if (takesValue) i++
      continue
    }
    out.flags[name] = takesValue ? next : null
    if (takesValue) i++
  }
  return out
}

/** A `control_response` ZumiBot sends as the SDK's own answer. An error response denies: a tool must never run on one. */
export function sdkDecision(response: Record<string, unknown>): PermissionResult {
  if (response.subtype === 'error') {
    const error = response.error
    return { behavior: 'deny', message: typeof error === 'string' && error ? error : UNKNOWN_REQUEST_ERROR }
  }
  const d = response.response as { behavior?: unknown; updatedInput?: unknown; updatedPermissions?: unknown; message?: unknown } | undefined
  if (d?.behavior !== 'allow') return { behavior: 'deny', message: typeof d?.message === 'string' ? d.message : DENIED_BY_USER }
  return {
    behavior: 'allow',
    ...(d.updatedInput !== undefined ? { updatedInput: d.updatedInput as Record<string, unknown> } : {}),
    ...(Array.isArray(d.updatedPermissions) ? { updatedPermissions: d.updatedPermissions as PermissionUpdate[] } : {})
  }
}

const STDERR_MAX = 64 * 1024

export function claudeSdkEngine(d: ClaudeSdkEngineDeps): EngineAdapter<ClaudeTurnConfig> {
  return {
    engine: 'claude',
    caps: () => d.caps(),
    locate: () => d.locate(),
    start: (turn, config) => startSdkRun(d, turn, config)
  }
}

function startSdkRun(d: ClaudeSdkEngineDeps, turn: EngineTurn, config: ClaudeTurnConfig): RunHandle {
  const outcome: RunOutcome = { exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: false }
  // requestId -> the canUseTool promise waiting for ZumiBot's answer.
  const pending = new Map<string, (r: PermissionResult) => void>()
  let finished = false
  let query: Query | null = null
  let closeInput = () => {}
  const inputClosed = new Promise<void>((r) => {
    closeInput = r
  })

  // The run's end from the outside: interrupt it, let its input go, then let the SDK close the process.
  const stopQuery = async () => {
    try {
      await query?.interrupt()
    } catch {
      /* the run may already be over */
    }
    closeInput()
    try {
      await query?.close()
    } catch {
      /* already gone */
    }
  }

  const emit = (e: RunEvent) => {
    if (e.kind === 'result') outcome.result = e
    if (d.intercept) d.intercept(e, turn.onEvent)
    else turn.onEvent(e)
    // The SDK owns stdin; the result is the run's last word, as it is for the CLI runner.
    if (e.kind === 'result') closeInput()
  }

  const canUseTool: CanUseTool = (toolName, input, o) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = o.requestId || randomUUID()
      pending.set(requestId, resolve)
      // The CLI's control_cancel_request, in the SDK's form: the card goes, and nothing may run on an unanswered request.
      o.signal.addEventListener(
        'abort',
        () => {
          if (!pending.delete(requestId)) return
          emit({ kind: 'permissionCancel', requestId })
          resolve({ behavior: 'deny', message: DENIED_BY_USER })
        },
        { once: true }
      )
      emit({
        kind: 'permissionRequest',
        requestId,
        toolName,
        input,
        description: typeof o.description === 'string' ? o.description : null,
        reason: typeof o.decisionReason === 'string' ? o.decisionReason : null,
        toolUseId: typeof o.toolUseID === 'string' ? o.toolUseID : null
      })
    })

  const done = (async (): Promise<RunOutcome> => {
    let options: Options
    try {
      options = sdkOptions(d, turn, config, canUseTool, (chunk) => {
        outcome.stderr += chunk
        if (outcome.stderr.length > STDERR_MAX) outcome.stderr = outcome.stderr.slice(-STDERR_MAX)
      })
    } catch (e) {
      // A turn whose argv the SDK cannot carry never starts: it would lose a bridge, a guard or a hook silently.
      outcome.spawnError = e instanceof Error ? e.message : String(e)
      finished = true
      return outcome
    }
    // One user message, then the input stays open until the result, exactly as the CLI runner keeps stdin open: a permission
    // answer travels on it.
    async function* input(): AsyncGenerator<SDKUserMessage> {
      // uuid: the id the CLI writes the prompt's own entry under, which a later cut declares as the turn it discards.
      yield {
        type: 'user',
        message: { role: 'user', content: turn.action.prompt },
        parent_tool_use_id: null,
        ...(turn.action.promptUuid !== undefined ? { uuid: turn.action.promptUuid } : {})
      } as SDKUserMessage
      await inputClosed
    }
    try {
      // Assigned before the handle is returned, so a stop() always finds the query to interrupt.
      query = (d.query ?? sdkQuery)({ prompt: input(), options })
      for await (const message of query) {
        // The SDK hands back the CLI's own stream-json objects, so the one parser reads both adapters' events.
        for (const e of parseLine(JSON.stringify(message))) emit(e)
      }
      // The SDK owns the process, so there is no exit code to report; a run that ended without being stopped ended cleanly.
      outcome.exitCode = outcome.stopped ? null : 0
    } catch (e) {
      if (!outcome.stopped) outcome.spawnError = e instanceof Error ? e.message : String(e)
    } finally {
      finished = true
      closeInput()
      // Every card still waiting is answered, so no tool can run on an answer nobody gave.
      for (const [, resolve] of pending) resolve({ behavior: 'deny', message: DENIED_BY_USER })
      pending.clear()
      try {
        await query?.close()
      } catch {
        /* already gone */
      }
    }
    return outcome
  })()

  return {
    done,
    send: (message) => {
      if (finished || outcome.stopped) return false
      const m = message as { type?: unknown; response?: Record<string, unknown> } | null
      if (m?.type !== 'control_response' || !m.response) return false
      const id = m.response.request_id
      if (typeof id !== 'string') return false
      const resolve = pending.get(id)
      if (!resolve) return false
      pending.delete(id)
      resolve(sdkDecision(m.response))
      return true
    },
    stop: () => {
      if (finished || outcome.stopped) return
      outcome.stopped = true
      void stopQuery()
    }
  }
}

/** Everything the SDK is given for one turn. Throws when the turn's argv holds a flag the SDK could only drop. */
function sdkOptions(
  d: ClaudeSdkEngineDeps,
  turn: EngineTurn,
  config: ClaudeTurnConfig,
  canUseTool: CanUseTool,
  stderr: (chunk: string) => void
): Options {
  const parts = splitExtraArgs(config.extraArgs ?? [])
  if (parts.unsupported.length > 0) {
    throw new Error(`The Claude SDK adapter cannot pass these run arguments: ${parts.unsupported.join(' ')}`)
  }
  const flags: Record<string, string | null> = {
    // ZumiBot's own `manual` is not one of the SDK's typed modes, and the CLI takes it, so the mode rides as its flag.
    'permission-mode': config.permissionMode,
    ...parts.flags,
    // The bridges' and the guards' own flags, merged as the CLI's last-one-wins rules require (mergeInlineJson).
    ...(parts.mcpConfigs.length ? { 'mcp-config': mergeInlineJson(parts.mcpConfigs, '--mcp-config') } : {}),
    ...(parts.settings.length ? { settings: mergeInlineJson(parts.settings, '--settings') } : {}),
    // Not the SDK's `thinking` option: that also sends `--thinking=adaptive`, which would change what the model does. The
    // display flag alone is what the CLI adapter sends (see docs/architecture/thinking.md).
    ...(config.thinking ? { 'thinking-display': 'summarized' } : {}),
    // The snapshot must stay off, or the CLI replays the first turn's prompt on every resume. No typed option for it.
    ...(config.appendSystemPrompt ? { 'system-prompt-snapshot': 'off' } : {})
  }
  return {
    pathToClaudeCodeExecutable: turn.bin,
    cwd: turn.cwd,
    // The run env under the turn's own, as the CLI runner's dep merges them, and then the whole environment replaced with it
    // (the SDK does not merge). Background tasks stay off and Bash gets the longer timeouts, as in the CLI runner.
    env: claudeRunEnv(d.env ? { ...d.env(), ...turn.env } : (turn.env ?? process.env)),
    agent: config.agentName,
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
    ...sdkResume(turn.start),
    // Without the preset the SDK sends its own minimal system prompt and the agent file's body never applies.
    systemPrompt: { type: 'preset', preset: 'claude_code', ...(config.appendSystemPrompt ? { append: config.appendSystemPrompt } : {}) },
    ...(config.disallowedTools?.length ? { disallowedTools: [...config.disallowedTools] } : {}),
    ...(parts.addDirs.length ? { additionalDirectories: parts.addDirs } : {}),
    includePartialMessages: true,
    canUseTool,
    stderr,
    extraArgs: flags
  }
}
