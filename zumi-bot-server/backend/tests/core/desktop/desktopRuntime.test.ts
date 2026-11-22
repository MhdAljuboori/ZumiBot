import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDesktopRuntime } from '../../../src/core/desktop/desktopRuntime'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'cb-desk-rt-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const program = async (dir: string, name: string, mode = 0o755) => {
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, '#!/bin/sh\nexit 0\n', { mode })
  return path
}
const SESSION = ['xfsettingsd', 'xfwm4', 'xfce4-panel', 'xfdesktop']
const ALL_MISSING = ['TigerVNC (Xvnc)', 'D-Bus (dbus-daemon)', 'desktop session (xfwm4)', 'cua-driver']

it('lists all four programs as missing with an empty PATH', () => {
  const r = resolveDesktopRuntime({ PATH: '', HOME: join(tmp, 'nohome') })
  expect(r).toMatchObject({ xvnc: null, dbusDaemon: null, session: null, cuaDriver: null })
  expect(r.missing).toEqual(ALL_MISSING)
})

it('finds the programs on PATH and builds the light XFCE session from absolute paths', async () => {
  const bin = join(tmp, 'bin')
  for (const name of ['Xvnc', 'dbus-daemon', 'cua-driver', ...SESSION]) await program(bin, name)
  const r = resolveDesktopRuntime({ PATH: `relative/dir::${join(tmp, 'empty')}:${bin}`, HOME: join(tmp, 'nohome') })
  expect(r.missing).toEqual([])
  expect(r.xvnc).toBe(join(bin, 'Xvnc'))
  expect(r.dbusDaemon).toBe(join(bin, 'dbus-daemon'))
  expect(r.cuaDriver).toBe(join(bin, 'cua-driver'))
  // Not startxfce4: xfce4-session runs the host's autostart entries.
  expect(r.session).toEqual(['/bin/sh', '-c', '"$0" & "$1" & "$2" & exec "$3"', ...SESSION.map((n) => join(bin, n))])
})

it('skips files that are not executable and names the session after xfwm4 when a part is missing', async () => {
  const bin = join(tmp, 'bin')
  await program(bin, 'Xvnc', 0o644)
  for (const name of SESSION.filter((n) => n !== 'xfdesktop')) await program(bin, name)
  const r = resolveDesktopRuntime({ PATH: bin, HOME: join(tmp, 'nohome') })
  expect(r.xvnc).toBeNull()
  expect(r.session).toBeNull()
  expect(r.missing).toEqual(ALL_MISSING)
})

it('falls back to the per-user cua-driver install', async () => {
  const home = join(tmp, 'home')
  const cua = await program(join(home, '.cua-driver', 'packages', 'current'), 'cua-driver')
  const r = resolveDesktopRuntime({ PATH: '', HOME: home })
  expect(r.cuaDriver).toBe(cua)
  expect(r.missing).not.toContain('cua-driver')
})

it('takes absolute overrides, including a session command line, and reports none missing', async () => {
  const bin = join(tmp, 'fakes')
  const env = {
    PATH: '',
    HOME: join(tmp, 'nohome'),
    ZUMIBOT_DESKTOP_XVNC: await program(bin, 'fake-xvnc'),
    ZUMIBOT_DESKTOP_DBUS_DAEMON: await program(bin, 'fake-dbus'),
    ZUMIBOT_DESKTOP_SESSION: `${await program(bin, 'fake-session')} --replace  now`,
    ZUMIBOT_CUA_DRIVER: await program(bin, 'fake-cua')
  }
  const r = resolveDesktopRuntime(env)
  expect(r.missing).toEqual([])
  expect(r).toMatchObject({
    xvnc: env.ZUMIBOT_DESKTOP_XVNC,
    dbusDaemon: env.ZUMIBOT_DESKTOP_DBUS_DAEMON,
    cuaDriver: env.ZUMIBOT_CUA_DRIVER,
    session: [join(bin, 'fake-session'), '--replace', 'now']
  })
})

it('treats a relative or missing override as missing instead of searching PATH', async () => {
  const bin = join(tmp, 'bin')
  for (const name of ['Xvnc', 'dbus-daemon', 'cua-driver', ...SESSION]) await program(bin, name)
  const r = resolveDesktopRuntime({
    PATH: bin,
    HOME: join(tmp, 'nohome'),
    ZUMIBOT_DESKTOP_XVNC: 'Xvnc',
    ZUMIBOT_DESKTOP_SESSION: 'startxfce4',
    ZUMIBOT_CUA_DRIVER: join(tmp, 'gone'),
    ZUMIBOT_DESKTOP_DBUS_DAEMON: ''
  })
  expect(r.missing).toEqual(['TigerVNC (Xvnc)', 'desktop session (xfwm4)', 'cua-driver'])
  expect(r.dbusDaemon).toBe(join(bin, 'dbus-daemon'))
})

it('resolves the bridge entry beside the built server and the node to run it with', () => {
  const r = resolveDesktopRuntime({ PATH: '' })
  expect(r.bridgeEntry).toMatch(/[/\\]dist[/\\]desktopBridge\.mjs$/)
  expect(r.node).toBe(process.execPath)
  expect(r.electronNode).toBe(Boolean(process.versions.electron))
  const packaged = resolveDesktopRuntime({ PATH: '' }, 'file:///opt/zumibot/server/server.mjs')
  expect(packaged.bridgeEntry).toBe('/opt/zumibot/server/desktopBridge.mjs')
})
