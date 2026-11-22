import { createHmac } from 'node:crypto'
import { request } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectTooLarge } from '../support/chatTooLarge'
import type { Routine, RoutineRun, WebhookCall } from '@zumibot/shared/routines'
import { createLimiter } from '../../src/auth/rateLimit'
import { RoutineStore } from '../../src/core/routines/routineStore'
import { createHookHandler, routineHookTarget, workflowHookTarget, type HookTarget } from '../../src/http/hooks'
import { HookFile } from '../../src/core/hooks/hookFile'
import type { Workflow, WorkflowRunSummary } from '@zumibot/shared/workflows'
import { allowGate, startRig, type Rig } from './helpers'

const SECRET = 'sekret-value-123'
const routine = (o: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  name: 'Hook',
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'webhook', sample: null },
  target: { kind: 'new-chat', agent: 'alpha', cwd: '/w' },
  prompt: 'go',
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...o
})

let rig: Rig
let store: RoutineStore
let calls: WebhookCall[]
let clock: number
let runStatus: RoutineRun['status']

const routineTarget = (st: RoutineStore): HookTarget =>
  routineHookTarget({
    store: st,
    runner: {
      run: async (_r, _via, o) => {
        calls.push(o!.call!)
        return { id: `run-${calls.length}`, status: runStatus } as RoutineRun
      }
    }
  })

async function start(gateAllow = true): Promise<void> {
  runStatus = 'running'
  store = new RoutineStore(await mkdtemp(join(tmpdir(), 'cb-hooks-')))
  calls = []
  clock = 1_000_000
  const handler = createHookHandler({
    targets: [routineTarget(store)],
    badSecrets: createLimiter({ now: () => clock }),
    now: () => clock
  })
  rig = await startRig({ gate: allowGate(gateAllow), hooks: handler })
}

const hit = (id: string, init: RequestInit & { secret?: string | null } = {}): Promise<Response> => {
  const { secret = SECRET, headers, ...rest } = init
  const h: Record<string, string> = { ...(headers as Record<string, string>) }
  if (secret !== null) h['X-ZumiBot-Secret'] = secret
  return fetch(`${rig.base}/hooks/${id}`, { method: 'POST', ...rest, headers: h })
}
const json = { 'Content-Type': 'application/json' }

beforeEach(async () => {
  await start()
  await store.putHook({ id: 'r1', secret: SECRET, latest: null, draftAt: null })
  await store.put(routine())
})
afterEach(async () => {
  await rig.close()
})

describe('webhook route', () => {
  it('needs no session: a correct call passes even when the gate refuses everyone', async () => {
    await rig.close()
    await start(false)
    await store.putHook({ id: 'r1', secret: SECRET, latest: null, draftAt: null })
    await store.put(routine())
    expect((await hit('r1', { headers: json, body: '{}' })).status).toBe(202)
  })

  it('answers 401 for a wrong secret, a missing secret and an unknown id with the same body', async () => {
    const seen: (readonly [number, string])[] = []
    for (const p of [() => hit('r1', { secret: 'nope' }), () => hit('r1', { secret: null }), () => hit('missing'), () => hit('bad%20id')]) {
      const r = await p()
      seen.push([r.status, await r.text()] as const)
      clock += 10_000 // past the backoff, so every call reaches the secret check
    }
    for (const b of seen) expect(b).toEqual([401, '{"error":"Unauthorized"}'])
  })

  it('locks an IP after 10 bad secrets, even for the right secret', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await hit('r1', { secret: 'nope' })).status).toBe(401)
      clock += 61_000 // past the longest backoff, so all 10 failures count
    }
    expect((await hit('r1', { headers: json, body: '{}' })).status).toBe(429)
  })

  it('treats a stored secret shorter than 16 chars as never matching', async () => {
    await store.putHook({ id: 'r1', secret: 'short', latest: null, draftAt: null })
    expect((await hit('r1', { secret: 'short' })).status).toBe(401)
  })

  // Holds the body open so the secret check passes first, then lets `change` run before the body ends.
  async function slowCall(change: () => Promise<void>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        `${rig.base}/hooks/r1`,
        { method: 'POST', headers: { 'X-ZumiBot-Secret': SECRET, 'Content-Type': 'application/json' } },
        (res) => {
          res.resume()
          resolve(res.statusCode!)
        }
      )
      req.on('error', reject)
      req.write('{"a":')
      setTimeout(() => {
        change().then(() => req.end('1}'), reject)
      }, 50)
    })
  }

  it('answers 401 and keeps the new secret when it rotates during a slow body', async () => {
    const status = await slowCall(() => store.putHook({ id: 'r1', secret: 'rotated-secret-0123', latest: null, draftAt: null }))
    expect(status).toBe(401)
    expect(calls).toEqual([])
    expect(await store.hook('r1')).toEqual({ id: 'r1', secret: 'rotated-secret-0123', latest: null, draftAt: null })
  })

  it('answers 401 and does not resurrect a hook removed during a slow body', async () => {
    const status = await slowCall(() => store.remove('r1'))
    expect(status).toBe(401)
    expect(calls).toEqual([])
    expect(await store.hook('r1')).toBeNull()
  })

  it('rejects JSON nested deeper than 64 levels with 400 and accepts 64', async () => {
    const nest = (n: number): string => '['.repeat(n) + ']'.repeat(n)
    expect((await hit('r1', { headers: json, body: nest(65) })).status).toBe(400)
    expect((await hit('r1', { headers: json, body: nest(64) })).status).toBe(202)
    // An escaped quote must not end the string early, or the scan would lose count.
    expect((await hit('r1', { headers: json, body: '["\\"",' + nest(65) + ']' })).status).toBe(400)
    expect((await hit('r1', { headers: json, body: '{"s":"[[[[' + '[['.repeat(40) + '"}' })).status).toBe(202)
  })

  it('stores the hooks file as compact JSON', async () => {
    await hit('r1', { headers: json, body: '{"a":1}' })
    const raw = await readFile(join((store as unknown as { dataDir: string }).dataDir, 'routine-hooks.json'), 'utf8')
    expect(raw).not.toContain('\n')
  })

  it('captures a draft hook call without running anything', async () => {
    await store.putHook({ id: 'd1', secret: SECRET, latest: null, draftAt: 5 })
    const res = await hit('d1?x=1', { headers: json, body: '{"a":1}' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'test call captured' })
    expect((await store.hook('d1'))!.latest).toEqual({ method: 'POST', query: { x: '1' }, body: { a: 1 }, receivedAt: clock })
    expect(calls).toEqual([])
  })

  it('starts a run for a saved webhook routine with the parsed body and query', async () => {
    const res = await hit('r1?a=1&a=2&b=x', { headers: json, body: '{"n":[1]}' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ runId: 'run-1' })
    expect(calls[0]).toEqual({ method: 'POST', query: { a: '1', b: 'x' }, body: { n: [1] }, receivedAt: clock })
    expect((await store.hook('r1'))!.latest).toEqual(calls[0])
  })

  it('says when the call did not meet the routine condition', async () => {
    runStatus = 'skipped'
    const res = await hit('r1', { headers: json, body: '{"n":1}' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ runId: 'run-1', skipped: true })
  })

  it('upper-cases the method and parses form and text bodies, empty as null', async () => {
    await hit('r1', { method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'k=1&k=2&z=3' })
    await hit('r1', { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'hello' })
    await hit('r1', { method: 'DELETE' })
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ['PUT', { k: '1', z: '3' }],
      ['POST', 'hello'],
      ['DELETE', null]
    ])
  })

  it('answers 409 for a disabled routine and 405 for other methods', async () => {
    await store.put(routine({ enabled: false }))
    expect((await hit('r1', { headers: json, body: '{}' })).status).toBe(409)
    expect((await hit('r1', { method: 'OPTIONS' })).status).toBe(405)
    expect(calls).toEqual([])
  })

  it('answers 429 for the 61st valid call within a minute, then lets it through later', async () => {
    for (let i = 0; i < 60; i++) expect((await hit('r1', { headers: json, body: '{}' })).status).toBe(202)
    expect((await hit('r1', { headers: json, body: '{}' })).status).toBe(429)
    clock += 61_000
    expect((await hit('r1', { headers: json, body: '{}' })).status).toBe(202)
  })

  it('rejects a body over 1 MiB with 413, by header and by stream', async () => {
    const big = 'x'.repeat(1_048_576 + 1)
    await expectTooLarge(hit('r1', { headers: { 'Content-Type': 'text/plain' }, body: big }))
    const chunked = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big))
        c.close()
      }
    })
    await expectTooLarge(hit('r1', { headers: { 'Content-Type': 'text/plain' }, body: chunked, duplex: 'half' } as RequestInit))
    expect((await hit('r1', { headers: { 'Content-Type': 'text/plain' }, body: 'x'.repeat(1_048_576) })).status).toBe(202)
  })

  it('answers 415 for an unknown content type and 400 for bad JSON', async () => {
    expect((await hit('r1', { headers: { 'Content-Type': 'application/xml' }, body: '<a/>' })).status).toBe(415)
    expect((await hit('r1', { headers: json, body: '{oops' })).status).toBe(400)
  })

  it('never echoes the secret and never logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const texts: string[] = []
    for (const r of [
      await hit('r1', { secret: SECRET + 'x' }),
      await hit('r1', { headers: json, body: '{oops' }),
      await hit('r1', { headers: { 'Content-Type': 'application/xml' }, body: 'z' })
    ])
      texts.push(await r.text())
    expect(texts.join()).not.toContain(SECRET)
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET)
    log.mockRestore()
  })
  describe('GitHub signature and several targets', () => {
    const sign = (raw: string, secret = SECRET): string => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
    const signed = (raw: string, sig: string | null = sign(raw)): Promise<Response> =>
      hit('r1', { secret: null, headers: { ...json, ...(sig === null ? {} : { 'X-Hub-Signature-256': sig }) }, body: raw })

    it('GitHub signature accepted', async () => {
      const raw = '{"zen":"Keep it logically awesome.",\n "n": 1}'
      const res = await signed(raw)
      expect(res.status).toBe(202)
      expect(await res.json()).toEqual({ runId: 'run-1' })
      expect(calls[0]!.body).toEqual({ zen: 'Keep it logically awesome.', n: 1 })
      expect((await store.hook('r1'))!.latest).toEqual(calls[0])
    })

    it('GitHub signature over altered body rejected', async () => {
      const res = await signed('{"n":2}', sign('{"n":1}'))
      expect([res.status, await res.text()]).toEqual([401, '{"error":"Unauthorized"}'])
      expect(calls).toEqual([])
      expect((await signed('{"n":1}', sign('{"n":1}', 'another-secret-value'))).status).toBe(401)
    })

    it('malformed signature header', async () => {
      const raw = '{"n":1}'
      const good = sign(raw).slice('sha256='.length)
      const bad = ['', 'sha256=', 'sha256=zz', `sha1=${good}`, good, `sha256=${good.slice(2)}`, `sha256=${good}00`, `SHA256=${good}`]
      for (const sig of bad) {
        const res = await signed(raw, sig)
        expect([sig, res.status, await res.text()]).toEqual([sig, 401, '{"error":"Unauthorized"}'])
        clock += 61_000 // past the backoff, so each call reaches the check
      }
      expect(calls).toEqual([])
    })

    it('answers an unknown id, a bad signature and a missing credential alike, even for a bad method or size', async () => {
      const raw = '{"n":1}'
      const seen: (readonly [number, string])[] = []
      const calls401: (() => Promise<Response>)[] = [
        () => hit('missing', { secret: null, headers: { ...json, 'X-Hub-Signature-256': sign(raw) }, body: raw }),
        () => signed(raw, sign('x')),
        () => hit('r1', { secret: null, headers: json, body: raw }),
        () => hit('r1', { secret: null, method: 'OPTIONS', headers: { 'X-Hub-Signature-256': sign('', 'wrong') } }),
        () => signed('x'.repeat(1_048_576 + 1), sign('y'))
      ]
      for (const p of calls401) {
        const r = await p()
        seen.push([r.status, await r.text()] as const)
        clock += 61_000
      }
      for (const b of seen) expect(b).toEqual([401, '{"error":"Unauthorized"}'])
    })

    it('a valid signature still meets the method, size and rate rules, and a short stored secret never signs', async () => {
      expect((await hit('r1', { secret: null, method: 'OPTIONS', headers: { 'X-Hub-Signature-256': sign('') } })).status).toBe(405)
      for (let i = 0; i < 60; i++) expect((await signed('{}')).status).toBe(202)
      expect((await signed('{}')).status).toBe(429)
      await store.putHook({ id: 'r1', secret: 'short', latest: null, draftAt: null })
      expect((await signed('{}', sign('{}', 'short'))).status).toBe(401)
    })

    it('the secret header wins when both are sent', async () => {
      const raw = '{"n":1}'
      expect((await hit('r1', { headers: { ...json, 'X-Hub-Signature-256': sign(raw) }, body: raw, secret: 'nope' })).status).toBe(401)
      expect((await hit('r1', { headers: { ...json, 'X-Hub-Signature-256': 'sha256=bad' }, body: raw })).status).toBe(202)
    })

    it('the workflow target: no workflow or no webhook trigger captures, off is 409, else it runs', async () => {
      const workflows = new Map<string, Workflow>()
      const started: { id: string; via: string; call: WebhookCall | undefined }[] = []
      let status: WorkflowRunSummary['status'] = 'running'
      const hooks = new HookFile(join(await mkdtemp(join(tmpdir(), 'cb-wf-hooks-')), 'workflow-hooks.json'))
      const target = workflowHookTarget({
        store: { hooks, get: async (id) => workflows.get(id) ?? null },
        runner: {
          run: async (w, via, o) => {
            started.push({ id: w.id, via, call: o?.call })
            return { id: `wr-${started.length}`, status } as WorkflowRunSummary
          }
        }
      })
      const flow = (o: Partial<Workflow>): Workflow => ({
        id: 'w1',
        name: 'F',
        enabled: true,
        timeZone: 'UTC',
        trigger: { kind: 'webhook', sample: null, filters: [] },
        steps: [],
        edges: [],
        nextRunAt: null,
        createdAt: 1,
        updatedAt: 1,
        ...o
      })
      const call: WebhookCall = { method: 'POST', query: {}, body: { a: 1 }, receivedAt: 5 }
      expect(target.hooks).toBe(hooks)
      expect(await target.fire('w1', call)).toEqual({ status: 202, body: { status: 'test call captured' } })
      workflows.set('w1', flow({ trigger: { kind: 'manual' } }))
      expect(await target.fire('w1', call)).toEqual({ status: 202, body: { status: 'test call captured' } })
      workflows.set('w1', flow({ enabled: false }))
      expect(await target.fire('w1', call)).toEqual({ status: 409, body: { error: 'Workflow is disabled' } })
      expect(started).toEqual([])
      workflows.set('w1', flow({}))
      expect(await target.fire('w1', call)).toEqual({ status: 202, body: { runId: 'wr-1' } })
      status = 'skipped'
      expect(await target.fire('w1', call)).toEqual({ status: 202, body: { runId: 'wr-2', skipped: true } })
      expect(started).toEqual([
        { id: 'w1', via: 'webhook', call },
        { id: 'w1', via: 'webhook', call }
      ])
    })

    it('second target receives its own ids', async () => {
      const fired: string[] = []
      const wfSecret = 'workflow-secret-0123'
      const second: HookTarget = {
        hooks: {
          hook: async (hid) => (hid === 'w1' ? { id: 'w1', secret: wfSecret, latest: null, draftAt: null } : null),
          recordCall: async (hid, sec) => hid === 'w1' && sec === wfSecret
        },
        fire: async (hid) => {
          fired.push(hid)
          return { status: 202, body: { runId: 'wf-run' } }
        }
      }
      await rig.close()
      rig = await startRig({
        gate: allowGate(true),
        hooks: createHookHandler({
          targets: [routineTarget(store), second],
          badSecrets: createLimiter({ now: () => clock }),
          now: () => clock
        })
      })
      const res = await hit('w1', { secret: wfSecret, headers: json, body: '{}' })
      expect([res.status, await res.json()]).toEqual([202, { runId: 'wf-run' }])
      const raw = '{"ref":"main"}'
      const viaSig = await hit('w1', { secret: null, headers: { ...json, 'X-Hub-Signature-256': sign(raw, wfSecret) }, body: raw })
      expect(viaSig.status).toBe(202)
      expect(fired).toEqual(['w1', 'w1'])
      expect(calls).toEqual([]) // the routine target never saw them
      expect((await hit('r1', { headers: json, body: '{}' })).status).toBe(202)
      expect(fired).toEqual(['w1', 'w1'])
      expect(calls).toHaveLength(1)
      expect((await hit('w1', { secret: SECRET, headers: json, body: '{}' })).status).toBe(401)
    })
  })
})
