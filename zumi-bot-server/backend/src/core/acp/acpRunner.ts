import { spawn, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import { ACP_TEXT, refusedMode } from '@zumibot/shared/acp'
import { QUESTION_TOOL } from '@zumibot/shared/questions'
import type { UserContent } from '../chat/controlProtocol'
import type { RunEvent } from '../chat/streamParser'
import type { RunHandle, RunOutcome } from '../engines/engine'
import { acpPermissionAnswer } from './acpAnswers'
import { elicitationAnswer, elicitationQuestions } from './acpElicitation'
import { AcpEventMapper, modeReport, reportedModes } from './acpEvents'
import { askHeld, askSwitch } from './acpModes'
import { ACP_ERROR, AcpRpc, AcpRpcError, type AcpId } from './acpRpc'
import { classifyTool } from './acpTools'
import { ProcTree } from './procTree'
import { signalChildGroup } from '../procKill'

// One ACP turn: one agent process per attempt (initialize, a session start, one session/prompt), with the lifecycle and
// outcome of `runCodex`. See docs/architecture/protocol-engines.md ("The run").

/** Where the turn's session comes from. ACP has no fork at a point (no rewind), so a fork never reaches here. */
export type AcpStart = { kind: 'new' } | { kind: 'resume'; sessionId: string }

export interface AcpRunOptions {
  bin: string
  /** The agent file's arguments. Never logged or put in an error. */
  args: string[]
  cwd: string
  /** The run env. Every `ZUMIBOT_*` name is stripped here too, whatever the caller passed. */
  env: NodeJS.ProcessEnv
  start: AcpStart
  prompt: UserContent
  /** The agent's instructions. In `systemPrompt` when the agent takes one, else a preamble on a new session's first prompt. */
  systemPrompt: string
  /**
   * Prefixed to every request id the run emits (`<tag>:<id>`), and `send` answers only ids carrying it: agents number their
   * requests from 0 in every process, so one tag per attempt keeps a card from answering another attempt's request.
   */
  requestTag: string
  /** How long a stopped or finished agent gets to exit before SIGTERM to its tree (default 5 s). */
  killGraceMs?: number
  /** From SIGTERM to SIGKILL (default 5 s). */
  killForceMs?: number
  /** A stdout line longer than this ends the run (default 8 MiB). */
  maxLineBytes?: number
  onEvent(e: RunEvent): void
}

// Exactly what the design advertises: no fs or terminal methods (ZumiBot would become the executor), forms only.
export const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
  elicitation: { form: {} },
  session: {}
} as const
export const ACP_CLIENT_INFO = { name: 'zumibot', title: 'ZumiBot', version: '1.0.0' }
export const ACP_MAX_LINE_BYTES = 8 * 1024 * 1024
const KILL_GRACE_MS = 5000
const KILL_FORCE_MS = 5000
const STDERR_MAX = 64 * 1024
const DRAIN_MS = 2000
// Stray stdout text is dropped, but an agent that writes little else is not speaking the protocol.
const MALFORMED_MAX = 1000
const ERROR_MAX = 500
const STOP_REASONS = new Set(['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'])
// Only these names reach the log line; anything else is "other", so agent text never does.
const CHUNK_KINDS = new Set(['image', 'audio', 'resource', 'resource_link'])
const CANCELLED_PERMISSION = { outcome: { outcome: 'cancelled' } }
const CANCELLED_QUESTION = { action: 'cancel' }

type Obj = Record<string, any>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
// ACP capability objects are advertised by presence (`resume: {}`), some older ones as `true`.
export const advertised = (v: unknown): boolean => v !== undefined && v !== null && v !== false

/** The instructions as the first text of a new session's first prompt, for an agent that takes no `systemPrompt`. */
export const acpPreamble = (instructions: string): string =>
  `[ZumiBot] These are your instructions for this whole conversation. Follow them in every reply.\n\n<instructions>\n${instructions}\n</instructions>`

/** The prompt as ACP content blocks, or null when it holds an image the agent cannot take. */
export function acpPrompt(content: UserContent, images: boolean, preamble: string | null): Obj[] | null {
  const out: Obj[] = preamble === null ? [] : [{ type: 'text', text: preamble }]
  for (const b of typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text })
    else if (!images) return null
    else out.push({ type: 'image', mimeType: b.source.media_type, data: b.source.data })
  }
  return out
}

// The names the sign-in sentence lists: each method's name, else its id; short, and only a few.
function authNames(v: unknown): string[] {
  const out: string[] = []
  for (const m of Array.isArray(v) ? v : []) {
    const o = obj(m)
    const name = typeof o?.name === 'string' && o.name.trim() ? o.name : typeof o?.id === 'string' ? o.id : ''
    if (name.trim()) out.push(name.trim().slice(0, 80))
  }
  return out.slice(0, 8)
}

// The mode ids a session start reports: the current mode and every mode-category config value.
function startModes(res: Obj | null): string[] {
  const ids: string[] = []
  const current = obj(res?.modes)?.currentModeId
  if (typeof current === 'string') ids.push(current)
  for (const c of Array.isArray(res?.configOptions) ? res!.configOptions : []) {
    const opt = obj(c)
    if (opt?.category === 'mode' && typeof opt.currentValue === 'string') ids.push(opt.currentValue)
  }
  return ids
}

// stdout lines with a byte cap: a line past it is never held whole, so a runaway agent cannot fill memory.
export class BoundedLines {
  private parts: string[] = []
  private bytes = 0
  over = false
  constructor(private readonly max: number) {}

  /** The lines this chunk completes, up to (not including) one over the cap, which sets `over`. */
  push(chunk: string): string[] {
    const lines: string[] = []
    let start = 0
    for (let i = chunk.indexOf('\n'); i !== -1; i = chunk.indexOf('\n', start)) {
      if (!this.add(chunk.slice(start, i))) return lines
      lines.push(this.take())
      start = i + 1
    }
    this.add(chunk.slice(start))
    return lines
  }

  flush(): string[] {
    if (this.over) return []
    const rest = this.take()
    return rest ? [rest] : []
  }

  private add(piece: string): boolean {
    if (this.over) return false
    this.bytes += Buffer.byteLength(piece)
    if (this.bytes > this.max) {
      this.over = true
      this.parts = []
      return false
    }
    if (piece) this.parts.push(piece)
    return true
  }

  private take(): string {
    const line = this.parts.join('')
    this.parts = []
    this.bytes = 0
    return line.endsWith('\r') ? line.slice(0, -1) : line
  }
}

type OpenRequest = { rpcId: AcpId; kind: 'permission' | 'question'; params: any }

/** One ACP turn over the agent's stdio, with the lifecycle and outcome of `runCodex`. */
export function startAcp(o: AcpRunOptions): RunHandle {
  const outcome: RunOutcome = { exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: false }
  const prefix = o.requestTag ? `${o.requestTag}:` : ''
  const untagged = (id: unknown): string | null => (typeof id === 'string' && id.startsWith(prefix) ? id.slice(prefix.length) : null)
  const grace = o.killGraceMs ?? KILL_GRACE_MS
  let stopFn: () => void = () => {}
  let sendFn: (message: object) => boolean = () => false
  let earlyStop = false
  let finished = false

  const done = (async (): Promise<RunOutcome> => {
    try {
      const st = await stat(o.cwd).catch(() => null)
      if (!st || !st.isDirectory()) {
        outcome.spawnError = `Folder not found: ${o.cwd}`
        finished = true
        return outcome
      }
      if (earlyStop) {
        outcome.stopped = true
        finished = true
        return outcome
      }
      return await new Promise<RunOutcome>((resolve) => {
        let child: ChildProcess | null = null
        // What runs below the agent, outside its group too (a tool shell in a session of its own).
        let tree: ProcTree | null = null
        let inp: Writable | null = null
        let exited = false
        let settled = false
        let termed = false
        let timer: NodeJS.Timeout | null = null
        let drainTimer: NodeJS.Timeout | null = null
        // When the tree's SIGTERM went out (Stop's ladder, or the agent's exit): its SIGKILL comes the force grace after it.
        let termAt: number | null = null
        const force = o.killForceMs ?? KILL_FORCE_MS
        let stderr = ''
        let phase: 'starting' | 'prompting' | 'ended' = 'starting'
        // Set by a fatal error, a refused mode or a missing session: nothing the agent sends after it is acted on.
        let dead = false
        // A load's replay: from its request to the line that answers it (not the await after it, a microtask later).
        let replaying = false
        // The last mode the replay reported, and each mode option's last value, for a load answer that names none.
        let replayMode: string | null = null
        const replayOptions = new Map<string, string>()
        let sessionId: string | null = null
        let signIn: string[] = []
        // The error item's text when the run itself knows why it failed; it beats the stderr tail.
        let errorText: string | null = null
        let refused: string | null = null
        const openTools = new Set<string>()
        const open = new Map<string, OpenRequest>()
        const dropped = new Set<string>()
        const lines = new BoundedLines(o.maxLineBytes ?? ACP_MAX_LINE_BYTES)
        // The mapper only reports a mode; the check runs once its update is handled, outside the mapper.
        const mapper = new AcpEventMapper({
          onMode: (id) => {
            if (refused === null && refusedMode(id)) refused = id
          }
        })
        const rpc = new AcpRpc((line) => {
          if (!inp || inp.destroyed || inp.writableEnded) return false
          inp.write(line)
          return true
        })

        // Tool ids are unique only within a session, and each attempt is a new process (a reseed a new session), whose plan rows
        // also count from 1: every id leaving the attempt carries its tag, as request ids do, so it never names an earlier row.
        // The mapper and `openTools` keep the agent's own ids.
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
          if (e.kind === 'toolUse') openTools.add(e.id)
          else if (e.kind === 'toolResult') openTools.delete(e.toolUseId)
          if (e.kind === 'result') outcome.result = e
          o.onEvent(tagged(e))
        }
        const emit = (events: RunEvent[]) => {
          for (const e of events) deliver(e)
        }

        // Every card still open is answered `cancelled`, as the spec requires once a turn is cancelled or over.
        const cancelOpen = () => {
          for (const [id, req] of [...open]) {
            open.delete(id)
            rpc.respond(req.rpcId, req.kind === 'permission' ? CANCELLED_PERMISSION : CANCELLED_QUESTION)
            deliver({ kind: 'permissionCancel', requestId: id })
          }
        }
        // Nothing stays live past the turn: the open text or thought run, every row still running, every card.
        const closeTurn = () => {
          emit(mapper.turnEnd())
          for (const id of [...openTools]) deliver({ kind: 'toolResult', toolUseId: id, content: ACP_TEXT.toolUnfinished, isError: true })
          cancelOpen()
        }

        // Taken before every signal and before stdin closes: once the agent exits, its children are reparented and no walk
        // from it finds them. Never throws: it runs inside event handlers.
        const snap = () => {
          try {
            tree?.snap()
          } catch {
            /* the group kill still runs */
          }
        }
        // The tree seen so far (each process once, through its group), then the agent's own group unless the tree reached it
        // already. Once the agent is gone its group is reached only through a member the tree verified: an empty group's id could
        // be another process's by then. Without /proc the group kill is all there is (on Windows not after the exit, where the
        // freed pid may already be another process's: signalChildGroup).
        const signalGroup = (sig: NodeJS.Signals) => {
          const c = child
          const pid = c?.pid
          if (!c || pid === undefined) return
          let reached: ReadonlySet<number> = new Set()
          try {
            if (tree) reached = tree.signal(sig)
          } catch {
            /* the group kill still runs */
          }
          if (reached.has(pid) || (exited && tree?.sees)) return
          try {
            signalChildGroup(c, sig)
          } catch {
            /* ESRCH: the group is gone */
          }
        }
        const sigterm = () => {
          termAt = Date.now()
          signalGroup('SIGTERM')
        }
        const endStdin = () => {
          try {
            if (inp && !inp.destroyed && !inp.writableEnded) inp.end()
          } catch {
            /* already closed */
          }
        }
        // Ends the tree now: SIGTERM, then SIGKILL after the force grace.
        const term = () => {
          if (!exited && !settled) snap()
          endStdin()
          if (exited || settled || termed) return
          termed = true
          if (timer) clearTimeout(timer)
          sigterm()
          timer = setTimeout(() => {
            if (exited) return
            snap()
            signalGroup('SIGKILL')
          }, force)
        }
        // The polite end: stdin closes, which ends an agent, and the tree is ended only if it outlives the grace.
        const wind = () => {
          if (!exited && !settled) snap()
          endStdin()
          if (exited || settled || timer) return
          timer = setTimeout(term, grace)
        }
        const fail = (text: string) => {
          if (outcome.spawnError === null) outcome.spawnError = text
          dead = true
          cancelOpen()
          term()
        }

        const finish = () => {
          if (settled) return
          closeTurn()
          settled = true
          finished = true
          if (timer) clearTimeout(timer)
          if (drainTimer) clearTimeout(drainTimer)
          rpc.close(new Error('The agent exited'))
          // Whatever the agent left in its tree (a tool's child, in its group or not) ends with the attempt, but only the force
          // grace after its SIGTERM, so a command can clean up (a git index.lock). `done` does not wait for it: the timer is one
          // shot and left ref'd, so the SIGKILL fires even when nothing else holds the event loop.
          snap()
          if (child?.pid !== undefined) {
            setTimeout(
              () => {
                snap()
                signalGroup('SIGKILL')
              },
              termAt === null ? 0 : Math.max(0, termAt + force - Date.now())
            )
          }
          const crashed =
            child?.pid !== undefined && phase !== 'ended' && !outcome.stopped && outcome.spawnError === null && !outcome.missingSession
          outcome.stderr =
            errorText ??
            (crashed ? [ACP_TEXT.stopped(outcome.exitCode ?? outcome.signal), stderr.trim()].filter(Boolean).join('\n\n') : stderr)
          resolve(outcome)
        }

        try {
          // Its own session and process group, so Stop ends the agent's children too. ZUMIBOT_* never reaches the agent.
          const env = Object.fromEntries(Object.entries(o.env).filter(([k]) => !k.startsWith('ZUMIBOT_')))
          child = spawn(o.bin, o.args, { cwd: o.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
        } catch (e) {
          outcome.spawnError = e instanceof Error ? e.message : String(e)
          return finish()
        }
        // Read at once, while the agent surely runs: its start time tells it from a later process given the same pid.
        if (child.pid !== undefined) tree = new ProcTree(child.pid)
        const proc = child
        const out = proc.stdout!,
          err = proc.stderr!
        const stdin = proc.stdin!
        inp = stdin
        out.setEncoding('utf8')
        err.setEncoding('utf8')

        const dropLog = (u: Obj | null) => {
          if (u?.sessionUpdate !== 'agent_message_chunk') return
          const type = obj(u.content)?.type
          if (typeof type !== 'string' || type === 'text') return
          const kind = CHUNK_KINDS.has(type) ? type : 'other'
          if (dropped.has(kind)) return
          dropped.add(kind)
          console.error(`[acp] dropped an agent message chunk of kind ${kind}`)
        }

        // Before the session is known only a mode counts, whatever session the update names: text or a tool row there is a
        // load's replay (history the chat already shows) or chatter from before the prompt. A replayed mode may be one the
        // session has since left, so only the last is kept, for the load's answer; any other is checked at once.
        const early = (u: Obj | null) => {
          const r = modeReport(u)
          if (replaying) {
            if (r.mode !== null) replayMode = r.mode
            for (const [id, value] of r.options) replayOptions.set(id, value)
          } else if (refused === null) refused = reportedModes(r).find(refusedMode) ?? null
        }
        const notification = (method: string, params: unknown) => {
          // After the prompt's answer the turn is over.
          if (method !== 'session/update' || phase === 'ended') return
          const p = obj(params)
          const u = obj(p?.update)
          if (sessionId === null) return early(u)
          if (p?.sessionId !== sessionId) return
          dropLog(u)
          emit(mapper.update(u))
        }

        const permission = (id: AcpId, key: string, params: unknown) => {
          const p = obj(params)
          const tc = obj(p?.toolCall) ?? {}
          const callId = typeof tc.toolCallId === 'string' && tc.toolCallId !== '' ? tc.toolCallId : null
          // The call's row comes before its card, so the card and its result have one to sit on: a row still waiting is shown now,
          // named as the card is, and a call the stream never announced is opened from the request.
          if (callId !== null) emit(mapper.show(callId, tc))
          // The request's own fields win over what the stream said: they describe exactly what is being approved.
          const merged: Obj = { ...(callId !== null ? mapper.toolCall(callId) : {}) }
          for (const k of ['kind', 'title', 'rawInput', 'content', 'locations']) if (tc[k] !== undefined) merged[k] = tc[k]
          const c = classifyTool(merged, o.cwd)
          open.set(key, { rpcId: id, kind: 'permission', params })
          deliver({
            kind: 'permissionRequest',
            requestId: key,
            toolName: c.toolName,
            input: c.input,
            description: null,
            reason: null,
            toolUseId: callId
          })
        }

        const request = (id: AcpId, method: string, params: unknown) => {
          const key = String(id)
          // A repeated id adds no second card: the first card's answer goes to that id.
          if (open.has(key)) return
          // A turn that is over or stopped asks the user nothing more.
          const closed = phase === 'ended' || outcome.stopped
          if (method === 'session/request_permission') {
            if (closed) rpc.respond(id, CANCELLED_PERMISSION)
            else permission(id, key, params)
          } else if (method === 'elicitation/create') {
            if (closed) return rpc.respond(id, CANCELLED_QUESTION)
            const input = elicitationQuestions(params)
            // A form no card can show (or url mode) is declined at once, so the agent never waits on it.
            if (!input) return rpc.respond(id, { action: 'decline' })
            open.set(key, { rpcId: id, kind: 'question', params })
            deliver({
              kind: 'permissionRequest',
              requestId: key,
              toolName: QUESTION_TOOL,
              input,
              description: null,
              reason: null,
              toolUseId: null
            })
          } else {
            // fs/*, terminal/* (never advertised) and anything newer.
            rpc.respondError(id, ACP_ERROR.methodNotFound, 'Method not found')
          }
        }

        const handle = (batch: string[]) => {
          for (const l of batch) {
            if (dead) return
            const m = rpc.receive(l)
            if (rpc.malformed > MALFORMED_MAX) return fail(ACP_TEXT.unreadable)
            if (!m) continue
            if (m.kind === 'notification') notification(m.method, m.params)
            else request(m.id, m.method, m.params)
            // A refused mode ends the turn at once; the agent may already act without asking.
            if (refused !== null && !dead) fail(ACP_TEXT.refusedMode(refused))
          }
        }
        out.on('data', (c: string) => {
          if (dead) return
          handle(lines.push(c))
          if (lines.over && !dead) fail(ACP_TEXT.unreadable)
        })
        err.on('data', (c: string) => {
          stderr += c
          if (stderr.length > STDERR_MAX) stderr = stderr.slice(-STDERR_MAX)
        })
        stdin.on('error', () => {
          /* EPIPE when the agent dies early */
        })

        proc.on('error', (e) => {
          if (settled) return
          outcome.spawnError = e.message
          finish()
        })
        // 'exit' fires when the agent dies; 'close' only after stdio drains, which a child holding the pipes delays.
        // finish waits a tick so a reply read in the last flush is handled first.
        proc.on('exit', (code, signal) => {
          if (settled) return
          exited = true
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          outcome.exitCode = code
          outcome.signal = signal
          endStdin()
          // The agent is gone; what it left running in its tree goes too, which also lets the pipes close. A tree already sent
          // SIGTERM by Stop's ladder is not sent it again.
          snap()
          if (termAt === null) sigterm()
          drainTimer = setTimeout(() => {
            out.destroy()
            err.destroy()
            if (!dead) handle(lines.flush())
            setImmediate(finish)
          }, DRAIN_MS)
        })
        proc.on('close', () => {
          if (settled || !exited) return
          if (!dead) handle(lines.flush())
          setImmediate(finish)
        })

        stopFn = () => {
          if (exited || settled || outcome.stopped) return
          outcome.stopped = true
          if (phase === 'prompting' && sessionId !== null && !dead) {
            // Before the cancel: the agent may end its tools' processes, and a shell they leave behind is reparented at once.
            snap()
            rpc.notify('session/cancel', { sessionId })
            cancelOpen()
            // The prompt's `cancelled` answer ends the turn; past the grace the tree is ended anyway.
            if (!timer) timer = setTimeout(term, grace)
          } else wind()
        }
        sendFn = (message) => {
          if (exited || settled || dead || outcome.stopped || stdin.destroyed || stdin.writableEnded) return false
          // Never throws: ChatService answers from inside its event handlers.
          try {
            const id = untagged(obj(obj(message)?.response)?.request_id)
            const req = id === null ? undefined : open.get(id)
            if (!req) return false
            open.delete(id!)
            rpc.respond(
              req.rpcId,
              req.kind === 'permission' ? acpPermissionAnswer(message, obj(req.params)?.options) : elicitationAnswer(message, req.params)
            )
            return true
          } catch {
            return false
          }
        }

        const endTurn = (reason: string) => {
          phase = 'ended'
          closeTurn()
          if (reason === 'cancelled') outcome.stopped = true
          else if (reason !== 'end_turn') errorText = ACP_TEXT.stopReason(reason)
          const size = mapper.contextWindow
          deliver({
            kind: 'result',
            subtype: reason,
            isError: reason !== 'end_turn' && reason !== 'cancelled',
            numTurns: 1,
            sessionId: sessionId!,
            denials: [],
            windows: size === null ? {} : { acp: size },
            uuid: null,
            cost: null
          })
          wind()
        }

        const gone = () => settled || exited || dead || outcome.stopped
        const start = async () => {
          const init = obj(
            await rpc.request('initialize', {
              protocolVersion: 1,
              clientCapabilities: ACP_CLIENT_CAPABILITIES,
              clientInfo: ACP_CLIENT_INFO
            })
          )
          if (gone()) return
          if (!init) return fail(ACP_TEXT.unreadable)
          if (init.protocolVersion !== 1) return fail(ACP_TEXT.protocol)
          signIn = authNames(init.authMethods)
          const agent = obj(init.agentCapabilities) ?? {}
          const sessionCaps = obj(agent.sessionCapabilities) ?? {}
          const version = obj(init.agentInfo)?.version
          const instructions = o.systemPrompt.trim() === '' ? null : o.systemPrompt
          const takesSystem = advertised(sessionCaps.systemPrompt)
          // Checked before any session, so an image the agent cannot take writes nothing into its store.
          const prompt = acpPrompt(
            o.prompt,
            obj(agent.promptCapabilities)?.image === true,
            o.start.kind === 'new' && instructions !== null && !takesSystem ? acpPreamble(instructions) : null
          )
          if (!prompt) return fail(ACP_TEXT.noImages)
          const system =
            instructions !== null && takesSystem
              ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: instructions }] } }
              : {}

          let res: Obj | null
          let id: string
          if (o.start.kind === 'new') {
            res = obj(await rpc.request('session/new', { cwd: o.cwd, mcpServers: [], ...system }))
            if (gone()) return
            if (typeof res?.sessionId !== 'string' || res.sessionId === '') return fail(ACP_TEXT.unreadable)
            id = res.sessionId
          } else {
            const method = advertised(sessionCaps.resume) ? 'session/resume' : agent.loadSession === true ? 'session/load' : null
            // The caller reseeds into a new session; this attempt starts none. An agent that resumes nothing is no lost session:
            // every turn reseeds, and the caller shows no notice for it.
            const missing = () => {
              outcome.missingSession = true
              dead = true
              wind()
            }
            if (method === null) {
              outcome.noResume = true
              return missing()
            }
            replaying = method === 'session/load'
            try {
              // The replay ends on the answer's own line, so a mode reported right after it in the same chunk is checked.
              res = obj(
                await rpc.request(method, { sessionId: o.start.sessionId, cwd: o.cwd, mcpServers: [], ...system }, () => {
                  replaying = false
                })
              )
            } catch (e) {
              // Signed out is not a lost session. Any other error reseeds once: a load into nothing loses nothing kept.
              if (!(e instanceof AcpRpcError) || e.code === ACP_ERROR.authRequired || gone()) throw e
              return missing()
            } finally {
              replaying = false
            }
            if (gone()) return
            id = o.start.sessionId
          }
          sessionId = id
          // The answer's own mode state wins; where it names none, the session's is the last its replay reported.
          const replayed = [
            ...(typeof obj(res?.modes)?.currentModeId !== 'string' && replayMode !== null ? [replayMode] : []),
            ...(Array.isArray(res?.configOptions) ? [] : replayOptions.values())
          ]
          const current = [...startModes(res), ...replayed]
          const mode = current.find(refusedMode)
          if (mode !== undefined) return fail(ACP_TEXT.refusedMode(mode))
          // The chat asks before acting, so a session in another of the agent's modes (the Claude adapter starts in the user's
          // own, such as auto) is put in its asking one first, on every turn: a resumed session may start in its default again.
          // Its update for the switch reaches the mapper, which checks it as any other; its answer is checked here.
          const ask = askSwitch(res, current)
          if (ask !== null) {
            let switched: Obj | null
            try {
              switched = obj(await rpc.request(ask.method, { sessionId: id, ...ask.params }))
            } catch (e) {
              if (!(e instanceof AcpRpcError) || e.code === ACP_ERROR.authRequired || gone()) throw e
              return fail(ACP_TEXT.askModeFailed)
            }
            if (gone()) return
            const after = startModes(switched).find(refusedMode)
            if (after !== undefined) return fail(ACP_TEXT.refusedMode(after))
            if (!askHeld(ask, switched)) return fail(ACP_TEXT.askModeFailed)
          }
          deliver({ kind: 'init', sessionId: id, ...(typeof version === 'string' && version ? { version: version.slice(0, 100) } : {}) })
          if (gone()) return
          phase = 'prompting'
          const answer = obj(await rpc.request('session/prompt', { sessionId: id, prompt }))
          if (settled || dead) return
          const reason = answer?.stopReason
          if (typeof reason !== 'string' || !STOP_REASONS.has(reason)) return fail(ACP_TEXT.unreadable)
          endTurn(reason)
        }
        start().catch((e) => {
          if (settled || dead) return
          // A stopped turn is a stop, whatever the agent answered after the cancel.
          if (e instanceof AcpRpcError && !outcome.stopped) {
            if (e.code === ACP_ERROR.authRequired) return fail(ACP_TEXT.notSignedIn(signIn))
            // Only the agent's own message, cut; a closed pipe is explained by the exit and stderr instead.
            errorText = e.message.slice(0, ERROR_MAX)
          }
          if (phase === 'prompting') {
            phase = 'ended'
            closeTurn()
          }
          wind()
        })
      })
    } catch (e) {
      outcome.spawnError = e instanceof Error ? e.message : String(e)
      finished = true
      return outcome
    }
  })()

  return {
    done,
    send: (message) => !finished && !earlyStop && sendFn(message),
    stop: () => {
      if (finished) return
      earlyStop = true
      stopFn()
    }
  }
}
