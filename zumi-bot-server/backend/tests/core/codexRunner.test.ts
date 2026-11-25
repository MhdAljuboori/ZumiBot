import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { CODEX_REFUSALS } from '@zumibot/shared/engine'
import { isMissingThread, runCodex, type CodexRunOptions } from '../../src/core/codex/codexRunner'
import { codexHookTrust } from '../../src/core/codex/codexHookTrust'
import { RpcError } from '../../src/core/codex/codexRpc'
import {
  CODEX_QUESTION_FEATURE,
  codexInput,
  hookConfig,
  threadParams,
  type CodexHook,
  type CodexThreadInput
} from '../../src/core/codex/codexParams'
import { allowResponse, denyResponse, errorResponse } from '../../src/core/chat/controlProtocol'
import type { RunEvent } from '../../src/core/chat/streamParser'
import { codexShim } from '../support/codexShim'

// What every Codex process is started with.
const ARGV = ['app-server', '--listen', 'stdio://', '--disable', 'multi_agent', '--enable', 'default_mode_request_user_input']
const FAKE = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'cb-codex-runner-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
// runCodex spawns `bin app-server ...`, so the fake (or a stand-in script) is reached through a fake bin; `before` is
// JavaScript it runs first, in the same process (Windows cannot spawn a sh shim).
const shim = (name: string, script: string, before = ''): string => codexShim(root, name, script, before)
// The shim's argv, one arg a line; its env as `env` prints it.
const argsTo = (file: string) => `fs.writeFileSync(${JSON.stringify(file)}, args.map((a) => a + '\\n').join(''))\n`
const envTo = (file: string) =>
  `fs.writeFileSync(${JSON.stringify(file)}, Object.entries(process.env).map(([k, v]) => k + '=' + v + '\\n').join(''))\n`
const codexBin = shim('codex', FAKE)

let dir: string
let n = 0
beforeEach(() => {
  dir = join(root, `case-${n++}`)
  mkdirSync(join(dir, 'home'), { recursive: true })
  mkdirSync(join(dir, 'ws'))
})

const ws = () => join(dir, 'ws')
const home = () => join(dir, 'home')
const logFile = () => join(dir, 'log.jsonl')
const answersFile = () => join(dir, 'answers.jsonl')
const lines = (p: string) =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const methods = () => lines(logFile()).map((l: any) => l.method)
function script(...steps: unknown[]): string {
  const p = join(dir, 'script.jsonl')
  writeFileSync(p, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return p
}

const thread = (o: Partial<CodexThreadInput> = {}): CodexThreadInput => ({
  cwd: ws(),
  baseInstructions: 'You are a test agent.',
  permissionMode: 'manual',
  mcpServers: [],
  ...o
})

function run(
  env: Record<string, string> = {},
  o: Partial<CodexRunOptions> & { react?: (e: RunEvent, h: ReturnType<typeof runCodex>) => void } = {}
) {
  const events: RunEvent[] = []
  const { react, ...rest } = o
  let h: ReturnType<typeof runCodex> | null = null
  h = runCodex({
    bin: codexBin,
    cwd: ws(),
    start: { kind: 'new' },
    action: { kind: 'turn', prompt: 'hello' },
    thread: thread(),
    env: { ...process.env, FAKE_CODEX_HOME: home(), FAKE_CODEX_LOG: logFile(), FAKE_CODEX_ANSWERS: answersFile(), ...env },
    onEvent: (e) => {
      events.push(e)
      react?.(e, h!)
    },
    ...rest
  })
  return { h, events }
}

const delta = (text: string) => ({
  notify: { method: 'item/agentMessage/delta', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'm1', delta: text } }
})
const message = (text: string) => ({
  notify: { method: 'item/completed', params: { threadId: '$THREAD', turnId: '$TURN', item: { type: 'agentMessage', id: 'm1', text } } }
})
const approval = (command: string) => ({
  request: {
    method: 'item/commandExecution/requestApproval',
    params: { threadId: '$THREAD', turnId: '$TURN', itemId: `e-${command}`, command, cwd: '/w', reason: null }
  }
})
const askQ = (id: string) => ({
  request: {
    method: 'item/tool/requestUserInput',
    params: {
      threadId: '$THREAD',
      turnId: '$TURN',
      itemId: 'q1',
      questions: [
        {
          id,
          header: 'Color',
          question: 'Which color do you pick?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Red', description: 'Pick red.' },
            { label: 'Blue', description: 'Pick blue.' }
          ]
        }
      ]
    }
  }
})

describe('runCodex against fake-codex', () => {
  test('a turn with skills sends them as skill items on turn/start', async () => {
    const skills = [{ name: 'pdf', path: '/s/pdf/SKILL.md' }]
    const { h } = run({ FAKE_CODEX_SCRIPT: script(message('ok')) }, { skills, action: { kind: 'turn', prompt: '$pdf hello' } })
    await h.done
    const log = lines(logFile())
    expect(log.find((l: any) => l.method === 'turn/start').params.input).toEqual(codexInput('$pdf hello', skills))
    expect(log.find((l: any) => l.method === 'turn/start').params.input.at(-1)).toEqual({ type: 'skill', name: 'pdf', path: '/s/pdf/SKILL.md' })
  })

  test('a plain turn: init, text, result; the outcome holds the result and exit code 0', async () => {
    const { h, events } = run({ FAKE_CODEX_SCRIPT: script(delta('Hi'), delta(' there'), message('Hi there')) })
    const out = await h.done
    expect(events.map((e) => e.kind)).toEqual(['init', 'textDelta', 'textDelta', 'assistantText', 'entry', 'result'])
    const init = events[0] as Extract<RunEvent, { kind: 'init' }>
    expect(init.sessionId).toMatch(/[0-9a-f-]{36}/)
    expect(init.version).toBe('0.0.0') // after the first '/' of 'fake-codex/0.0.0 (...)'
    const result = events.at(-1) as Extract<RunEvent, { kind: 'result' }>
    expect(result).toMatchObject({ isError: false, subtype: 'completed', sessionId: init.sessionId })
    expect(out.result).toEqual(result)
    expect(out).toMatchObject({ exitCode: 0, signal: null, spawnError: null, stopped: false, stderr: '' })
    expect(out.missingSession).toBeUndefined()
    const log = lines(logFile())
    expect(log.map((l: any) => l.method)).toEqual(['initialize', 'thread/start', 'turn/start'])
    expect(log[0].params).toEqual({ clientInfo: { name: 'zumibot', title: null, version: expect.any(String) }, capabilities: null })
    expect(log[1].params).toEqual(threadParams(thread()))
    expect(log[2].params).toEqual({ threadId: init.sessionId, input: codexInput('hello') })
  })

  test('spawns exactly app-server over stdio with multi_agent off, adding nothing to the env', async () => {
    const argsOut = join(dir, 'args.txt'),
      envOut = join(dir, 'env.txt')
    const bin = shim(`codex-args-${n}`, FAKE, argsTo(argsOut) + envTo(envOut))
    const given = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE_CODE_'))) as Record<string, string>
    const { h } = run({}, { bin, env: { ...given, FAKE_CODEX_HOME: home() } })
    await h.done
    expect(readFileSync(argsOut, 'utf8').split('\n').filter(Boolean)).toEqual(ARGV)
    expect(
      readFileSync(envOut, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('CLAUDE_CODE_'))
    ).toEqual([])
  })

  test('resume sends thread/resume with the given id, the same thread params and excludeTurns (check 16: the answer then holds no turns)', async () => {
    mkdirSync(join(home(), 'threads'), { recursive: true })
    writeFileSync(join(home(), 'threads', 'thread-old'), '')
    const { h, events } = run({}, { start: { kind: 'resume', threadId: 'thread-old' } })
    const out = await h.done
    const log = lines(logFile())
    expect(log.map((l: any) => l.method)).toEqual(['initialize', 'thread/resume', 'turn/start'])
    expect(log[1].params).toEqual({ threadId: 'thread-old', ...threadParams(thread()), excludeTurns: true })
    expect(log[2].params.threadId).toBe('thread-old')
    expect(events[0]).toMatchObject({ kind: 'init', sessionId: 'thread-old' })
    expect(out.result?.sessionId).toBe('thread-old')
    expect(out.missingSession).toBeUndefined()
  })

  test('a missing thread ends with missingSession and no turn', async () => {
    const { h, events } = run({}, { start: { kind: 'resume', threadId: 'gone-thread' } })
    const out = await h.done
    expect(out.missingSession).toBe(true)
    expect(methods()).toEqual(['initialize', 'thread/resume'])
    expect(events).toEqual([])
    expect(out).toMatchObject({ result: null, stopped: false, spawnError: null, exitCode: 0 })
  })

  test('a missing thread is told by real codex\'s wording or a thread-specific "not found", and by nothing else', () => {
    // Observed on real codex 0.164.0 resuming an unknown UUID.
    expect(isMissingThread(new RpcError(-32600, 'no rollout found for thread id 0b1e5c1a-0000-4000-8000-000000000000'))).toBe(true)
    expect(isMissingThread(new RpcError(-32600, 'no rollout found for thread id x'))).toBe(true)
    expect(isMissingThread(new RpcError(-32600, 'thread not found: abc'))).toBe(true)
    expect(isMissingThread(new RpcError(-32600, 'Thread abc was not found'))).toBe(true)
    // Another missing thing on resume is no reason to drop the thread.
    expect(isMissingThread(new RpcError(-32600, 'model not found'))).toBe(false)
    expect(isMissingThread(new RpcError(-32600, 'model gpt-x not found for this account'))).toBe(false)
    expect(isMissingThread(new RpcError(-32601, 'Method not found: thread/resume'))).toBe(false)
    expect(isMissingThread(new RpcError(-32603, 'rate limited'))).toBe(false)
    expect(isMissingThread(new Error('no rollout found for thread id x'))).toBe(false)
  })

  test('approval round trip: allow and deny reach codex as accept and decline', async () => {
    const sent: boolean[] = []
    const { h, events } = run(
      { FAKE_CODEX_SCRIPT: script(approval('ls'), approval('rm'), message('done')) },
      {
        react: (e, hh) => {
          if (e.kind !== 'permissionRequest') return
          const input = e.input as { command: string }
          sent.push(hh.send(input.command === 'ls' ? allowResponse(e.requestId, {}) : denyResponse(e.requestId, 'No.')))
        }
      }
    )
    const out = await h.done
    const asks = events.filter((e) => e.kind === 'permissionRequest')
    expect(asks).toMatchObject([
      { requestId: '0', toolName: 'Bash', input: { command: 'ls', cwd: '/w' }, toolUseId: 'e-ls' },
      { requestId: '1', toolName: 'Bash', input: { command: 'rm', cwd: '/w' }, toolUseId: 'e-rm' }
    ])
    expect(sent).toEqual([true, true])
    expect(lines(answersFile())).toEqual([
      { id: 0, result: { decision: 'accept' } },
      { id: 1, result: { decision: 'decline' } }
    ])
    // The resolved notices that follow the answers cancel nothing.
    expect(events.some((e) => e.kind === 'permissionCancel')).toBe(false)
    expect(out.result?.isError).toBe(false)
  })

  test('an answer to a request already answered and resolved returns false', async () => {
    const results: boolean[] = []
    const { h } = run(
      { FAKE_CODEX_SCRIPT: script(approval('ls'), { sleep: 50 }, message('done')) },
      {
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') results.push(hh.send(allowResponse(e.requestId, {})))
          if (e.kind === 'assistantText') results.push(hh.send(allowResponse('0', {})))
        }
      }
    )
    await h.done
    expect(results).toEqual([true, false])
    expect(lines(answersFile())).toHaveLength(1)
  })

  test('stop interrupts the running turn, then the process ends', async () => {
    let stoppedAt = 0
    const { h, events } = run(
      { FAKE_CODEX_SCRIPT: script(delta('x'), { sleep: 60000 }, delta('never')) },
      {
        react: (e, hh) => {
          if (e.kind === 'textDelta' && !stoppedAt) {
            stoppedAt = Date.now()
            hh.stop()
          }
        }
      }
    )
    const out = await h.done
    expect(Date.now() - stoppedAt).toBeLessThan(2500)
    expect(out.stopped).toBe(true)
    const log = lines(logFile())
    const turnId = (out.result as any)?.uuid
    expect(log.map((l: any) => l.method)).toEqual(['initialize', 'thread/start', 'turn/start', 'turn/interrupt'])
    expect(log[3].params).toEqual({ threadId: events[0].kind === 'init' ? events[0].sessionId : null, turnId })
    expect(out.result).toMatchObject({ subtype: 'interrupted', isError: false })
    expect(events.filter((e) => e.kind === 'textDelta')).toHaveLength(1)
  }, 10_000)

  test('a late answer after the interrupt resolved the request returns false and throws nothing', async () => {
    let id: string | null = null
    let afterStop: boolean | null = null
    const { h, events } = run(
      { FAKE_CODEX_SCRIPT: script(approval('ls'), message('never')) },
      {
        react: (e, hh) => {
          if (e.kind !== 'permissionRequest') return
          id = e.requestId
          hh.stop()
          // Once stopped, no answer may reach codex any more.
          afterStop = hh.send(allowResponse(e.requestId, {}))
        }
      }
    )
    const out = await h.done
    expect(id).toBe('0')
    expect(afterStop).toBe(false)
    expect(out.stopped).toBe(true)
    expect(methods()).toContain('turn/interrupt')
    expect(events).toContainEqual({ kind: 'permissionCancel', requestId: '0' })
    let r: boolean | undefined
    expect(() => {
      r = h.send(allowResponse('0', {}))
    }).not.toThrow()
    expect(r).toBe(false)
    expect(lines(answersFile())).toEqual([])
  }, 10_000)

  test('a request ZumiBot does not show is answered at once: a question with none to show is skipped, other elicitations declined', async () => {
    const { h, events } = run({
      FAKE_CODEX_SCRIPT: script(
        {
          request: { method: 'item/tool/requestUserInput', params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'q1', questions: [] } }
        },
        {
          request: {
            method: 'mcpServer/elicitation/request',
            params: { threadId: '$THREAD', turnId: '$TURN', serverName: 'x', mode: 'form', message: 'Pick', _meta: null }
          }
        },
        message('ok')
      )
    })
    const out = await h.done
    expect(events.map((e) => e.kind)).toEqual(['init', 'assistantText', 'entry', 'result'])
    const got = lines(answersFile())
    expect(got[0]).toEqual({ id: 0, result: { answers: {} } })
    expect(got[1]).toEqual({ id: 1, result: { action: 'decline', content: null, _meta: null } })
    expect(out.result?.isError).toBe(false)
  })

  test('a question shows as an AskUserQuestion card, and its answer reaches codex by question id', async () => {
    const { h, events } = run(
      { FAKE_CODEX_SCRIPT: script(askQ('color'), message('Red it is')) },
      {
        react: (e, hh) => {
          if (e.kind !== 'permissionRequest') return
          const input = e.input as { questions: Array<{ question: string }> }
          hh.send(allowResponse(e.requestId, { ...input, answers: { [input.questions[0].question]: 'Red' } }))
        }
      }
    )
    const out = await h.done
    const card = events.find((e) => e.kind === 'permissionRequest') as Extract<RunEvent, { kind: 'permissionRequest' }>
    expect(card.toolName).toBe('AskUserQuestion')
    expect((card.input as any).questions[0]).toMatchObject({ question: 'Which color do you pick?', codexId: 'color' })
    expect(lines(answersFile())).toEqual([{ id: 0, result: { answers: { color: { answers: ['Red'] } } } }])
    expect(out.result?.isError).toBe(false)
  })

  test('Skip answers with no answers and the turn completes', async () => {
    const { h } = run(
      { FAKE_CODEX_SCRIPT: script(askQ('color'), message('Carrying on')) },
      {
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.send(denyResponse(e.requestId, 'Skipped by the user'))
        }
      }
    )
    const out = await h.done
    expect(lines(answersFile())).toEqual([{ id: 0, result: { answers: {} } }])
    expect(out.result).toMatchObject({ isError: false, subtype: 'completed' })
  })

  test('a file approval for changes it never saw is declined at once, with no card', async () => {
    const { h, events } = run({
      FAKE_CODEX_SCRIPT: script(
        {
          request: {
            method: 'item/fileChange/requestApproval',
            params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'f-unseen', reason: null, grantRoot: null }
          }
        },
        message('ok')
      )
    })
    const out = await h.done
    expect(events.some((e) => e.kind === 'permissionRequest')).toBe(false)
    expect(lines(answersFile())).toEqual([{ id: 0, result: { decision: 'decline' } }])
    expect(out.result?.isError).toBe(false)
  })

  test('a file approval that asks for a session-wide write root is declined at once, with no card, and the turn goes on', async () => {
    const { h, events } = run({
      FAKE_CODEX_SCRIPT: script(
        {
          notify: {
            method: 'item/started',
            params: {
              threadId: '$THREAD',
              turnId: '$TURN',
              item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/w/a', kind: { type: 'add' }, diff: 'x' }] }
            }
          }
        },
        {
          request: {
            method: 'item/fileChange/requestApproval',
            params: { threadId: '$THREAD', turnId: '$TURN', itemId: 'f1', reason: null, grantRoot: '/' }
          }
        },
        message('ok')
      )
    })
    const out = await h.done
    expect(events.some((e) => e.kind === 'permissionRequest')).toBe(false)
    expect(lines(answersFile())).toEqual([{ id: 0, result: { decision: 'decline' } }])
    expect(events.map((e) => e.kind)).toEqual(['init', 'toolUse', 'assistantText', 'entry', 'result'])
    expect(out.result?.isError).toBe(false)
  })

  test('an unknown request is shown as controlUnknown and its error answer goes back as an error', async () => {
    const sent: boolean[] = []
    const { h, events } = run(
      { FAKE_CODEX_SCRIPT: script({ request: { method: 'some/new/request', params: {} } }) },
      {
        react: (e, hh) => {
          if (e.kind === 'controlUnknown') sent.push(hh.send(errorResponse(e.requestId!, 'ZumiBot does not handle this request')))
        }
      }
    )
    await h.done
    expect(events).toContainEqual({ kind: 'controlUnknown', requestId: '0', subtype: 'some/new/request' })
    expect(sent).toEqual([true])
    expect(lines(answersFile())).toEqual([{ id: 0, error: { code: -32601, message: expect.any(String) } }])
  })

  test('send never throws on odd input and refuses ids that are not open', async () => {
    const results: boolean[] = []
    const { h } = run(
      { FAKE_CODEX_SCRIPT: script(approval('ls'), message('done')) },
      {
        react: (e, hh) => {
          if (e.kind !== 'permissionRequest') return
          results.push(hh.send({}), hh.send({ response: null }), hh.send(allowResponse('42', {})), hh.send(null as unknown as object))
          results.push(hh.send(allowResponse(e.requestId, {})))
        }
      }
    )
    await h.done
    expect(results).toEqual([false, false, false, false, true])
    expect(h.send(allowResponse('0', {}))).toBe(false)
  })

  test('signed out: an unauthorized error becomes the fixed sign-in sentence', async () => {
    const { h, events } = run({ FAKE_CODEX_UNAUTHORIZED: '1' })
    const out = await h.done
    expect(out.stderr).toBe(CODEX_REFUSALS.signedOut)
    expect(out.result?.isError).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'result', subtype: 'failed' })
  })

  test("a failed turn reports codex's own error message rather than the process stderr", async () => {
    const { h } = run({
      FAKE_CODEX_SCRIPT: script(
        {
          notify: {
            method: 'error',
            params: {
              error: { message: 'stream disconnected', codexErrorInfo: 'other', additionalDetails: null },
              willRetry: false,
              threadId: '$THREAD',
              turnId: '$TURN'
            }
          }
        },
        {
          notify: {
            method: 'turn/completed',
            params: { threadId: '$THREAD', turn: { id: '$TURN', status: 'failed', error: { message: 'stream disconnected' } } }
          }
        }
      )
    })
    const out = await h.done
    expect(out.stderr).toBe('stream disconnected')
    expect(out.result?.isError).toBe(true)
  })

  test('a missing folder is a spawn error and nothing runs', async () => {
    const { h, events } = run({}, { cwd: '/nope/xyz' })
    const out = await h.done
    expect(out.spawnError).toBe('Folder not found: /nope/xyz')
    expect(events).toEqual([])
    expect(existsSync(logFile())).toBe(false)
  })

  test('a folder that is a file is a spawn error too', async () => {
    const { h } = run({}, { cwd: FAKE })
    expect((await h.done).spawnError).toBe(`Folder not found: ${FAKE}`)
  })

  test('a bad bin is a spawn error', async () => {
    const { h } = run({}, { bin: '/nope/codex' })
    const out = await h.done
    expect(out.spawnError).toContain('ENOENT')
    expect(out.exitCode).toBeNull()
  })

  test('stop before the process starts runs nothing', async () => {
    const { h, events } = run()
    h.stop()
    const out = await h.done
    expect(out.stopped).toBe(true)
    expect(events).toEqual([])
    expect(existsSync(logFile())).toBe(false)
  })

  test('stop and send after the end are no-ops', async () => {
    const { h } = run()
    const out = await h.done
    expect(() => {
      h.stop()
      h.stop()
    }).not.toThrow()
    expect(out.stopped).toBe(false)
    expect(h.send(allowResponse('0', {}))).toBe(false)
  })

  test('a codex that dies at start keeps its stderr and exit code', async () => {
    const dies = join(root, `dies-${n}.mjs`)
    writeFileSync(dies, `process.stderr.write('boom'); process.exit(1)\n`)
    const { h, events } = run({}, { bin: shim(`codex-dies-${n}`, dies) })
    const out = await h.done
    expect(out).toMatchObject({ exitCode: 1, stderr: 'boom', result: null, spawnError: null })
    expect(events).toEqual([])
  })
})

describe('runCodex start modes, actions and options', () => {
  // A thread an earlier codex process made: the fake resumes or forks one whose marker exists.
  const saved = (id: string) => {
    mkdirSync(join(home(), 'threads'), { recursive: true })
    writeFileSync(join(home(), 'threads', id), '')
  }
  const marked = (id: string) => existsSync(join(home(), 'threads', id))

  test('fork sends thread/fork with the source, lastTurnId, the thread params and excludeTurns, then runs the turn on the new thread', async () => {
    saved('thread-src')
    const { h, events } = run({}, { start: { kind: 'fork', threadId: 'thread-src', lastTurnId: 'turn-1' } })
    const out = await h.done
    const log = lines(logFile())
    expect(log.map((l: any) => l.method)).toEqual(['initialize', 'thread/fork', 'turn/start'])
    expect(log[1].params).toEqual({ threadId: 'thread-src', lastTurnId: 'turn-1', ...threadParams(thread()), excludeTurns: true })
    const init = events[0] as Extract<RunEvent, { kind: 'init' }>
    expect(init.kind).toBe('init')
    expect(init.sessionId).not.toBe('thread-src')
    expect(log[2].params).toEqual({ threadId: init.sessionId, input: codexInput('hello') })
    expect(out.result).toMatchObject({ isError: false, sessionId: init.sessionId })
    expect(out.missingSession).toBeUndefined()
    // A kept fork is a thread a later process can resume; the source is untouched.
    expect(marked(init.sessionId)).toBe(true)
    expect(marked('thread-src')).toBe(true)
  })

  test('an ephemeral fork also sends ephemeral and excludeTurns, which codex requires together, and leaves no thread behind', async () => {
    saved('thread-src')
    const { h, events } = run({}, { start: { kind: 'fork', threadId: 'thread-src', lastTurnId: 'turn-2', ephemeral: true } })
    const out = await h.done
    const log = lines(logFile())
    expect(log[1]).toEqual({
      method: 'thread/fork',
      params: { threadId: 'thread-src', lastTurnId: 'turn-2', ...threadParams(thread()), ephemeral: true, excludeTurns: true }
    })
    const init = events[0] as Extract<RunEvent, { kind: 'init' }>
    expect(init.sessionId).not.toBe('thread-src')
    expect(out.result?.isError).toBe(false)
    expect(marked(init.sessionId)).toBe(false)
  })

  test('a fork of a missing thread ends with missingSession and no turn', async () => {
    const { h, events } = run({}, { start: { kind: 'fork', threadId: 'gone-thread', lastTurnId: 'turn-1' } })
    const out = await h.done
    expect(out.missingSession).toBe(true)
    expect(methods()).toEqual(['initialize', 'thread/fork'])
    expect(events).toEqual([])
    expect(out).toMatchObject({ result: null, stopped: false, spawnError: null, exitCode: 0 })
  })

  test("any error a main turn's fork answers with ends with missingSession and no turn, so the caller reseeds once", async () => {
    saved('thread-src')
    const { h, events } = run(
      { FAKE_CODEX_FORK_ERROR: 'fork exploded' },
      { start: { kind: 'fork', threadId: 'thread-src', lastTurnId: 'turn-1' } }
    )
    const out = await h.done
    expect(out.missingSession).toBe(true)
    expect(methods()).toEqual(['initialize', 'thread/fork'])
    expect(events).toEqual([])
    expect(out).toMatchObject({ result: null, stopped: false, spawnError: null })
  })

  test("a side run's ephemeral fork and a compaction's fork keep their handling: only a missing thread is missingSession", async () => {
    saved('thread-src')
    const side = run(
      { FAKE_CODEX_FORK_ERROR: 'fork exploded' },
      { start: { kind: 'fork', threadId: 'thread-src', lastTurnId: 'turn-1', ephemeral: true } }
    )
    const sideOut = await side.h.done
    expect(sideOut.missingSession).toBeUndefined()
    expect(sideOut.stderr).toBe('fork exploded')
    const compact = run(
      { FAKE_CODEX_FORK_ERROR: 'fork exploded' },
      { start: { kind: 'fork', threadId: 'thread-src', lastTurnId: 'turn-1' }, action: { kind: 'compact' } }
    )
    const compactOut = await compact.h.done
    expect(compactOut.missingSession).toBeUndefined()
    expect(compactOut.stderr).toBe('fork exploded')
  })

  test('a fork answered with the source id is reported as is, so the caller can see the fork was ignored', async () => {
    saved('thread-src')
    const { h, events } = run({ FAKE_CODEX_FORK_SAME: '1' }, { start: { kind: 'fork', threadId: 'thread-src', lastTurnId: 'turn-1' } })
    await h.done
    expect(events[0]).toMatchObject({ kind: 'init', sessionId: 'thread-src' })
  })

  test('compact resumes, starts the compaction and never a turn: compacting on, then off, compacted and the result', async () => {
    saved('thread-old')
    const { h, events } = run({}, { start: { kind: 'resume', threadId: 'thread-old' }, action: { kind: 'compact' } })
    const out = await h.done
    const log = lines(logFile())
    expect(log.map((l: any) => l.method)).toEqual(['initialize', 'thread/resume', 'thread/compact/start'])
    expect(log[2].params).toEqual({ threadId: 'thread-old' })
    expect(events[0]).toMatchObject({ kind: 'init', sessionId: 'thread-old' })
    const ends = events.filter((e) => e.kind === 'compacting' || e.kind === 'compacted' || e.kind === 'result')
    expect(ends.map((e) => e.kind)).toEqual(['compacting', 'compacting', 'compacted', 'result'])
    expect(ends[0]).toEqual({ kind: 'compacting', on: true })
    expect(ends[1]).toEqual({ kind: 'compacting', on: false })
    expect(events.filter((e) => e.kind === 'compacted')).toHaveLength(1)
    expect(out.result).toMatchObject({ kind: 'result', isError: false, sessionId: 'thread-old' })
    expect(events.at(-1)).toEqual(out.result)
    expect(out).toMatchObject({ exitCode: 0, stopped: false, spawnError: null })
  })

  test('stop during a compaction interrupts its turn; no compaction is reported and compacting ends', async () => {
    saved('thread-old')
    const { h, events } = run(
      { FAKE_CODEX_COMPACT_MS: '60000' },
      {
        start: { kind: 'resume', threadId: 'thread-old' },
        action: { kind: 'compact' },
        react: (e, hh) => {
          if (e.kind === 'compacting' && e.on) setTimeout(() => hh.stop(), 300)
        }
      }
    )
    const out = await h.done
    expect(out.stopped).toBe(true)
    const log = lines(logFile())
    expect(log.map((l: any) => l.method)).toEqual(['initialize', 'thread/resume', 'thread/compact/start', 'turn/interrupt'])
    expect(log[3].params).toEqual({ threadId: 'thread-old', turnId: (out.result as any)?.uuid })
    expect(out.result).toMatchObject({ subtype: 'interrupted', isError: false })
    expect(events.some((e) => e.kind === 'compacted')).toBe(false)
    expect(events.filter((e) => e.kind === 'compacting')).toEqual([
      { kind: 'compacting', on: true },
      { kind: 'compacting', on: false }
    ])
  }, 10_000)

  test('a compaction whose process dies still ends compacting', async () => {
    saved('thread-old')
    const dies = join(root, `dies-compact-${n}.mjs`)
    // Answers initialize and the resume, then exits as soon as the compaction is asked for.
    writeFileSync(
      dies,
      `let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='thread/compact/start')process.exit(3);if(m.id!=null)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{userAgent:'x/1.0.0'}:{thread:{id:'thread-old'}}})+'\\n')}})\n`
    )
    const { h, events } = run(
      {},
      { bin: shim(`codex-dies-compact-${n}`, dies), start: { kind: 'resume', threadId: 'thread-old' }, action: { kind: 'compact' } }
    )
    const out = await h.done
    expect(out.exitCode).toBe(3)
    expect(out.result).toBeNull()
    expect(events.filter((e) => e.kind === 'compacting')).toEqual([
      { kind: 'compacting', on: true },
      { kind: 'compacting', on: false }
    ])
  })

  test('requestTag prefixes every request id it emits, and send takes only ids carrying it, stripped', async () => {
    const results: boolean[] = []
    const { h, events } = run(
      { FAKE_CODEX_SCRIPT: script(approval('ls'), { request: { method: 'some/new/request', params: {} } }, message('done')) },
      {
        requestTag: 'tag-1',
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') {
            // Codex's own id, another attempt's tag and a bare prefix are refused; the tagged id is answered.
            results.push(hh.send(allowResponse('0', {})), hh.send(allowResponse('tag-2:0', {})), hh.send(allowResponse('tag-1', {})))
            results.push(hh.send(allowResponse(e.requestId, {})))
          }
          if (e.kind === 'controlUnknown') results.push(hh.send(errorResponse(e.requestId!, 'not handled')))
        }
      }
    )
    await h.done
    expect(events.find((e) => e.kind === 'permissionRequest')).toMatchObject({ requestId: 'tag-1:0', toolUseId: 'e-ls' })
    expect(events).toContainEqual({ kind: 'controlUnknown', requestId: 'tag-1:1', subtype: 'some/new/request' })
    expect(results).toEqual([false, false, false, true, true])
    expect(lines(answersFile())).toEqual([
      { id: 0, result: { decision: 'accept' } },
      { id: 1, error: { code: -32601, message: expect.any(String) } }
    ])
  })

  test('requestTag also tags the cancel of a request codex settled itself', async () => {
    const { h, events } = run(
      { FAKE_CODEX_SCRIPT: script(approval('ls'), message('never')) },
      {
        requestTag: 'tag-1',
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.stop()
        }
      }
    )
    await h.done
    expect(events).toContainEqual({ kind: 'permissionCancel', requestId: 'tag-1:0' })
    expect(h.send(allowResponse('tag-1:0', {}))).toBe(false)
  }, 10_000)

  test('enable adds an --enable flag per feature after the fixed args, and the question feature never goes in twice', async () => {
    const argsOut = join(dir, 'args.txt')
    const bin = shim(`codex-enable-${n}`, FAKE, argsTo(argsOut))
    const { h } = run({}, { bin, enable: ['x', CODEX_QUESTION_FEATURE] })
    await h.done
    expect(readFileSync(argsOut, 'utf8').split('\n').filter(Boolean)).toEqual([...ARGV, '--enable', 'x'])
  })

  test('enable can never turn multi_agent back on: the fixed --disable stands alone', async () => {
    const argsOut = join(dir, 'args.txt')
    const bin = shim(`codex-multi-${n}`, FAKE, argsTo(argsOut))
    const { h } = run({}, { bin, enable: ['multi_agent', 'x'] })
    await h.done
    const argv = readFileSync(argsOut, 'utf8').split('\n').filter(Boolean)
    expect(argv).toEqual([...ARGV, '--enable', 'x'])
    expect(argv.filter((a) => a === 'multi_agent')).toHaveLength(1)
  })

  test('questions off (the cap): no question feature flag, even through enable, and a question is refused at once with no card', async () => {
    const argsOut = join(dir, 'args.txt')
    const bin = shim(`codex-noq-${n}`, FAKE, argsTo(argsOut))
    const { h, events } = run(
      { FAKE_CODEX_SCRIPT: script(askQ('color'), message('No answer, going on')) },
      { bin, questions: false, enable: [CODEX_QUESTION_FEATURE] }
    )
    const out = await h.done
    expect(readFileSync(argsOut, 'utf8').split('\n').filter(Boolean)).toEqual(ARGV.slice(0, -2))
    expect(events.some((e) => e.kind === 'permissionRequest')).toBe(false)
    // Phase 1's answer to a question it had no card for.
    expect(lines(answersFile())).toEqual([{ id: 0, error: { code: -32601, message: 'ZumiBot does not handle this request' } }])
    expect(out.result).toMatchObject({ isError: false })
  })

  // Without the flag a model's question is a plain message and the turn sleeps for good (probe check 15), so every
  // process (a turn, a compaction, a fork) carries it, exactly once.
  test.each([
    ['a plain turn', {}],
    ['a compaction', { action: { kind: 'compact' } }],
    ['a fork', { start: { kind: 'fork', threadId: 'thread-old', lastTurnId: 't1' } }]
  ] as const)('%s runs with the question feature enabled once', async (_n, o) => {
    mkdirSync(join(home(), 'threads'), { recursive: true })
    writeFileSync(join(home(), 'threads', 'thread-old'), '')
    const argsOut = join(dir, 'args.txt')
    const bin = shim(`codex-q-${n}`, FAKE, argsTo(argsOut))
    const start = 'start' in o ? o.start : { kind: 'resume' as const, threadId: 'thread-old' }
    const { h } = run({}, { bin, start, ...('action' in o ? { action: o.action } : {}) })
    await h.done
    const argv = readFileSync(argsOut, 'utf8').split('\n').filter(Boolean)
    expect(argv).toEqual(ARGV)
    expect(argv.filter((a) => a === CODEX_QUESTION_FEATURE)).toHaveLength(1)
  })

  test("the thread's sandbox reaches thread/start", async () => {
    const { h } = run({}, { thread: thread({ sandbox: 'read-only', permissionMode: 'manual' }) })
    await h.done
    const log = lines(logFile())
    expect(log[1].method).toBe('thread/start')
    expect(log[1].params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' })
  })
})

describe('runCodex hooks, subagents and excludeTurns (Phase 3)', () => {
  const FIX = fileURLToPath(new URL('../fixtures/codex/codex-check11.jsonl', import.meta.url))
  // The hook stdin check 11 recorded first (`echo ok` on the main thread), verbatim.
  const recordedInput = () =>
    JSON.parse(
      readFileSync(FIX, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .at(-1)
        .meta.files['hook-log'].split('\n')[0]
    )
  const KEY = '/<session-flags>/config.toml:pre_tool_use:0:0'

  // Check 11's probe hook: logs each stdin, blocks `blocked-marker` (exit 2), exits 1 on `exit1-marker`.
  function probeHook(): { hook: CodexHook; log: string } {
    const file = join(dir, 'probe-hook.sh'),
      log = join(dir, 'hook-log.jsonl')
    writeFileSync(
      file,
      [
        '#!/bin/sh',
        'input=$(cat)',
        `printf '%s\\n' "$input" >> ${q(log)}`,
        'case "$input" in',
        '  *blocked-marker*) echo "BLOCKED-BY-PROBE" >&2; exit 2 ;;',
        '  *exit1-marker*) echo "EXIT1-BY-PROBE" >&2; exit 1 ;;',
        'esac',
        'exit 0',
        ''
      ].join('\n')
    )
    return { hook: { event: 'preToolUse', matcher: null, command: `sh ${q(file)}`, timeoutSec: 5 }, log }
  }
  // A shim that appends each invocation's argv (one arg a line, then ---), so the pre-flight and the real run both show.
  function argvShim(name: string): { bin: string; calls: () => string[][] } {
    const out = join(dir, `${name}-argv.txt`)
    const bin = shim(`${name}-${n}`, FAKE, `fs.appendFileSync(${JSON.stringify(out)}, args.map((a) => a + '\\n').join('') + '---\\n')\n`)
    const calls = () =>
      existsSync(out)
        ? readFileSync(out, 'utf8')
            .split('---\n')
            .filter(Boolean)
            .map((c) => c.split('\n').filter(Boolean))
        : []
    return { bin, calls }
  }
  const env = (over: Record<string, string> = {}) => ({ ...process.env, FAKE_CODEX_HOME: home(), FAKE_CODEX_LOG: logFile(), ...over })
  const exec = (command: string, more: Record<string, unknown> = {}) => ({ exec: { command, ...more } })

  test('no hooks: the argv and every request are the bytes they were before Phase 3', async () => {
    const { bin, calls } = argvShim('codex-pin')
    const { h, events } = run({}, { bin })
    await h.done
    expect(calls()).toEqual([ARGV])
    const thread = (events[0] as Extract<RunEvent, { kind: 'init' }>).sessionId
    const raw = readFileSync(logFile(), 'utf8')
      .split('\n')
      .filter(Boolean)
      // As JSON spells it: a Windows path's backslashes come doubled.
      .map((l) => l.replaceAll(JSON.stringify(ws()).slice(1, -1), '<ws>').replaceAll(thread, '<thread>'))
    // Since then only model_reasoning_summary joined the thread config (thought rows, docs/architecture/thinking.md).
    expect(raw).toEqual([
      '{"method":"initialize","params":{"clientInfo":{"name":"zumibot","title":null,"version":"1.0.0"},"capabilities":null}}',
      '{"method":"thread/start","params":{"cwd":"<ws>","baseInstructions":"You are a test agent.","approvalPolicy":"untrusted","approvalsReviewer":"user","sandbox":"workspace-write","config":{"sandbox_workspace_write.network_access":true,"features.multi_agent":false,"model_reasoning_summary":"auto"}}}',
      '{"method":"turn/start","params":{"threadId":"<thread>","input":[{"type":"text","text":"hello","text_elements":[]}]}}'
    ])
  })

  test('an empty hook list is no hooks: no pre-flight, no hooks/list, the same argv', async () => {
    const { bin, calls } = argvShim('codex-empty')
    const { h } = run({}, { bin, thread: thread({ hooks: [] }) })
    const out = await h.done
    expect(calls()).toEqual([ARGV])
    expect(methods()).toEqual(['initialize', 'thread/start', 'turn/start'])
    expect(out.hooksUntrusted).toBeUndefined()
  })

  test('subagents: --enable multi_agent in place of --disable, no thread-level switch, and enable still cannot add it', async () => {
    const { bin, calls } = argvShim('codex-sub')
    const { h } = run({}, { bin, subagents: true, enable: ['multi_agent', 'x'] })
    await h.done
    const argv = calls()[0]
    expect(argv).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '--enable',
      'multi_agent',
      '--enable',
      CODEX_QUESTION_FEATURE,
      '--enable',
      'x'
    ])
    expect(argv).not.toContain('--disable')
    expect(argv.filter((a) => a === 'multi_agent')).toHaveLength(1)
    const start = lines(logFile())[1]
    expect(start.method).toBe('thread/start')
    expect(start.params).toEqual(threadParams(thread(), { subagents: true }))
    expect('features.multi_agent' in start.params.config).toBe(false)
  })

  // R23: a thread no subAgentActivity announced in this process (a child resumed in a later one, say) is nobody this run
  // shows: its notices are dropped and its request is declined at once, with no card, so codex never waits on it.
  test('a thread no start announced: its item is no row and its approval is declined at once with no card; the turn goes on', async () => {
    const stranger = (method: string, item: Record<string, unknown>) => ({
      notify: { method, params: { threadId: 'stranger', turnId: 'x', item } }
    })
    const { h, events } = run(
      {
        FAKE_CODEX_SCRIPT: script(
          stranger('item/started', { type: 'commandExecution', id: 'sx', command: 'rm -rf /w', cwd: '/w', status: 'inProgress' }),
          {
            request: {
              method: 'item/commandExecution/requestApproval',
              params: { threadId: 'stranger', turnId: 'x', itemId: 'sx', command: 'rm -rf /w', cwd: '/w', reason: null }
            }
          },
          stranger('item/completed', { type: 'agentMessage', id: 'sm', text: 'from nowhere' }),
          message('done')
        )
      },
      { subagents: true }
    )
    const out = await h.done
    expect(out.result).toMatchObject({ isError: false })
    expect(events.some((e) => e.kind === 'permissionRequest' || e.kind === 'toolUse')).toBe(false)
    expect(events.filter((e) => e.kind === 'assistantText')).toEqual([{ kind: 'assistantText', text: 'done' }])
    expect(lines(answersFile())).toEqual([{ id: 0, result: { decision: 'decline' } }])
  })

  test('subagents false is the default: multi_agent stays disabled', async () => {
    const { bin, calls } = argvShim('codex-nosub')
    const { h } = run({}, { bin, subagents: false })
    await h.done
    expect(calls()).toEqual([ARGV])
    expect(lines(logFile())[1].params).toEqual(threadParams(thread()))
  })

  test("hooks: a model-free pre-flight learns the hash, the real run is started trusted by it and checks hooks/list, and a blocked call becomes a row with the hook's text", async () => {
    const { hook, log } = probeHook()
    const { bin, calls } = argvShim('codex-hooks')
    const { h, events } = run(
      {
        FAKE_CODEX_SCRIPT: script(
          exec('echo ok', { output: 'ok\n' }),
          exec('touch blocked-marker'),
          exec('touch exit1-marker'),
          message('done')
        )
      },
      { bin, thread: thread({ hooks: [hook] }) }
    )
    const out = await h.done
    expect(out.hooksUntrusted).toBeUndefined()
    expect(out.result).toMatchObject({ isError: false })
    // The pre-flight (initialize, hooks/list, no thread) and the real run, which lists the hooks again before its thread.
    expect(methods()).toEqual(['initialize', 'hooks/list', 'initialize', 'hooks/list', 'thread/start', 'turn/start'])
    const log0 = lines(logFile())
    expect(log0[1].params).toEqual({ cwds: [ws()] })
    expect(log0[3].params).toEqual({ cwds: [ws()] })
    // The hooks never reach the request: the thread starts with the params a run without them sends.
    expect(log0[4].params).toEqual(threadParams(thread()))
    // The cached trust (no new pre-flight) is exactly what the real run was started with.
    const trust = await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook] })
    expect([...trust!.keys()]).toEqual([KEY])
    expect(trust!.get(KEY)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(methods()).toHaveLength(6)
    expect(calls()).toEqual([
      ['app-server', '--listen', 'stdio://', '--disable', 'multi_agent', ...hookConfig([hook])],
      [...ARGV, ...hookConfig([hook], trust)]
    ])
    expect(calls()[1].slice(-2)).toEqual(['-c', `hooks.state={"${KEY}"={trusted_hash="${trust!.get(KEY)}"}}`])
    // The blocked call has no item: its row is built from hook/completed and carries the hook's stderr.
    const uses = events.filter((e) => e.kind === 'toolUse') as Extract<RunEvent, { kind: 'toolUse' }>[]
    expect(uses.map((u) => u.name)).toEqual(['Bash', 'Blocked', 'Bash'])
    const blocked = uses[1]
    expect(blocked.input).toEqual({})
    expect(events).toContainEqual({ kind: 'toolResult', toolUseId: blocked.id, content: 'BLOCKED-BY-PROBE', isError: true })
    expect((uses[0].input as any).command).toBe("/bin/bash -lc 'echo ok'")
    expect((uses[2].input as any).command).toBe("/bin/bash -lc 'touch exit1-marker'") // exit 1 fails open, as real codex does
    // The hook read check 11's input shape, key for key, on the main thread.
    const inputs = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(inputs).toHaveLength(3)
    expect(Object.keys(inputs[0])).toEqual(Object.keys(recordedInput()))
    expect(inputs[1]).toMatchObject({
      hook_event_name: 'PreToolUse',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'touch blocked-marker' },
      tool_use_id: blocked.id,
      cwd: ws()
    })
    expect(inputs[1].session_id).toBe((events[0] as Extract<RunEvent, { kind: 'init' }>).sessionId)
    expect(inputs.some((i) => 'agent_id' in i)).toBe(false)
    // Never a trust bypass, on either process.
    expect(calls().flat().join(' ')).not.toMatch(/bypass/i)
  })

  // A main-thread block as check 11 recorded it, sent by a script step (no hooks needed to replay the notice).
  const blockedNotice = (toolUseId: string, text: string) => ({
    notify: {
      method: 'hook/completed',
      params: {
        threadId: '$THREAD',
        turnId: '$TURN',
        run: {
          id: `pre-tool-use:0:/<session-flags>/config.toml:${toolUseId}`,
          eventName: 'preToolUse',
          handlerType: 'command',
          executionMode: 'sync',
          scope: 'turn',
          sourcePath: '/<session-flags>/config.toml',
          source: 'sessionFlags',
          displayOrder: 0,
          status: 'blocked',
          statusMessage: null,
          startedAt: 1,
          completedAt: 1,
          durationMs: 2,
          entries: [{ kind: 'feedback', text }]
        }
      }
    }
  })

  test('a blocked row held by the mapper goes out before a server request that follows it', async () => {
    const { h, events } = run(
      { FAKE_CODEX_SCRIPT: script(blockedNotice('exec-held', 'NOPE'), approval('ls'), message('done')) },
      {
        react: (e, hh) => {
          if (e.kind === 'permissionRequest') hh.send(allowResponse(e.requestId, {}))
        }
      }
    )
    await h.done
    const k = events.map((e) => e.kind)
    expect(k.indexOf('toolUse')).toBeLessThan(k.indexOf('permissionRequest'))
    expect(events).toContainEqual({ kind: 'toolResult', toolUseId: 'exec-held', content: 'NOPE', isError: true })
  })

  test('a blocked row is not lost when codex dies right after the block', async () => {
    const dies = join(root, `dies-blocked-${n}.mjs`)
    // Answers initialize, the thread and the turn, then reports a blocked call and exits before anything else.
    writeFileSync(
      dies,
      `let b='';const o=m=>process.stdout.write(JSON.stringify(m)+'\\n');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id==null)continue;` +
        `if(m.method==='initialize')o({id:m.id,result:{userAgent:'x/1.0.0'}});else if(m.method==='thread/start')o({id:m.id,result:{thread:{id:'th-1'}}});` +
        `else if(m.method==='turn/start'){o({id:m.id,result:{turn:{id:'tu-1'}}});o({method:'hook/completed',params:{threadId:'th-1',turnId:'tu-1',run:{id:'pre-tool-use:0:/s:exec-last',eventName:'preToolUse',sourcePath:'/s',status:'blocked',entries:[{kind:'feedback',text:'LAST'}]}}});process.exit(0)}}})\n`
    )
    const { h, events } = run({}, { bin: shim(`codex-dies-blocked-${n}`, dies) })
    const out = await h.done
    expect(out.result).toBeNull()
    expect(events).toContainEqual({ kind: 'toolUse', id: 'exec-last', name: 'Blocked', input: {}, message: 'th-1:response-0' })
    expect(events).toContainEqual({ kind: 'toolResult', toolUseId: 'exec-last', content: 'LAST', isError: true })
  })

  test('codexHookTrust: key to hash from one model-free hooks/list, cached per hook set and shared by calls made together; fresh asks again', async () => {
    const { hook } = probeHook()
    const { bin, calls } = argvShim('codex-trust')
    const [a, b] = await Promise.all([
      codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook] }),
      codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook] })
    ])
    expect(a).toEqual(b)
    expect([...a!.entries()]).toEqual([[KEY, expect.stringMatching(/^sha256:[0-9a-f]{64}$/)]])
    expect(methods()).toEqual(['initialize', 'hooks/list'])
    expect(calls()).toEqual([['app-server', '--listen', 'stdio://', '--disable', 'multi_agent', ...hookConfig([hook])]])
    // Cached: no second process.
    expect(await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook] })).toEqual(a)
    expect(calls()).toHaveLength(1)
    // Another hook set is another entry, with its own key per group.
    const two = await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook, { ...hook, matcher: 'Bash', timeoutSec: 30 }] })
    expect([...two!.keys()]).toEqual([KEY, '/<session-flags>/config.toml:pre_tool_use:1:0'])
    expect(calls()).toHaveLength(2)
    // fresh drops the entry and asks again.
    expect(await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook], fresh: true })).toEqual(a)
    expect(calls()).toHaveLength(3)
  })

  test('codexHookTrust is null on any failure, and a failure is not kept', async () => {
    const { hook } = probeHook()
    const { bin, calls } = argvShim('codex-trust-fail')
    // A codex without hooks/list (an older one): -32601.
    expect(await codexHookTrust({ bin, env: env({ FAKE_CODEX_HOOKS_LIST: 'off' }), cwd: ws(), hooks: [hook] })).toBeNull()
    expect(await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook] })).not.toBeNull()
    expect(calls()).toHaveLength(2)
    // A listing that lacks one of the hooks trusts none of them.
    expect(
      await codexHookTrust({ bin, env: env({ FAKE_CODEX_HOOKS_LIST: 'empty' }), cwd: ws(), hooks: [{ ...hook, command: 'exit 0' }] })
    ).toBeNull()
    // No codex at all, or no hooks.
    expect(await codexHookTrust({ bin: join(dir, 'no-such-codex'), env: env(), cwd: ws(), hooks: [hook] })).toBeNull()
    expect(await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [] })).toBeNull()
  })

  test('a pre-flight that fails ends the run with hooksUntrusted, before the real process starts', async () => {
    const { hook } = probeHook()
    const { bin, calls } = argvShim('codex-pre-fail')
    const { h, events } = run(
      { FAKE_CODEX_HOOKS_LIST: 'off', FAKE_CODEX_SCRIPT: script(exec('echo ok')) },
      { bin, thread: thread({ hooks: [hook] }) }
    )
    const out = await h.done
    expect(out.hooksUntrusted).toBe(true)
    expect(out).toMatchObject({ result: null, stopped: false, spawnError: null })
    expect(events).toEqual([])
    expect(calls()).toHaveLength(1) // the pre-flight only
    expect(methods()).toEqual(['initialize', 'hooks/list'])
  })

  test('a hook the real process does not trust ends the run before thread/start with hooksUntrusted; the stale entry is dropped', async () => {
    const { hook, log } = probeHook()
    const { bin, calls } = argvShim('codex-stale')
    // The pre-flight hashed under one codex, the real run under another (an update between them): the cached trust is stale.
    await codexHookTrust({ bin, env: env({ FAKE_CODEX_HOOK_SALT: 'old' }), cwd: ws(), hooks: [hook] })
    const first = run(
      { FAKE_CODEX_HOOK_SALT: 'new', FAKE_CODEX_SCRIPT: script(exec('touch blocked-marker'), message('never')) },
      { bin, thread: thread({ hooks: [hook] }) }
    )
    const out = await first.h.done
    expect(out.hooksUntrusted).toBe(true)
    expect(out).toMatchObject({ result: null, stopped: false, spawnError: null })
    expect(first.events).toEqual([])
    // No thread, no turn: nothing spent.
    expect(methods()).toEqual(['initialize', 'hooks/list', 'initialize', 'hooks/list'])
    expect(existsSync(log)).toBe(false)
    expect(calls()).toHaveLength(2)
    // The entry that failed is gone, so the next run asks again and is trusted.
    const second = run(
      { FAKE_CODEX_HOOK_SALT: 'new', FAKE_CODEX_SCRIPT: script(exec('touch blocked-marker'), message('done')) },
      { bin, thread: thread({ hooks: [hook] }) }
    )
    const out2 = await second.h.done
    expect(out2.hooksUntrusted).toBeUndefined()
    expect(out2.result).toMatchObject({ isError: false })
    expect(calls()).toHaveLength(4)
    expect(second.events).toContainEqual(expect.objectContaining({ kind: 'toolResult', content: 'BLOCKED-BY-PROBE', isError: true }))
  })

  test('the hook pre-flight runs with hookTrustEnv in place of the run env, so a value only the run holds never reaches it', async () => {
    const { hook } = probeHook()
    const out = join(dir, 'env.txt')
    const bin = shim(
      `codex-trust-env-${n}`,
      FAKE,
      `const kind = args.join(' ').includes('hooks.state=') ? 'run' : 'preflight'\nfs.appendFileSync(${JSON.stringify(out)}, kind + ' ' + (process.env.CB_RUN_ONLY || 'none') + '\\n')\n`
    )
    const { h } = run(
      { CB_RUN_ONLY: 'run-only-value', FAKE_CODEX_SCRIPT: script(message('done')) },
      { bin, thread: thread({ hooks: [hook] }), hookTrustEnv: env() }
    )
    const o = await h.done
    expect(o.hooksUntrusted).toBeUndefined()
    expect(o.result).toMatchObject({ isError: false })
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual(['preflight none', 'run run-only-value'])
  })

  test('without hookTrustEnv the pre-flight gets the run env, as before', async () => {
    const { hook } = probeHook()
    const out = join(dir, 'env.txt')
    const bin = shim(
      `codex-trust-env-default-${n}`,
      FAKE,
      `const kind = args.join(' ').includes('hooks.state=') ? 'run' : 'preflight'\nfs.appendFileSync(${JSON.stringify(out)}, kind + ' ' + (process.env.CB_RUN_ONLY || 'none') + '\\n')\n`
    )
    const { h } = run({ CB_RUN_ONLY: 'run-value', FAKE_CODEX_SCRIPT: script(message('done')) }, { bin, thread: thread({ hooks: [hook] }) })
    await h.done
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual(['preflight run-value', 'run run-value'])
  })

  test('freshHookTrust drops a cached entry before the run, so a stale one never reaches the real process', async () => {
    const { hook } = probeHook()
    const { bin, calls } = argvShim('codex-fresh')
    await codexHookTrust({ bin, env: env({ FAKE_CODEX_HOOK_SALT: 'old' }), cwd: ws(), hooks: [hook] })
    const { h } = run(
      { FAKE_CODEX_HOOK_SALT: 'new', FAKE_CODEX_SCRIPT: script(message('done')) },
      { bin, thread: thread({ hooks: [hook] }), freshHookTrust: true }
    )
    const out = await h.done
    expect(out.hooksUntrusted).toBeUndefined()
    expect(out.result).toMatchObject({ isError: false })
    expect(calls()).toHaveLength(3) // the old pre-flight, a fresh one, the run
    expect(methods()).toEqual([
      'initialize',
      'hooks/list',
      'initialize',
      'hooks/list',
      'initialize',
      'hooks/list',
      'thread/start',
      'turn/start'
    ])
  })

  // A shim that records each invocation's pid (`exec` keeps it), so a test can see the process is gone.
  function pidShim(name: string): { bin: string; pids: () => number[] } {
    const out = join(dir, `${name}-pids.txt`)
    const bin = shim(`${name}-${n}`, FAKE, `fs.appendFileSync(${JSON.stringify(out)}, process.pid + '\\n')\n`)
    return { bin, pids: () => (existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(Number) : []) }
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  async function goneWithin(pid: number, ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (!alive(pid)) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return !alive(pid)
  }

  test("the run's own hooks/list failing after a cache hit ends with hooksUntrusted and no thread", async () => {
    const { hook } = probeHook()
    const { bin, calls } = argvShim('codex-list-fails')
    expect(await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook] })).not.toBeNull()
    const { h, events } = run(
      { FAKE_CODEX_HOOKS_LIST: 'off', FAKE_CODEX_SCRIPT: script(message('never')) },
      { bin, thread: thread({ hooks: [hook] }) }
    )
    const out = await h.done
    expect(out.hooksUntrusted).toBe(true)
    expect(out).toMatchObject({ result: null, stopped: false, spawnError: null })
    expect(events).toEqual([])
    expect(calls()).toHaveLength(2) // the cached pre-flight, then the run
    expect(methods()).toEqual(['initialize', 'hooks/list', 'initialize', 'hooks/list'])
  })

  test("the run's own hooks/list past its deadline fails closed the same way, and the process ends", async () => {
    const { hook } = probeHook()
    const { bin, pids } = pidShim('codex-list-hangs')
    expect(await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook] })).not.toBeNull()
    const t0 = Date.now()
    const { h, events } = run(
      { FAKE_CODEX_HOOKS_LIST: 'hang', FAKE_CODEX_SCRIPT: script(message('never')) },
      { bin, thread: thread({ hooks: [hook] }), hooksTimeoutMs: 300 }
    )
    const out = await h.done
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(out.hooksUntrusted).toBe(true)
    expect(events).toEqual([])
    expect(methods()).toEqual(['initialize', 'hooks/list', 'initialize', 'hooks/list'])
    expect(await goneWithin(pids()[1], 5000)).toBe(true)
  }, 10_000)

  test('a pre-flight past its deadline is null, and its process is killed and gone', async () => {
    const { hook } = probeHook()
    const { bin, pids } = pidShim('codex-pre-hangs')
    const t0 = Date.now()
    // The deadline must fall after the fake is up and has written its pid: an Intel Mac running the suite misses 300 ms.
    const timeoutMs = process.platform === 'darwin' ? 2000 : 300
    expect(await codexHookTrust({ bin, env: env({ FAKE_CODEX_HOOKS_LIST: 'hang' }), cwd: ws(), hooks: [hook], timeoutMs })).toBeNull()
    expect(Date.now() - t0).toBeLessThan(timeoutMs + 2700)
    expect(pids()).toHaveLength(1)
    expect(await goneWithin(pids()[0], 3000)).toBe(true)
    // Not kept: the next call asks again.
    expect(await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [hook] })).not.toBeNull()
    expect(pids()).toHaveLength(2)
  }, 10_000)

  test('a stop during the pre-flight ends the run at once; the shared pre-flight keeps its own deadline and kill', async () => {
    const { hook } = probeHook()
    const { bin, pids } = pidShim('codex-stop-pre')
    const { h, events } = run({ FAKE_CODEX_HOOKS_LIST: 'hang' }, { bin, thread: thread({ hooks: [hook] }), hooksTimeoutMs: 2000 })
    // Stop once the pre-flight is waiting on hooks/list, not after a fixed pause a slow machine (an Intel Mac) overruns
    // before the fake is even up. Well inside the 2 s pre-flight deadline.
    for (const end = Date.now() + 1500; Date.now() < end && !(pids().length === 1 && methods().includes('hooks/list'));)
      await new Promise((r) => setTimeout(r, 20))
    const stoppedAt = Date.now()
    h.stop()
    const out = await h.done
    expect(Date.now() - stoppedAt).toBeLessThan(500)
    expect(out).toMatchObject({ stopped: true, result: null, spawnError: null })
    expect(out.hooksUntrusted).toBeUndefined()
    expect(events).toEqual([])
    // Only the pre-flight ever started, and its deadline still kills it.
    expect(pids()).toHaveLength(1)
    expect(alive(pids()[0])).toBe(true)
    expect(await goneWithin(pids()[0], 5000)).toBe(true)
    expect(methods()).toEqual(['initialize', 'hooks/list'])
    expect(pids()).toHaveLength(1)
  }, 10_000)

  test('hooks that cannot be encoded end the run with hooksUntrusted before any process starts', async () => {
    const { hook } = probeHook()
    const { bin, pids } = pidShim('codex-unencodable')
    for (const bad of [
      { ...hook, command: `${hook.command}\u007f` },
      { ...hook, timeoutSec: 2.5 }
    ]) {
      expect(await codexHookTrust({ bin, env: env(), cwd: ws(), hooks: [bad] })).toBeNull()
      const { h, events } = run({}, { bin, thread: thread({ hooks: [hook, bad] }) })
      const out = await h.done
      expect(out.hooksUntrusted).toBe(true)
      expect(events).toEqual([])
    }
    expect(pids()).toEqual([])
    expect(methods()).toEqual([])
  })

  test('a hooked resume carries the hooks on argv and excludeTurns on the request', async () => {
    mkdirSync(join(home(), 'threads'), { recursive: true })
    writeFileSync(join(home(), 'threads', 'thread-old'), '')
    const { hook } = probeHook()
    const { bin, calls } = argvShim('codex-resume-hooks')
    const { h } = run({}, { bin, start: { kind: 'resume', threadId: 'thread-old' }, thread: thread({ hooks: [hook] }) })
    await h.done
    expect(methods()).toEqual(['initialize', 'hooks/list', 'initialize', 'hooks/list', 'thread/resume', 'turn/start'])
    expect(lines(logFile())[4].params).toEqual({ threadId: 'thread-old', ...threadParams(thread()), excludeTurns: true })
    expect(calls()[1].slice(0, ARGV.length)).toEqual(ARGV)
    expect(
      calls()[1]
        .slice(ARGV.length)
        .filter((a) => a === '-c')
    ).toHaveLength(2)
  })
})

// The SIGINT/SIGTERM/SIGKILL ladder is POSIX: Windows ends the tree with taskkill at the first step.
describe.skipIf(process.platform === 'win32')('runCodex stop ladder', () => {
  // A codex that never answers and ignores stdin closing (and SIGINT, maybe SIGTERM too).
  function hanging(ignore: string[]) {
    const p = join(root, `hang-${n}.mjs`)
    const ready = join(dir, 'ready')
    writeFileSync(
      p,
      `import { writeFileSync } from 'node:fs'\n${ignore.map((s) => `process.on('${s}', () => {})`).join('\n')}\nwriteFileSync(${JSON.stringify(ready)}, '')\nsetInterval(() => {}, 1000)\n`
    )
    return { bin: shim(`codex-hang-${n}`, p), ready }
  }
  const waitFor = async (f: string) => {
    for (let i = 0; i < 400 && !existsSync(f); i++) await new Promise((r) => setTimeout(r, 10))
  }

  test('escalates to SIGTERM when codex ignores stdin closing and SIGINT', async () => {
    const { bin, ready } = hanging(['SIGINT'])
    const { h } = run({}, { bin, killGraceMs: 100 })
    await waitFor(ready)
    h.stop()
    const out = await h.done
    expect(out.stopped).toBe(true)
    expect(out.signal).toBe('SIGTERM')
  }, 10_000)

  test('escalates to SIGKILL when SIGTERM is ignored too', async () => {
    const { bin, ready } = hanging(['SIGINT', 'SIGTERM'])
    const { h } = run({}, { bin, killGraceMs: 100, killForceMs: 200 })
    await waitFor(ready)
    const t = Date.now()
    h.stop()
    const out = await h.done
    expect(out.signal).toBe('SIGKILL')
    expect(out.stopped).toBe(true)
    expect(Date.now() - t).toBeLessThan(3000)
  }, 10_000)
})
