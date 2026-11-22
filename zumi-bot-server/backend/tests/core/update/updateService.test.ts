import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  ALREADY_UPDATING,
  LOCAL_UPDATES_ENV,
  UPDATE_CHECK_MS,
  UPDATE_STALE_MS,
  releaseSignedText,
  type UpdateAvailability,
  type UpdateStatus
} from '@zumibot/shared/update'
import {
  UNSIGNED,
  UpdateService,
  detectAvailability,
  systemctlActive,
  systemdRunArgs,
  type UpdateDeps
} from '../../../src/core/update/updateService'

const SITE = 'https://site.test'

// A publisher key of the tests' own, pinned through deps.publicKey; OTHER stands for anyone else's.
const keyPair = () => {
  const k = generateKeyPairSync('ed25519')
  return { priv: k.privateKey, pub: k.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') }
}
const PUBLISHER = keyPair()
const OTHER = keyPair()
const signFor = (version: string, sha256: string, by = PUBLISHER): string =>
  sign(null, Buffer.from(releaseSignedText(version.replace(/^v/, ''), sha256)), by.priv).toString('base64')

let root: string
let dataDir: string
let installDir: string
let tarball: Buffer
let sha: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-update-'))
  dataDir = join(root, 'data')
  installDir = join(root, 'zumibot')
  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(join(installDir, 'bin'), { recursive: true })
  // A real tarball: the service extracts from it with tar.
  const src = join(root, 'src')
  await fs.mkdir(join(src, 'zumibot-server'), { recursive: true })
  await fs.writeFile(join(src, 'zumibot-server', 'install.sh'), '#!/bin/sh\necho new installer\n')
  await fs.writeFile(join(src, 'zumibot-server', 'other.txt'), 'x')
  const out = join(root, 'pack.tar.gz')
  // A relative archive name: Git Bash's GNU tar reads `C:\...` as a remote host.
  execFileSync('tar', ['-czf', 'pack.tar.gz', '-C', src, 'zumibot-server'], { cwd: root })
  tarball = await fs.readFile(out)
  sha = createHash('sha256').update(tarball).digest('hex')
})
afterEach(async () => {
  vi.useRealTimers()
  // A state write still finishing after stop() can refill a folder rm just emptied (ENOTEMPTY, seen on macOS CI): rm retries.
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 })
})

interface Harness {
  svc: UpdateService
  calls: string[]
  detached: { argv: string[]; log: string }[]
  broadcasts: UpdateStatus[]
  busy: { n: number }
  alive: { v: boolean | null }
  units: string[]
}

function make(
  o: {
    version?: string
    current?: string
    availability?: UpdateAvailability
    sha256?: string
    signature?: string | null
    respond?: (url: string) => Response | undefined
    detach?: () => Promise<void>
    /** Local mode: the shell's builds folder, and what a restart request does. */
    local?: { dir: string; restart?: () => void }
    clock?: { t: number }
  } = {}
): Harness {
  const calls: string[] = []
  const detached: Harness['detached'] = []
  const broadcasts: UpdateStatus[] = []
  const busy = { n: 0 }
  const alive = { v: true as boolean | null }
  const units: string[] = []
  const version = o.version ?? '0.2.0'
  const fetchImpl = (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    const custom = o.respond?.(url)
    if (custom) return custom
    if (url === `${SITE}/releases/latest.json`) {
      const sha256 = o.sha256 ?? sha
      // null: an unsigned manifest; undefined: signed by the publisher over what it lists.
      const signature = o.signature === null ? undefined : (o.signature ?? signFor(version, sha256))
      return Response.json({
        version,
        publishedAt: '2026-11-18T10:00:00Z',
        notes: 'Release notes',
        tarball: `/releases/${version}/zumibot-server.tar.gz`,
        sha256,
        signature
      })
    }
    if (url.endsWith('/zumibot-server.tar.gz')) return new Response(new Uint8Array(tarball))
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const deps: UpdateDeps = {
    dataDir,
    site: SITE,
    installDir: o.local ? null : installDir,
    localDir: o.local?.dir ?? null,
    local: o.local !== undefined,
    restart: o.local?.restart,
    availability: o.availability ?? 'ok',
    current: o.current ?? '0.1.0',
    busy: () => busy.n,
    broadcast: (s) => broadcasts.push(s),
    fetchImpl,
    publicKey: PUBLISHER.pub,
    now: () => o.clock?.t ?? 1_000_000,
    isActive: async () => alive.v,
    runDetached: async (argv, log, unit) => {
      detached.push({ argv, log })
      units.push(unit)
      await o.detach?.()
    }
  }
  return { svc: new UpdateService(deps), calls, detached, broadcasts, busy, alive, units }
}

const updatesLeft = () => fs.readdir(join(installDir, 'updates')).catch(() => [] as string[])

describe('check', () => {
  it('never reaches the site when this install cannot update itself', async () => {
    for (const availability of ['local', 'container', 'notInstaller'] as const) {
      const h = make({ availability })
      await h.svc.start()
      expect(await h.svc.check()).toMatchObject({ availability, latest: null, checkedAt: null })
      expect(h.calls).toEqual([])
      h.svc.stop()
    }
  })

  it('needs no token: it asks the site, with no credentials', async () => {
    const h = make()
    await h.svc.start()
    await h.svc.check()
    expect(h.calls).toEqual([`${SITE}/releases/latest.json`])
    expect(JSON.stringify(h.svc.status())).not.toMatch(/token/i)
    h.svc.stop()
  })

  it('finds a newer release from the manifest and tells every tab', async () => {
    const h = make()
    await h.svc.start()
    const s = await h.svc.check()
    expect(s).toMatchObject({
      current: '0.1.0',
      availability: 'ok',
      newer: true,
      checking: false,
      error: null,
      checkedAt: 1_000_000,
      latest: { version: '0.2.0', publishedAt: '2026-11-18T10:00:00Z', notes: 'Release notes' }
    })
    expect(h.broadcasts.length).toBeGreaterThanOrEqual(2)
    expect(h.broadcasts[0].checking).toBe(true)
    expect(h.broadcasts.at(-1)).toEqual(s)
    h.svc.stop()
  })

  it('takes a manifest version with a v prefix as the bare version', async () => {
    const h = make({ version: 'v0.3.0' })
    await h.svc.start()
    expect((await h.svc.check()).latest?.version).toBe('0.3.0')
    h.svc.stop()
  })

  it('is not newer when the release is the same or older', async () => {
    for (const version of ['0.1.0', '0.0.9']) {
      const h = make({ version })
      await h.svc.start()
      expect((await h.svc.check()).newer).toBe(false)
      h.svc.stop()
    }
  })

  it('a 404 is no release yet: nothing latest, no error, but it was checked', async () => {
    const h = make({ respond: () => new Response('nope', { status: 404 }) })
    await h.svc.start()
    expect(await h.svc.check()).toMatchObject({ latest: null, newer: false, error: null, checkedAt: 1_000_000 })
    h.svc.stop()
  })

  it('a 404 after a release was seen forgets it', async () => {
    let gone = false
    const h = make({ respond: () => (gone ? new Response('nope', { status: 404 }) : undefined) })
    await h.svc.start()
    expect((await h.svc.check()).newer).toBe(true)
    gone = true
    expect(await h.svc.check()).toMatchObject({ latest: null, newer: false, error: null })
    h.svc.stop()
  })

  it('keeps a network failure as a fixed message', async () => {
    const h = make({
      respond: () => {
        throw new Error('boom secret-detail')
      }
    })
    await h.svc.start()
    const s = await h.svc.check()
    expect(s).toMatchObject({ error: 'Could not reach the update site', newer: false, checkedAt: 1_000_000 })
    expect(JSON.stringify(s)).not.toContain('secret-detail')
    h.svc.stop()
  })

  it('shows the site status, and a later good answer clears it', async () => {
    let bad = true
    const h = make({ respond: () => (bad ? new Response('{}', { status: 503 }) : undefined) })
    await h.svc.start()
    expect((await h.svc.check()).error).toBe('The update site answered 503')
    bad = false
    expect(await h.svc.check()).toMatchObject({ error: null, newer: true })
    h.svc.stop()
  })

  it('a failed check keeps the release seen before', async () => {
    let bad = false
    const h = make({ respond: () => (bad ? new Response('{}', { status: 500 }) : undefined) })
    await h.svc.start()
    await h.svc.check()
    bad = true
    expect(await h.svc.check()).toMatchObject({ newer: true, error: 'The update site answered 500' })
    h.svc.stop()
  })

  it('an odd version is not offered', async () => {
    const h = make({ version: 'nightly' })
    await h.svc.start()
    expect(await h.svc.check()).toMatchObject({ latest: null, newer: false, error: 'The latest release has no usable version' })
    h.svc.stop()
  })

  it('a manifest it cannot use is a fixed error', async () => {
    for (const body of [Response.json({ version: '0.2.0' }), new Response('<html>', { status: 200 })]) {
      const h = make({ respond: () => body })
      await h.svc.start()
      expect(await h.svc.check()).toMatchObject({ latest: null, newer: false, error: 'The site sent a release it cannot use' })
      h.svc.stop()
    }
  })

  it('a tarball on another origin is refused when it is checked', async () => {
    const h = make({
      respond: (u) =>
        u.endsWith('latest.json')
          ? Response.json({ version: '0.2.0', publishedAt: 't', notes: '', tarball: 'https://evil.example/x.tar.gz', sha256: sha })
          : undefined
    })
    await h.svc.start()
    expect(await h.svc.check()).toMatchObject({
      latest: null,
      newer: false,
      error: 'The update site pointed to a download on another site'
    })
    h.svc.stop()
  })

  it('never offers an unsigned release, or one signed by another key or over other bytes', async () => {
    const cases = [
      { signature: null },
      { signature: signFor('0.2.0', sha, OTHER) },
      { signature: signFor('0.2.0', '0'.repeat(64)) },
      { signature: signFor('0.3.0', sha) }
    ]
    for (const c of cases) {
      const h = make(c)
      await h.svc.start()
      expect(await h.svc.check()).toMatchObject({ latest: null, newer: false, error: UNSIGNED })
      await expect(h.svc.install({ force: false })).rejects.toThrow('There is no newer release to install')
      expect(h.calls).toEqual([`${SITE}/releases/latest.json`])
      h.svc.stop()
    }
  })

  it('a release that loses its signature after the check is refused before the download', async () => {
    const h = make()
    await h.svc.start()
    await h.svc.check()
    // As if the pinned key had changed under a release found earlier: the install checks again.
    ;(h.svc as unknown as { d: UpdateDeps }).d.publicKey = OTHER.pub
    await expect(h.svc.install({ force: false })).rejects.toThrow(UNSIGNED)
    expect(h.calls).toEqual([`${SITE}/releases/latest.json`])
    expect(h.detached).toEqual([])
    expect(await updatesLeft()).toEqual([])
    h.svc.stop()
  })

  it('checks that overlap share one request', async () => {
    const h = make()
    await h.svc.start()
    await Promise.all([h.svc.check(), h.svc.check()])
    expect(h.calls).toHaveLength(1)
    h.svc.stop()
  })

  it('start checks after 10 s, then every hour, and stop ends it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = make()
    await h.svc.start()
    const count = () => h.calls.filter((u) => u.endsWith('/latest.json')).length
    expect(count()).toBe(0)
    expect(UPDATE_CHECK_MS).toBe(60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(count()).toBe(1)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS)
    expect(count()).toBe(2)
    h.svc.stop()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS)
    expect(count()).toBe(2)
  })
})

describe('seen', () => {
  const count = (h: Harness) => h.calls.filter((u) => u.endsWith('/latest.json')).length

  it('a tab that comes back after the answer went stale starts a check, and the toast reaches every tab', async () => {
    const clock = { t: 1_000_000 }
    const h = make({ clock })
    await h.svc.check()
    expect(count(h)).toBe(1)
    clock.t += UPDATE_STALE_MS - 1
    h.svc.seen()
    expect(count(h)).toBe(1)
    clock.t += 1
    const before = h.broadcasts.length
    expect(h.svc.seen().latest?.version).toBe('0.2.0') // the answer it already had, at once
    await vi.waitFor(() => expect(count(h)).toBe(2))
    await vi.waitFor(() => expect(h.broadcasts.length).toBeGreaterThan(before + 1))
    expect(h.broadcasts.at(-1)?.newer).toBe(true)
  })

  it('leaves the first check to the boot timer, and never checks where updates are not available', async () => {
    const h = make()
    h.svc.seen()
    const off = make({ availability: 'container', clock: { t: 10 * UPDATE_STALE_MS } })
    await off.svc.check()
    off.svc.seen()
    expect(count(h) + count(off)).toBe(0)
  })

  it('does not start a second check while one runs', async () => {
    const clock = { t: 1_000_000 }
    const h = make({ clock })
    await h.svc.check()
    clock.t += UPDATE_STALE_MS
    h.svc.seen()
    h.svc.seen()
    await vi.waitFor(() => expect(count(h)).toBe(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(count(h)).toBe(2)
  })
})

describe('boot', () => {
  const state = (s: unknown) => fs.writeFile(join(dataDir, 'update.json'), JSON.stringify(s))

  it('a pending update that did not arrive is a failure with the log tail', async () => {
    await state({ pending: { from: '0.1.0', to: '0.1.1', at: 5 } })
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    await fs.writeFile(join(dataDir, 'update-log.txt'), lines.join('\n') + '\n')
    const h = make({ current: '0.1.0' })
    await h.svc.start()
    const r = h.svc.status().lastResult
    expect(r).toMatchObject({ kind: 'failed', from: '0.1.0', to: '0.1.1', at: 1_000_000 })
    expect(r?.logTail?.split('\n')).toEqual(lines.slice(10))
    expect(JSON.parse(await fs.readFile(join(dataDir, 'update.json'), 'utf8')).pending).toBeUndefined()
    // Remembered over another restart.
    const again = make({ current: '0.1.0' })
    await again.svc.start()
    expect(again.svc.status().lastResult?.kind).toBe('failed')
    h.svc.stop()
    again.svc.stop()
  })

  it('a pending update that arrived is a success', async () => {
    await state({ pending: { from: '0.1.0', to: '0.1.1', at: 5 } })
    const h = make({ current: '0.1.1' })
    await h.svc.start()
    expect(h.svc.status().lastResult).toEqual({ kind: 'updated', from: '0.1.0', to: '0.1.1', at: 1_000_000 })
    h.svc.stop()
  })

  it('a rollback note becomes rolledBack with the file time, and is removed', async () => {
    const note = join(dataDir, 'update-rolled-back')
    await fs.writeFile(note, JSON.stringify({ from: '0.1.1', to: '0.1.0' }))
    const at = new Date('2026-11-18T12:00:00Z')
    await fs.utimes(note, at, at)
    const h = make({ current: '0.1.0' })
    await h.svc.start()
    expect(h.svc.status().lastResult).toEqual({ kind: 'rolledBack', from: '0.1.1', to: '0.1.0', at: at.getTime() })
    await expect(fs.stat(note)).rejects.toThrow()
    h.svc.stop()
  })

  it('a damaged rollback note still counts, with unknown versions', async () => {
    await fs.writeFile(join(dataDir, 'update-rolled-back'), 'garbage')
    const h = make()
    await h.svc.start()
    expect(h.svc.status().lastResult).toMatchObject({ kind: 'rolledBack', from: 'unknown', to: 'unknown' })
    h.svc.stop()
  })

  it('a damaged state file is ignored', async () => {
    await fs.writeFile(join(dataDir, 'update.json'), '{nope')
    const h = make()
    await h.svc.start()
    expect(h.svc.status().lastResult).toBeNull()
    h.svc.stop()
  })

  it('removes downloads a killed run left behind', async () => {
    await fs.mkdir(join(installDir, 'updates', 'v0.0.9'), { recursive: true })
    await fs.writeFile(join(installDir, 'updates', 'v0.0.9', 'zumibot-server.tar.gz'), 'x')
    const h = make()
    await h.svc.start()
    expect(await updatesLeft()).toEqual([])
    h.svc.stop()
  })

  it('removes the sealed token an earlier version left, and starts fine without one', async () => {
    const file = join(dataDir, 'update-token.json')
    await fs.writeFile(file, JSON.stringify({ updatedAt: 1, sealed: 'x' }))
    const h = make()
    await h.svc.start()
    await expect(fs.stat(file)).rejects.toThrow()
    h.svc.stop()
    const again = make()
    await again.svc.start()
    again.svc.stop()
  })

  it('canRollBack needs both app.prev and data.prev, and an update that swapped', async () => {
    await state({ lastResult: { kind: 'updated', from: '0.0.9', to: '0.1.0', at: 5 } })
    const h = make()
    await h.svc.start()
    expect(h.svc.status().canRollBack).toBe(false)
    await fs.mkdir(join(installDir, 'app.prev'))
    expect(h.svc.status().canRollBack).toBe(false)
    await fs.mkdir(join(installDir, 'data.prev'))
    expect(h.svc.status().canRollBack).toBe(true)
    h.svc.stop()
  })
})

// The VPS install runs the release's sh installer under systemd-run: a Linux host's path, never the Windows one.
describe.skipIf(process.platform === 'win32')('install', () => {
  it('downloads, verifies against the manifest, and hands the new installer to the detached runner', async () => {
    const h = make()
    await h.svc.start()
    await h.svc.check()
    expect(await h.svc.install({ force: false })).toEqual({ started: true })
    expect(h.detached).toHaveLength(1)
    const { argv, log } = h.detached[0]
    const dir = join(installDir, 'updates', 'v0.2.0')
    expect(argv).toEqual([
      'sh',
      join(dir, 'zumibot-server', 'install.sh'),
      '--dir',
      installDir,
      '--tarball',
      join(dir, 'zumibot-server.tar.gz'),
      '--snapshot-data'
    ])
    expect(log).toBe(join(dataDir, 'update-log.txt'))
    expect(h.calls).toEqual([`${SITE}/releases/latest.json`, `${SITE}/releases/0.2.0/zumibot-server.tar.gz`])
    // Only the installer is taken out of the tarball.
    expect(await fs.readdir(join(dir, 'zumibot-server'))).toEqual(['install.sh'])
    expect(JSON.parse(await fs.readFile(join(dataDir, 'update.json'), 'utf8')).pending).toEqual({
      from: '0.1.0',
      to: '0.2.0',
      at: 1_000_000
    })
    expect(h.svc.status().installing).toBe(true)
    h.svc.stop()
  })

  it('adds --force when told to, even with replies running', async () => {
    const h = make()
    await h.svc.start()
    await h.svc.check()
    h.busy.n = 3
    await h.svc.install({ force: true })
    expect(h.detached[0].argv.at(-1)).toBe('--force')
    expect(h.detached[0].argv).toContain('--snapshot-data')
    h.svc.stop()
  })

  it('reports the running replies and does not download without force', async () => {
    const h = make()
    await h.svc.start()
    await h.svc.check()
    const before = h.calls.length
    h.busy.n = 2
    expect(await h.svc.install({ force: false })).toEqual({ busy: 2 })
    expect(h.calls.length).toBe(before)
    expect(h.detached).toEqual([])
    expect(h.svc.status().installing).toBe(false)
    h.svc.stop()
  })

  it('a checksum mismatch stops before the runner and leaves no download', async () => {
    const h = make({ sha256: '0'.repeat(64) })
    await h.svc.start()
    await h.svc.check()
    await expect(h.svc.install({ force: false })).rejects.toThrow('The download did not match its checksum')
    expect(h.detached).toEqual([])
    expect(await updatesLeft()).toEqual([])
    expect(h.svc.status()).toMatchObject({ installing: false, error: 'The download did not match its checksum' })
    await expect(fs.stat(join(dataDir, 'update.json'))).rejects.toThrow()
    h.svc.stop()
  })

  it('a download failure keeps the message, clears installing and the folder', async () => {
    const h = make({ respond: (u) => (u.endsWith('.tar.gz') ? new Response('{}', { status: 500 }) : undefined) })
    await h.svc.start()
    await h.svc.check()
    await expect(h.svc.install({ force: false })).rejects.toThrow('The update site answered 500')
    expect(h.svc.status()).toMatchObject({ installing: false, error: 'The update site answered 500' })
    expect(await updatesLeft()).toEqual([])
    h.svc.stop()
  })

  it('a runner that cannot start undoes the pending note and the download', async () => {
    const h = make({ detach: () => Promise.reject(new Error('systemd-run missing')) })
    await h.svc.start()
    await h.svc.check()
    await expect(h.svc.install({ force: false })).rejects.toThrow()
    expect(h.svc.status()).toMatchObject({ installing: false, error: 'Could not start the updater' })
    expect(await updatesLeft()).toEqual([])
    expect(JSON.parse(await fs.readFile(join(dataDir, 'update.json'), 'utf8')).pending).toBeUndefined()
    h.svc.stop()
  })

  it('two installs at once: one starts, the other is refused, the runner runs once', async () => {
    const h = make()
    await h.svc.start()
    await h.svc.check()
    const results = await Promise.allSettled([h.svc.install({ force: false }), h.svc.install({ force: false })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason.message).toBe(ALREADY_UPDATING)
    expect(h.detached).toHaveLength(1)
    h.svc.stop()
  })

  it.each<UpdateAvailability>(['local', 'container', 'notInstaller'])('refuses when availability is %s', async (availability) => {
    const h = make({ availability })
    await h.svc.start()
    await h.svc.check()
    await expect(h.svc.install({ force: false })).rejects.toThrow(/cannot update itself/)
    h.svc.stop()
  })

  it('refuses without a check, and when not newer', async () => {
    const b = make()
    await b.svc.start()
    await expect(b.svc.install({ force: false })).rejects.toThrow(/newer/i)
    expect(b.calls).toEqual([])
    b.svc.stop()
    const c = make({ version: '0.1.0' })
    await c.svc.start()
    await c.svc.check()
    await expect(c.svc.install({ force: false })).rejects.toThrow(/newer/i)
    c.svc.stop()
  })

  it('an updater unit that died before the restart fails the update at once, with the log tail', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = make()
    await h.svc.start()
    await h.svc.check()
    await fs.writeFile(join(dataDir, 'update-log.txt'), 'installer died\n')
    await h.svc.install({ force: false })
    expect(h.units).toEqual(['zumibot-updater-1000000'])
    expect(h.svc.status().installing).toBe(true)
    h.alive.v = false
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() =>
      expect(h.svc.status()).toMatchObject({
        installing: false,
        lastResult: { kind: 'failed', from: '0.1.0', to: '0.2.0', logTail: 'installer died' }
      })
    )
    // Cleaned up like any failed install: no download, no pending note to fail a second time at boot.
    expect(await updatesLeft()).toEqual([])
    expect(JSON.parse(await fs.readFile(join(dataDir, 'update.json'), 'utf8')).pending).toBeUndefined()
    expect(h.broadcasts.at(-1)?.installing).toBe(false)
    h.svc.stop()
  })

  it('a slow updater that still runs is never given up on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = make()
    await h.svc.start()
    await h.svc.check()
    await h.svc.install({ force: false })
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(h.svc.status()).toMatchObject({ installing: true, lastResult: null })
    h.svc.stop()
  })

  it('an updater nobody can ask about is waited for, then released without being called failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = make()
    await h.svc.start()
    await h.svc.check()
    await h.svc.install({ force: false })
    h.alive.v = null
    await vi.advanceTimersByTimeAsync(23 * 5_000)
    expect(h.svc.status()).toMatchObject({ installing: true, error: null })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.svc.status()).toMatchObject({ installing: false, error: 'Could not tell whether the updater is running', lastResult: null })
    // Left for the next boot to settle.
    expect(JSON.parse(await fs.readFile(join(dataDir, 'update.json'), 'utf8')).pending).toMatchObject({ to: '0.2.0' })
    expect(await updatesLeft()).toEqual(['v0.2.0'])
    h.svc.stop()
  })

  it('one answer between the silences starts the count again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = make()
    await h.svc.start()
    await h.svc.check()
    await h.svc.install({ force: false })
    h.alive.v = null
    await vi.advanceTimersByTimeAsync(20 * 5_000)
    h.alive.v = true
    await vi.advanceTimersByTimeAsync(5_000)
    h.alive.v = null
    await vi.advanceTimersByTimeAsync(20 * 5_000)
    expect(h.svc.status().installing).toBe(true)
    h.svc.stop()
  })

  it('replies that started during the download stop the update, and clean up', async () => {
    let h: Harness
    h = make({
      respond: (u) => {
        if (u.endsWith('.tar.gz')) h.busy.n = 2
        return undefined
      }
    })
    await h.svc.start()
    await h.svc.check()
    expect(await h.svc.install({ force: false })).toEqual({ busy: 2 })
    expect(h.detached).toEqual([])
    expect(await updatesLeft()).toEqual([])
    expect(h.svc.status()).toMatchObject({ installing: false, error: null })
    await expect(fs.stat(join(dataDir, 'update.json'))).rejects.toThrow()
    // Forced, the same download goes on.
    expect(await h.svc.install({ force: true })).toEqual({ started: true })
    h.svc.stop()
  })
})

describe('rollBack', () => {
  // The last install swapped: that is what makes the previous pair this roll back's.
  beforeEach(() =>
    fs.writeFile(join(dataDir, 'update.json'), JSON.stringify({ lastResult: { kind: 'updated', from: '0.0.9', to: '0.1.0', at: 5 } }))
  )
  const prev = async () => {
    await fs.mkdir(join(installDir, 'app.prev'))
    await fs.mkdir(join(installDir, 'data.prev'))
  }

  it('runs the rollback script detached', async () => {
    const h = make()
    await h.svc.start()
    await prev()
    expect(await h.svc.rollBack({ force: false })).toEqual({ started: true })
    expect(h.detached).toEqual([{ argv: [join(installDir, 'bin', 'zumibot-rollback')], log: join(dataDir, 'update-log.txt') }])
    expect(h.svc.status().installing).toBe(true)
    h.svc.stop()
  })

  it('refuses while replies run unless forced', async () => {
    const h = make()
    await h.svc.start()
    await prev()
    h.busy.n = 1
    expect(await h.svc.rollBack({ force: false })).toEqual({ busy: 1 })
    expect(h.detached).toEqual([])
    expect(await h.svc.rollBack({ force: true })).toEqual({ started: true })
    h.svc.stop()
  })

  it('refuses with nothing to go back to, or while another run is going', async () => {
    const h = make()
    await h.svc.start()
    await expect(h.svc.rollBack({ force: false })).rejects.toThrow(/nothing to roll back/i)
    await prev()
    await h.svc.rollBack({ force: false })
    await expect(h.svc.rollBack({ force: false })).rejects.toThrow(ALREADY_UPDATING)
    h.svc.stop()
  })

  it('refuses after a failed update even when app.prev and data.prev exist', async () => {
    await fs.writeFile(join(dataDir, 'update.json'), JSON.stringify({ lastResult: { kind: 'failed', from: '0.1.0', to: '0.2.0', at: 5 } }))
    const h = make()
    await h.svc.start()
    await prev()
    await expect(h.svc.rollBack({ force: true })).rejects.toThrow(/nothing to roll back/i)
    expect(h.detached).toEqual([])
    h.svc.stop()
  })

  it('a rollback unit that died fails it with the version it was going back to', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = make()
    await h.svc.start()
    await prev()
    await fs.writeFile(join(installDir, 'data.prev', '.zumibot-from'), '0.0.9\n')
    await h.svc.rollBack({ force: false })
    h.alive.v = false
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() =>
      expect(h.svc.status()).toMatchObject({ installing: false, lastResult: { kind: 'failed', from: '0.1.0', to: '0.0.9' } })
    )
    h.svc.stop()
  })

  it('names no version when data.prev does not say', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = make()
    await h.svc.start()
    await prev()
    await h.svc.rollBack({ force: false })
    h.alive.v = false
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.waitFor(() => expect(h.svc.status().lastResult).toMatchObject({ kind: 'failed', to: 'the previous version' }))
    h.svc.stop()
  })

  it('refuses when the install cannot update itself', async () => {
    const h = make({ availability: 'container' })
    await h.svc.start()
    await expect(h.svc.rollBack({ force: false })).rejects.toThrow(/cannot update itself/)
    h.svc.stop()
  })
})

describe('local install', () => {
  let builds: string

  /** A release package the way package.sh lays it out, with the version it names inside. */
  const pack = async (named: string, withServer = true): Promise<void> => {
    const src = join(root, `local-src-${named}-${withServer}`)
    await fs.mkdir(join(src, 'zumibot-server', 'app'), { recursive: true })
    await fs.writeFile(join(src, 'zumibot-server', 'VERSION'), `${named}\n`)
    if (withServer) await fs.writeFile(join(src, 'zumibot-server', 'app', 'server.mjs'), 'console.log("LISTENING 1")\n')
    const name = `local-${named}-${withServer}.tar.gz`
    const out = join(root, name)
    execFileSync('tar', ['-czf', name, '-C', src, 'zumibot-server'], { cwd: root })
    tarball = await fs.readFile(out)
    sha = createHash('sha256').update(tarball).digest('hex')
  }

  beforeEach(async () => {
    builds = join(root, 'server-updates')
    await fs.mkdir(builds, { recursive: true })
  })

  it('unpacks the signed build, names it for the shell, notes the pending update, then asks for a restart', async () => {
    await pack('0.2.0')
    const restart = vi.fn()
    const h = make({ local: { dir: builds, restart } })
    await h.svc.start()
    await h.svc.check()
    expect(h.svc.status()).toMatchObject({ availability: 'ok', local: true, newer: true })
    expect(await h.svc.install({ force: false })).toEqual({ started: true })
    expect(await fs.readFile(join(builds, 'v0.2.0', 'zumibot-server', 'app', 'server.mjs'), 'utf8')).toContain('LISTENING')
    expect(JSON.parse(await fs.readFile(join(builds, 'current.json'), 'utf8'))).toEqual({ version: '0.2.0' })
    expect(JSON.parse(await fs.readFile(join(dataDir, 'update.json'), 'utf8')).pending).toEqual({
      from: '0.1.0',
      to: '0.2.0',
      at: 1_000_000
    })
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1))
    // No systemd, no installer script, no download or staging left beside the build.
    expect(h.detached).toEqual([])
    expect((await fs.readdir(builds)).sort()).toEqual(['current.json', 'v0.2.0'])
    expect(h.svc.status().installing).toBe(true) // until the process ends and the shell starts the new build
    h.svc.stop()
  })

  it('never runs a package that names another version or has no server, and names nothing for the shell', async () => {
    for (const [named, withServer] of [
      ['0.1.9', true],
      ['0.2.0', false]
    ] as const) {
      await pack(named, withServer)
      const restart = vi.fn()
      const h = make({ local: { dir: builds, restart } })
      await h.svc.check()
      await expect(h.svc.install({ force: false })).rejects.toThrow('The update package is incomplete')
      expect(restart).not.toHaveBeenCalled()
      expect(await fs.readdir(builds)).toEqual([])
      expect(h.svc.status()).toMatchObject({ installing: false, error: 'The update package is incomplete' })
      expect(JSON.parse(await fs.readFile(join(dataDir, 'update.json'), 'utf8').catch(() => '{}')).pending).toBeUndefined()
    }
  })

  it('a checksum mismatch stops before anything is unpacked', async () => {
    await pack('0.2.0')
    const h = make({ local: { dir: builds, restart: vi.fn() }, sha256: 'f'.repeat(64) })
    await h.svc.check()
    await expect(h.svc.install({ force: false })).rejects.toThrow('The download did not match its checksum')
    expect(await fs.readdir(builds)).toEqual([])
  })

  it('replies that started during the download stop it, and clean up', async () => {
    await pack('0.2.0')
    const restart = vi.fn()
    const h = make({ local: { dir: builds, restart } })
    await h.svc.check()
    const real = h.svc.status
    let looks = 0
    // The first look (before the download) sees none, the second (after it) sees two.
    ;(h.svc as unknown as { d: UpdateDeps }).d.busy = () => (looks++ === 0 ? 0 : 2)
    expect(await h.svc.install({ force: false })).toEqual({ busy: 2 })
    expect(real.call(h.svc).installing).toBe(false)
    expect(restart).not.toHaveBeenCalled()
    expect(await fs.readdir(builds)).toEqual([])
  })

  it('start drops a killed install’s download and half-unpacked build, and keeps the builds', async () => {
    await fs.mkdir(join(builds, 'downloads', 'v0.2.0'), { recursive: true })
    await fs.mkdir(join(builds, 'v0.2.0.staging'), { recursive: true })
    await fs.mkdir(join(builds, 'v0.1.5'), { recursive: true })
    const h = make({ local: { dir: builds } })
    await h.svc.start()
    expect(await fs.readdir(builds)).toEqual(['v0.1.5'])
    h.svc.stop()
  })

  it('clears the update log, so the shell’s note on a build that would not start is the only text in it', async () => {
    await pack('0.2.0')
    await fs.writeFile(join(dataDir, 'update-log.txt'), 'an older run\n')
    const h = make({ local: { dir: builds, restart: vi.fn() } })
    await h.svc.check()
    await h.svc.install({ force: false })
    expect(await fs.readFile(join(dataDir, 'update-log.txt'), 'utf8')).toBe('')
  })

  it('never offers a roll back', async () => {
    const h = make({ local: { dir: builds } })
    await expect(h.svc.rollBack({ force: false })).rejects.toThrow(/cannot update itself/)
    expect(h.svc.status().canRollBack).toBe(false)
  })
})

describe('detectAvailability', () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p)
  const dir = '/home/u/zumibot'
  const upd = join(dir, 'bin', 'zumibot-update')

  const builds = '/home/u/.config/ZumiBot/server-updates'

  it.each([
    ['local mode, a shell that keeps no builds', 'local', {}, has('/.dockerenv', upd), 'local', null, null, true],
    ['local mode, a shell that keeps builds', 'local', { [LOCAL_UPDATES_ENV]: builds }, has(), 'ok', null, builds, true],
    ['local mode, a relative builds folder', 'local', { [LOCAL_UPDATES_ENV]: 'server-updates' }, has(), 'local', null, null, true],
    ['the builds folder means nothing to a vps', 'vps', { [LOCAL_UPDATES_ENV]: builds }, has(), 'notInstaller', null, null, false],
    ['dockerenv', 'vps', { ZUMIBOT_INSTALL_DIR: dir }, has('/.dockerenv', upd), 'container', null, null, false],
    ['container env', 'vps', { ZUMIBOT_CONTAINER: '1', ZUMIBOT_INSTALL_DIR: dir }, has(upd), 'container', null, null, false],
    ['no install dir', 'vps', {}, has(), 'notInstaller', null, null, false],
    ['no update script', 'vps', { ZUMIBOT_INSTALL_DIR: dir }, has(), 'notInstaller', null, null, false],
    ['installer layout', 'vps', { ZUMIBOT_INSTALL_DIR: dir }, has(upd), 'ok', dir, null, false]
  ] as const)('%s', (_n, mode, env, exists, availability, installDir, localDir, local) => {
    expect(detectAvailability(mode, env as NodeJS.ProcessEnv, exists)).toEqual({ availability, installDir, localDir, local })
  })
})

describe('systemdRunArgs', () => {
  it('runs in its own user unit, one output file for both streams, the data dir set, the command last', () => {
    const args = systemdRunArgs(['sh', '/x/install.sh', '--dir', '/d'], '/data/update-log.txt', 'zumibot-updater-7', '/data')
    expect(args).toEqual([
      '--user',
      '--collect',
      '--unit=zumibot-updater-7',
      '--setenv=ZUMIBOT_DATA_DIR=/data',
      '-p',
      'StandardOutput=truncate:/data/update-log.txt',
      '-p',
      'StandardError=inherit',
      'sh',
      '/x/install.sh',
      '--dir',
      '/d'
    ])
    // Two descriptors on one file would each keep their own offset and overwrite each other.
    expect(args.join(' ')).not.toContain('append:')
  })
})

describe('robustness', () => {
  const state = (s: unknown) => fs.writeFile(join(dataDir, 'update.json'), JSON.stringify(s))

  it('drops the parts of the state file that have the wrong shape', async () => {
    await state({ pending: 'x', lastResult: { kind: 'exploded', from: 1 } })
    const h = make()
    await h.svc.start()
    expect(h.svc.status().lastResult).toBeNull()
    h.svc.stop()
    await state({ pending: { from: '0.1.0', to: 5, at: 1 }, lastResult: null })
    const g = make()
    await g.svc.start()
    expect(g.svc.status().lastResult).toBeNull()
    g.svc.stop()
  })

  it('keeps a valid last result and a good part beside a bad one', async () => {
    await state({ pending: 7, lastResult: { kind: 'updated', from: '0.0.1', to: '0.1.0', at: 9, extra: 1 } })
    const h = make()
    await h.svc.start()
    expect(h.svc.status().lastResult).toEqual({ kind: 'updated', from: '0.0.1', to: '0.1.0', at: 9 })
    h.svc.stop()
  })

  it('a throwing broadcast does not break a check', async () => {
    const h = make()
    const svc = new UpdateService({
      ...(h.svc as unknown as { d: UpdateDeps }).d,
      broadcast: () => {
        throw new Error('socket gone')
      }
    })
    await svc.start()
    expect(await svc.check()).toMatchObject({ newer: true, checking: false })
    svc.stop()
  })
})

// systemd is Linux-only, and the fake is an sh script on a ':' PATH.
describe.skipIf(process.platform === 'win32')('systemctlActive (the real probe, with a fake systemctl first on PATH)', () => {
  const oldPath = process.env.PATH
  afterEach(() => {
    process.env.PATH = oldPath
  })

  async function fake(body: string): Promise<void> {
    const bin = join(root, 'bin')
    await fs.mkdir(bin, { recursive: true })
    await fs.writeFile(join(bin, 'systemctl'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    process.env.PATH = `${bin}:${oldPath}`
  }

  it.each([
    ['no answer and a failure (no user bus)', 'exit 1', null],
    ['an error on stderr only', 'echo "Failed to connect to bus" >&2; exit 1', null],
    ['inactive (exit 3)', 'echo inactive; exit 3', false],
    ['failed (exit 3)', 'echo failed; exit 3', false],
    ['dead (exit 4)', 'echo dead; exit 4', false],
    ['active', 'echo active; exit 0', true],
    ['activating', 'echo activating; exit 3', true],
    ['something unknown', 'echo weird; exit 0', null]
  ])('%s', async (_n, body, want) => {
    await fake(body)
    expect(await systemctlActive('zumibot-updater-1')).toBe(want)
  })

  it('no systemctl at all is no answer, not a dead unit', async () => {
    process.env.PATH = join(root, 'nothing-here')
    expect(await systemctlActive('zumibot-updater-1')).toBeNull()
  })
})
