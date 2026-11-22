// A throwaway X session for the desktop e2e: its own Xvnc display, session bus and window manager (xfwm4), so the
// shell under test never touches the developer's real desktop. Once an e2e window crashed the real GNOME Shell
// (Mutter aborts on some window-state/monitor combinations), and the shell's tray registers on the session bus.
// The Electron under test gets only the env this returns; nothing here ever reads or sets the real DISPLAY's session.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(50)
  }
  throw new Error(`throwaway display: timed out waiting for ${what}`)
}

/** The first display number from 90 up with no X socket or lock file: never one that is in use. */
export function freeDisplay(exists = existsSync) {
  for (let n = 90; n < 200; n++) {
    if (!exists(`/tmp/.X11-unix/X${n}`) && !exists(`/tmp/.X${n}-lock`)) return n
  }
  throw new Error('throwaway display: no free X display number between 90 and 199')
}

/** Xvnc, dbus-daemon, xfwm4 and xprop must be on PATH; the message names the opt-in for a machine that has no such tools. */
function missing(bin) {
  return new Error(
    `throwaway display: "${bin}" not found on PATH. Install it (Xvnc: tigervnc-standalone-server, xfwm4: xfwm4, dbus-daemon: dbus-daemon, xprop: x11-utils), ` +
      'or run on the real display with ZUMIBOT_E2E_REAL_DISPLAY=1 (it can crash a GNOME Shell session).'
  )
}

/**
 * @param {string} root a temp directory the caller owns (removed by the caller); the session keeps its files under it
 * @param {{ avoid?: string }} o `avoid`: the display of the caller's own environment, which must never be chosen
 * @returns {Promise<{ display: string, env: Record<string, string>, stop(): Promise<void> }>}
 */
export async function startThrowawayDisplay(root, o = {}) {
  const run = join(root, 'xrun')
  const logs = join(root, 'xlogs')
  await mkdir(run, { recursive: true, mode: 0o700 })
  await mkdir(logs, { recursive: true })
  const children = []
  const launch = async (name, cmd, args, env) => {
    const log = await open(join(logs, `${name}.log`), 'w')
    const child = spawn(cmd, args, { env, stdio: ['ignore', log.fd, log.fd] })
    await log.close()
    child.once('error', (e) => {
      child.spawnError = e // ENOENT: the tool is not installed
    })
    children.push(child)
    return child
  }
  const stop = async () => {
    for (const c of children.reverse()) {
      if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM')
    }
    await sleep(300)
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
    }
  }
  try {
    const base = {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'xhome'),
      XDG_RUNTIME_DIR: run,
      XDG_CONFIG_HOME: join(root, 'xconfig'),
      XDG_CACHE_HOME: join(root, 'xcache'),
      GSETTINGS_BACKEND: 'keyfile'
    }
    let n
    let xvnc = null
    for (let attempt = 0; attempt < 5 && !xvnc; attempt++) {
      n = freeDisplay()
      if (`:${n}` === o.avoid) throw new Error('throwaway display: refusing the display of the calling environment')
      const c = await launch(
        'xvnc',
        'Xvnc',
        [
          `:${n}`,
          '-geometry',
          '1920x1080',
          '-depth',
          '24',
          '-rfbport',
          '-1',
          '-nolisten',
          'tcp',
          '-SecurityTypes',
          'None',
          '-rfbunixpath',
          join(run, 'vnc.sock'),
          '-AlwaysShared'
        ],
        base
      )
      try {
        await waitFor(() => existsSync(`/tmp/.X11-unix/X${n}`) || c.exitCode !== null || c.spawnError, 10_000, 'Xvnc')
      } catch {}
      if (c.spawnError) throw missing('Xvnc')
      // Another run may have taken this number between the check and the bind: its socket appears while ours dies. Give ours a
      // moment to fail, then accept the display only if this very Xvnc is still alive.
      if (existsSync(`/tmp/.X11-unix/X${n}`)) await sleep(200)
      if (c.exitCode === null && c.signalCode === null && existsSync(`/tmp/.X11-unix/X${n}`)) xvnc = c
    }
    if (!xvnc) throw missing('Xvnc')
    const display = `:${n}`
    const bus = `unix:path=${join(run, 'bus')}`
    const dbus = await launch('dbus', 'dbus-daemon', ['--session', '--nofork', `--address=${bus}`], base)
    await waitFor(() => existsSync(join(run, 'bus')) || dbus.exitCode !== null || dbus.spawnError, 5_000, 'dbus-daemon')
    if (dbus.exitCode !== null || dbus.spawnError) throw missing('dbus-daemon')
    const env = { ...base, DISPLAY: display, DBUS_SESSION_BUS_ADDRESS: bus, XDG_SESSION_TYPE: 'x11' }
    const wm = await launch('xfwm4', 'xfwm4', ['--display', display, '--compositor=off', '--sm-client-disable'], env)
    // The window manager is up when the root window names a supporting window (EWMH); the island's sticky state needs it.
    await waitFor(
      async () => {
        if (wm.exitCode !== null || wm.spawnError) throw missing('xfwm4')
        return new Promise((resolve, reject) => {
          const x = spawn('xprop', ['-display', display, '-root', '_NET_SUPPORTING_WM_CHECK'], { stdio: ['ignore', 'pipe', 'ignore'] })
          let out = ''
          x.stdout.on('data', (b) => (out += b))
          x.once('error', (e) => (e.code === 'ENOENT' ? reject(missing('xprop')) : resolve(false)))
          x.once('exit', () => resolve(/window id # 0x/.test(out)))
        })
      },
      10_000,
      'the window manager'
    )
    return {
      display,
      env: { DISPLAY: display, DBUS_SESSION_BUS_ADDRESS: bus, XDG_RUNTIME_DIR: run, XDG_SESSION_TYPE: 'x11', GSETTINGS_BACKEND: 'keyfile' },
      async stop() {
        await stop()
        for (const f of [`/tmp/.X11-unix/X${n}`, `/tmp/.X${n}-lock`]) await rm(f, { force: true })
      }
    }
  } catch (err) {
    await stop()
    throw err
  }
}
