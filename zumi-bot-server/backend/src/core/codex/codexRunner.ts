import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { Writable } from 'node:stream'
import { CODEX_REFUSALS } from '@zumibot/shared/engine'
import type { RunHandle, RunOutcome } from '../chat/claudeRunner'
import { denyResponse, UNKNOWN_REQUEST_ERROR, type UserContent } from '../chat/controlProtocol'
import { LineSplitter, type RunEvent } from '../chat/streamParser'
import { codexAnswer, type CodexAnswer, type CodexRequestKind } from './codexAnswers'
import { CodexEventMapper } from './codexEvents'
import { codexVersion, dropHookTrust, HOOKS_TIMEOUT_MS, hooksTrusted, hookTrustFor, type HookTrust } from './codexHookTrust'
import { CODEX_QUESTION_FEATURE, codexInput, hookConfig, threadParams, type CodexThreadInput } from './codexParams'
import { CodexRpc, RpcError, type RpcId } from './codexRpc'
import { killTree } from '../procKill'

/** Where the run's thread comes from. A fork keeps the turns up to and including `lastTurnId` (probe check 7). */
export type CodexStart =
  { kind: 'new' } | { kind: 'resume'; threadId: string } | { kind: 'fork'; threadId: string; lastTurnId: string; ephemeral?: true }
/** What the run does on it: a turn on the prompt, or a compaction of the thread so far. */
export type CodexAction = { kind: 'turn'; prompt: UserContent } | { kind: 'compact' }

export interface CodexRunOptions {
  bin: string
  cwd: string
  env?: NodeJS.ProcessEnv
  start: CodexStart
  action: CodexAction
  thread: CodexThreadInput
  /** Features turned on for this process, each passed as `--enable <name>`. Never `multi_agent` or the question feature (FIXED). */
  enable?: string[]
  /**
   * Codex subagents (`--enable multi_agent` and no thread-level switch, as probe check 13 ran them); default off. The only way
   * to turn them on: a child thread runs turns ZumiBot must show and stop, which only a caller that maps them can.
   */
  subagents?: boolean
  /**
   * Asks codex for `thread.hooks`' trust again instead of using the cached table (`hookTrustFor`'s `fresh`). A run whose
   * hooks codex did not trust ends with `hooksUntrusted` and already forgets the table.
   */
  freshHookTrust?: boolean
  /** How long the hook pre-flight and this run's own `hooks/list` may each take (default HOOKS_TIMEOUT_MS); past it, `hooksUntrusted`. */
  hooksTimeoutMs?: number
  /**
   * The hook pre-flight's env in place of `env`. That process only lists hooks, so it needs none of the run's own values (the
   * agent's API keys least of all); the hash and the trust cache do not depend on the env.
   */
  hookTrustEnv?: NodeJS.ProcessEnv
  /**
   * Question cards (the `questions` cap); default on. Off: no question feature flag, and a question codex sends anyway is
   * refused at once with no card, as before question cards existed.
   */
  questions?: boolean
  /**
   * Prefixed to every request id the run emits (`<tag>:<id>`), and `send` answers only ids carrying it. Codex numbers its
   * requests from 0 in every process and a card's item id is its request id: one tag per attempt keeps a turn's first card
   * from taking an earlier attempt's id, and an id another attempt tagged never reaches this process.
   */
  requestTag?: string
  killGraceMs?: number
  killForceMs?: number
  onEvent(e: RunEvent): void
}

// multi_agent off unless `subagents`: Codex subagents would run turns ZumiBot neither shows nor stops. The question feature is
// on for every process while question cards are, since a question without it hangs the turn.
const ARGS = ['app-server', '--listen', 'stdio://']
// Set by `subagents` and `questions` alone: an `enable` naming one would undo the --disable, or turn questions on with no card for them.
const FIXED = new Set(['multi_agent', CODEX_QUESTION_FEATURE])
// Only names the client; codex echoes it in its userAgent.
const CLIENT_INFO = { name: 'zumibot', title: null, version: '1.0.0' }
const STDERR_MAX = 64 * 1024
const DRAIN_MS = 2000
const UNKNOWN_ANSWER: CodexAnswer = { error: { code: -32601, message: UNKNOWN_REQUEST_ERROR } }

// Real codex 0.164.0 answers an unknown thread with -32600 "no rollout found for thread id <id>"; a "not found" counts only
// when it names the thread, since dropping the thread on "model not found" would lose the conversation. -32601 is a method
// codex lacks, not a missing thread.
export const isMissingThread = (e: unknown) =>
  e instanceof RpcError && e.code !== -32601 && /no rollout found|thread[^\n]{0,40}not found/i.test(e.message)

type OpenRequest = { rpcId: RpcId; kind: CodexRequestKind | null; params: unknown }

// Ends a compaction whose turn/completed carried no turn, so the run still finishes like a turn.
const compactResult = (sessionId: string): RunEvent => ({
  kind: 'result',
  subtype: 'success',
  isError: false,
  numTurns: 0,
  sessionId,
  denials: [],
  windows: {},
  uuid: null,
  cost: null
})

/** One Codex turn or compaction over `codex app-server`, with the lifecycle and outcome of `runClaude`. */
export function runCodex(o: CodexRunOptions): RunHandle {
  const outcome: RunOutcome = { exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: false }
  const questions = o.questions !== false
  const prefix = o.requestTag === undefined ? '' : `${o.requestTag}:`
  // The tag goes on every id the caller sees, and only an id carrying it comes back off.
  const tagged = (e: RunEvent): RunEvent =>
    !prefix
      ? e
      : e.kind === 'permissionRequest' || e.kind === 'permissionCancel'
        ? { ...e, requestId: prefix + e.requestId }
        : e.kind === 'controlUnknown' && e.requestId !== null
          ? { ...e, requestId: prefix + e.requestId }
          : e
  const untagged = (id: unknown): string | null =>
    typeof id !== 'string' ? null : !prefix ? id : id.startsWith(prefix) ? id.slice(prefix.length) : null
  let stopFn: () => void = () => {}
  let earlyStop = false
  let finished = false
  let sendFn: (message: object) => boolean = () => false

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
      const hooks = o.thread.hooks ?? []
      const hooksMs = o.hooksTimeoutMs ?? HOOKS_TIMEOUT_MS
      let trust: HookTrust | null = null
      let hookArgs: string[] = []
      if (hooks.length) {
        // A stop ends the run at once; the pre-flight, which other runs may share, keeps its own deadline and kill.
        const stopped = new Promise<null>((r) => {
          stopFn = () => r(null)
        })
        trust = await Promise.race([
          hookTrustFor({ bin: o.bin, env: o.hookTrustEnv ?? o.env, cwd: o.cwd, hooks, fresh: o.freshHookTrust, timeoutMs: hooksMs }),
          stopped
        ])
        stopFn = () => {}
        if (earlyStop) {
          outcome.stopped = true
          finished = true
          return outcome
        }
        hookArgs = trust ? hookConfig(hooks, trust.trust) : []
        // No trust table, or hooks that cannot be written: codex would skip them silently, so the run must not start (fail closed).
        if (!hookArgs.length) {
          outcome.hooksUntrusted = true
          finished = true
          return outcome
        }
      }
      return await new Promise<RunOutcome>((resolve) => {
        let exited = false
        let settled = false
        let timer: NodeJS.Timeout | null = null
        let drainTimer: NodeJS.Timeout | null = null
        let inp: Writable | null = null
        let stderr = ''
        let startError: string | null = null // codex's own message for a failed request before the turn
        let threadId: string | null = null
        let turnId: string | null = null
        let turnSent = false
        // A compaction in progress: its `compacted` is held to the end, after `compacting` off, in the order Claude reports them.
        let compaction: { held: RunEvent[] } | null = null
        const mapper = new CodexEventMapper()
        const open = new Map<string, OpenRequest>() // requests shown to ChatService and not answered or resolved yet
        const rpc = new CodexRpc((line) => {
          if (!inp || inp.destroyed || inp.writableEnded) return false
          inp.write(line)
          return true
        })

        // Declared before `finish`, which calls them and runs on a failed spawn too, before the child's streams exist.
        const endStdin = () => {
          try {
            if (inp && !inp.destroyed && !inp.writableEnded) inp.end()
          } catch {
            /* already closed */
          }
        }
        const deliver = (e: RunEvent) => {
          const t = tagged(e)
          if (t.kind === 'result') outcome.result = t
          // Called from stream listeners and finish(): a throw would be uncaught (the server dies) or skip the rest of
          // finish() (the turn never ends). One bad event costs only itself.
          try {
            o.onEvent(t)
          } catch (err) {
            console.error('run event failed:', err instanceof Error ? err.message : String(err))
          }
          // codex stays up while stdin is open; the turn's end is its last word.
          if (t.kind === 'result') endStdin()
        }
        const endCompaction = () => {
          if (!compaction) return
          const { held } = compaction
          compaction = null
          deliver({ kind: 'compacting', on: false })
          for (const e of held) deliver(e)
        }
        const emit = (events: RunEvent[]) => {
          for (const e of events) {
            if (compaction && e.kind === 'compacted') {
              compaction.held.push(e)
              continue
            }
            if (compaction && e.kind === 'result') endCompaction()
            deliver(e)
          }
        }

        const finish = () => {
          if (settled) return
          // A blocked call codex sent nothing after (the process died) still gets its row.
          emit(mapper.flush())
          // A compaction cut short (a dead process, a failed request) still ends, so nothing shows "Compacting…" forever.
          endCompaction()
          settled = true
          finished = true
          if (timer) clearTimeout(timer)
          if (drainTimer) clearTimeout(drainTimer)
          rpc.close(new Error('Codex exited'))
          // Signed out is a fixed sentence, never codex's text; else codex's own error beats the log lines on stderr.
          outcome.stderr = mapper.lastErrorInfo === 'unauthorized' ? CODEX_REFUSALS.signedOut : (mapper.lastError ?? startError ?? stderr)
          resolve(outcome)
        }

        let child: ReturnType<typeof spawn>
        try {
          const args = [
            ...ARGS,
            ...(o.subagents ? ['--enable', 'multi_agent'] : ['--disable', 'multi_agent']),
            ...(questions ? ['--enable', CODEX_QUESTION_FEATURE] : []),
            ...(o.enable ?? []).filter((name) => !FIXED.has(name)).flatMap((name) => ['--enable', name]),
            ...hookArgs
          ]
          child = spawn(o.bin, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
        } catch (e) {
          outcome.spawnError = e instanceof Error ? e.message : String(e)
          return finish()
        }
        const out = child.stdout!,
          err = child.stderr!
        const stdin = child.stdin!
        inp = stdin
        out.setEncoding('utf8')
        err.setEncoding('utf8')
        const split = new LineSplitter()
        const answer = (rpcId: RpcId, a: CodexAnswer) => {
          if ('result' in a) rpc.respond(rpcId, a.result)
          else rpc.respondError(rpcId, a.error.code, a.error.message)
          mapper.answered(rpcId)
        }
        // A request with no card (a question with none usable, an elicitation that is no tool approval or names no sure tool,
        // a patch with no changes to show or asking for a write root) is refused at once, so codex never waits on an answer nobody can give: a decline,
        // or for a question an empty answer.
        const refusal = (id: RpcId, kind: CodexRequestKind | null, params: unknown): CodexAnswer =>
          kind === null ? UNKNOWN_ANSWER : codexAnswer(kind, denyResponse(String(id), UNKNOWN_REQUEST_ERROR), params)

        const handle = (lines: string[]) => {
          for (const l of lines) {
            const m = rpc.receive(l)
            if (!m) continue
            if (m.kind === 'notification') {
              // Settled by codex itself (an interrupt): a late answer must find nothing to answer.
              if (m.method === 'serverRequest/resolved' && m.params?.requestId != null) open.delete(String(m.params.requestId))
              // thread/compact/start answers before its turn exists: the turn's id, which an interrupt needs, comes here.
              if (compaction && m.method === 'turn/started' && turnId === null && typeof m.params?.turn?.id === 'string') {
                turnId = m.params.turn.id
                if (outcome.stopped) interrupt()
              }
              const events = mapper.notification(m.method, m.params)
              if (compaction && m.method === 'turn/completed' && !events.some((e) => e.kind === 'result'))
                events.push(compactResult(threadId ?? ''))
              emit(events)
              continue
            }
            // A held blocked-call row goes first, in the order codex sent things.
            emit(mapper.flush())
            const r = mapper.serverRequest(m.id, m.method, m.params)
            // Without question cards a question gets Phase 1's answer: refused at once, with no card.
            if (r.kind === 'userInput' && !questions) {
              answer(m.id, UNKNOWN_ANSWER)
              continue
            }
            if (!r.events.length) {
              answer(m.id, refusal(m.id, r.kind, m.params))
              continue
            }
            open.set(String(m.id), { rpcId: m.id, kind: r.kind, params: m.params })
            emit(r.events)
          }
        }
        out.on('data', (c: string) => handle(split.push(c)))
        err.on('data', (c: string) => {
          stderr += c
          if (stderr.length > STDERR_MAX) stderr = stderr.slice(-STDERR_MAX)
        })
        stdin.on('error', () => {
          /* EPIPE when child dies early */
        })

        child.on('error', (e) => {
          if (settled) return
          outcome.spawnError = e.message
          finish()
        })
        // 'exit' fires when the process dies; 'close' only after stdio drains, which
        // may never happen if a grandchild (an MCP server) inherited the pipes.
        child.on('exit', (code, signal) => {
          if (settled) return
          exited = true
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          outcome.exitCode = code
          outcome.signal = signal
          endStdin()
          drainTimer = setTimeout(() => {
            out.destroy()
            err.destroy()
            handle(split.flush())
            finish()
          }, DRAIN_MS)
        })
        child.on('close', () => {
          if (settled || !exited) return
          handle(split.flush())
          finish()
        })

        // runClaude's SIGINT/SIGTERM/SIGKILL ladder, one grace later: the polite step (an interrupt, or stdin closed)
        // comes first, and an early SIGINT would kill codex before it reads the interrupt.
        const killLadder = () => {
          if (exited || settled || timer) return
          const grace = o.killGraceMs ?? 3000
          timer = setTimeout(() => {
            if (exited) return
            // Windows: SIGINT would be TerminateProcess on claude alone, orphaning its tools' processes; end the tree.
            if (process.platform === 'win32') killTree(child.pid)
            else child.kill('SIGINT')
            timer = setTimeout(() => {
              if (exited) return
              child.kill('SIGTERM')
              timer = setTimeout(() => {
                if (!exited) child.kill('SIGKILL')
              }, o.killForceMs ?? 5000)
            }, grace)
          }, grace)
        }
        const interrupt = () => {
          if (!threadId || !turnId) return
          rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {
            /* codex is gone; the ladder ends it */
          })
        }

        stopFn = () => {
          if (exited || settled || outcome.stopped) return
          outcome.stopped = true
          if (turnId) interrupt()
          else if (!turnSent) endStdin() // no turn yet: codex ends when its stdin closes
          // else turn/start is on its way: its answer sends the interrupt
          killLadder()
        }
        sendFn = (message) => {
          if (exited || settled || outcome.stopped || stdin.destroyed || stdin.writableEnded) return false
          // Never throws: ChatService answers from inside its event handlers.
          try {
            const id = untagged((message as { response?: { request_id?: unknown } } | null)?.response?.request_id)
            const req = id === null ? undefined : open.get(id)
            if (!req) return false
            open.delete(id!)
            answer(req.rpcId, req.kind === null ? UNKNOWN_ANSWER : codexAnswer(req.kind, message, req.params))
            return true
          } catch {
            return false
          }
        }

        const gone = () => settled || outcome.stopped
        const start = async () => {
          const init = await rpc.request<{ userAgent?: unknown } | null>('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
          if (gone()) return
          rpc.notify('initialized')
          if (trust) {
            // The table belongs to the codex that reported it; another version may hash differently, so the next run asks again.
            if (codexVersion(init?.userAgent) !== trust.version) dropHookTrust(o.bin, hooks)
            // An untrusted hook is skipped silently (check 11): before any thread, so the run spends nothing. A listing that
            // fails or outlives its deadline counts as untrusted.
            let deadline: NodeJS.Timeout | undefined
            const listed = await Promise.race([
              rpc.request('hooks/list', { cwds: [o.cwd] }),
              new Promise<null>((r) => {
                deadline = setTimeout(() => r(null), hooksMs)
              })
            ])
              .catch(() => null)
              .finally(() => clearTimeout(deadline))
            if (gone()) return
            if (!hooksTrusted(listed, hooks)) {
              dropHookTrust(o.bin, hooks)
              outcome.hooksUntrusted = true
              endStdin()
              killLadder()
              return
            }
          }
          const params = threadParams(o.thread, { subagents: o.subagents })
          const s = o.start
          let res: { thread?: { id?: unknown }; model?: unknown } | null
          try {
            // excludeTurns: the answer leaves out the turns, which nothing here reads, and the model still remembers them
            // (probe check 16). An ephemeral fork is refused without it (check 8).
            res =
              s.kind === 'new'
                ? await rpc.request('thread/start', params)
                : s.kind === 'resume'
                  ? await rpc.request('thread/resume', { threadId: s.threadId, ...params, excludeTurns: true })
                  : // lastTurnId as the stamp gives it: codex keeps that turn (inclusive, probe checks 7 and 16).
                    await rpc.request('thread/fork', {
                      threadId: s.threadId,
                      lastTurnId: s.lastTurnId,
                      ...params,
                      ...(s.ephemeral ? { ephemeral: true } : {}),
                      excludeTurns: true
                    })
          } catch (e) {
            // A main turn's fork reseeds on any error codex answers: the fork never writes into its source, and the rewind point
            // would otherwise fail the same way on every later send. A side run's (ephemeral) fork and a compaction's keep the rule.
            const reseeds = s.kind === 'fork' && !s.ephemeral && o.action.kind === 'turn' ? e instanceof RpcError : isMissingThread(e)
            if (s.kind === 'new' || !reseeds) throw e
            if (settled) return
            // The caller reseeds into a fresh thread; this run starts no turn.
            outcome.missingSession = true
            endStdin()
            killLadder()
            return
          }
          if (gone()) return
          // Only a resume may fall back to the id it asked for: a fork's thread is a new one, or the fork never happened.
          const id = typeof res?.thread?.id === 'string' ? res.thread.id : s.kind === 'resume' ? s.threadId : null
          if (!id) throw new RpcError(-32603, 'Codex started no thread')
          threadId = id
          emit(mapper.started(id, typeof res?.model === 'string' ? res.model : null, codexVersion(init?.userAgent)))
          if (gone()) return
          if (o.action.kind === 'compact') {
            // Before the request: its turn's notices may follow its answer at once.
            compaction = { held: [] }
            deliver({ kind: 'compacting', on: true })
            if (gone()) return
            turnSent = true
            // Answers {} at once; a real turn then runs, holding a contextCompaction item, and turn/completed ends it (probe check 9).
            // A stop meanwhile is sent by turn/started, which names the turn; the kill ladder covers one that never comes.
            await rpc.request('thread/compact/start', { threadId: id })
            return
          }
          turnSent = true
          const turn = await rpc.request<{ turn?: { id?: unknown } } | null>('turn/start', {
            threadId: id,
            input: codexInput(o.action.prompt)
          })
          if (settled) return
          turnId = typeof turn?.turn?.id === 'string' ? turn.turn.id : null
          // A stop that came while turn/start was on its way.
          if (outcome.stopped) {
            if (turnId) interrupt()
            else endStdin()
          }
        }
        start().catch((e) => {
          if (settled) return
          // Only codex's own message; a closed pipe is explained by the exit and stderr instead.
          if (e instanceof RpcError) startError = e.message
          endStdin()
          killLadder()
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
