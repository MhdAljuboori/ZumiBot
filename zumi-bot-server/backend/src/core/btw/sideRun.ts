import { randomUUID } from 'node:crypto'
import { ASK_SIDE_TOOL } from '@zumibot/shared/agentAsk'
import { SIDE_TIMEOUT_MS, SIDE_TIMEOUT_TEXT } from '@zumibot/shared/btw'
import { CODEX_REFUSALS, ENGINE_LABEL, markEngine, type Engine, type Provider } from '@zumibot/shared/engine'
import type { BrowserTurn } from '../browser/browserIpc'
import { DESKTOP_ASK_SETTINGS, type DesktopTurn } from '../desktop/desktopIpc'
import { codexServers, FORK_IGNORED_TEXT, notePrivateValues, redactPrivate, type SideBase, type SideTurn } from '../chat/chatService'
import { buildArgs, type RunHandle, type RunOptions } from '../chat/claudeRunner'
import { turnStart } from '../engines/engine'
import { claudeResume } from '../engines/claudeEngine'
import { codexStartOf } from '../engines/codexEngine'
import { CODEX_SIDE_DENY_HOOK } from '../codex/codexHooks'
import type { CodexRunOptions } from '../codex/codexRunner'
import { allowResponse, denyResponse, errorResponse, UNKNOWN_REQUEST_ERROR } from '../chat/controlProtocol'
import { minusBaseline, type CostBaseline } from '../usage/costBaseline'
import type { RunCost } from '../usage/runCost'
import { DeltaScrubber, scrubEvent } from '../vault/scrub'
import type { RunEvent } from '../chat/streamParser'
import type { AuditTap } from '../audit/auditTap'

export const SIDE_GUARD_SETTINGS =
  '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo \'No tools in a side answer\' >&2; exit 2"}]}]}}'
// The same guard, except that exactly `side_question` passes (a lookahead on the whole tool name; the real CLI honours it in auto and
// default mode, which e2e/sideAskProbe.mjs checks, and a unit test pins the two strings together). Only a user's own side question
// in a single chat uses it, so no agent can chain asks.
export const SIDE_GUARD_ASKING =
  '{"hooks":{"PreToolUse":[{"matcher":"^(?!mcp__zumibot_agents__side_question$).*","hooks":[{"type":"command","command":"echo \'No tools in a side answer\' >&2; exit 2"}]}]}}'

export interface SideRunOptions {
  base: SideBase
  /** `engine: 'codex'` marks a Codex thread and turn id: only a Codex base forks those, as only a Claude one forks the rest. */
  point: { session: string; at: string; engine?: Provider } | null
  message: string
  browser: SideTurn | null
  desktop?: DesktopTurn | null
  /** The side_question exception: its guard, and its permission request is allowed. A Codex run has none (no hook can single it out). */
  asking?: boolean
  run(o: RunOptions): RunHandle
  /** Runs a Codex base's side run; without it such a run ends with the not-found sentence. */
  codexRun?(o: CodexRunOptions): RunHandle
  /** false: the `questions` cap is off, so a Codex run goes without the question feature (the runner's own default is on). */
  questions?: false
  onText(answer: string): void
  onCost(e: { sessionId: string | null; window: [number, number]; cost: RunCost; id: string | null }): void
  /** A fork restores the main session's cost so far; read before the run, so only the side answer's own cost is reported. */
  costBaseline?: CostBaseline
  now(): number
  timeoutMs?: number
  /** The caller's deadline (it can pause): when given, the run keeps no timer of its own. */
  expired?: AbortSignal
  /** The audit log's tap for this side run: every call it sees (the guard denies nearly all), ended when the process is gone. */
  audit?: AuditTap
}

/**
 * missing: a Codex fork found no thread, or the point was the other engine's (a Claude run's missing session is read off its
 * error text instead). Either way the caller seeds from the history.
 */
export interface SideRunEnd {
  ok: boolean
  stopped: boolean
  error: string | null
  answer: string
  missing?: true
}

/** Shown only if a caller never seeds after a point of the other engine; every caller does. */
export const SIDE_POINT_OTHER_ENGINE = 'The session to answer from belongs to the other engine.'

export function sideArgs(
  base: SideBase,
  point: SideRunOptions['point'],
  browser: BrowserTurn | null,
  desktop: DesktopTurn | null = null,
  asking = false
): string[] {
  // A side turn's desktop args carry no --settings: the guard's one settings object gets the ask rules instead. For an agent with no
  // own --settings and no desktop server the guard string stays exactly as the probe pins it; an agent's own settings (in the base's
  // extraArgs, first) are merged into it by buildArgs, and the guard's block still wins (the model probe's guard check).
  const ask = desktop?.args.length ? ['--settings', DESKTOP_ASK_SETTINGS] : []
  return buildArgs({
    // The same reading of a point as a main run's (core/engines/): a point is forked, so the base's own session stays as it was.
    ...base.args,
    // A side run takes no steers: nothing it would echo has anywhere to go.
    replayUser: false,
    ...claudeResume(turnStart(point?.session ?? null, point?.at)),
    extraArgs: [
      ...base.args.extraArgs,
      ...(browser?.args ?? []),
      ...(desktop?.args ?? []),
      '--no-session-persistence',
      '--settings',
      asking ? SIDE_GUARD_ASKING : SIDE_GUARD_SETTINGS,
      ...ask
    ],
    appendSystemPrompt: [base.args.appendSystemPrompt, browser?.prompt, desktop?.prompt].filter(Boolean).join('\n\n')
  })
}

/** `done` settles as soon as the answer's outcome is known; `exited` only once the CLI process is gone. */
export function startSideRun(o: SideRunOptions): { stop(): void; done: Promise<SideRunEnd>; exited: Promise<void> } {
  const start = o.now()
  const codex = o.base.codex
  // A belt (every caller passes a point of the base's own engine): the other engine's session id never reaches this CLI.
  // A base is Claude's or Codex's by its shape: only those two engines answer side questions.
  const runEngine: Engine = codex !== undefined ? 'codex' : 'claude'
  const otherEngine = o.point !== null && markEngine(o.point.engine) !== runEngine
  // A Codex result's cost is the turn's own already.
  const baseline = o.point && o.costBaseline && !codex && !otherEngine ? o.costBaseline(o.point.session).catch(() => null) : null
  const texts: string[] = []
  let partial = ''
  let sessionId: string | null = null
  let finished = false
  let handle: RunHandle | undefined
  const pendingAnswers: object[] = []
  let earlyStop = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let exited: Promise<void> = Promise.resolve()
  let resolve!: (end: SideRunEnd) => void
  const done = new Promise<SideRunEnd>((r) => {
    resolve = r
  })
  const answer = () => [...texts, ...(partial ? [partial] : [])].join('\n\n')
  // The error is stored in btw.json and shown: like the main run's, it never carries a capability or IPC path.
  const privateValues = new Map<string, string>()
  if (o.browser) notePrivateValues(privateValues, 'browser', o.browser.env)
  if (o.desktop) notePrivateValues(privateValues, 'desktop', o.desktop.env)
  // The base agent's API key values: scrubbed from every event and from the error, like a main run's.
  const scrub = o.base.scrub ?? new Map<string, string>()
  for (const [value, label] of scrub) privateValues.set(value, label)
  const deltas = new DeltaScrubber(scrub)
  const finish = (ok: boolean, stopped: boolean, error: string | null, missing?: true) => {
    if (finished) return
    finished = true
    partial += deltas.flush()
    clearTimeout(timer)
    o.expired?.removeEventListener('abort', expire)
    resolve({
      ok,
      stopped,
      error: error === null ? null : redactPrivate(error, privateValues),
      answer: answer(),
      ...(missing ? { missing } : {})
    })
  }
  // A Codex side run's hook: `cached` trust, then trust asked `fresh` (a codex update may hash differently), then `none`, which is
  // the side run without it: decline-all is its guarantee either way (R20).
  const spawn = (onEvent: (e: RunEvent) => void, guard: 'cached' | 'fresh' | 'none' = 'cached'): RunHandle => {
    if (!codex) {
      // The agent's own servers start here as in its main run, so they need the same Vault values; first, as there, so a
      // bridge's or the temp folder's value always wins.
      const ownEnv = o.base.env && Object.keys(o.base.env).length > 0 ? o.base.env : undefined
      return o.run({
        bin: o.base.bin,
        cwd: o.base.cwd,
        args: sideArgs(o.base, o.point, o.browser, o.desktop ?? null, o.asking === true),
        stdin: o.message,
        ...(ownEnv || o.browser || o.desktop || o.base.tmpDir
          ? { env: { ...ownEnv, ...o.browser?.env, ...o.desktop?.env, ...(o.base.tmpDir ? { CLAUDE_CODE_TMPDIR: o.base.tmpDir } : {}) } }
          : {}),
        onEvent
      })
    }
    if (!o.codexRun) throw new Error(CODEX_REFUSALS.notFound)
    return o.codexRun({
      bin: o.base.bin,
      cwd: o.base.cwd,
      ...(o.browser ? { env: { ...o.browser.env } } : {}),
      // Ephemeral: the fork writes no rollout, and the thread it reads stays as it was (probe check 8). A Claude side run says
      // the same with --no-session-persistence below.
      start: codexStartOf(turnStart(o.point?.session ?? null, o.point?.at), { ephemeral: true }),
      action: { kind: 'turn', prompt: o.message },
      // Untrusted and read-only: a command, an MCP call and an edit each asked first (probe check 14), and every ask is declined
      // below, so the run never acts. The side turn's own bridges, whose env it carries, in the main run's order.
      thread: {
        cwd: o.base.cwd,
        ...(codex.model !== undefined ? { model: codex.model } : {}),
        permissionMode: 'manual',
        sandbox: 'read-only',
        baseInstructions: [codex.baseInstructions, o.browser?.prompt].filter(Boolean).join('\n\n'),
        mcpServers: codexServers(o.browser ? (o.browser.servers ?? [o.browser.mcp]) : []),
        // Only the deny-all hook: a side run has no keys (no vault hook) and is never paused. It also blocks the reads that
        // `untrusted` runs without asking. The pre-flight that reads its trust starts no model and gets none of the run's env.
        ...(guard !== 'none' ? { hooks: [CODEX_SIDE_DENY_HOOK] } : {})
      },
      ...(guard !== 'none' ? { hookTrustEnv: {} } : {}),
      ...(guard === 'fresh' ? { freshHookTrust: true } : {}),
      // Codex numbers each process's requests from 0: its own tag keeps them apart from any other run's.
      requestTag: randomUUID(),
      ...(o.questions === false ? { questions: false } : {}),
      onEvent
    })
  }
  const stopProcess = () => {
    if (handle) handle.stop()
    else earlyStop = true
  }
  const expire = () => {
    finish(false, false, SIDE_TIMEOUT_TEXT)
    stopProcess()
  }
  let stoppedByCaller = false
  const stop = () => {
    stoppedByCaller = true
    if (finished) return
    finish(false, true, null)
    stopProcess()
  }
  // Nothing runs: the end says missing, which makes the caller seed from the history instead.
  if (otherEngine) {
    finish(false, false, SIDE_POINT_OTHER_ENGINE, true)
    return { stop, done, exited }
  }
  // The run's one handler, for every process the Codex reruns start.
  const onEvent = (raw: RunEvent): void => {
    let e: RunEvent = raw
    if (scrub.size > 0) {
      if (raw.kind === 'textDelta') {
        const text = deltas.push(raw.text)
        if (finished || !text) return
        partial += text
        o.onText(answer())
        return
      }
      // The held tail comes out before the message that completes it.
      if (raw.kind === 'assistantText' && !finished) partial += deltas.flush()
      e = scrubEvent(raw, scrub)
    }
    // Before the finished check: a call the stopped run still reports is part of the record.
    o.audit?.event(e)
    // A result that lands after a stop or timeout was still paid for.
    if (e.kind === 'result') {
      if (e.cost) {
        const run = { sessionId, window: [start, o.now()] as [number, number], id: e.uuid }
        const cost = e.cost
        if (baseline) void baseline.then((b) => o.onCost({ ...run, cost: minusBaseline(cost, b) }))
        else o.onCost({ ...run, cost })
      }
      return
    }
    if (finished) return
    switch (e.kind) {
      case 'init':
        sessionId = e.sessionId
        if (o.point && sessionId === o.point.session) {
          finish(false, false, FORK_IGNORED_TEXT[runEngine](e.version))
          stopProcess()
        }
        break
      case 'permissionRequest': {
        // Only the exact side tool, and only in a Claude run that has the exception; the hook blocks everything else first.
        // A Codex run has no hook: this decline is its guard, for every request, with no card.
        const allowed = !codex && o.asking === true && e.toolName === ASK_SIDE_TOOL
        const denial = allowed ? allowResponse(e.requestId, e.input) : denyResponse(e.requestId, 'No tools in a side answer')
        o.audit?.decided(
          e.requestId,
          allowed ? { kind: 'allowedByZumiBot', why: 'sideAsk' } : { kind: 'deniedByZumiBot', why: 'sideGuard' }
        )
        if (handle) handle.send(denial)
        else pendingAnswers.push(denial)
        break
      }
      case 'controlUnknown': {
        // A request of a kind Codex added later: answered as unknown at once (as a main run does), or codex waits on it
        // until the deadline. A Claude side run is left as it always was.
        if (!codex || e.requestId === null) break
        const unknown = errorResponse(e.requestId, UNKNOWN_REQUEST_ERROR)
        if (handle) handle.send(unknown)
        else pendingAnswers.push(unknown)
        break
      }
      case 'textDelta':
        partial += e.text
        o.onText(answer())
        break
      case 'assistantText':
        texts.push(e.text)
        partial = ''
        o.onText(answer())
        break
    }
  }
  // `exited` is the last process's end: a rerun is a new process of the same side run.
  let resolveExited = () => {}
  const begin = (guard: 'cached' | 'fresh' | 'none') => {
    handle = spawn(onEvent, guard)
    const current = handle
    for (const a of pendingAnswers.splice(0)) current.send(a)
    if (earlyStop) current.stop()
    void current.done.then(
      (outcome) => {
        // Hooks codex did not trust ended that run before any thread: once more with trust asked afresh, then without the hook
        // (the side run as it was before it). The timer or deadline set below keeps running across them, and a Stop or a timeout
        // has finished the side run before this, so none starts after it. Logged by code only.
        if (codex && !finished && outcome.hooksUntrusted && !outcome.stopped && guard !== 'none') {
          const next = guard === 'cached' ? 'fresh' : 'none'
          if (next === 'none') console.error('codex side hook not confirmed: running the side answer without the deny hook')
          try {
            begin(next)
          } catch (e) {
            resolveExited()
            finish(false, false, e instanceof Error ? e.message : String(e))
          }
          return
        }
        resolveExited()
        if (finished) return
        if (outcome.stopped) finish(false, true, null)
        else if (outcome.spawnError) finish(false, false, outcome.spawnError)
        else if (codex && outcome.missingSession) finish(false, false, CODEX_REFUSALS.threadGone, true)
        else if (!outcome.result || outcome.result.isError) {
          finish(false, false, outcome.stderr.trim() || `${ENGINE_LABEL[runEngine]} exited with code ${outcome.exitCode ?? outcome.signal}`)
        } else finish(true, false, null)
      },
      (e) => {
        resolveExited()
        finish(false, false, e instanceof Error ? e.message : String(e))
      }
    )
  }
  try {
    exited = new Promise<void>((r) => {
      resolveExited = r
    })
    void exited.then(() => o.audit?.end(stoppedByCaller))
    begin('cached')
    if (!finished) {
      if (!o.expired) timer = setTimeout(expire, o.timeoutMs ?? SIDE_TIMEOUT_MS)
      else if (o.expired.aborted) expire()
      else o.expired.addEventListener('abort', expire, { once: true })
    }
  } catch (e) {
    resolveExited()
    finish(false, false, e instanceof Error ? e.message : String(e))
  }
  return { stop, done, exited }
}
