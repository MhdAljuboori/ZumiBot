import { randomUUID } from 'node:crypto'
import { AGUI_TEXT, aguiHost, type AguiThread } from '@zumibot/shared/agui'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import type { ModelSpend } from '@zumibot/shared/usageReport'
import type { RunEvent } from '../chat/streamParser'
import type { RunHandle, RunOutcome } from '../engines/engine'
import type { RunCost } from '../usage/runCost'
import { AGUI_LIMITS, postRun, type AguiLimits } from './aguiClient'
import type { AguiLookup } from './aguiEndpoint'
import { AguiEventMapper, type AguiStateChange, type AguiTerminal, type AguiUsage } from './aguiEvents'
import { expiryOf, interruptQuestions, isExpired, resumeEntry, type AguiInterrupt, type AguiResumeEntry } from './aguiInterrupts'
import type { AguiMessage } from './aguiMessages'
import { applyPatch } from './aguiPatch'

// One AG-UI turn: one RunHandle per attempt, holding one run, plus one more per interrupt round (the answers go back as a new
// run on the same thread, inside the same handle), with the lifecycle and outcome of `startAcp`.
// See docs/architecture/protocol-engines.md (AG-UI engine: Interrupts, Message map).

export interface AguiRunOptions {
  endpoint: string
  /** The auth header the caller built; its value is in the turn's scrub map. Never logged or put in an error. */
  headers: Record<string, string>
  /** The env name of the key the header carries (never its value), named by a 401 or 403's sentence. */
  authKey: string | null
  threadId: string
  /** The chat's visible history, this turn's message last (`aguiMessages`). */
  messages: AguiMessage[]
  /** `chats/<id>.agui.json` as loaded: its state and open interrupts count only for its own thread. */
  thread: AguiThread | null
  /** The thread file to keep; the caller saves it. */
  onThread(t: AguiThread): void
  /**
   * Prefixed to every tool and request id the handle emits (`<tag>:<id>`), and `send` answers only ids carrying it: a server's
   * ids are its own, so one tag per attempt keeps a card or a row from naming another attempt's.
   */
  requestTag: string
  /** The dev hook (`ZUMIBOT_AGUI_ALLOW_LOCAL`), read by the caller through `devEnv()`. */
  allowLocal: boolean
  lookup?: AguiLookup
  limits?: Partial<AguiLimits>
  onEvent(e: RunEvent): void
}

const ERROR_MAX = 500
const REASON_MAX = 100
const CODE_MAX = 100
const MODEL_MAX = 100
// setTimeout's longest delay: an expiry further off gets no timer, and its card waits as any other.
const TIMER_MAX = 2 ** 31 - 1
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g

/** A remote string fit to show: each run of control characters becomes one space, then it is cut (by code points). */
const clean = (s: string, max: number): string => Array.from(s.replace(CONTROL, ' ').trim()).slice(0, max).join('')

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const cancelled = (i: AguiInterrupt): AguiResumeEntry => ({ interruptId: i.id, status: 'cancelled' })

/** A 4xx the server would give again for the same resume; not 401, 403 (the key), 408 or 429 (try again later). */
const refusesResume = (status: number): boolean => status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status)

/** The tokens of every round, unpriced (`costUsd` null): AG-UI reports no cost. null when the server reported no usage. */
function costOf(usage: readonly AguiUsage[]): RunCost | null {
  if (usage.length === 0) return null
  const models = new Map<string, ModelSpend>()
  for (const u of usage) {
    const name = (u.model === undefined ? '' : clean(u.model, MODEL_MAX)) || 'unknown'
    const m = models.get(name) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null }
    // Cached and cache-write input are parts of the input total, so only the rest is plain input.
    const cached = u.cachedInputTokens ?? 0
    const written = u.cacheWriteInputTokens ?? 0
    m.input += Math.max(0, (u.inputTokens ?? 0) - cached - written)
    m.output += u.outputTokens ?? 0
    m.cacheRead += cached
    m.cacheWrite += written
    models.set(name, m)
  }
  // fromEntries defines each model as an own key, so a model named __proto__ stays a key.
  return { totalUsd: 0, models: Object.fromEntries(models) }
}

/** A terminal that ends the turn (an interrupt opens a round instead). */
type FinalTerminal = Exclude<AguiTerminal, { kind: 'interrupt' }>

type RunEnd =
  | { kind: 'terminal'; terminal: AguiTerminal; transcript: AguiMessage[] }
  | { kind: 'failed'; text: string; unsent: boolean }
  | { kind: 'stopped' }

/** One AG-UI turn over HTTPS + SSE, with the outcome of `startAcp`. */
export function startAgui(o: AguiRunOptions): RunHandle {
  const limits: AguiLimits = { ...AGUI_LIMITS, ...o.limits }
  const outcome: RunOutcome = { exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: false }
  const prefix = o.requestTag ? `${o.requestTag}:` : ''
  const untagged = (id: unknown): string | null => (typeof id === 'string' && id.startsWith(prefix) ? id.slice(prefix.length) : null)
  // Logs name the host only, never the path or the query.
  const log = (what: string) => console.error(`[agui] ${aguiHost(o.endpoint) ?? 'endpoint'}: ${what}`)
  const tooBig = (v: unknown): boolean => Buffer.byteLength(JSON.stringify(v) ?? '') > limits.stateBytes

  // The file counts only for its own thread: a new one (an Edit, a Resend, a reseed) starts at {} with nothing open (Rulings 3).
  const own = o.thread !== null && o.thread.threadId === o.threadId ? o.thread : null
  const thread: AguiThread = {
    v: 1,
    threadId: o.threadId,
    state: own === null ? {} : own.state,
    interrupts: own === null ? [] : own.interrupts.map((i) => ({ ...i }))
  }
  if (thread.state !== null && tooBig(thread.state)) {
    thread.state = null
    log('the kept state is over its cap, so it was dropped')
  }
  const keep = () => o.onThread({ ...thread, interrupts: thread.interrupts.map((i) => ({ ...i })) })

  // The first run cancels every interrupt the thread still holds (a Stop left its cards unanswered).
  let resume: AguiResumeEntry[] = thread.interrupts.map((i) => ({ interruptId: i.id, status: 'cancelled' }))
  // The input of the next run: the history, then each finished run's transcript.
  const history: AguiMessage[] = [...o.messages]
  const usage: AguiUsage[] = []
  // Server tool ids: every row this handle showed, and those still running.
  const rows = new Set<string>()
  const openTools = new Set<string>()
  // The open cards by their key (what follows the tag), and every key used, so a repeated interrupt id gets a fresh one.
  const cards = new Map<string, { interrupt: AguiInterrupt; timer: NodeJS.Timeout | null }>()
  const keys = new Set<string>()
  let round: { answers: Map<string, AguiResumeEntry>; opening: boolean; wake(): void } | null = null
  let mapper: AguiEventMapper | null = null
  let controller: AbortController | null = null
  let runs = 0
  let rounds = 0
  let stopped = false
  let finished = false

  const tagged = (e: RunEvent): RunEvent => {
    switch (e.kind) {
      case 'toolUse':
        return { ...e, id: prefix + e.id }
      case 'toolResult':
        return { ...e, toolUseId: prefix + e.toolUseId }
      case 'permissionRequest':
        return { ...e, requestId: prefix + e.requestId, toolUseId: e.toolUseId === null ? null : prefix + e.toolUseId }
      case 'permissionCancel':
        return { ...e, requestId: prefix + e.requestId }
      default:
        return e
    }
  }
  const deliver = (e: RunEvent) => {
    if (e.kind === 'toolUse') {
      // A later round may announce a call an earlier one showed (run once its approval came back): its row is there already.
      if (rows.has(e.id)) return
      rows.add(e.id)
      openTools.add(e.id)
    } else if (e.kind === 'toolResult') openTools.delete(e.toolUseId)
    if (e.kind === 'result') outcome.result = e
    o.onEvent(tagged(e))
  }

  const dropState = (why: string) => {
    thread.state = null
    log(`${why}, so the state was dropped`)
  }
  const applyState = (c: AguiStateChange) => {
    let next: unknown
    if (c.kind === 'snapshot') next = c.snapshot
    else {
      // A delta against a state already dropped has nothing to apply to; a snapshot brings one back.
      if (thread.state === null) return
      // The cap bounds what the patch may write while it runs, not only its result: a copy doubles the document per op.
      const r = applyPatch(thread.state, c.delta, limits.stateBytes)
      if (!r.ok) return dropState('a state patch did not apply')
      next = r.doc
    }
    if (tooBig(next)) return dropState('the state is over its cap')
    thread.state = next
  }

  const settleCard = (key: string, entry: AguiResumeEntry) => {
    const c = cards.get(key)
    if (!c) return
    if (c.timer) clearTimeout(c.timer)
    cards.delete(key)
    const r = round
    if (!r) return
    r.answers.set(c.interrupt.id, entry)
    if (cards.size === 0 && !r.opening) r.wake()
  }
  const cardKey = (id: string): string => {
    let key = id
    for (let n = 2; keys.has(key); n++) key = `${id}#${n}`
    keys.add(key)
    return key
  }

  /** The round's cards: resolves with a resume entry for every interrupt once each card is settled (or Stop). */
  const ask = (interrupts: AguiInterrupt[]): Promise<AguiResumeEntry[]> =>
    new Promise((resolve) => {
      const answers = new Map<string, AguiResumeEntry>()
      const r = {
        answers,
        // ChatService may answer a card inside its own request event, so the round wakes only once every card is out.
        opening: true,
        wake: () => {
          if (round === r) round = null
          resolve(interrupts.map((i) => answers.get(i.id) ?? cancelled(i)))
        }
      }
      round = r
      const now = Date.now()
      for (const i of interrupts) {
        if (stopped) break
        const input = interruptQuestions(i)
        if (input === null) {
          // Approval payloads are framework-specific: guessing one could present a call as approved when it was not.
          answers.set(i.id, cancelled(i))
          deliver({ kind: 'notice', text: AGUI_TEXT.interruptDeclined(clean(i.reason, REASON_MAX)) })
          continue
        }
        if (isExpired(i, now)) {
          answers.set(i.id, cancelled(i))
          continue
        }
        const key = cardKey(i.id)
        const at = expiryOf(i.expiresAt)
        // An interrupt past its expiresAt is cancelled, so its card goes then (Rulings 5).
        const timer =
          at !== null && at - now <= TIMER_MAX
            ? setTimeout(() => {
                if (!cards.has(key)) return
                deliver({ kind: 'permissionCancel', requestId: key })
                settleCard(key, cancelled(i))
              }, at - now)
            : null
        cards.set(key, { interrupt: i, timer })
        const toolUseId = i.toolCallId !== undefined && rows.has(i.toolCallId) ? i.toolCallId : null
        deliver({ kind: 'permissionRequest', requestId: key, toolName: QUESTION_TOOL, input, description: null, reason: null, toolUseId })
      }
      r.opening = false
      if (cards.size === 0) r.wake()
    })

  const runOnce = async (): Promise<RunEnd> => {
    runs++
    const runId = randomUUID()
    const m = new AguiEventMapper({ threadId: o.threadId, runId })
    mapper = m
    const resuming = resume.length > 0
    // A dropped state is sent as {}, and is {} from here on: that is what the server was told.
    if (thread.state === null) thread.state = {}
    // Never parentRunId, no system or developer message, no tools: nothing local reaches the remote host.
    const body = JSON.stringify({
      threadId: o.threadId,
      runId,
      protocolVersion: '1.0',
      state: thread.state,
      messages: history,
      tools: [],
      context: [],
      forwardedProps: {},
      ...(resuming ? { resume } : {})
    })
    const ac = new AbortController()
    controller = ac
    let terminal: AguiTerminal | null = null
    let failure: string | null = null
    let grace: NodeJS.Timeout | null = null
    const onData = (raw: string) => {
      if (failure !== null || stopped) return
      const r = m.event(raw)
      for (const e of r.events) {
        // A Stop raised from inside an event: nothing more is shown, though what this event read still counts below.
        if (stopped) break
        // The server took the resume once its run starts: the interrupts are answered.
        if (e.kind === 'init' && resuming && thread.interrupts.length > 0) {
          thread.interrupts = []
          keep()
        }
        deliver(e)
      }
      if (r.state) applyState(r.state)
      if (r.terminal) {
        usage.push(...r.terminal.usage)
        // Kept before any card waits, so a Stop or a crash leaves them for the next send to cancel.
        if (r.terminal.kind === 'interrupt')
          thread.interrupts = r.terminal.interrupts.map((i) => ({ id: i.id, expiresAt: i.expiresAt ?? null }))
        // A run that failed after asking has nothing left to resume.
        else if (r.terminal.kind === 'error' && terminal?.kind === 'interrupt') thread.interrupts = []
        // The server holds what it already sent, so the thread keeps it even after a Stop.
        keep()
        // After a Stop: no card, no grace, no request.
        if (stopped) return
        // A late RUN_ERROR beats our RUN_FINISHED (Rulings 2), and nothing after an error can change the run.
        if (terminal === null || r.terminal.kind === 'error') terminal = r.terminal
        if (terminal.kind === 'error') ac.abort()
        else if (grace === null) grace = setTimeout(() => ac.abort(), limits.finishGraceMs)
      }
      if (r.fatal !== undefined && !stopped) {
        failure = r.fatal
        ac.abort()
      }
    }
    const res = await postRun(
      {
        url: o.endpoint,
        body,
        headers: o.headers,
        authKey: o.authKey,
        allowLocal: o.allowLocal,
        lookup: o.lookup,
        limits,
        signal: ac.signal
      },
      onData
    )
    if (grace) clearTimeout(grace)
    controller = null
    if (stopped) return { kind: 'stopped' }
    // A server that definitively refuses the request carrying a resume would refuse every later one too, so its interrupts
    // are dropped. Auth and rate problems keep them: a fixed key or a retry still resumes.
    if (resuming && res.kind === 'error' && res.status !== undefined && refusesResume(res.status) && thread.interrupts.length > 0) {
      thread.interrupts = []
      keep()
    }
    // Anything unreadable, even after our terminal event, is an error: never a synthesized success.
    if (failure !== null) return { kind: 'failed', text: failure, unsent: false }
    // A connection dropped after our terminal event loses nothing; any other failure stands.
    if (res.kind === 'error' && !(terminal !== null && res.text === AGUI_TEXT.cut))
      return { kind: 'failed', text: res.text, unsent: res.unsent === true }
    if (terminal === null) return { kind: 'failed', text: AGUI_TEXT.cut, unsent: false }
    return { kind: 'terminal', terminal, transcript: m.transcript() }
  }

  // Each pending call that has a row is answered with an error, which later runs resend (Rulings 7).
  const answerPending = (ids: readonly string[]) => {
    let answered = false
    for (const id of new Set(ids)) {
      if (openTools.has(id)) {
        deliver({ kind: 'toolResult', toolUseId: id, content: AGUI_TEXT.noTools, isError: true })
        answered = true
      } else if (!rows.has(id)) log('a pending tool call with no row was dropped')
    }
    if (answered) deliver({ kind: 'notice', text: AGUI_TEXT.pendingTools })
  }

  // Nothing stays live past the turn: the open text or thought, every row still running, every card.
  const closeTurn = () => {
    if (mapper) for (const e of mapper.close()) deliver(e)
    for (const id of [...openTools]) deliver({ kind: 'toolResult', toolUseId: id, content: AGUI_TEXT.toolUnfinished, isError: true })
    for (const [key, c] of [...cards]) {
      if (c.timer) clearTimeout(c.timer)
      cards.delete(key)
      deliver({ kind: 'permissionCancel', requestId: key })
    }
  }

  // The outcome a run's own end gives. Pending calls are answered here, before `closeTurn` would call them unfinished.
  const settleOutcome = (t: FinalTerminal) => {
    if (t.kind === 'success') answerPending(t.pendingToolCallIds)
    else if (t.kind === 'cancelled') outcome.stopped = true
    // Cut and stripped here; ChatService scrubs it (the key may be echoed).
    else outcome.stderr = AGUI_TEXT.runError(clean(t.message, ERROR_MAX), t.code === null ? null : clean(t.code, CODE_MAX) || null)
  }

  const done = (async (): Promise<RunOutcome> => {
    // The run's own end, when it had one: it alone gives a result, after everything else is closed.
    let final: FinalTerminal | null = null
    try {
      for (;;) {
        const end = await runOnce()
        if (end.kind === 'stopped') break
        if (end.kind === 'failed') {
          // Only the turn's first request can be refused before anything left: later ones follow a run that started.
          if (end.unsent && runs === 1) outcome.spawnError = end.text
          else outcome.stderr = end.text
          break
        }
        history.push(...end.transcript)
        const t = end.terminal
        if (t.kind !== 'interrupt') {
          final = t
          break
        }
        // A server that answers every cancelled resume with a new interrupt would loop with no user (Rulings 4).
        if (++rounds > limits.rounds) {
          outcome.stderr = AGUI_TEXT.tooManyRounds
          break
        }
        resume = await ask(t.interrupts)
        if (stopped) break
      }
      if (final !== null) settleOutcome(final)
    } catch (e) {
      final = null
      outcome.stderr = e instanceof Error ? e.message : String(e)
    }
    closeTurn()
    if (final !== null) {
      deliver({
        kind: 'result',
        subtype: final.kind,
        isError: final.kind === 'error',
        numTurns: runs,
        sessionId: o.threadId,
        denials: [],
        windows: {},
        uuid: null,
        cost: costOf(usage)
      })
    }
    finished = true
    return outcome
  })()

  return {
    done,
    send: (message) => {
      if (finished || stopped) return false
      // Never throws: ChatService answers from inside its event handlers.
      try {
        const key = untagged(obj(obj(message)?.response)?.request_id)
        const c = key === null ? undefined : cards.get(key)
        if (key === null || !c) return false
        settleCard(key, resumeEntry(c.interrupt, message, Date.now()))
        return true
      } catch {
        return false
      }
    },
    stop: () => {
      if (finished || stopped) return
      stopped = true
      outcome.stopped = true
      // Nothing more is sent: the open cards become unanswered, and the thread keeps their interrupts for the next send.
      controller?.abort()
      for (const [key, c] of [...cards]) {
        if (c.timer) clearTimeout(c.timer)
        cards.delete(key)
        deliver({ kind: 'permissionCancel', requestId: key })
      }
      round?.wake()
    }
  }
}
