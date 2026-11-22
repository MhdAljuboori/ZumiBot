import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { controlPath, serveControl } from '@zumibot/backend/control'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { portInUse, startLocalServer } from '../src/main/localServer'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-local-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function script(body: string): string {
  const f = join(dir, 'fake.mjs')
  writeFileSync(f, body)
  return f
}
// The Linux protocol (SIGTERM stops it, the socket answers busy); the Windows one, over stdin, has its own test below.
const base = (entry: string) => ({
  node: process.execPath,
  entry,
  env: { ...process.env, ZUMIBOT_DATA_DIR: dir },
  platform: 'linux' as const
})

// Stays alive until SIGTERM like the real server, which exits 0 on it.
const LISTEN = `console.log('LISTENING 1234'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)`

describe('startLocalServer', () => {
  it('resolves origin http://127.0.0.1:1234 and a 64-hex secret', async () => {
    const s = await startLocalServer(base(script(LISTEN)))
    try {
      expect(s.origin).toBe('http://127.0.0.1:1234')
      expect(s.secret).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await s.stop()
    }
  })

  it('hands the child its mode and secret through env, and nothing else secret through argv', async () => {
    const f = script(`
      const e = process.env
      console.error(JSON.stringify({ m: e.ZUMIBOT_MODE, hex: /^[0-9a-f]{64}$/.test(e.ZUMIBOT_LOCAL_SECRET), argv: process.argv.slice(2) }))
      console.log('LISTENING 4321'); setInterval(() => {}, 1000)`)
    const lines: string[] = []
    const s = await startLocalServer({ ...base(f), onStderr: (l) => lines.push(l) })
    try {
      await new Promise((r) => setTimeout(r, 100))
      const got = JSON.parse(lines.join('\n'))
      expect(got.m).toBe('local')
      expect(got.hex).toBe(true) // the child got a 64-hex secret (redacted if echoed)
      expect(got.argv).toEqual([])
    } finally {
      await s.stop()
    }
  })

  it('rejects with stderr tail on early exit', async () => {
    const f = script(`console.error('boom: port in use'); process.exit(3)`)
    await expect(startLocalServer(base(f))).rejects.toThrow(/boom: port in use/)
  })

  it('keeps only the last 20 stderr lines', async () => {
    const f = script(`for (let i = 0; i < 50; i++) console.error('line ' + i); process.exit(1)`)
    const err = await startLocalServer(base(f)).catch((e: Error) => e)
    expect((err as Error).message).toContain('line 49')
    expect((err as Error).message).toContain('line 30')
    expect((err as Error).message).not.toContain('line 29\n')
  })

  it('rejects after timeoutMs with no LISTENING', async () => {
    const f = script(`setInterval(() => {}, 1000)`)
    const t0 = Date.now()
    await expect(startLocalServer({ ...base(f), timeoutMs: 300 })).rejects.toThrow(/did not start/)
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('the secret is never in the rejection text', async () => {
    // A server that echoes its env into stderr, as a crash dump might.
    const f = script(`console.error('env dump ' + process.env.ZUMIBOT_LOCAL_SECRET + ' end'); process.exit(1)`)
    const err = (await startLocalServer(base(f)).catch((e: Error) => e)) as Error
    expect(err.message).toContain('env dump')
    expect(err.message).not.toMatch(/[0-9a-f]{64}/)
  })

  it('stop() ends the child and busy() rejects once there is no control socket', async () => {
    const s = await startLocalServer(base(script(LISTEN)))
    await expect(s.busy()).rejects.toThrow()
    await s.stop()
    await s.stop() // idempotent
  })

  it('stop() kills a child that ignores SIGTERM after killAfterMs', async () => {
    const f = script(`console.log('LISTENING 1234'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`)
    const s = await startLocalServer({ ...base(f), killAfterMs: 200 })
    const t0 = Date.now()
    await s.stop()
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})

describe('startLocalServer extras', () => {
  it('forwards stderr after ready, with the secret redacted', async () => {
    const f = script(`
      console.log('LISTENING 1234')
      console.error('later ' + process.env.ZUMIBOT_LOCAL_SECRET)
      setInterval(() => {}, 1000)`)
    const lines: string[] = []
    const s = await startLocalServer({ ...base(f), onStderr: (l) => lines.push(l) })
    try {
      await until(() => lines.length > 0)
      expect(lines[0]).toMatch(/^later \[redacted\]$/)
    } finally {
      await s.stop()
    }
  })

  it('onExit reports an unexpected exit code', async () => {
    const f = script(`console.log('LISTENING 1234'); setTimeout(() => process.exit(7), 100)`)
    const got: unknown[] = []
    const s = await startLocalServer({ ...base(f), onExit: (code, signal) => got.push([code, signal]) })
    await until(() => got.length > 0)
    expect(got[0]).toEqual([7, null])
    await s.stop()
  })

  // pgrep and a SIGKILL exit signal are POSIX's; on Windows a kill is an exit code.
  it.skipIf(process.platform === 'win32')('onExit reports the signal when it was killed, and not at all after stop()', async () => {
    const f = script(`console.log('LISTENING 1234'); setInterval(() => {}, 1000)`)
    const got: unknown[] = []
    const s = await startLocalServer({ ...base(f), onExit: (code, signal) => got.push([code, signal]) })
    await s.stop()
    await new Promise((r) => setTimeout(r, 100))
    expect(got).toEqual([])
    const g2: unknown[] = []
    const s2 = await startLocalServer({ ...base(f), onExit: (code, signal) => g2.push([code, signal]) })
    // killed from outside, not through stop(): matched by this test's own script path, never another process's
    process.kill(Number(execFileSync('pgrep', ['-nf', '--', f]).toString().trim()), 'SIGKILL')
    await until(() => g2.length > 0)
    expect(g2[0]).toEqual([null, 'SIGKILL'])
    await s2.stop()
  })

  it('processes() asks the control socket for running background processes, apart from busy', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'cb-xdg-'))
    mkdirSync(join(xdg, 'zumibot'))
    const stopControl = await serveControl(controlPath(join(xdg, 'zumibot')), { busy: () => 0, processes: () => 2 })
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_DATA_HOME: xdg }
    delete env['ZUMIBOT_DATA_DIR']
    const s = await startLocalServer({ node: process.execPath, entry: script(LISTEN), env, platform: 'linux' })
    try {
      expect(await s.busy()).toBe(0)
      expect(await s.processes()).toBe(2)
    } finally {
      await s.stop()
      await stopControl()
      rmSync(xdg, { recursive: true, force: true })
    }
  })

  it('busy() asks the control socket in the server data dir (XDG rule, same as the server)', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'cb-xdg-'))
    mkdirSync(join(xdg, 'zumibot'))
    const stopControl = await serveControl(controlPath(join(xdg, 'zumibot')), { busy: () => 3 })
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_DATA_HOME: xdg }
    delete env['ZUMIBOT_DATA_DIR']
    const s = await startLocalServer({ node: process.execPath, entry: script(LISTEN), env, platform: 'linux' })
    try {
      expect(await s.busy()).toBe(3)
      // A server without the processes line (older, as this one is) answers `error`: the shell reads that as none.
      await expect(s.processes()).rejects.toThrow('bad control reply')
    } finally {
      await s.stop()
      await stopControl()
      rmSync(xdg, { recursive: true, force: true })
    }
  })
})

describe('startLocalServer on Windows', () => {
  // As the real server with ZUMIBOT_STDIN_CONTROL: questions and the stop arrive on stdin, answers on stdout.
  const STDIN_SERVER = `
    const rl = require('node:readline').createInterface({ input: process.stdin })
    console.log('LISTENING 1234')
    rl.on('line', (l) => { if (l === 'busy') console.log('CONTROL busy 4'); if (l === 'processes') console.log('CONTROL processes 1') })
    rl.on('close', () => { console.error('stopped cleanly'); process.exit(0) })`

  it('asks and stops the server over stdin, since Windows has no SIGTERM', async () => {
    const f = join(dir, 'fake.cjs')
    writeFileSync(f, STDIN_SERVER)
    const lines: string[] = []
    const s = await startLocalServer({ ...base(f), platform: 'win32', onStderr: (l) => lines.push(l) })
    expect(await s.busy()).toBe(4)
    expect(await s.processes()).toBe(1)
    const t0 = Date.now()
    await s.stop()
    expect(Date.now() - t0).toBeLessThan(5000)
    await until(() => lines.includes('stopped cleanly'))
  })
})

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('portInUse', () => {
  it('matches EADDRINUSE only', () => {
    expect(portInUse('Error: listen EADDRINUSE: address already in use 127.0.0.1:4318')).toBe(true)
    expect(portInUse('Error: something else broke')).toBe(false)
    expect(portInUse('')).toBe(false)
  })
})
