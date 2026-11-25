import { promises as fs, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROCESS_REFUSALS } from '@zumibot/shared/processes'
import { RUN_OUTPUT_MAX } from '@zumibot/shared/runBlocks'
import {
  ProcessService,
  processEnv,
  type ProcessEvent,
  type ProcessServiceDeps,
  type RunEndEvent
} from '../../src/core/processes/processService'

// A zombie (an orphan a non-reaping PID 1 holds) is dead.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true
  }
}
// The pid Windows knows: Git Bash's $! is its own numbering, which process.kill cannot see.
const BG = process.platform === 'win32' ? '$(cat /proc/$!/winpid)' : '$!'
const until = async (ok: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

let tmp: string, data: string, folder: string
let events: ProcessEvent[]
let chats: Map<string, { cwd: string; archived: boolean }>
const services: ProcessService[] = []

const make = (over: Partial<ProcessServiceDeps> = {}) => {
  const s = new ProcessService({
    dataDir: data,
    env: async () => ({
      ...process.env,
      ZUMIBOT_TODOS_CAPABILITY: 'secret-cap',
      CLAUDE_CODE_TMPDIR: '/x',
      CLAUDECODE: '1',
      KEEP_ME: 'yes'
    }),
    chat: async (id) => chats.get(id) ?? null,
    push: (e) => events.push(e),
    limits: { graceMs: 400, killWaitMs: 1000, outputEventMs: 10 },
    ...over
  })
  services.push(s)
  return s
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'procs-'))
  data = join(tmp, 'data')
  folder = join(tmp, 'repo')
  await fs.mkdir(join(folder, 'web'), { recursive: true })
  events = []
  chats = new Map([
    ['c1', { cwd: folder, archived: false }],
    ['c2', { cwd: folder, archived: false }]
  ])
})
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown()
  await fs.rm(tmp, { recursive: true, force: true })
})

const logs = (s: ProcessService, chat: string, id: string) => s.read(chat, id).then((r) => r.text)

describe('ProcessService', () => {
  it('starts in its own group, reads output, and stop ends the whole tree', async () => {
    const s = make()
    await s.load()
    const p = await s.start('c1', 'dev', { command: `sleep 300 & echo child=${BG}; echo hello; sleep 300`, name: 'dev' })
    expect(p).toMatchObject({ state: 'running', name: 'dev', startedBy: 'dev', cwd: await fs.realpath(folder) })
    expect(p).not.toHaveProperty('pid')
    await until(async () => (await logs(s, 'c1', p.id)).includes('hello'))
    const child = Number(/child=(\d+)/.exec(await logs(s, 'c1', p.id))![1])
    expect(alive(child)).toBe(true)
    expect(s.counts()).toEqual({ c1: 1 })
    const done = await s.stop('c1', p.id, 'user')
    expect(done).toMatchObject({ state: 'stopped', stoppedBy: 'user' })
    expect(alive(child)).toBe(false)
    expect(s.counts()).toEqual({})
    expect(events.some((e) => e.kind === 'changed' && e.chatId === 'c1' && e.running === 0)).toBe(true)
  })

  it('kills a tree that ignores SIGTERM', async () => {
    const s = make()
    await s.load()
    const p = await s.start('c1', 'dev', { command: `trap '' TERM; sleep 300 & echo child=${BG}; wait` })
    await until(async () => /child=\d+/.test(await logs(s, 'c1', p.id)))
    const child = Number(/child=(\d+)/.exec(await logs(s, 'c1', p.id))![1])
    await s.stop('c1', p.id, 'agent')
    expect(alive(child)).toBe(false)
  })

  it('records an exit and ends what the leader left behind', async () => {
    const s = make()
    await s.load()
    const p = await s.start('c1', 'dev', { command: `(sleep 300 & echo left=${BG}); exit 3` })
    await until(() => s.list('c1')[0].state !== 'running')
    expect(s.list('c1')[0]).toMatchObject({ state: 'exited', exitCode: 3, stoppedBy: null })
    const left = Number(/left=(\d+)/.exec(await logs(s, 'c1', p.id))![1])
    expect(alive(left)).toBe(false)
  })

  it('gives the process a minimal env', async () => {
    const s = make()
    await s.load()
    const p = await s.start('c1', 'dev', { command: 'env' })
    await until(() => s.list('c1')[0].state === 'exited')
    const out = await logs(s, 'c1', p.id)
    expect(out).toContain('KEEP_ME=yes')
    expect(out).not.toContain('secret-cap')
    expect(out).not.toContain('CLAUDE_CODE_TMPDIR')
    expect(out).not.toMatch(/^CLAUDECODE=/m)
    expect(processEnv({ ZUMIBOT_DATA_DIR: 'x', PATH: '/bin' })).toEqual({ PATH: '/bin' })
  })

  it('keeps cwd inside the chat folder', async () => {
    const s = make()
    await s.load()
    // A junction (the type only Windows reads) needs no privilege there.
    await fs.symlink(tmp, join(folder, 'out'), 'junction')
    const sub = await s.start('c1', 'dev', { command: 'pwd', cwd: 'web' })
    expect(sub.cwd).toBe(join(await fs.realpath(folder), 'web'))
    await expect(s.start('c1', 'dev', { command: 'pwd', cwd: '..' })).rejects.toThrow(PROCESS_REFUSALS.cwd)
    await expect(s.start('c1', 'dev', { command: 'pwd', cwd: 'out' })).rejects.toThrow(PROCESS_REFUSALS.cwd)
    await expect(s.start('c1', 'dev', { command: 'pwd', cwd: 'missing' })).rejects.toThrow(PROCESS_REFUSALS.cwd)
    await expect(s.start('c1', 'dev', { command: 'pwd', cwd: tmp })).rejects.toThrow(PROCESS_REFUSALS.cwd)
  })

  it('enforces the per-chat and total caps, names, and command rules', async () => {
    const s = make({ limits: { perChat: 2, total: 3, graceMs: 200, killWaitMs: 1000 } })
    await s.load()
    await s.start('c1', 'a', { command: 'sleep 300', name: 'one' })
    await expect(s.start('c1', 'a', { command: 'sleep 300', name: 'one' })).rejects.toThrow(/A process named one is already running/)
    await s.start('c1', 'a', { command: 'sleep 300' })
    await expect(s.start('c1', 'a', { command: 'sleep 300' })).rejects.toThrow(PROCESS_REFUSALS.perChat)
    await s.start('c2', 'a', { command: 'sleep 300' })
    await expect(s.start('c2', 'a', { command: 'sleep 300' })).rejects.toThrow(PROCESS_REFUSALS.total)
    await expect(s.start('c2', 'a', { command: '' })).rejects.toThrow(PROCESS_REFUSALS.command)
    await expect(s.start('c2', 'a', { command: 'x', name: '../x' })).rejects.toThrow(PROCESS_REFUSALS.name)
    await expect(s.start('c2', 'a', { command: 'x', timeoutMinutes: 0 })).rejects.toThrow(/timeoutMinutes/)
  })

  it("refuses an archived or gone chat and ends a chat's processes on archive", async () => {
    const s = make()
    await s.load()
    const a = await s.start('c1', 'dev', { command: 'sleep 300' })
    const b = await s.start('c2', 'dev', { command: 'sleep 300' })
    chats.set('c1', { cwd: folder, archived: true })
    expect(await s.endChat('c1', 'archive')).toBe(1)
    expect(s.list('c1')[0]).toMatchObject({ id: a.id, state: 'stopped', stoppedBy: 'archive' })
    expect(s.list('c2')[0]).toMatchObject({ id: b.id, state: 'running' })
    await expect(s.start('c1', 'dev', { command: 'sleep 1' })).rejects.toThrow(PROCESS_REFUSALS.closed)
    await expect(s.start('nope', 'dev', { command: 'sleep 1' })).rejects.toThrow(PROCESS_REFUSALS.closed)
  })

  it('a start racing an archive is either ended by it or refused', async () => {
    const s = make()
    await s.load()
    const starting = s.start('c1', 'dev', { command: 'sleep 300' })
    chats.set('c1', { cwd: folder, archived: true })
    const ending = s.endChat('c1', 'archive')
    const started = await starting.catch((e: Error) => e)
    await ending
    if (started instanceof Error) expect(started.message).toBe(PROCESS_REFUSALS.closed)
    expect(s.counts()).toEqual({})
  })

  it('removing a chat deletes its records and logs', async () => {
    const s = make()
    await s.load()
    await s.start('c1', 'dev', { command: 'echo hi; sleep 300' })
    await s.removeChat('c1')
    expect(s.list('c1')).toEqual([])
    await expect(fs.access(join(data, 'processes', 'c1'))).rejects.toThrow()
  })

  it('marks running records lost at start and ends a tree that is provably the same', async () => {
    const a = make()
    await a.load()
    const p = await a.start('c1', 'dev', { command: 'echo up; sleep 300' })
    await until(async () => (await logs(a, 'c1', p.id)).includes('up'))
    const pid = JSON.parse(await fs.readFile(join(data, 'processes', 'index.json'), 'utf8')).items[0].pid as number
    // A second server over the same data, as after a crash: the first never shut down.
    const b = make()
    await b.load()
    const rec = b.list('c1')[0]
    expect(rec.state).toBe('lost')
    // Linux proves the pid through /proc, Windows through the id in the env of each Git Bash process; macOS has neither.
    if (process.platform === 'linux' || process.platform === 'win32') {
      expect(rec.note).toBe('ended at start')
      // Git for Windows' bash.exe is a launcher that ends once the bash it started is gone.
      await until(() => !alive(pid), 3000)
    }
    expect(await logs(b, 'c1', p.id)).toContain('up')
    expect(b.counts()).toEqual({})
  })

  it('never ends a pid whose start time does not match', async () => {
    const other = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
    try {
      await fs.mkdir(join(data, 'processes'), { recursive: true })
      await fs.writeFile(
        join(data, 'processes', 'index.json'),
        JSON.stringify({
          v: 1,
          items: [
            {
              id: 'p_00000000aa',
              chatId: 'c1',
              name: 'x',
              command: 'sleep 300',
              cwd: folder,
              startedBy: 'dev',
              startedAt: 1,
              endedAt: null,
              state: 'running',
              pid: other.pid,
              bootId: 'whatever',
              startTicks: '1',
              logBase: 0
            }
          ]
        })
      )
      const s = make()
      await s.load()
      expect(s.list('c1')[0]).toMatchObject({ state: 'lost', note: null })
      expect(alive(other.pid!)).toBe(true)
    } finally {
      other.kill('SIGKILL')
    }
  })

  it('keeps cursors across rotation and says what was dropped', async () => {
    const s = make({ limits: { ringBytes: 1000, fileBytes: 4000, graceMs: 200, killWaitMs: 1000 } })
    await s.load()
    const p = await s.start('c1', 'dev', { command: 'for i in $(seq 1 2000); do echo line-$i; done' })
    await until(() => s.list('c1')[0].state === 'exited')
    const all = await s.read('c1', p.id, 0)
    expect(all.dropped).toBeGreaterThan(0)
    expect(all.from).toBe(all.dropped)
    expect(all.text).toContain('line-2000')
    expect(all.to).toBe(s.list('c1')[0].out)
    const tail = await s.agentLogs('c1', { id: p.id, tail: 3 })
    expect(tail).toContain('line-1998\nline-1999\nline-2000')
  })

  it('wait matches a ready line, before or after the call, and reports exits and timeouts', async () => {
    const s = make()
    await s.load()
    const p = await s.start('c1', 'dev', { command: 'echo booting; sleep 0.3; echo "ready in 5ms"; sleep 300' })
    expect(await s.agentWait('c1', { id: p.id, patterns: ['ready in'], timeoutSeconds: 5 })).toMatch(/^Matched: ready in 5ms/)
    // Printed before this call: still found.
    expect(await s.agentWait('c1', { id: p.id, patterns: ['booting'], timeoutSeconds: 5 })).toMatch(/^Matched: booting/)
    expect(await s.agentWait('c1', { id: p.id, patterns: ['never'], timeoutSeconds: 1 })).toMatch(/^Still running after 1s/)
    const q = await s.start('c1', 'dev', { command: 'sleep 0.2; exit 2' })
    expect(await s.agentWait('c1', { id: q.id, timeoutSeconds: 5 })).toMatch(/^It ended: exited with code 2/)
    const ac = new AbortController()
    const w = s.agentWait('c1', { id: p.id, patterns: ['never'], timeoutSeconds: 60 }, ac.signal)
    ac.abort()
    expect(await w).toBe('Wait ended.')
  })

  it('ends a process at its lifetime', async () => {
    let calls = 0
    const s = make({ now: () => (calls++ === 0 ? Date.now() - 59_800 : Date.now()) })
    await s.load()
    await s.start('c1', 'dev', { command: 'sleep 300', timeoutMinutes: 1 })
    await until(() => s.list('c1')[0].state !== 'running')
    expect(s.list('c1')[0]).toMatchObject({ state: 'stopped', stoppedBy: 'lifetime' })
  })

  it('restarts under the same id, and shutdown ends everything', async () => {
    const s = make()
    await s.load()
    const p = await s.start('c1', 'dev', { command: 'echo run; sleep 300' })
    await until(async () => (await logs(s, 'c1', p.id)).includes('run'))
    const r = await s.restart('c1', p.id)
    expect(r).toMatchObject({ id: p.id, state: 'running', restarts: 1 })
    await until(async () => (await logs(s, 'c1', p.id)).split('run').length === 3)
    expect(await logs(s, 'c1', p.id)).toContain('restarted by the user')
    await s.shutdown()
    expect(s.list('c1')[0]).toMatchObject({ state: 'stopped', stoppedBy: 'shutdown' })
    await expect(s.start('c1', 'dev', { command: 'sleep 1' })).rejects.toThrow(PROCESS_REFUSALS.down)
    const index = JSON.parse(await fs.readFile(join(data, 'processes', 'index.json'), 'utf8'))
    expect(index.items[0].state).toBe('stopped')
    if (process.platform !== 'win32') expect((await fs.stat(join(data, 'processes', 'index.json'))).mode & 0o777).toBe(0o600)
    if (process.platform !== 'win32') expect((await fs.stat(join(data, 'processes', 'c1'))).mode & 0o777).toBe(0o700)
  })

  it("moves startedBy on rename, refuses another chat's process, and scrubs output", async () => {
    const s = make({ scrubOf: (agent) => new Map(agent === 'dev' ? [['hunter2', '[vault: pw]']] : []) })
    await s.load()
    const p = await s.start('c1', 'dev', { command: 'echo pass=hunter2; sleep 300' })
    await until(async () => (await logs(s, 'c1', p.id)).includes('pass='))
    expect(await logs(s, 'c1', p.id)).toContain('pass=[vault: pw]')
    expect(s.list('c1')[0].command).toContain('[vault: pw]')
    expect(() => s.list('c2')).not.toThrow()
    await expect(s.stop('c2', p.id, 'agent')).rejects.toThrow(PROCESS_REFUSALS.notFound)
    await s.renameAgent('dev', 'web-dev')
    expect(s.list('c1')[0].startedBy).toBe('web-dev')
  })
})

describe('ProcessService notify rules', () => {
  const wakes = () => {
    const got: import('@zumibot/shared/processes').WakeEvent[] = []
    return { got, onWake: (e: import('@zumibot/shared/processes').WakeEvent) => got.push(e) }
  }

  it('raises an exit event once with the last lines, and never after a stop', async () => {
    const w = wakes()
    const s = make({ onWake: w.onWake })
    await s.load()
    const p = await s.start('c1', 'dev', { command: 'echo building; echo "error: 2 failed"; exit 2', notify: { on: 'exit' } })
    await until(() => w.got.length === 1)
    expect(w.got[0]).toMatchObject({ chatId: 'c1', id: p.id, name: p.name, startedBy: 'dev', kind: 'exit', exitCode: 2, signal: null })
    expect(w.got[0].tail).toBe('building\nerror: 2 failed')
    expect(s.list('c1')[0].wake).toMatchObject({ on: 'exit', times: 1, fired: 1 })
    const q = await s.start('c1', 'dev', { command: 'sleep 300', notify: { on: 'exit' } })
    await s.stop('c1', q.id, 'user')
    await new Promise((r) => setTimeout(r, 200))
    expect(w.got).toHaveLength(1)
  })

  it('fail fires only on a non-zero code or a signal', async () => {
    const w = wakes()
    const s = make({ onWake: w.onWake })
    await s.load()
    await s.start('c1', 'dev', { command: 'exit 0', notify: { on: 'fail' } })
    const bad = await s.start('c1', 'dev', { command: 'exit 1', notify: { on: 'fail' } })
    await until(() => s.list('c1').every((p) => p.state !== 'running'))
    await until(() => w.got.length === 1)
    await new Promise((r) => setTimeout(r, 100))
    expect(w.got.map((e) => e.id)).toEqual([bad.id])
  })

  it('match fires per matching line up to times, and Restart lets it fire again', async () => {
    const w = wakes()
    const s = make({ onWake: w.onWake })
    await s.load()
    const p = await s.start('c1', 'dev', {
      command: 'for i in 1 2 3 4; do echo "FAIL test $i"; echo ok; done; sleep 300',
      notify: { on: 'match', patterns: ['FAIL'], times: 2 }
    })
    await until(() => w.got.length === 2)
    await new Promise((r) => setTimeout(r, 200))
    expect(w.got.map((e) => [e.kind, e.line])).toEqual([
      ['match', 'FAIL test 1'],
      ['match', 'FAIL test 2']
    ])
    expect(s.list('c1')[0].wake).toMatchObject({ fired: 2, times: 2 })
    await s.restart('c1', p.id)
    await until(() => w.got.length === 4)
    await s.noteWake(p.id, 'Wake-up skipped: daily spend cap')
    expect(s.list('c1')[0].wake?.note).toBe('Wake-up skipped: daily spend cap')
    await s.wakeSent(p.id)
    expect(s.list('c1')[0].wake?.note).toBeNull()
  })

  it('refuses a rule that does not fit, before anything starts', async () => {
    const s = make()
    await s.load()
    await expect(s.start('c1', 'dev', { command: 'x', notify: { on: 'match' } })).rejects.toThrow('notify with on: match needs patterns.')
    await expect(s.start('c1', 'dev', { command: 'x', notify: { on: 'exit', patterns: ['a'] } })).rejects.toThrow(
      'notify.patterns go only with on: match.'
    )
    await expect(s.start('c1', 'dev', { command: 'x', notify: { on: 'exit', times: 6 } })).rejects.toThrow(/notify.times/)
    expect(s.list('c1')).toEqual([])
  })

  it('keeps the rule across a restart of the server, and the agent hears what it set up', async () => {
    const s = make()
    await s.load()
    const text = await s.agentStart('c1', 'dev', { command: 'sleep 300', notify: { on: 'fail', times: 3 } })
    expect(text).toContain('if it fails (at most 3 times)')
    const b = make()
    await b.load()
    expect(b.list('c1')[0].wake).toMatchObject({ on: 'fail', times: 3, fired: 0 })
  })
})

describe('ProcessService user runs', () => {
  const runs = () => {
    const got: RunEndEvent[] = []
    return { got, onRunEnd: (e: RunEndEvent) => got.push(e) }
  }

  it('run records its mark and survives a reload', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    const p = await s.run('c1', 'dev', 'm1', 'echo hi')
    expect(p.run).toEqual({ messageId: 'm1' })
    expect(p.startedBy).toBe('dev')
    const agent = await s.start('c1', 'dev', { command: 'echo x' })
    expect(agent.run).toBeNull()
    await until(() => s.list('c1').every((x) => x.state !== 'running'))
    const b = make()
    await b.load()
    expect(b.list('c1').find((x) => x.id === p.id)?.run).toEqual({ messageId: 'm1' })
    expect(b.list('c1').find((x) => x.id === agent.id)?.run).toBeNull()
  })

  it('run skips no limit', async () => {
    const s = make()
    await s.load()
    for (let i = 0; i < 5; i++) await s.start('c1', 'dev', { command: 'sleep 300' })
    await expect(s.run('c1', 'dev', 'm1', 'echo hi')).rejects.toThrow(PROCESS_REFUSALS.perChat)
    chats.set('c2', { cwd: folder, archived: true })
    await expect(s.run('c2', 'dev', 'm1', 'echo hi')).rejects.toThrow(PROCESS_REFUSALS.closed)
  })

  it('run end on exit 0', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    const p = await s.run('c1', 'dev', 'm1', 'echo fine')
    await until(() => r.got.length === 1)
    expect(r.got[0]).toMatchObject({
      chatId: 'c1',
      id: p.id,
      messageId: 'm1',
      command: 'echo fine',
      cwd: await fs.realpath(folder),
      agent: 'dev',
      end: { kind: 'exit', code: 0 },
      outcome: 'ok',
      error: null,
      output: 'fine\n',
      cut: false
    })
    expect(r.got[0].startedAt).toBe(p.startedAt)
    expect(r.got[0].endedAt).toBeGreaterThanOrEqual(r.got[0].startedAt)
  })

  it('run end on exit N', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    await s.run('c1', 'dev', 'm1', 'echo hi; exit 3')
    await until(() => r.got.length === 1)
    expect(r.got[0]).toMatchObject({ end: { kind: 'exit', code: 3 }, outcome: 'error', error: 'exit code 3', cut: false })
    expect(r.got[0].output).toContain('hi')
  })

  // POSIX signal: on Windows Git Bash's `kill -9 $$` ends with exit code 2304, and Node sees no signal.
  it.skipIf(process.platform === 'win32')('run end on a signal that is not a stop', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    await s.run('c1', 'dev', 'm1', 'kill -9 $$')
    await until(() => r.got.length === 1)
    expect(r.got[0]).toMatchObject({ end: { kind: 'signal', signal: 'SIGKILL' }, outcome: 'error', error: 'SIGKILL' })
  })

  it('run end on user stop', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    const p = await s.run('c1', 'dev', 'm1', 'echo up; sleep 30')
    await until(async () => (await logs(s, 'c1', p.id)).includes('up'))
    await s.stop('c1', p.id, 'user')
    expect(r.got).toHaveLength(1)
    expect(r.got[0]).toMatchObject({
      end: { kind: 'stopped', by: 'user' },
      outcome: 'interrupted',
      error: 'stopped by the user',
      output: 'up\n'
    })
  })

  it('run end at its lifetime', async () => {
    const r = runs()
    let calls = 0
    const s = make({ onRunEnd: r.onRunEnd, now: () => (calls++ === 0 ? Date.now() - 59_800 : Date.now()) })
    await s.load()
    await s.start('c1', 'dev', { command: 'sleep 300', timeoutMinutes: 1 }, { run: { messageId: 'm1' } })
    await until(() => r.got.length === 1)
    expect(r.got[0]).toMatchObject({ end: { kind: 'stopped', by: 'lifetime' }, outcome: 'interrupted', error: 'stopped at its time limit' })
  })

  it('restart sends nothing for the old run', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    const p = await s.run('c1', 'dev', 'm1', 'echo old; sleep 30')
    await until(async () => (await logs(s, 'c1', p.id)).includes('old'))
    await s.restart('c1', p.id)
    expect(r.got).toHaveLength(1)
    expect(r.got[0]).toMatchObject({ id: p.id, end: null, outcome: 'interrupted', error: 'restarted', output: '', cut: false })
    // The second run's own echo first (the restart appends to the same log): where a start is slower (macOS), an
    // immediate stop lands before it.
    await until(async () => (await logs(s, 'c1', p.id)).match(/old/g)?.length === 2)
    await s.stop('c1', p.id, 'user')
    expect(r.got).toHaveLength(2)
    expect(r.got[1]).toMatchObject({ id: p.id, end: { kind: 'stopped', by: 'user' }, error: 'stopped by the user' })
    // The second run's tail holds its own output, not the first run's.
    expect(r.got[1].startedAt).toBeGreaterThanOrEqual(r.got[0].endedAt)
    expect(r.got[1].output).toBe('old\n')
  })

  it('agent stop sends no message', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    const p = await s.run('c1', 'dev', 'm1', 'sleep 30')
    await s.stop('c1', p.id, 'agent')
    expect(r.got).toHaveLength(1)
    expect(r.got[0]).toMatchObject({ end: null, outcome: 'interrupted', error: 'stopped by the agent', output: '' })
  })

  it('archive ends run with no message', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    await s.run('c1', 'dev', 'm1', 'sleep 30')
    await s.endChat('c1', 'archive')
    expect(r.got).toHaveLength(1)
    expect(r.got[0]).toMatchObject({ end: null, outcome: 'interrupted', error: 'stopped at archive' })
  })

  it('remove and shutdown end a run with no message', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    await s.run('c1', 'dev', 'm1', 'sleep 30')
    await s.run('c2', 'dev', 'm2', 'sleep 30')
    await s.removeChat('c1')
    await s.shutdown()
    expect(r.got.map((e) => [e.messageId, e.end, e.error])).toEqual([
      ['m1', null, 'stopped at remove'],
      ['m2', null, 'stopped with the server']
    ])
  })

  it('spawn failure sends no message', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd, shell: join(tmp, 'no-such-shell') })
    await s.load()
    await s.run('c1', 'dev', 'm1', 'echo hi')
    await until(() => r.got.length === 1)
    expect(r.got[0]).toMatchObject({ end: null, outcome: 'error', error: 'ENOENT', output: '' })
  })

  it('lost run raises end with no message', async () => {
    await fs.mkdir(join(data, 'processes'), { recursive: true })
    await fs.writeFile(
      join(data, 'processes', 'index.json'),
      JSON.stringify({
        v: 1,
        items: [
          {
            id: 'p_00000000bb',
            chatId: 'c1',
            name: 'x',
            command: 'sleep 300',
            cwd: folder,
            startedBy: 'dev',
            startedAt: 1,
            endedAt: null,
            state: 'running',
            pid: null,
            logBase: 0,
            run: { messageId: 'm9' }
          },
          {
            id: 'p_00000000cc',
            chatId: 'c1',
            name: 'y',
            command: 'sleep 300',
            cwd: folder,
            startedBy: 'dev',
            startedAt: 1,
            endedAt: null,
            state: 'running',
            pid: null,
            logBase: 0,
            run: 'junk'
          }
        ]
      })
    )
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    expect(r.got).toHaveLength(1)
    expect(r.got[0]).toMatchObject({
      id: 'p_00000000bb',
      messageId: 'm9',
      agent: 'dev',
      startedAt: 1,
      end: null,
      outcome: 'interrupted',
      error: 'lost at restart',
      output: '',
      cut: false
    })
    expect(s.list('c1').find((x) => x.id === 'p_00000000cc')?.run).toBeNull()
  })

  it('run tail is scrubbed', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd, scrubOf: (a) => new Map(a === 'dev' ? [['s3cr3t', '[vault]']] : []) })
    await s.load()
    await s.run('c1', 'dev', 'm1', 'echo s3cr3t')
    await until(() => r.got.length === 1)
    expect(r.got[0].output).toContain('[vault]')
    expect(r.got[0].output).not.toContain('s3cr3t')
    expect(r.got[0].command).not.toContain('s3cr3t')
  })

  it('run tail is scrubbed before its long lines are cut, so a secret across the cut leaves no prefix', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd, scrubOf: (a) => new Map(a === 'dev' ? [['S3CRETVALUE', '[vault]']] : []) })
    await s.load()
    // The secret starts at column 1995 of a line cut at 2000.
    await s.run('c1', 'dev', 'm1', `printf '%*s' 1995 '' | tr ' ' x; echo S3CRETVALUE`)
    await until(() => r.got.length === 1)
    expect(r.got[0].output.startsWith('x'.repeat(1995))).toBe(true)
    expect(r.got[0].output).not.toContain('S3CRE')
  })

  it('a Restart that lands while the end is being saved changes nothing the ended run reports', async () => {
    const r = runs()
    let open!: () => void
    const gate = new Promise<void>((res) => {
      open = res
    })
    let restarted: Promise<unknown> | null = null
    const s: ProcessService = make({
      onRunEnd: r.onRunEnd,
      push: (e) => {
        events.push(e)
        // The end's own output event comes right before its save (the record already ended): that save is held, by
        // holding the service's write queue, and the Restart lands meanwhile.
        if (restarted || e.kind !== 'output' || s.list('c1')[0]?.state !== 'exited') return
        const inner = s as unknown as { writeQueue: Promise<void> }
        inner.writeQueue = inner.writeQueue.then(() => gate)
        restarted = s.restart('c1', e.id)
      }
    })
    await s.load()
    // The first run ends only once its start has settled (the held save would hold that start too) and exits 3; the
    // restarted one prints its own number and runs on until told.
    const command =
      'while [ ! -e go ]; do sleep 0.02; done; n=$(($(cat n 2>/dev/null || echo 0)+1)); echo $n > n; echo run$n; ' +
      '[ $n = 1 ] && exit 3; while [ ! -e go2 ]; do sleep 0.02; done; exit 0'
    const p = await s.run('c1', 'dev', 'm1', command)
    await fs.writeFile(join(folder, 'go'), '')
    await until(async () => restarted !== null && (await logs(s, 'c1', p.id)).includes('run2'))
    open()
    await restarted
    await until(() => r.got.length === 1)
    expect(r.got[0]).toMatchObject({ end: { kind: 'exit', code: 3 }, outcome: 'error', error: 'exit code 3', output: 'run1\n' })
    expect(r.got[0].startedAt).toBe(p.startedAt)
    expect(r.got[0].endedAt).toBeGreaterThanOrEqual(p.startedAt)
    await fs.writeFile(join(folder, 'go2'), '')
    await until(() => r.got.length === 2)
    expect(r.got[1]).toMatchObject({ end: { kind: 'exit', code: 0 }, outcome: 'ok', output: 'run2\n' })
    expect(r.got[1].startedAt).toBeGreaterThanOrEqual(r.got[0].endedAt)
  })

  it('run tail is cut', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    await s.run('c1', 'dev', 'm1', `seq -f 'line %05g xxxxxxxxxxxxxxxxxxxxxxxxx' 1 1500`)
    await until(() => r.got.length === 1)
    const e = r.got[0]
    expect(e.cut).toBe(true)
    expect(Buffer.byteLength(e.output)).toBeLessThanOrEqual(RUN_OUTPUT_MAX)
    expect(e.output).toMatch(/^line \d{5} x{25}\n/)
    expect(e.output.endsWith('line 01500 xxxxxxxxxxxxxxxxxxxxxxxxx\n')).toBe(true)
  })

  it('agent processes raise no run end', async () => {
    const r = runs()
    const s = make({ onRunEnd: r.onRunEnd })
    await s.load()
    await s.start('c1', 'dev', { command: 'exit 1' })
    await until(() => s.list('c1')[0].state === 'exited')
    await new Promise((res) => setTimeout(res, 100))
    expect(r.got).toEqual([])
  })

  it('a run ignores notify, and a throwing onRunEnd does not break the end', async () => {
    const s = make({
      onWake: () => {
        throw new Error('no wake for a run')
      },
      onRunEnd: () => {
        throw new Error('boom')
      }
    })
    await s.load()
    const p = await s.start('c1', 'dev', { command: 'exit 1', notify: { on: 'exit' } }, { run: { messageId: 'm1' } })
    expect(p.wake).toBeNull()
    await until(() => s.list('c1')[0].state === 'exited')
    expect(s.list('c1')[0]).toMatchObject({ state: 'exited', exitCode: 1 })
  })

  it('tells the agent a process was run by the user', async () => {
    const s = make()
    await s.load()
    await s.run('c1', 'dev', 'm1', 'sleep 30')
    expect(s.agentList('c1')).toContain('(run by the user from a block)')
  })
})
