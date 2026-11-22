import { promises as fs, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROCESS_REFUSALS } from '@zumibot/shared/processes'
import { ProcessService, processEnv, type ProcessEvent, type ProcessServiceDeps } from '../../src/core/processes/processService'

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
