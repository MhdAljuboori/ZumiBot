import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runSyncProcess } from '../src/main/syncProcess'

const roots: string[] = []
const groups: number[] = []
function worker(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'sync-worker-'))
  roots.push(root)
  const entry = join(root, 'runner.mjs')
  writeFileSync(entry, source)
  return entry
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 4000
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
afterEach(() => {
  for (const pgid of groups.splice(0))
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const config = { VPS_HOST: 'fake', VPS_USER: 'bot', VPS_DIR: '/srv/bot' }

describe('sync worker', () => {
  it('passes config through IPC, forwards logs, and resolves only after exit', async () => {
    const log: string[] = []
    const entry = worker(`process.once('message', m => {
      if (m.config.VPS_HOST !== 'fake' || m.home !== '/tmp/fake-home' || m.chats !== true || process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(8)
      process.send({ type: 'log', line: 'Joining chats...' })
      process.disconnect()
      process.exitCode = 0
    })`)
    expect(
      await runSyncProcess({ node: process.execPath, entry, config, home: '/tmp/fake-home', chats: true, log: (line) => log.push(line) })
    ).toBe(0)
    expect(log).toEqual(['Joining chats...'])
  })
  it('reports nonzero exits and stderr', async () => {
    const log: string[] = []
    const entry = worker("process.once('message', () => { console.error('failed to start'); process.exit(3) })")
    expect(
      await runSyncProcess({ node: process.execPath, entry, config, home: '/tmp/fake-home', chats: false, log: (line) => log.push(line) })
    ).toBe(3)
    expect(log.join('\n')).toContain('failed to start')
  })
  it('rejects spawn errors without hanging', async () => {
    await expect(
      runSyncProcess({ node: '/missing/node', entry: '/missing/runner', config, home: '/tmp/fake-home', chats: false, log: () => {} })
    ).rejects.toThrow()
  })
  // Process groups and /proc are POSIX; Windows has neither.
  it.skipIf(process.platform === 'win32')('runs the worker as its own process group leader', async () => {
    const log: string[] = []
    // ps, not /proc/self/stat: macOS has no /proc.
    const entry = worker(`import { execFileSync } from 'node:child_process'
    process.once('message', () => {
      const pgrp = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim())
      process.send({ type: 'log', line: String(pgrp === process.pid) })
      process.disconnect()
    })`)
    expect(
      await runSyncProcess({ node: process.execPath, entry, config, home: '/tmp/fake-home', chats: true, log: (line) => log.push(line) })
    ).toBe(0)
    expect(log).toEqual(['true'])
  })
})

describe('shipped sync runner', () => {
  it('stops the sync and the commands it started when the app goes away mid-sync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-runner-'))
    roots.push(root)
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/sync/runner.mjs'), join(root, 'runner.mjs'))
    // Stands in for sync.mjs stuck in a long rsync: a running command and a promise that never settles.
    writeFileSync(
      join(root, 'sync.mjs'),
      `import { spawn } from 'node:child_process'
    export function sync({ log }) {
      const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      log(String(command.pid))
      return new Promise(() => {})
    }`
    )
    const child = spawn(process.execPath, [join(root, 'runner.mjs')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true })
    groups.push(child.pid!)
    const command = new Promise<number>((resolve) => child.on('message', (m: { line: string }) => resolve(Number(m.line))))
    child.send({ config, home: root })
    const pid = await command
    expect(alive(pid)).toBe(true)
    child.disconnect() // what the worker sees when Electron is killed
    await until(() => child.exitCode !== null || child.signalCode !== null)
    await until(() => !alive(pid))
  })
})
